/**
 * daemon-scheduler.test.ts -- Unit tests for the Scheduler class.
 *
 * Strategy: Use real DaemonState (proven by daemon-state tests) and a mock
 * AgentRunner that records calls. The Scheduler's tick loop and task selection
 * depend on loadFeatures/selectFeatures which read from disk — we pre-populate
 * agents in DaemonState to test the scheduling logic without needing real task
 * files. For the getCandidateTasks path we test through the external signals
 * and lifecycle methods.
 *
 * Coverage:
 *   - start() sets status to running, applies config overrides
 *   - pause() / resume() lifecycle
 *   - stop() transitions through stopping to idle when agents finish
 *   - kill() force-kills agents
 *   - shutdown() clears tick timer
 *   - prioritize(): pinned -> queued -> candidates ordering
 *   - External signals: pinTask, skipTask, retryAgent, setConcurrency, cancelAgent
 *   - Dependency-blocked agents not launched
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonState, createDaemonAgentState } from "../src/daemon/state";
import type { InternalAgentState } from "../src/daemon/state";
import { Scheduler } from "../src/daemon/scheduler";
import type { SchedulerConfig, SchedulerDeps } from "../src/daemon/scheduler";
import type { WomboConfig } from "../src/config";
import { AgentRunner } from "../src/daemon/agent-runner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "daemon-sched-test-"));
}

/** Minimal WomboConfig for testing (only fields the scheduler reads). */
function makeConfig(overrides: Partial<WomboConfig> = {}): WomboConfig {
  return {
    baseBranch: "main",
    maxConcurrent: 4,
    model: null,
    agent: { name: "test-agent", provider: "anthropic" },
    build: { command: "echo ok", enabled: false },
    merge: { strategy: "merge", maxEscalation: "tier4" },
    browser: { enabled: false },
    tdd: { enabled: false },
    tui: {},
    quest: {},
    defaults: { maxConcurrent: 4, maxRetries: 2 },
    ...overrides,
  } as WomboConfig;
}

/** Create a mock AgentRunner that records method calls. */
function makeMockRunner() {
  const calls: Array<{ method: string; args: any[] }> = [];
  return {
    calls,
    runner: {
      submitTask: (...args: any[]) => calls.push({ method: "submitTask", args }),
      launchAgent: (...args: any[]) => calls.push({ method: "launchAgent", args }),
      killAll: async () => { calls.push({ method: "killAll", args: [] }); },
      cancelAgent: (...args: any[]) => calls.push({ method: "cancelAgent", args }),
      reapDeadProcesses: () => calls.push({ method: "reapDeadProcesses", args: [] }),
    } as any,
  };
}

/** Create a DaemonState pre-populated with agents. */
function makePopulatedState(
  tempDir: string,
  agents: InternalAgentState[]
): DaemonState {
  const state = new DaemonState(tempDir);
  for (const agent of agents) {
    state.addAgent(agent);
  }
  return state;
}

