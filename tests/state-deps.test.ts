/**
 * state-deps.test.ts — Unit tests for dependency-aware state helpers.
 *
 * These functions were added for dependency-aware scheduling (streams,
 * merge gates, cascading failure). They're tested separately from the
 * core state CRUD tests in state.test.ts.
 *
 * Coverage:
 *   - areAgentDepsReady: no deps, verified dep, failed dep, external dep
 *   - readyToLaunchAgents: filters queued + deps-ready
 *   - getDownstreamAgents: direct downstream, transitive downstream, cycles
 *   - cancelDownstream: cascading failure, terminal states not cancelled
 */

import { describe, test, expect } from "bun:test";
import {
  areAgentDepsReady,
  readyToLaunchAgents,
  getDownstreamAgents,
  cancelDownstream,
  updateAgent,
} from "../src/lib/state.js";
import type { WaveState, AgentState, AgentStatus } from "../src/lib/state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(
  featureId: string,
  status: AgentStatus = "queued",
  deps: string[] = [],
  dependedOnBy: string[] = []
): AgentState {
  return {
    feature_id: featureId,
    branch: `feature/${featureId}`,
    worktree: `/tmp/wombo-${featureId}`,
    session_id: null,
    pid: null,
    status,
    activity: null,
    activity_updated_at: null,
    retries: 0,
    max_retries: 2,
    started_at: null,
    completed_at: null,
    build_passed: null,
    build_output: null,
    error: null,
    effort_estimate_ms: null,
    stream_index: null,
    depends_on: deps,
    depended_on_by: dependedOnBy,
    agent_name: null,
    agent_type: null,
  };
}

function makeWave(agents: AgentState[]): WaveState {
  return {
    wave_id: "wave-2025-01-01-000",
    base_branch: "main",
    started_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    max_concurrent: 4,
    model: null,
    interactive: false,
    agents,
    schedule_plan: null,
  };
}

// ---------------------------------------------------------------------------
// areAgentDepsReady
// ---------------------------------------------------------------------------

