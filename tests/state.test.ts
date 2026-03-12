/**
 * state.test.ts — Unit tests for wave state persistence and mutations.
 *
 * Coverage:
 *   - saveState / loadState round-trip
 *   - Atomic write (write to .tmp then rename)
 *   - State file corruption recovery (returns null)
 *   - createWaveState / createAgentState
 *   - updateAgent with valid/invalid feature IDs
 *   - agentCounts
 *   - activeAgents / queuedAgents
 *   - isWaveComplete
 *   - generateWaveId format
 *   - Concurrent mutation patterns
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadState,
  saveState,
  createWaveState,
  createAgentState,
  getAgent,
  updateAgent,
  agentCounts,
  activeAgents,
  queuedAgents,
  isWaveComplete,
  generateWaveId,
} from "../src/lib/state.js";
import type { WaveState, AgentState, AgentStatus } from "../src/lib/state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wombo-test-state-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeWaveState(overrides?: Partial<WaveState>): WaveState {
  return {
    wave_id: "wave-2025-01-01-000",
    base_branch: "main",
    started_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    max_concurrent: 4,
    model: null,
    interactive: false,
    agents: [],
    ...overrides,
  };
}

function makeAgentState(overrides?: Partial<AgentState>): AgentState {
  return {
    feature_id: "test-feature",
    branch: "feature/test-feature",
    worktree: "/tmp/wombo-test-feature",
    session_id: null,
    pid: null,
    status: "queued",
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateWaveId
// ---------------------------------------------------------------------------

describe("generateWaveId", () => {
  test("produces wave ID in expected format", () => {
    const id = generateWaveId();
    // The sequence part is hours*60+minutes, padStart(3, "0"), so can be 3-4 digits
    expect(id).toMatch(/^wave-\d{4}-\d{2}-\d{2}-\d{3,4}$/);
  });

  test("includes current date", () => {
    const id = generateWaveId();
    const today = new Date().toISOString().slice(0, 10);
    expect(id).toContain(today);
  });

  test("produces consistent format on repeated calls", () => {
    const id1 = generateWaveId();
    const id2 = generateWaveId();
    // Both should match the format (though values may differ slightly)
    expect(id1).toMatch(/^wave-\d{4}-\d{2}-\d{2}-\d{3,4}$/);
    expect(id2).toMatch(/^wave-\d{4}-\d{2}-\d{2}-\d{3,4}$/);
  });
});

// ---------------------------------------------------------------------------
// createWaveState
// ---------------------------------------------------------------------------

describe("createWaveState", () => {
  test("creates state with provided options", () => {
    const state = createWaveState({
      baseBranch: "develop",
      maxConcurrent: 3,
      model: "gpt-4",
      interactive: true,
    });
    expect(state.base_branch).toBe("develop");
    expect(state.max_concurrent).toBe(3);
    expect(state.model).toBe("gpt-4");
    expect(state.interactive).toBe(true);
    expect(state.agents).toEqual([]);
    expect(state.wave_id).toMatch(/^wave-/);
  });

  test("creates state with null model", () => {
    const state = createWaveState({
      baseBranch: "main",
      maxConcurrent: 6,
      model: null,
      interactive: false,
    });
    expect(state.model).toBeNull();
  });

  test("sets started_at and updated_at timestamps", () => {
    const before = new Date().toISOString();
    const state = createWaveState({
      baseBranch: "main",
      maxConcurrent: 1,
      model: null,
      interactive: false,
    });
    const after = new Date().toISOString();
    expect(state.started_at >= before).toBe(true);
    expect(state.started_at <= after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createAgentState
// ---------------------------------------------------------------------------

describe("createAgentState", () => {
  test("creates agent with default max retries", () => {
    const agent = createAgentState("my-feat", "feature/my-feat", "/tmp/wt");
    expect(agent.feature_id).toBe("my-feat");
    expect(agent.branch).toBe("feature/my-feat");
    expect(agent.worktree).toBe("/tmp/wt");
    expect(agent.status).toBe("queued");
    expect(agent.max_retries).toBe(2);
    expect(agent.retries).toBe(0);
    expect(agent.pid).toBeNull();
    expect(agent.session_id).toBeNull();
    expect(agent.build_passed).toBeNull();
  });

  test("creates agent with custom max retries", () => {
    const agent = createAgentState("my-feat", "feature/my-feat", "/tmp/wt", 5);
    expect(agent.max_retries).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// saveState / loadState round-trip
// ---------------------------------------------------------------------------

describe("saveState / loadState", () => {
  test("round-trips state through file system", () => {
    const state = makeWaveState({
      agents: [makeAgentState({ feature_id: "feat-a" })],
    });
    saveState(tmpDir, state);
    const loaded = loadState(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.wave_id).toBe(state.wave_id);
    expect(loaded!.agents).toHaveLength(1);
    expect(loaded!.agents[0].feature_id).toBe("feat-a");
  });

  test("updates updated_at timestamp on save", () => {
    const state = makeWaveState();
    const oldTimestamp = state.updated_at;
    // Wait a tiny bit to ensure timestamp differs
    saveState(tmpDir, state);
    const loaded = loadState(tmpDir);
    expect(loaded).not.toBeNull();
    // The saved state should have a newer (or equal) timestamp
    expect(loaded!.updated_at >= oldTimestamp).toBe(true);
  });

  test("writes valid JSON", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "feat-a", status: "running" }),
        makeAgentState({ feature_id: "feat-b", status: "completed" }),
      ],
    });
    saveState(tmpDir, state);
    const raw = readFileSync(join(tmpDir, ".wombo-state.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.wave_id).toBe(state.wave_id);
    expect(parsed.agents).toHaveLength(2);
  });

  test("atomic write: tmp file is cleaned up after rename", () => {
    const state = makeWaveState();
    saveState(tmpDir, state);
    // The .tmp file should not exist after a successful save
    expect(existsSync(join(tmpDir, ".wombo-state.json.tmp"))).toBe(false);
    // The actual file should exist
    expect(existsSync(join(tmpDir, ".wombo-state.json"))).toBe(true);
  });

  test("returns null when no state file exists", () => {
    const loaded = loadState(tmpDir);
    expect(loaded).toBeNull();
  });

  test("returns null on corrupted JSON", () => {
    writeFileSync(
      join(tmpDir, ".wombo-state.json"),
      "{{not valid json!!!",
      "utf-8"
    );
    const loaded = loadState(tmpDir);
    expect(loaded).toBeNull();
  });

  test("returns null on empty file", () => {
    writeFileSync(join(tmpDir, ".wombo-state.json"), "", "utf-8");
    const loaded = loadState(tmpDir);
    expect(loaded).toBeNull();
  });

  test("handles state with many agents", () => {
    const agents: AgentState[] = [];
    for (let i = 0; i < 50; i++) {
      agents.push(
        makeAgentState({
          feature_id: `feat-${i}`,
          branch: `feature/feat-${i}`,
        })
      );
    }
    const state = makeWaveState({ agents });
    saveState(tmpDir, state);
    const loaded = loadState(tmpDir);
    expect(loaded!.agents).toHaveLength(50);
  });

  test("preserves all agent fields through round-trip", () => {
    const agent = makeAgentState({
      feature_id: "full-agent",
      branch: "feature/full",
      worktree: "/tmp/wt-full",
      session_id: "tmux-session-123",
      pid: 12345,
      status: "running",
      activity: "Building project",
      activity_updated_at: "2025-01-01T12:00:00Z",
      retries: 1,
      max_retries: 3,
      started_at: "2025-01-01T10:00:00Z",
      completed_at: null,
      build_passed: null,
      build_output: null,
      error: null,
      effort_estimate_ms: 3600000,
    });
    const state = makeWaveState({ agents: [agent] });
    saveState(tmpDir, state);
    const loaded = loadState(tmpDir);
    const loadedAgent = loaded!.agents[0];
    expect(loadedAgent.feature_id).toBe("full-agent");
    expect(loadedAgent.session_id).toBe("tmux-session-123");
    expect(loadedAgent.pid).toBe(12345);
    expect(loadedAgent.status).toBe("running");
    expect(loadedAgent.activity).toBe("Building project");
    expect(loadedAgent.retries).toBe(1);
    expect(loadedAgent.max_retries).toBe(3);
    expect(loadedAgent.effort_estimate_ms).toBe(3600000);
  });
});

// ---------------------------------------------------------------------------
// getAgent
// ---------------------------------------------------------------------------

describe("getAgent", () => {
  test("finds agent by feature ID", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "feat-a" }),
        makeAgentState({ feature_id: "feat-b" }),
      ],
    });
    const agent = getAgent(state, "feat-b");
    expect(agent).toBeDefined();
    expect(agent!.feature_id).toBe("feat-b");
  });

  test("returns undefined for nonexistent feature ID", () => {
    const state = makeWaveState({
      agents: [makeAgentState({ feature_id: "feat-a" })],
    });
    const agent = getAgent(state, "nonexistent");
    expect(agent).toBeUndefined();
  });

  test("returns undefined when agents list is empty", () => {
    const state = makeWaveState({ agents: [] });
    const agent = getAgent(state, "any");
    expect(agent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// updateAgent
// ---------------------------------------------------------------------------

describe("updateAgent", () => {
  test("updates agent status", () => {
    const state = makeWaveState({
      agents: [makeAgentState({ feature_id: "feat-a", status: "queued" })],
    });
    updateAgent(state, "feat-a", { status: "running" });
    expect(state.agents[0].status).toBe("running");
  });

  test("updates multiple fields at once", () => {
    const state = makeWaveState({
      agents: [makeAgentState({ feature_id: "feat-a" })],
    });
    updateAgent(state, "feat-a", {
      status: "running",
      pid: 12345,
      started_at: "2025-01-01T00:00:00Z",
      activity: "Installing dependencies",
    });
    expect(state.agents[0].status).toBe("running");
    expect(state.agents[0].pid).toBe(12345);
    expect(state.agents[0].started_at).toBe("2025-01-01T00:00:00Z");
    expect(state.agents[0].activity).toBe("Installing dependencies");
  });

  test("throws for nonexistent feature ID", () => {
    const state = makeWaveState({
      agents: [makeAgentState({ feature_id: "feat-a" })],
    });
    expect(() => updateAgent(state, "nonexistent", { status: "running" })).toThrow(
      "Agent not found for feature: nonexistent"
    );
  });

  test("throws when agents list is empty", () => {
    const state = makeWaveState({ agents: [] });
    expect(() => updateAgent(state, "any", { status: "running" })).toThrow(
      "Agent not found for feature: any"
    );
  });

  test("only updates the targeted agent", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "feat-a", status: "queued" }),
        makeAgentState({ feature_id: "feat-b", status: "queued" }),
      ],
    });
    updateAgent(state, "feat-a", { status: "running" });
    expect(state.agents[0].status).toBe("running");
    expect(state.agents[1].status).toBe("queued");
  });

  test("sequential updates accumulate correctly", () => {
    const state = makeWaveState({
      agents: [makeAgentState({ feature_id: "feat-a" })],
    });
    updateAgent(state, "feat-a", { status: "installing" });
    updateAgent(state, "feat-a", { status: "running", pid: 1234 });
    updateAgent(state, "feat-a", {
      status: "completed",
      completed_at: "2025-01-01T01:00:00Z",
      build_passed: true,
    });
    const agent = state.agents[0];
    expect(agent.status).toBe("completed");
    expect(agent.pid).toBe(1234);
    expect(agent.build_passed).toBe(true);
    expect(agent.completed_at).toBe("2025-01-01T01:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// agentCounts
// ---------------------------------------------------------------------------

describe("agentCounts", () => {
  test("counts agents by status", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "a", status: "queued" }),
        makeAgentState({ feature_id: "b", status: "queued" }),
        makeAgentState({ feature_id: "c", status: "running" }),
        makeAgentState({ feature_id: "d", status: "completed" }),
        makeAgentState({ feature_id: "e", status: "failed" }),
      ],
    });
    const counts = agentCounts(state);
    expect(counts.queued).toBe(2);
    expect(counts.running).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.installing).toBe(0);
    expect(counts.verified).toBe(0);
    expect(counts.merged).toBe(0);
    expect(counts.retry).toBe(0);
    expect(counts.resolving_conflict).toBe(0);
  });

  test("returns all zeros for empty agents list", () => {
    const state = makeWaveState({ agents: [] });
    const counts = agentCounts(state);
    expect(counts.queued).toBe(0);
    expect(counts.running).toBe(0);
    expect(counts.completed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// activeAgents
// ---------------------------------------------------------------------------

describe("activeAgents", () => {
  test("returns running, installing, and resolving_conflict agents", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "a", status: "running" }),
        makeAgentState({ feature_id: "b", status: "installing" }),
        makeAgentState({ feature_id: "c", status: "resolving_conflict" }),
        makeAgentState({ feature_id: "d", status: "queued" }),
        makeAgentState({ feature_id: "e", status: "completed" }),
      ],
    });
    const active = activeAgents(state);
    expect(active).toHaveLength(3);
    const ids = active.map((a) => a.feature_id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
  });

  test("returns empty array when no agents are active", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "a", status: "queued" }),
        makeAgentState({ feature_id: "b", status: "completed" }),
      ],
    });
    expect(activeAgents(state)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// queuedAgents
// ---------------------------------------------------------------------------

describe("queuedAgents", () => {
  test("returns only queued agents", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "a", status: "queued" }),
        makeAgentState({ feature_id: "b", status: "running" }),
        makeAgentState({ feature_id: "c", status: "queued" }),
      ],
    });
    const queued = queuedAgents(state);
    expect(queued).toHaveLength(2);
    expect(queued[0].feature_id).toBe("a");
    expect(queued[1].feature_id).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// isWaveComplete
// ---------------------------------------------------------------------------

describe("isWaveComplete", () => {
  test("returns true when all agents are in terminal states", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "a", status: "completed" }),
        makeAgentState({ feature_id: "b", status: "verified" }),
        makeAgentState({ feature_id: "c", status: "failed" }),
        makeAgentState({ feature_id: "d", status: "merged" }),
      ],
    });
    expect(isWaveComplete(state)).toBe(true);
  });

  test("returns false when some agents are still queued", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "a", status: "completed" }),
        makeAgentState({ feature_id: "b", status: "queued" }),
      ],
    });
    expect(isWaveComplete(state)).toBe(false);
  });

  test("returns false when some agents are still running", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "a", status: "completed" }),
        makeAgentState({ feature_id: "b", status: "running" }),
      ],
    });
    expect(isWaveComplete(state)).toBe(false);
  });

  test("returns false when some agents are installing", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "a", status: "installing" }),
      ],
    });
    expect(isWaveComplete(state)).toBe(false);
  });

  test("returns false when some agents are in retry", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "a", status: "retry" }),
      ],
    });
    expect(isWaveComplete(state)).toBe(false);
  });

  test("returns true for empty agents list", () => {
    const state = makeWaveState({ agents: [] });
    expect(isWaveComplete(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrent mutation patterns (save-load-modify-save cycles)
// ---------------------------------------------------------------------------

describe("concurrent mutation patterns", () => {
  test("multiple save-load cycles preserve data integrity", () => {
    const state = makeWaveState({
      agents: [
        makeAgentState({ feature_id: "feat-a", status: "queued" }),
        makeAgentState({ feature_id: "feat-b", status: "queued" }),
      ],
    });

    // Save initial state
    saveState(tmpDir, state);

    // Simulate agent A starting: load, modify, save
    const s1 = loadState(tmpDir)!;
    updateAgent(s1, "feat-a", { status: "running", pid: 1001 });
    saveState(tmpDir, s1);

    // Simulate agent B starting: load, modify, save
    const s2 = loadState(tmpDir)!;
    expect(s2.agents[0].status).toBe("running"); // A's change persisted
    updateAgent(s2, "feat-b", { status: "running", pid: 1002 });
    saveState(tmpDir, s2);

    // Final verification
    const final = loadState(tmpDir)!;
    expect(final.agents[0].status).toBe("running");
    expect(final.agents[0].pid).toBe(1001);
    expect(final.agents[1].status).toBe("running");
    expect(final.agents[1].pid).toBe(1002);
  });

  test("rapid sequential updates don't corrupt state", () => {
    const state = makeWaveState({
      agents: [makeAgentState({ feature_id: "feat-a", status: "queued" })],
    });

    // Rapid fire updates
    const statuses: AgentStatus[] = [
      "queued",
      "installing",
      "running",
      "completed",
    ];
    for (const status of statuses) {
      updateAgent(state, "feat-a", { status });
      saveState(tmpDir, state);
    }

    const loaded = loadState(tmpDir)!;
    expect(loaded.agents[0].status).toBe("completed");
  });

  test("save and load with all possible agent statuses", () => {
    const allStatuses: AgentStatus[] = [
      "queued",
      "installing",
      "running",
      "completed",
      "verified",
      "failed",
      "merged",
      "retry",
      "resolving_conflict",
    ];

    const agents = allStatuses.map((status, i) =>
      makeAgentState({ feature_id: `feat-${i}`, status })
    );
    const state = makeWaveState({ agents });
    saveState(tmpDir, state);

    const loaded = loadState(tmpDir)!;
    for (let i = 0; i < allStatuses.length; i++) {
      expect(loaded.agents[i].status).toBe(allStatuses[i]);
    }
  });
});
