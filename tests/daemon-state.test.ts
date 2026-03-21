/**
 * daemon-state.test.ts -- Unit tests for DaemonState class.
 *
 * Coverage:
 *   - Constructor defaults
 *   - load() / save() round-trip (temp directory)
 *   - load() handles missing file, corrupted file, wrong version
 *   - Atomic save (write to .tmp then rename)
 *   - scheduleSave() / flush() debouncing
 *   - Agent CRUD: addAgent, getAgent, getAllAgents, getAgentsByStatus, removeAgent
 *   - updateAgentStatus emits events, tracks timestamps, updates stats
 *   - updateAgent does NOT allow status changes
 *   - updateAgentActivity emits events without saving
 *   - Pinning/skipping: mutual exclusion
 *   - Dependency resolution: areDepsReady, getReadyAgents, getActiveAgents, availableSlots, allComplete
 *   - cancelDownstream transitively cancels dependents
 *   - retryAgent increments count, resets fields
 *   - getSnapshot strips internal fields
 *   - clearCompleted removes terminal agents
 *   - reset clears everything
 *   - subscribe / emit listener pattern
 *   - createDaemonAgentState factory defaults
 *   - destroy cleans up
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { DaemonState, createDaemonAgentState } from "../src/daemon/state";
import type { InternalAgentState, PersistedDaemonState, StateListener } from "../src/daemon/state";
import type { EventType, EventMap, SchedulerState } from "../src/daemon/protocol";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "daemon-state-test-"));
}

/** Create a minimal agent state for testing. */
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

/** Advance past the debounce timer. */
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
// Constructor
// ---------------------------------------------------------------------------