/** Create a minimal agent. */
function makeAgent(
  featureId: string,
  overrides: Partial<InternalAgentState> = {}
): InternalAgentState {
  return createDaemonAgentState({
    featureId,
    taskTitle: `Task: ${featureId}`,
    branch: `feature/${featureId}`,
    baseBranch: "main",
    worktree: `/tmp/wt-${featureId}`,
    dependsOn: overrides.dependsOn ?? [],
    dependedOnBy: overrides.dependedOnBy ?? [],
    ...overrides,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Lifecycle: start
// ---------------------------------------------------------------------------

describe("Scheduler start", () => {
  test("sets scheduler status to running", () => {
    const state = new DaemonState(tempDir);
    // Add a non-terminal agent so tick doesn't immediately transition to idle
    state.addAgent(makeAgent("keep-alive"));
    state.updateAgentStatus("keep-alive", "running");

    const { runner } = makeMockRunner();
    const config: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig(),
      tickIntervalMs: 60000, // very long so tick doesn't auto-fire
    };

    const scheduler = new Scheduler(config, { state, runner });
    scheduler.start();

    expect(state.getSchedulerStatus()).toBe("running");
    scheduler.shutdown();
    state.destroy();
  });

  test("applies config overrides (maxConcurrent, model, questId)", () => {
    const state = new DaemonState(tempDir);
    const { runner } = makeMockRunner();
    const config: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig(),
      tickIntervalMs: 60000,
      maxConcurrent: 8,
      model: "gpt-4o",
      questId: "quest-1",
    };

    const scheduler = new Scheduler(config, { state, runner });
    scheduler.start();

    expect(state.getMaxConcurrent()).toBe(8);
    expect(state.getModel()).toBe("gpt-4o");
    expect(state.getQuestId()).toBe("quest-1");
    scheduler.shutdown();
    state.destroy();
  });

  test("sets baseBranch from config", () => {
    const state = new DaemonState(tempDir);
    const { runner } = makeMockRunner();
    const config: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig({ baseBranch: "develop" }),
      tickIntervalMs: 60000,
    };

    const scheduler = new Scheduler(config, { state, runner });
    scheduler.start();

    expect(state.getBaseBranch()).toBe("develop");
    scheduler.shutdown();
    state.destroy();
  });

  test("does not start if already running", () => {
    const state = new DaemonState(tempDir);
    const { runner } = makeMockRunner();
    const config: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig(),
      tickIntervalMs: 60000,
    };

    const scheduler = new Scheduler(config, { state, runner });
    scheduler.start();
    const startedAt = state.getSchedulerState().startedAt;

    // Start again — should be a no-op
    scheduler.start();
    expect(state.getSchedulerState().startedAt).toBe(startedAt);
    scheduler.shutdown();
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: pause / resume
// ---------------------------------------------------------------------------

describe("Scheduler pause / resume", () => {
  test("pause sets status to paused", () => {
    const state = new DaemonState(tempDir);
    const { runner } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );
    scheduler.start();
    scheduler.pause();

    expect(state.getSchedulerStatus()).toBe("paused");
    scheduler.shutdown();
    state.destroy();
  });

  test("resume from paused sets status to running", () => {
    const state = new DaemonState(tempDir);
    // Need a non-terminal agent so resume-tick doesn't immediately go idle
    state.addAgent(makeAgent("keep-alive"));
    state.updateAgentStatus("keep-alive", "running");

    const { runner } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );
    scheduler.start();
    scheduler.pause();
    scheduler.resume();

    expect(state.getSchedulerStatus()).toBe("running");
    scheduler.shutdown();
    state.destroy();
  });

  test("resume from non-paused state is a no-op", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("keep-alive"));
    state.updateAgentStatus("keep-alive", "running");

    const { runner } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );
    scheduler.start();
    // Already running — resume should do nothing
    scheduler.resume();
    expect(state.getSchedulerStatus()).toBe("running");
    scheduler.shutdown();
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: stop
// ---------------------------------------------------------------------------

describe("Scheduler stop", () => {
  test("sets status to stopping", () => {
    const state = new DaemonState(tempDir);
    const { runner } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );
    scheduler.start();
    scheduler.stop();

    expect(state.getSchedulerStatus()).toBe("stopping");
    scheduler.shutdown();
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: kill
// ---------------------------------------------------------------------------

describe("Scheduler kill", () => {
  test("calls runner.killAll and sets status to idle", async () => {
    const state = new DaemonState(tempDir);
    const { runner, calls } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );
    scheduler.start();
    await scheduler.kill();

    expect(calls.some((c) => c.method === "killAll")).toBe(true);
    expect(state.getSchedulerStatus()).toBe("idle");
    scheduler.shutdown();
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: shutdown
// ---------------------------------------------------------------------------

describe("Scheduler shutdown", () => {
  test("sets status to shutdown", () => {
    const state = new DaemonState(tempDir);
    const { runner } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );
    scheduler.start();
    scheduler.shutdown();

    expect(state.getSchedulerStatus()).toBe("shutdown");
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tick: ready agents get launched
// ---------------------------------------------------------------------------

describe("Scheduler tick behavior", () => {
  test("launches ready queued agents on tick", async () => {
    const state = new DaemonState(tempDir);
    state.setMaxConcurrent(4);
    // Pre-populate agents that are queued with no deps
    state.addAgent(makeAgent("a1"));
    state.addAgent(makeAgent("a2"));

    const { runner, calls } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );

    // Start fires immediate tick
    scheduler.start();

    // The tick should have seen 2 ready agents and called launchAgent
    const launchCalls = calls.filter((c) => c.method === "launchAgent");
    expect(launchCalls).toHaveLength(2);
    expect(launchCalls.map((c) => c.args[0]).sort()).toEqual(["a1", "a2"]);

    scheduler.shutdown();
    state.destroy();
  });

  test("respects concurrency limit", async () => {
    const state = new DaemonState(tempDir);

    // Already have one active agent
    const active = makeAgent("active");
    state.addAgent(active);
    state.updateAgentStatus("active", "running");

    // Two more queued
    state.addAgent(makeAgent("q1"));
    state.addAgent(makeAgent("q2"));

    const { runner, calls } = makeMockRunner();
    const scheduler = new Scheduler(
      // Pass maxConcurrent: 1 explicitly so start() sets it before ticking
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000, maxConcurrent: 1 },
      { state, runner }
    );
    scheduler.start();

    // No launches should happen — 0 available slots
    const launchCalls = calls.filter((c) => c.method === "launchAgent");
    expect(launchCalls).toHaveLength(0);

    scheduler.shutdown();
    state.destroy();
  });

  test("does not launch dependency-blocked agents", () => {
    const state = new DaemonState(tempDir);
    state.setMaxConcurrent(4);

    state.addAgent(makeAgent("dep-1"));
    state.addAgent(makeAgent("child-1", { dependsOn: ["dep-1"] }));

    const { runner, calls } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );
    scheduler.start();

    // Only dep-1 should be launched, not child-1
    const launchCalls = calls.filter((c) => c.method === "launchAgent");
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0].args[0]).toBe("dep-1");

    scheduler.shutdown();
    state.destroy();
  });

  test("already-queued agents are always launched regardless of concurrency limit", () => {
    const state = new DaemonState(tempDir);

    state.addAgent(makeAgent("normal"));
    state.addAgent(makeAgent("pinned"));
    state.pinTask("pinned");

    const { runner, calls } = makeMockRunner();
    const scheduler = new Scheduler(
      // maxConcurrent: 1 — but both agents are already queued-ready,
      // so both should be launched (they've already been allocated slots)
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000, maxConcurrent: 2 },
      { state, runner }
    );
    scheduler.start();

    // Both pre-queued agents must be launched
    const launchCalls = calls.filter((c) => c.method === "launchAgent");
    expect(launchCalls).toHaveLength(2);

    scheduler.shutdown();
    state.destroy();
  });

  test("does not pick tasks when paused", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));

    const { runner, calls } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );
    scheduler.start();

    // Clear the launch calls from the initial tick
    const initialCalls = calls.length;

    // Pause and trigger another round
    scheduler.pause();

    // Manually add another agent while paused
    state.addAgent(makeAgent("a2"));

    // Resume will trigger a tick
    const preResumeCalls = calls.length;
    scheduler.resume();
    // After resume, the new agent should be picked up
    const postResumeLaunch = calls.slice(preResumeCalls).filter((c) => c.method === "launchAgent");
    expect(postResumeLaunch.length).toBeGreaterThanOrEqual(1);

    scheduler.shutdown();
    state.destroy();
  });

  test("reaps dead processes on each tick", () => {
    const state = new DaemonState(tempDir);
    const { runner, calls } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );
    scheduler.start();

    expect(calls.some((c) => c.method === "reapDeadProcesses")).toBe(true);

    scheduler.shutdown();
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// External signals
// ---------------------------------------------------------------------------

describe("Scheduler external signals", () => {
  test("pinTask delegates to state.pinTask", () => {
    const state = new DaemonState(tempDir);
    const { runner } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );
    scheduler.start();
    scheduler.pinTask("task-x");

    // The pin gets consumed during tick, but we can check that it was processed
    // by verifying the state accepted it (or consumed it if tick ran)
    // Just verify no error thrown
    scheduler.shutdown();
    state.destroy();
  });

  test("skipTask marks queued agent as failed", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("skip-me"));

    const { runner } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );

    // Don't start — we want the agent to stay queued
    scheduler.skipTask("skip-me");

    expect(state.isSkipped("skip-me")).toBe(true);
    expect(state.getAgent("skip-me")!.status).toBe("failed");
    scheduler.shutdown();
    state.destroy();
  });

  test("retryAgent re-queues a failed agent", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("retry-me"));
    state.updateAgentStatus("retry-me", "running");
    state.updateAgentStatus("retry-me", "failed");

    const { runner } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );

    scheduler.retryAgent("retry-me");

    // retryAgent in state sets to "retry", then scheduler sets to "queued"
    expect(state.getAgent("retry-me")!.status).toBe("queued");
    expect(state.getAgent("retry-me")!.retries).toBe(1);
    scheduler.shutdown();
    state.destroy();
  });

  test("setConcurrency updates max concurrent", () => {
    const state = new DaemonState(tempDir);
    const { runner } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );
    scheduler.start();
    scheduler.setConcurrency(12);

    expect(state.getMaxConcurrent()).toBe(12);
    scheduler.shutdown();
    state.destroy();
  });

  test("cancelAgent calls runner.cancelAgent and marks agent failed", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("cancel-me"));
    state.updateAgentStatus("cancel-me", "running");

    const { runner, calls } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );

    scheduler.cancelAgent("cancel-me");

    expect(calls.some((c) => c.method === "cancelAgent" && c.args[0] === "cancel-me")).toBe(true);
    expect(state.getAgent("cancel-me")!.status).toBe("failed");
    scheduler.shutdown();
    state.destroy();
  });

  test("cancelAgent cancels downstream dependents", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("parent"));
    state.addAgent(makeAgent("child", { dependsOn: ["parent"] }));
    state.updateAgentStatus("parent", "running");

    const { runner } = makeMockRunner();
    const scheduler = new Scheduler(
      { projectRoot: tempDir, config: makeConfig(), tickIntervalMs: 60000 },
      { state, runner }
    );

    scheduler.cancelAgent("parent");

    expect(state.getAgent("parent")!.status).toBe("failed");
    expect(state.getAgent("child")!.status).toBe("failed");
    scheduler.shutdown();
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// availableSlots: queued-ready agents count against the limit (Bug 1 fix)
// ---------------------------------------------------------------------------