describe("areAgentDepsReady", () => {
  test("returns true when agent has no dependencies", () => {
    const agent = makeAgent("task-a");
    const state = makeWave([agent]);
    expect(areAgentDepsReady(state, agent)).toBe(true);
  });

  test("returns true when dependency is verified", () => {
    const depAgent = makeAgent("task-a", "verified");
    const agent = makeAgent("task-b", "queued", ["task-a"]);
    const state = makeWave([depAgent, agent]);
    expect(areAgentDepsReady(state, agent)).toBe(true);
  });

  test("returns true when dependency is merged", () => {
    const depAgent = makeAgent("task-a", "merged");
    const agent = makeAgent("task-b", "queued", ["task-a"]);
    const state = makeWave([depAgent, agent]);
    expect(areAgentDepsReady(state, agent)).toBe(true);
  });

  test("returns false when dependency is running", () => {
    const depAgent = makeAgent("task-a", "running");
    const agent = makeAgent("task-b", "queued", ["task-a"]);
    const state = makeWave([depAgent, agent]);
    expect(areAgentDepsReady(state, agent)).toBe(false);
  });

  test("returns false when dependency is queued", () => {
    const depAgent = makeAgent("task-a", "queued");
    const agent = makeAgent("task-b", "queued", ["task-a"]);
    const state = makeWave([depAgent, agent]);
    expect(areAgentDepsReady(state, agent)).toBe(false);
  });

  test("returns false when dependency is completed but not verified", () => {
    const depAgent = makeAgent("task-a", "completed");
    const agent = makeAgent("task-b", "queued", ["task-a"]);
    const state = makeWave([depAgent, agent]);
    expect(areAgentDepsReady(state, agent)).toBe(false);
  });

  test("returns false when dependency has failed", () => {
    const depAgent = makeAgent("task-a", "failed");
    const agent = makeAgent("task-b", "queued", ["task-a"]);
    const state = makeWave([depAgent, agent]);
    expect(areAgentDepsReady(state, agent)).toBe(false);
  });

  test("returns true when dependency is external (not in wave)", () => {
    // If a dependency is not in the current wave, it's assumed to be external
    // and is considered satisfied
    const agent = makeAgent("task-b", "queued", ["external-task"]);
    const state = makeWave([agent]);
    expect(areAgentDepsReady(state, agent)).toBe(true);
  });

  test("requires ALL dependencies to be satisfied", () => {
    const dep1 = makeAgent("task-a", "verified");
    const dep2 = makeAgent("task-c", "running");
    const agent = makeAgent("task-b", "queued", ["task-a", "task-c"]);
    const state = makeWave([dep1, dep2, agent]);
    expect(areAgentDepsReady(state, agent)).toBe(false);
  });

  test("returns true when all multiple dependencies are satisfied", () => {
    const dep1 = makeAgent("task-a", "verified");
    const dep2 = makeAgent("task-c", "merged");
    const agent = makeAgent("task-b", "queued", ["task-a", "task-c"]);
    const state = makeWave([dep1, dep2, agent]);
    expect(areAgentDepsReady(state, agent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readyToLaunchAgents
// ---------------------------------------------------------------------------

describe("readyToLaunchAgents", () => {
  test("returns empty array when no agents", () => {
    const state = makeWave([]);
    expect(readyToLaunchAgents(state)).toHaveLength(0);
  });

  test("returns queued agents with no dependencies", () => {
    const agent = makeAgent("task-a");
    const state = makeWave([agent]);
    const ready = readyToLaunchAgents(state);
    expect(ready).toHaveLength(1);
    expect(ready[0].feature_id).toBe("task-a");
  });

  test("excludes running agents", () => {
    const agent = makeAgent("task-a", "running");
    const state = makeWave([agent]);
    expect(readyToLaunchAgents(state)).toHaveLength(0);
  });

  test("excludes completed agents", () => {
    const agent = makeAgent("task-a", "completed");
    const state = makeWave([agent]);
    expect(readyToLaunchAgents(state)).toHaveLength(0);
  });

  test("excludes queued agents with unsatisfied dependencies", () => {
    const dep = makeAgent("task-a", "running");
    const agent = makeAgent("task-b", "queued", ["task-a"]);
    const state = makeWave([dep, agent]);
    expect(readyToLaunchAgents(state)).toHaveLength(0);
  });

  test("includes queued agents with satisfied dependencies", () => {
    const dep = makeAgent("task-a", "verified");
    const agent = makeAgent("task-b", "queued", ["task-a"]);
    const state = makeWave([dep, agent]);
    const ready = readyToLaunchAgents(state);
    expect(ready).toHaveLength(1);
    expect(ready[0].feature_id).toBe("task-b");
  });

  test("returns multiple ready agents", () => {
    const dep = makeAgent("task-a", "verified");
    const b = makeAgent("task-b", "queued", ["task-a"]);
    const c = makeAgent("task-c", "queued");
    const state = makeWave([dep, b, c]);
    const ready = readyToLaunchAgents(state);
    expect(ready).toHaveLength(2);
    const ids = ready.map((a) => a.feature_id).sort();
    expect(ids).toEqual(["task-b", "task-c"]);
  });
});

// ---------------------------------------------------------------------------
// getDownstreamAgents
// ---------------------------------------------------------------------------

describe("getDownstreamAgents", () => {
  test("returns empty array when no downstream", () => {
    const agent = makeAgent("task-a");
    const state = makeWave([agent]);
    expect(getDownstreamAgents(state, "task-a")).toHaveLength(0);
  });

  test("returns direct downstream agents", () => {
    const a = makeAgent("task-a", "running", [], ["task-b"]);
    const b = makeAgent("task-b", "queued", ["task-a"]);
    const state = makeWave([a, b]);
    const downstream = getDownstreamAgents(state, "task-a");
    expect(downstream).toHaveLength(1);
    expect(downstream[0].feature_id).toBe("task-b");
  });

  test("returns transitive downstream agents", () => {
    const a = makeAgent("task-a", "running", [], ["task-b"]);
    const b = makeAgent("task-b", "queued", ["task-a"], ["task-c"]);
    const c = makeAgent("task-c", "queued", ["task-b"]);
    const state = makeWave([a, b, c]);
    const downstream = getDownstreamAgents(state, "task-a");
    expect(downstream).toHaveLength(2);
    const ids = downstream.map((a) => a.feature_id).sort();
    expect(ids).toEqual(["task-b", "task-c"]);
  });

  test("handles diamond dependencies without duplicates", () => {
    // A -> B, A -> C, B -> D, C -> D
    const a = makeAgent("task-a", "running", [], ["task-b", "task-c"]);
    const b = makeAgent("task-b", "queued", ["task-a"], ["task-d"]);
    const c = makeAgent("task-c", "queued", ["task-a"], ["task-d"]);
    const d = makeAgent("task-d", "queued", ["task-b", "task-c"]);
    const state = makeWave([a, b, c, d]);
    const downstream = getDownstreamAgents(state, "task-a");
    // Should include b, c, d but no duplicates
    expect(downstream).toHaveLength(3);
    const ids = downstream.map((a) => a.feature_id).sort();
    expect(ids).toEqual(["task-b", "task-c", "task-d"]);
  });

  test("returns empty for non-existent feature", () => {
    const state = makeWave([makeAgent("task-a")]);
    expect(getDownstreamAgents(state, "non-existent")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cancelDownstream
// ---------------------------------------------------------------------------

describe("cancelDownstream", () => {
  test("cancels queued downstream agents", () => {
    const a = makeAgent("task-a", "failed", [], ["task-b"]);
    const b = makeAgent("task-b", "queued", ["task-a"]);
    const state = makeWave([a, b]);
    const cancelled = cancelDownstream(state, "task-a");
    expect(cancelled).toEqual(["task-b"]);
    expect(b.status).toBe("failed");
    expect(b.error).toContain("task-a");
  });

  test("cancels running downstream agents", () => {
    const a = makeAgent("task-a", "failed", [], ["task-b"]);
    const b = makeAgent("task-b", "running", ["task-a"]);
    const state = makeWave([a, b]);
    const cancelled = cancelDownstream(state, "task-a");
    expect(cancelled).toEqual(["task-b"]);
    expect(b.status).toBe("failed");
  });

  test("does not cancel verified downstream agents", () => {
    const a = makeAgent("task-a", "failed", [], ["task-b"]);
    const b = makeAgent("task-b", "verified", ["task-a"]);
    const state = makeWave([a, b]);
    const cancelled = cancelDownstream(state, "task-a");
    expect(cancelled).toHaveLength(0);
    expect(b.status).toBe("verified");
  });

  test("does not cancel merged downstream agents", () => {
    const a = makeAgent("task-a", "failed", [], ["task-b"]);
    const b = makeAgent("task-b", "merged", ["task-a"]);
    const state = makeWave([a, b]);
    const cancelled = cancelDownstream(state, "task-a");
    expect(cancelled).toHaveLength(0);
    expect(b.status).toBe("merged");
  });

  test("does not cancel already-failed downstream agents", () => {
    const a = makeAgent("task-a", "failed", [], ["task-b"]);
    const b = makeAgent("task-b", "failed", ["task-a"]);
    const state = makeWave([a, b]);
    const cancelled = cancelDownstream(state, "task-a");
    expect(cancelled).toHaveLength(0);
  });

  test("cascades through transitive dependencies", () => {
    const a = makeAgent("task-a", "failed", [], ["task-b"]);
    const b = makeAgent("task-b", "queued", ["task-a"], ["task-c"]);
    const c = makeAgent("task-c", "queued", ["task-b"]);
    const state = makeWave([a, b, c]);
    const cancelled = cancelDownstream(state, "task-a");
    expect(cancelled.sort()).toEqual(["task-b", "task-c"]);
    expect(b.status).toBe("failed");
    expect(c.status).toBe("failed");
  });

  test("sets completed_at on cancelled agents", () => {
    const a = makeAgent("task-a", "failed", [], ["task-b"]);
    const b = makeAgent("task-b", "queued", ["task-a"]);
    const state = makeWave([a, b]);
    cancelDownstream(state, "task-a");
    expect(b.completed_at).not.toBeNull();
  });

  test("returns empty when no downstream exists", () => {
    const a = makeAgent("task-a", "failed");
    const state = makeWave([a]);
    const cancelled = cancelDownstream(state, "task-a");
    expect(cancelled).toHaveLength(0);
  });

  test("cancels installing downstream agents", () => {
    const a = makeAgent("task-a", "failed", [], ["task-b"]);
    const b = makeAgent("task-b", "installing", ["task-a"]);
    const state = makeWave([a, b]);
    const cancelled = cancelDownstream(state, "task-a");
    expect(cancelled).toEqual(["task-b"]);
  });

  test("cancels retry downstream agents", () => {
    const a = makeAgent("task-a", "failed", [], ["task-b"]);
    const b = makeAgent("task-b", "retry", ["task-a"]);
    const state = makeWave([a, b]);
    const cancelled = cancelDownstream(state, "task-a");
    expect(cancelled).toEqual(["task-b"]);
  });

  test("does not cancel completed downstream agents", () => {
    const a = makeAgent("task-a", "failed", [], ["task-b"]);
    const b = makeAgent("task-b", "completed", ["task-a"]);
    const state = makeWave([a, b]);
    const cancelled = cancelDownstream(state, "task-a");
    expect(cancelled).toHaveLength(0);
    expect(b.status).toBe("completed");
  });
});