describe("DaemonState constructor", () => {
  test("creates default scheduler state", () => {
    const state = new DaemonState(tempDir);
    const sched = state.getSchedulerState();

    expect(sched.status).toBe("idle");
    expect(sched.maxConcurrent).toBe(4);
    expect(sched.model).toBeNull();
    expect(sched.baseBranch).toBe("main");
    expect(sched.questId).toBeNull();
    expect(sched.startedAt).toBeNull();
    expect(sched.pinnedTasks).toEqual([]);
    expect(sched.skippedTasks).toEqual([]);
    expect(sched.totalProcessed).toBe(0);
    expect(sched.totalCompleted).toBe(0);
    expect(sched.totalFailed).toBe(0);
  });

  test("starts with no agents", () => {
    const state = new DaemonState(tempDir);
    expect(state.getAllAgents()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Persistence: load / save round-trip
// ---------------------------------------------------------------------------

describe("load / save", () => {
  test("save then load restores scheduler state", () => {
    const state = new DaemonState(tempDir);
    state.setMaxConcurrent(8);
    state.setModel("gpt-4o");
    state.setBaseBranch("develop");
    state.setQuestId("quest-1");
    state.save();

    const state2 = new DaemonState(tempDir);
    state2.load();
    const sched = state2.getSchedulerState();

    expect(sched.maxConcurrent).toBe(8);
    expect(sched.model).toBe("gpt-4o");
    expect(sched.baseBranch).toBe("develop");
    expect(sched.questId).toBe("quest-1");
  });

  test("save then load restores agents", () => {
    const state = new DaemonState(tempDir);
    const agent = makeAgent("feat-1");
    state.addAgent(agent);
    state.save();

    const state2 = new DaemonState(tempDir);
    state2.load();
    const loaded = state2.getAgent("feat-1");

    expect(loaded).toBeDefined();
    expect(loaded!.featureId).toBe("feat-1");
    expect(loaded!.taskTitle).toBe("Task: feat-1");
    expect(loaded!.branch).toBe("feature/feat-1");
  });

  test("load handles missing file gracefully", () => {
    const state = new DaemonState(tempDir);
    // No file exists — should not throw
    state.load();
    expect(state.getAllAgents()).toEqual([]);
    expect(state.getSchedulerState().status).toBe("idle");
  });

  test("load handles corrupted JSON gracefully", () => {
    const dir = join(tempDir, ".wombo-combo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "daemon-state.json"), "NOT VALID JSON{{{", "utf-8");

    const state = new DaemonState(tempDir);
    state.load();
    // Should fall back to defaults
    expect(state.getAllAgents()).toEqual([]);
    expect(state.getSchedulerState().status).toBe("idle");
  });

  test("load handles wrong version gracefully", () => {
    const dir = join(tempDir, ".wombo-combo");
    mkdirSync(dir, { recursive: true });
    const badVersion: PersistedDaemonState = {
      version: 999,
      scheduler: {} as SchedulerState,
      agents: [],
    };
    writeFileSync(join(dir, "daemon-state.json"), JSON.stringify(badVersion), "utf-8");

    const state = new DaemonState(tempDir);
    state.load();
    // Wrong version — should start fresh
    expect(state.getSchedulerState().status).toBe("idle");
  });

  test("save creates .wombo-combo directory if missing", () => {
    const state = new DaemonState(tempDir);
    state.save();
    expect(existsSync(join(tempDir, ".wombo-combo", "daemon-state.json"))).toBe(true);
  });

  test("save writes valid JSON with version field", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.save();

    const raw = readFileSync(join(tempDir, ".wombo-combo", "daemon-state.json"), "utf-8");
    const parsed = JSON.parse(raw) as PersistedDaemonState;
    expect(parsed.version).toBe(1);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.scheduler).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// scheduleSave / flush debouncing
// ---------------------------------------------------------------------------

describe("scheduleSave / flush", () => {
  test("scheduleSave writes after debounce delay", async () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1")); // triggers scheduleSave internally
    // File shouldn't exist yet (debounce hasn't fired)
    const p = join(tempDir, ".wombo-combo", "daemon-state.json");
    // It might or might not exist yet — that's ok. Let's wait for the debounce.
    await sleep(200);
    expect(existsSync(p)).toBe(true);
    state.destroy();
  });

  test("flush forces immediate save if dirty", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    // Force immediate
    state.flush();
    const p = join(tempDir, ".wombo-combo", "daemon-state.json");
    expect(existsSync(p)).toBe(true);
    state.destroy();
  });

  test("flush does nothing if not dirty", () => {
    const state = new DaemonState(tempDir);
    // Nothing dirty — shouldn't create a file
    state.flush();
    const p = join(tempDir, ".wombo-combo", "daemon-state.json");
    expect(existsSync(p)).toBe(false);
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// Agent CRUD
// ---------------------------------------------------------------------------

describe("agent CRUD", () => {
  test("addAgent adds and getAgent retrieves", () => {
    const state = new DaemonState(tempDir);
    const agent = makeAgent("feat-1");
    state.addAgent(agent);

    const got = state.getAgent("feat-1");
    expect(got).toBeDefined();
    expect(got!.featureId).toBe("feat-1");
    state.destroy();
  });

  test("getAgent returns undefined for unknown ID", () => {
    const state = new DaemonState(tempDir);
    expect(state.getAgent("nonexistent")).toBeUndefined();
    state.destroy();
  });

  test("getAllAgents returns all agents", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.addAgent(makeAgent("a2"));
    state.addAgent(makeAgent("a3"));
    expect(state.getAllAgents()).toHaveLength(3);
    state.destroy();
  });

  test("getAgentsByStatus filters correctly", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.addAgent(makeAgent("a2"));
    state.updateAgentStatus("a1", "running");
    state.updateAgentStatus("a2", "failed");

    expect(state.getAgentsByStatus("running")).toHaveLength(1);
    expect(state.getAgentsByStatus("failed")).toHaveLength(1);
    expect(state.getAgentsByStatus("queued")).toHaveLength(0);
    expect(state.getAgentsByStatus("running", "failed")).toHaveLength(2);
    state.destroy();
  });

  test("removeAgent removes an agent", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    expect(state.getAgent("a1")).toBeDefined();

    state.removeAgent("a1");
    expect(state.getAgent("a1")).toBeUndefined();
    expect(state.getAllAgents()).toHaveLength(0);
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// updateAgentStatus
// ---------------------------------------------------------------------------

describe("updateAgentStatus", () => {
  test("changes status and emits event", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));

    const events: Array<{ type: string; payload: any }> = [];
    state.subscribe((type, payload) => events.push({ type, payload }));

    state.updateAgentStatus("a1", "running", "Launched");

    const agent = state.getAgent("a1")!;
    expect(agent.status).toBe("running");

    // Should have emitted both the addAgent event and the status change
    const statusEvents = events.filter((e) => e.type === "evt:agent-status-change");
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    const lastEvent = statusEvents[statusEvents.length - 1];
    expect(lastEvent.payload.featureId).toBe("a1");
    expect(lastEvent.payload.previousStatus).toBe("queued");
    expect(lastEvent.payload.newStatus).toBe("running");
    expect(lastEvent.payload.detail).toBe("Launched");
    state.destroy();
  });

  test("sets startedAt when transitioning to active status", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    expect(state.getAgent("a1")!.startedAt).toBeNull();

    state.updateAgentStatus("a1", "running");
    expect(state.getAgent("a1")!.startedAt).not.toBeNull();
    state.destroy();
  });

  test("sets completedAt when transitioning to terminal status", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.updateAgentStatus("a1", "running");
    expect(state.getAgent("a1")!.completedAt).toBeNull();

    state.updateAgentStatus("a1", "verified");
    expect(state.getAgent("a1")!.completedAt).not.toBeNull();
    state.destroy();
  });

  test("increments totalCompleted for merged/verified", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.addAgent(makeAgent("a2"));

    state.updateAgentStatus("a1", "running");
    state.updateAgentStatus("a1", "verified");
    expect(state.getSchedulerState().totalCompleted).toBe(1);

    state.updateAgentStatus("a2", "running");
    state.updateAgentStatus("a2", "merged");
    expect(state.getSchedulerState().totalCompleted).toBe(2);
    state.destroy();
  });

  test("increments totalFailed for failed status", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));

    state.updateAgentStatus("a1", "failed");
    expect(state.getSchedulerState().totalFailed).toBe(1);
    state.destroy();
  });

  test("no-ops when transitioning to same status", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.updateAgentStatus("a1", "running");

    const events: Array<{ type: string }> = [];
    state.subscribe((type) => events.push({ type }));

    state.updateAgentStatus("a1", "running"); // Same status
    // Should not emit
    expect(events.filter((e) => e.type === "evt:agent-status-change")).toHaveLength(0);
    state.destroy();
  });

  test("no-ops for unknown agent", () => {
    const state = new DaemonState(tempDir);
    // Should not throw
    state.updateAgentStatus("nonexistent", "running");
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// updateAgent (non-status fields)
// ---------------------------------------------------------------------------

describe("updateAgent", () => {
  test("updates arbitrary fields", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));

    state.updateAgent("a1", { error: "Build failed", buildPassed: false });
    const agent = state.getAgent("a1")!;
    expect(agent.error).toBe("Build failed");
    expect(agent.buildPassed).toBe(false);
    state.destroy();
  });

  test("does NOT allow status changes through updateAgent", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));

    state.updateAgent("a1", { status: "merged" } as any);
    // Status should remain queued — the status field is stripped
    expect(state.getAgent("a1")!.status).toBe("queued");
    state.destroy();
  });

  test("no-ops for unknown agent", () => {
    const state = new DaemonState(tempDir);
    // Should not throw
    state.updateAgent("nonexistent", { error: "test" });
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// updateAgentActivity
// ---------------------------------------------------------------------------

describe("updateAgentActivity", () => {
  test("updates activity and emits event", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));

    const events: Array<{ type: string; payload: any }> = [];
    state.subscribe((type, payload) => events.push({ type, payload }));

    state.updateAgentActivity("a1", "Editing file.ts");

    const agent = state.getAgent("a1")!;
    expect(agent.activity).toBe("Editing file.ts");
    expect(agent.activityUpdatedAt).not.toBeNull();

    const actEvents = events.filter((e) => e.type === "evt:agent-activity");
    expect(actEvents).toHaveLength(1);
    expect(actEvents[0].payload.activity).toBe("Editing file.ts");
    state.destroy();
  });

  test("no-ops for unknown agent", () => {
    const state = new DaemonState(tempDir);
    state.updateAgentActivity("nonexistent", "something");
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// Pinning / skipping
// ---------------------------------------------------------------------------

describe("pinning and skipping", () => {
  test("pinTask adds to pinnedTasks", () => {
    const state = new DaemonState(tempDir);
    state.pinTask("task-1");
    expect(state.isPinned("task-1")).toBe(true);
    expect(state.getSchedulerState().pinnedTasks).toContain("task-1");
    state.destroy();
  });

  test("pinTask removes from skippedTasks (mutual exclusion)", () => {
    const state = new DaemonState(tempDir);
    state.skipTask("task-1");
    expect(state.isSkipped("task-1")).toBe(true);

    state.pinTask("task-1");
    expect(state.isPinned("task-1")).toBe(true);
    expect(state.isSkipped("task-1")).toBe(false);
    state.destroy();
  });

  test("skipTask adds to skippedTasks", () => {
    const state = new DaemonState(tempDir);
    state.skipTask("task-1");
    expect(state.isSkipped("task-1")).toBe(true);
    expect(state.getSchedulerState().skippedTasks).toContain("task-1");
    state.destroy();
  });

  test("skipTask removes from pinnedTasks (mutual exclusion)", () => {
    const state = new DaemonState(tempDir);
    state.pinTask("task-1");
    expect(state.isPinned("task-1")).toBe(true);

    state.skipTask("task-1");
    expect(state.isSkipped("task-1")).toBe(true);
    expect(state.isPinned("task-1")).toBe(false);
    state.destroy();
  });

  test("unpinTask removes from pinnedTasks", () => {
    const state = new DaemonState(tempDir);
    state.pinTask("task-1");
    state.unpinTask("task-1");
    expect(state.isPinned("task-1")).toBe(false);
    state.destroy();
  });

  test("unskipTask removes from skippedTasks", () => {
    const state = new DaemonState(tempDir);
    state.skipTask("task-1");
    state.unskipTask("task-1");
    expect(state.isSkipped("task-1")).toBe(false);
    state.destroy();
  });

  test("pinning same task twice is idempotent", () => {
    const state = new DaemonState(tempDir);
    state.pinTask("task-1");
    state.pinTask("task-1");
    expect(state.getSchedulerState().pinnedTasks.filter((id) => id === "task-1")).toHaveLength(1);
    state.destroy();
  });

  test("skipping same task twice is idempotent", () => {
    const state = new DaemonState(tempDir);
    state.skipTask("task-1");
    state.skipTask("task-1");
    expect(state.getSchedulerState().skippedTasks.filter((id) => id === "task-1")).toHaveLength(1);
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

describe("dependency resolution", () => {
  test("areDepsReady returns true when no dependencies", () => {
    const state = new DaemonState(tempDir);
    const agent = makeAgent("a1");
    state.addAgent(agent);
    expect(state.areDepsReady(agent)).toBe(true);
    state.destroy();
  });

  test("areDepsReady returns false when dep is not satisfied", () => {
    const state = new DaemonState(tempDir);
    const dep = makeAgent("dep-1");
    const child = makeAgent("child-1", { dependsOn: ["dep-1"] });
    state.addAgent(dep);
    state.addAgent(child);

    // dep is still queued, not verified/merged
    expect(state.areDepsReady(child)).toBe(false);
    state.destroy();
  });

  test("areDepsReady returns true when dep is verified", () => {
    const state = new DaemonState(tempDir);
    const dep = makeAgent("dep-1");
    const child = makeAgent("child-1", { dependsOn: ["dep-1"] });
    state.addAgent(dep);
    state.addAgent(child);

    state.updateAgentStatus("dep-1", "running");
    state.updateAgentStatus("dep-1", "verified");
    expect(state.areDepsReady(child)).toBe(true);
    state.destroy();
  });

  test("areDepsReady returns true when dep is merged", () => {
    const state = new DaemonState(tempDir);
    const dep = makeAgent("dep-1");
    const child = makeAgent("child-1", { dependsOn: ["dep-1"] });
    state.addAgent(dep);
    state.addAgent(child);

    state.updateAgentStatus("dep-1", "running");
    state.updateAgentStatus("dep-1", "merged");
    expect(state.areDepsReady(child)).toBe(true);
    state.destroy();
  });

  test("areDepsReady returns true when dep agent does not exist (external completion)", () => {
    const state = new DaemonState(tempDir);
    // child depends on "external-dep" which isn't tracked
    const child = makeAgent("child-1", { dependsOn: ["external-dep"] });
    state.addAgent(child);
    expect(state.areDepsReady(child)).toBe(true);
    state.destroy();
  });

  test("getReadyAgents only returns queued agents with satisfied deps", () => {
    const state = new DaemonState(tempDir);
    const dep = makeAgent("dep-1");
    const child = makeAgent("child-1", { dependsOn: ["dep-1"] });
    const independent = makeAgent("ind-1");
    state.addAgent(dep);
    state.addAgent(child);
    state.addAgent(independent);

    const ready = state.getReadyAgents();
    expect(ready.map((a) => a.featureId)).toContain("dep-1");
    expect(ready.map((a) => a.featureId)).toContain("ind-1");
    expect(ready.map((a) => a.featureId)).not.toContain("child-1");
    state.destroy();
  });

  test("getActiveAgents returns only agents in active statuses", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.addAgent(makeAgent("a2"));
    state.addAgent(makeAgent("a3"));

    state.updateAgentStatus("a1", "running");
    state.updateAgentStatus("a2", "installing");
    // a3 stays queued

    const active = state.getActiveAgents();
    expect(active).toHaveLength(2);
    expect(active.map((a) => a.featureId).sort()).toEqual(["a1", "a2"]);
    state.destroy();
  });

  test("availableSlots reflects concurrency minus active", () => {
    const state = new DaemonState(tempDir);
    state.setMaxConcurrent(3);

    state.addAgent(makeAgent("a1"));
    state.addAgent(makeAgent("a2"));
    state.updateAgentStatus("a1", "running");

    expect(state.availableSlots()).toBe(2); // 3 - 1 active
    state.destroy();
  });

  test("availableSlots never goes below 0", () => {
    const state = new DaemonState(tempDir);
    state.setMaxConcurrent(1);
    state.addAgent(makeAgent("a1"));
    state.addAgent(makeAgent("a2"));
    state.updateAgentStatus("a1", "running");
    state.updateAgentStatus("a2", "installing");

    expect(state.availableSlots()).toBe(0);
    state.destroy();
  });

  test("allComplete returns true when no agents", () => {
    const state = new DaemonState(tempDir);
    expect(state.allComplete()).toBe(true);
    state.destroy();
  });

  test("allComplete returns true when all in terminal statuses", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.addAgent(makeAgent("a2"));

    state.updateAgentStatus("a1", "running");
    state.updateAgentStatus("a1", "merged");
    state.updateAgentStatus("a2", "failed");

    expect(state.allComplete()).toBe(true);
    state.destroy();
  });

  test("allComplete returns false when some are not terminal", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.addAgent(makeAgent("a2"));

    state.updateAgentStatus("a1", "running");
    state.updateAgentStatus("a2", "failed");

    expect(state.allComplete()).toBe(false);
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// cancelDownstream
// ---------------------------------------------------------------------------

describe("cancelDownstream", () => {
  test("cancels direct dependents", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("parent"));
    state.addAgent(makeAgent("child", { dependsOn: ["parent"] }));

    const cancelled = state.cancelDownstream("parent");
    expect(cancelled).toContain("child");
    expect(state.getAgent("child")!.status).toBe("failed");
    expect(state.getAgent("child")!.error).toContain("parent");
    state.destroy();
  });

  test("cancels transitive dependents", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("root"));
    state.addAgent(makeAgent("mid", { dependsOn: ["root"] }));
    state.addAgent(makeAgent("leaf", { dependsOn: ["mid"] }));

    const cancelled = state.cancelDownstream("root");
    expect(cancelled).toContain("mid");
    expect(cancelled).toContain("leaf");
    expect(state.getAgent("leaf")!.status).toBe("failed");
    state.destroy();
  });

  test("does not cancel already terminal agents", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("root"));
    state.addAgent(makeAgent("child", { dependsOn: ["root"] }));

    // child is already merged (terminal)
    state.updateAgentStatus("child", "running");
    state.updateAgentStatus("child", "merged");

    const cancelled = state.cancelDownstream("root");
    expect(cancelled).not.toContain("child");
    expect(state.getAgent("child")!.status).toBe("merged");
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// retryAgent
// ---------------------------------------------------------------------------

describe("retryAgent", () => {
  test("increments retry count and resets fields", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.updateAgentStatus("a1", "running");
    state.updateAgent("a1", { error: "Build error", buildPassed: false });
    state.updateAgentStatus("a1", "failed");

    const result = state.retryAgent("a1");
    expect(result).toBe(true);

    const agent = state.getAgent("a1")!;
    expect(agent.retries).toBe(1);
    expect(agent.error).toBeNull();
    expect(agent.buildPassed).toBeNull();
    expect(agent.completedAt).toBeNull();
    expect(agent.status).toBe("retry");
    state.destroy();
  });

  test("returns false when max retries exceeded", () => {
    const state = new DaemonState(tempDir);
    const agent = makeAgent("a1");
    agent.maxRetries = 1;
    agent.retries = 1;
    state.addAgent(agent);

    const result = state.retryAgent("a1");
    expect(result).toBe(false);
    state.destroy();
  });

  test("returns false for unknown agent", () => {
    const state = new DaemonState(tempDir);
    expect(state.retryAgent("nonexistent")).toBe(false);
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe("getSnapshot", () => {
  test("returns scheduler state and agents", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.addAgent(makeAgent("a2"));

    const snap = state.getSnapshot();
    expect(snap.scheduler).toBeDefined();
    expect(snap.agents).toHaveLength(2);
    expect(snap.uptime).toBe(0); // Daemon fills this in
    state.destroy();
  });

  test("strips internal-only fields (buildOutput, mergeQueuePosition)", () => {
    const state = new DaemonState(tempDir);
    const agent = makeAgent("a1");
    agent.buildOutput = "some build output";
    agent.mergeQueuePosition = 5;
    state.addAgent(agent);

    const snap = state.getSnapshot();
    const clientAgent = snap.agents[0] as any;
    expect(clientAgent.buildOutput).toBeUndefined();
    expect(clientAgent.mergeQueuePosition).toBeUndefined();
    // But non-internal fields should be there
    expect(clientAgent.featureId).toBe("a1");
    expect(clientAgent.status).toBe("queued");
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// clearCompleted / reset
// ---------------------------------------------------------------------------

describe("clearCompleted", () => {
  test("removes terminal agents", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.addAgent(makeAgent("a2"));
    state.addAgent(makeAgent("a3"));

    state.updateAgentStatus("a1", "running");
    state.updateAgentStatus("a1", "merged");
    state.updateAgentStatus("a2", "failed");
    // a3 is still queued

    const cleared = state.clearCompleted();
    expect(cleared).toBe(2);
    expect(state.getAllAgents()).toHaveLength(1);
    expect(state.getAgent("a3")).toBeDefined();
    state.destroy();
  });

  test("returns 0 when no terminal agents", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    expect(state.clearCompleted()).toBe(0);
    state.destroy();
  });
});

describe("reset", () => {
  test("clears all agents and resets scheduler to defaults", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    state.setMaxConcurrent(10);
    state.setModel("gpt-4o");

    state.reset();
    expect(state.getAllAgents()).toHaveLength(0);
    expect(state.getSchedulerState().maxConcurrent).toBe(4);
    expect(state.getSchedulerState().model).toBeNull();
    state.destroy();
  });

  test("emits idle scheduler status event", () => {
    const state = new DaemonState(tempDir);
    const events: Array<{ type: string; payload: any }> = [];
    state.subscribe((type, payload) => events.push({ type, payload }));

    state.reset();
    const schedEvents = events.filter((e) => e.type === "evt:scheduler-status");
    expect(schedEvents.length).toBeGreaterThanOrEqual(1);
    expect(schedEvents[schedEvents.length - 1].payload.status).toBe("idle");
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// subscribe / emit
// ---------------------------------------------------------------------------

describe("subscribe / emit", () => {
  test("listeners receive events", () => {
    const state = new DaemonState(tempDir);
    const received: Array<{ type: string; payload: any }> = [];
    state.subscribe((type, payload) => received.push({ type, payload }));

    state.emit("evt:log", { level: "info", message: "hello" });
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("evt:log");
    expect(received[0].payload.message).toBe("hello");
    state.destroy();
  });

  test("unsubscribe removes listener", () => {
    const state = new DaemonState(tempDir);
    const received: string[] = [];
    const unsub = state.subscribe((type) => received.push(type));

    state.emit("evt:log", { level: "info", message: "first" });
    unsub();
    state.emit("evt:log", { level: "info", message: "second" });

    expect(received).toHaveLength(1);
    state.destroy();
  });

  test("bad listener does not crash", () => {
    const state = new DaemonState(tempDir);
    state.subscribe(() => {
      throw new Error("bad listener");
    });
    // Should not throw
    state.emit("evt:log", { level: "info", message: "test" });
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// Scheduler state setters
// ---------------------------------------------------------------------------

describe("scheduler setters", () => {
  test("setSchedulerStatus emits event", () => {
    const state = new DaemonState(tempDir);
    const events: Array<{ type: string; payload: any }> = [];
    state.subscribe((type, payload) => events.push({ type, payload }));

    state.setSchedulerStatus("running", "Started");
    expect(state.getSchedulerStatus()).toBe("running");

    const schedEvents = events.filter((e) => e.type === "evt:scheduler-status");
    expect(schedEvents).toHaveLength(1);
    expect(schedEvents[0].payload.status).toBe("running");
    expect(schedEvents[0].payload.reason).toBe("Started");
    state.destroy();
  });

  test("setSchedulerStatus to running sets startedAt", () => {
    const state = new DaemonState(tempDir);
    expect(state.getSchedulerState().startedAt).toBeNull();

    state.setSchedulerStatus("running");
    expect(state.getSchedulerState().startedAt).not.toBeNull();
    state.destroy();
  });

  test("setSchedulerStatus no-ops on same status", () => {
    const state = new DaemonState(tempDir);
    state.setSchedulerStatus("running");

    const events: Array<{ type: string }> = [];
    state.subscribe((type) => events.push({ type }));

    state.setSchedulerStatus("running"); // Same
    expect(events.filter((e) => e.type === "evt:scheduler-status")).toHaveLength(0);
    state.destroy();
  });

  test("setMaxConcurrent allows 0 (unlimited) and clamps negative to 0", () => {
    const state = new DaemonState(tempDir);
    state.setMaxConcurrent(0);
    expect(state.getMaxConcurrent()).toBe(0);

    state.setMaxConcurrent(-5);
    expect(state.getMaxConcurrent()).toBe(0);
    state.destroy();
  });

  test("setModel / getModel round-trip", () => {
    const state = new DaemonState(tempDir);
    state.setModel("claude-sonnet");
    expect(state.getModel()).toBe("claude-sonnet");

    state.setModel(null);
    expect(state.getModel()).toBeNull();
    state.destroy();
  });

  test("setBaseBranch / getBaseBranch round-trip", () => {
    const state = new DaemonState(tempDir);
    state.setBaseBranch("develop");
    expect(state.getBaseBranch()).toBe("develop");
    state.destroy();
  });

  test("setQuestId / getQuestId round-trip", () => {
    const state = new DaemonState(tempDir);
    state.setQuestId("q1");
    expect(state.getQuestId()).toBe("q1");

    state.setQuestId(null);
    expect(state.getQuestId()).toBeNull();
    state.destroy();
  });
});

// ---------------------------------------------------------------------------
// createDaemonAgentState factory
// ---------------------------------------------------------------------------

describe("createDaemonAgentState", () => {
  test("creates agent with defaults", () => {
    const agent = createDaemonAgentState({
      featureId: "feat-1",
      taskTitle: "My Feature",
      branch: "feature/feat-1",
      baseBranch: "main",
      worktree: "/tmp/wt",
    });

    expect(agent.featureId).toBe("feat-1");
    expect(agent.taskTitle).toBe("My Feature");
    expect(agent.status).toBe("queued");
    expect(agent.retries).toBe(0);
    expect(agent.maxRetries).toBe(2);
    expect(agent.dependsOn).toEqual([]);
    expect(agent.dependedOnBy).toEqual([]);
    expect(agent.pid).toBeNull();
    expect(agent.sessionId).toBeNull();
    expect(agent.activity).toBeNull();
    expect(agent.startedAt).toBeNull();
    expect(agent.completedAt).toBeNull();
    expect(agent.buildPassed).toBeNull();
    expect(agent.error).toBeNull();
    expect(agent.effortEstimateMs).toBeNull();
    expect(agent.streamIndex).toBeNull();
    expect(agent.agentName).toBeNull();
    expect(agent.agentType).toBeNull();
    expect(agent.pendingQuestions).toEqual([]);
    expect(agent.tokenUsage).toBeNull();
    expect(agent.buildOutput).toBeNull();
    expect(agent.mergeQueuePosition).toBeNull();
  });

  test("accepts overrides", () => {
    const agent = createDaemonAgentState({
      featureId: "feat-2",
      taskTitle: "Feature 2",
      branch: "feature/feat-2",
      baseBranch: "develop",
      worktree: "/tmp/wt-2",
      maxRetries: 5,
      dependsOn: ["feat-1"],
      dependedOnBy: ["feat-3"],
      streamIndex: 2,
      agentName: "claude",
      agentType: "specialized",
      effortEstimateMs: 300000,
    });

    expect(agent.maxRetries).toBe(5);
    expect(agent.dependsOn).toEqual(["feat-1"]);
    expect(agent.dependedOnBy).toEqual(["feat-3"]);
    expect(agent.streamIndex).toBe(2);
    expect(agent.agentName).toBe("claude");
    expect(agent.agentType).toBe("specialized");
    expect(agent.effortEstimateMs).toBe(300000);
  });
});

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

describe("destroy", () => {
  test("flushes and clears timer", () => {
    const state = new DaemonState(tempDir);
    state.addAgent(makeAgent("a1"));
    // scheduleSave was called, timer is pending
    state.destroy();
    // After destroy, file should exist (flush happened)
    const p = join(tempDir, ".wombo-combo", "daemon-state.json");
    expect(existsSync(p)).toBe(true);
  });
});