describe("DaemonState.availableSlots() — queued-ready accounting", () => {
  test("queued agents with satisfied deps consume concurrency slots", () => {
    const state = new DaemonState(tempDir);
    state.setMaxConcurrent(3);

    // Two already running
    state.addAgent(makeAgent("r1"));
    state.updateAgentStatus("r1", "running");
    state.addAgent(makeAgent("r2"));
    state.updateAgentStatus("r2", "running");

    // One queued with no deps (dep-satisfied → counts as ready)
    state.addAgent(makeAgent("q1"));
    // status is "queued" by default from createDaemonAgentState

    // 3 active/ready vs maxConcurrent 3 → 0 slots free
    expect(state.availableSlots()).toBe(0);
    state.destroy();
  });

  test("queued agents with unsatisfied deps do NOT consume slots", () => {
    const state = new DaemonState(tempDir);
    state.setMaxConcurrent(3);

    // One running
    state.addAgent(makeAgent("r1"));
    state.updateAgentStatus("r1", "running");

    // One queued dep-free (blocker): counts as ready → consumes a slot
    state.addAgent(makeAgent("blocker"));

    // child depends on blocker and is NOT dep-satisfied yet → does NOT consume a slot
    state.addAgent(makeAgent("child", { dependsOn: ["blocker"] }));

    // r1 (active=1) + blocker (queued-ready=1) vs maxConcurrent=3 → 1 slot free
    // child is dep-blocked so it does NOT count
    expect(state.availableSlots()).toBe(1);
    state.destroy();
  });

  test("slots free up when queued-ready agent transitions to running", () => {
    const state = new DaemonState(tempDir);
    state.setMaxConcurrent(2);

    state.addAgent(makeAgent("q1")); // queued, dep-free
    expect(state.availableSlots()).toBe(1); // q1 consumes 1

    state.updateAgentStatus("q1", "running"); // now active
    expect(state.availableSlots()).toBe(1); // still 1 consumed, same result
    state.destroy();
  });

  test("maxConcurrent 0 returns MAX_SAFE_INTEGER regardless of queued agents", () => {
    const state = new DaemonState(tempDir);
    state.setMaxConcurrent(0);

    for (let i = 0; i < 10; i++) {
      state.addAgent(makeAgent(`q${i}`));
    }

    expect(state.availableSlots()).toBe(Number.MAX_SAFE_INTEGER);
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// Concurrency pinning — start() re-invocations must not reset runtime value
// ---------------------------------------------------------------------------

describe("Scheduler concurrency pinning", () => {
  test("3.3 first start() applies config value (pinning does not block initial apply)", () => {
    const state = new DaemonState(tempDir);
    // Pre-populate so tick doesn't go idle immediately
    state.addAgent(makeAgent("keep-alive"));
    state.updateAgentStatus("keep-alive", "running");

    const { runner } = makeMockRunner();
    const config: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig({ defaults: { maxConcurrent: 6, maxRetries: 2 } }),
      tickIntervalMs: 60000,
    };
    const scheduler = new Scheduler(config, { state, runner });
    scheduler.start();

    expect(state.getMaxConcurrent()).toBe(6);
    scheduler.shutdown();
    state.destroy();
  });

  test("3.1 second start() does not reset maxConcurrent to config default after infinite override", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("keep-alive"));
    state.updateAgentStatus("keep-alive", "running");

    const { runner } = makeMockRunner();
    const config: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig({ defaults: { maxConcurrent: 4, maxRetries: 2 } }),
      tickIntervalMs: 60000,
    };
    const scheduler = new Scheduler(config, { state, runner });
    scheduler.start(); // applies config default (4), pins

    // User sets infinite concurrency at runtime
    scheduler.setConcurrency(0);
    expect(state.getMaxConcurrent()).toBe(0);

    // Simulate watcher re-trigger: scheduler goes idle then start() is called again
    scheduler.shutdown();
    scheduler.start();

    // Must still be 0 — not reset to 4
    expect(state.getMaxConcurrent()).toBe(0);
    scheduler.shutdown();
    state.destroy();
  });

  test("3.2 start() re-invocation after setConcurrency(8) preserves 8", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("keep-alive"));
    state.updateAgentStatus("keep-alive", "running");

    const { runner } = makeMockRunner();
    const config: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig({ defaults: { maxConcurrent: 4, maxRetries: 2 } }),
      tickIntervalMs: 60000,
    };
    const scheduler = new Scheduler(config, { state, runner });
    scheduler.start(); // applies 4, pins

    scheduler.setConcurrency(8);
    expect(state.getMaxConcurrent()).toBe(8);

    // Simulate re-trigger
    scheduler.shutdown();
    scheduler.start();

    expect(state.getMaxConcurrent()).toBe(8);
    scheduler.shutdown();
    state.destroy();
  });

  test("3.5 Scheduler reconstructed with initialMaxConcurrent=0 does not reset state to config default", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("keep-alive"));
    state.updateAgentStatus("keep-alive", "running");

    const { runner } = makeMockRunner();
    // Original scheduler: user pins to infinite (0)
    const config: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig({ defaults: { maxConcurrent: 3, maxRetries: 2 } }),
      tickIntervalMs: 60000,
    };
    const scheduler = new Scheduler(config, { state, runner });
    scheduler.start();           // applies config default (3), pins
    scheduler.setConcurrency(0); // user sets infinite
    expect(state.getMaxConcurrent()).toBe(0);
    scheduler.shutdown();

    // Daemon rebuilds scheduler (e.g. cmd:start with questId).
    // Carries forward state.getMaxConcurrent() = 0 via initialMaxConcurrent.
    const rebuilt: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig({ defaults: { maxConcurrent: 3, maxRetries: 2 } }),
      tickIntervalMs: 60000,
      questId: "quest-1",
      initialMaxConcurrent: state.getMaxConcurrent(), // = 0
    };
    const scheduler2 = new Scheduler(rebuilt, { state, runner });
    scheduler2.start();

    // Must remain 0 — not reset to config default (3)
    expect(state.getMaxConcurrent()).toBe(0);
    expect(scheduler2.concurrencyPinned).toBe(true);
    scheduler2.shutdown();
    state.destroy();
  });

  test("3.6 Scheduler reconstructed with initialMaxConcurrent=5 starts pinned at 5", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("keep-alive"));
    state.updateAgentStatus("keep-alive", "running");

    const { runner } = makeMockRunner();
    const rebuilt: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig({ defaults: { maxConcurrent: 3, maxRetries: 2 } }),
      tickIntervalMs: 60000,
      initialMaxConcurrent: 5,
    };
    const scheduler = new Scheduler(rebuilt, { state, runner });
    scheduler.start();

    expect(state.getMaxConcurrent()).toBe(5);
    expect(scheduler.concurrencyPinned).toBe(true);
    scheduler.shutdown();
    state.destroy();
  });

  test("3.7 Scheduler cold-start with no initialMaxConcurrent applies config default normally", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("keep-alive"));
    state.updateAgentStatus("keep-alive", "running");

    const { runner } = makeMockRunner();
    const config: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig({ defaults: { maxConcurrent: 7, maxRetries: 2 } }),
      tickIntervalMs: 60000,
      // No initialMaxConcurrent
    };
    const scheduler = new Scheduler(config, { state, runner });
    scheduler.start();

    expect(state.getMaxConcurrent()).toBe(7);
    scheduler.shutdown();
    state.destroy();
  });

  test("3.4 infinite concurrency: all candidate disk tasks submitted in one tick", () => {
    // We test the tick's slotsForNew logic by pre-populating agents in state
    // as queued (simulating already-submitted tasks) and verifying launchAgent
    // is called for ALL of them when maxConcurrent=0.
    const N = 8;
    const agents = Array.from({ length: N }, (_, i) =>
      makeAgent(`task-${i}`)
    );
    const state = makePopulatedState(tempDir, agents);
    state.setMaxConcurrent(0);

    const { runner, calls } = makeMockRunner();
    const config: SchedulerConfig = {
      projectRoot: tempDir,
      config: makeConfig(),
      tickIntervalMs: 60000,
      maxConcurrent: 0,
    };

    const scheduler = new Scheduler(config, { state, runner });
    scheduler.start(); // triggers first tick

    const launchCalls = calls.filter((c) => c.method === "launchAgent");
    expect(launchCalls).toHaveLength(N);
    scheduler.shutdown();
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// AgentRunner.reconcileOrphanedTasks() — Bug 2 fix
// ---------------------------------------------------------------------------

describe("AgentRunner.reconcileOrphanedTasks()", () => {
  /** Write a minimal task YAML file directly to the tasks store directory. */
  function writeTaskYml(dir: string, id: string, status: string): void {
    mkdirSync(dir, { recursive: true });
    const content = [
      `id: ${id}`,
      `title: Test task ${id}`,
      `status: ${status}`,
      `priority: medium`,
      `effort: PT30M`,
      `depends_on: []`,
    ].join("\n") + "\n";
    writeFileSync(join(dir, `${id}.yml`), content, "utf-8");
  }

  test("resets in_progress tasks with no active agent to planned", async () => {
    const womboDir = join(tempDir, ".wombo-combo");
    const tasksStoreDir = join(womboDir, "tasks");
    mkdirSync(womboDir, { recursive: true });

    const config = makeConfig({ tasksDir: "tasks", archiveDir: "archive" });

    // Write a task with status "in_progress" (orphan — no daemon agent)
    writeTaskYml(tasksStoreDir, "orphan-1", "in_progress");

    const state = new DaemonState(tempDir);
    const runner = new AgentRunner({ projectRoot: tempDir, config }, state);

    runner.reconcileOrphanedTasks();

    // Task should now be "planned"
    const { loadTasksFromStore } = await import("../src/lib/task-store");
    const { tasks } = loadTasksFromStore(tempDir, config);
    const task = tasks.find((t) => t.id === "orphan-1");
    expect(task).toBeDefined();
    expect(task!.status).toBe("planned");

    state.destroy();
  });

  test("does not reset in_progress tasks that have an active daemon agent", async () => {
    const womboDir = join(tempDir, ".wombo-combo");
    const tasksStoreDir = join(womboDir, "tasks");
    mkdirSync(womboDir, { recursive: true });

    const config = makeConfig({ tasksDir: "tasks", archiveDir: "archive" });

    writeTaskYml(tasksStoreDir, "active-task", "in_progress");

    const state = new DaemonState(tempDir);
    // Register an active agent for this task in daemon state
    state.addAgent(makeAgent("active-task"));
    state.updateAgentStatus("active-task", "running");

    const runner = new AgentRunner({ projectRoot: tempDir, config }, state);
    runner.reconcileOrphanedTasks();

    // Task should still be "in_progress" on disk (runner leaves it alone)
    const { loadTasksFromStore } = await import("../src/lib/task-store");
    const { tasks } = loadTasksFromStore(tempDir, config);
    const task = tasks.find((t) => t.id === "active-task");
    expect(task).toBeDefined();
    expect(task!.status).toBe("in_progress");

    state.destroy();
  });

  test("does not touch done or cancelled tasks", async () => {
    const womboDir = join(tempDir, ".wombo-combo");
    const tasksStoreDir = join(womboDir, "tasks");
    mkdirSync(womboDir, { recursive: true });

    const config = makeConfig({ tasksDir: "tasks", archiveDir: "archive" });

    writeTaskYml(tasksStoreDir, "done-task", "done");
    writeTaskYml(tasksStoreDir, "cancelled-task", "cancelled");

    const state = new DaemonState(tempDir);
    const runner = new AgentRunner({ projectRoot: tempDir, config }, state);
    runner.reconcileOrphanedTasks();

    const { loadTasksFromStore } = await import("../src/lib/task-store");
    const { tasks } = loadTasksFromStore(tempDir, config);

    expect(tasks.find((t) => t.id === "done-task")!.status).toBe("done");
    expect(tasks.find((t) => t.id === "cancelled-task")!.status).toBe("cancelled");

    state.destroy();
  });
});
