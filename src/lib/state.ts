/**
 * state.ts — Persistent wave state management.
 *
 * Responsibilities:
 *   - Define the shape of .wombo-combo/state.json
 *   - Read/write state atomically
 *   - Generate wave IDs
 *   - Update individual agent state within a wave
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { WOMBO_DIR } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentStatus =
  | "queued"
  | "installing"
  | "running"
  | "completed"
  | "verified"
  | "failed"
  | "merged"
  | "retry"
  | "resolving_conflict";

export interface AgentState {
  feature_id: string;
  branch: string;
  worktree: string;
  session_id: string | null;
  pid: number | null;
  status: AgentStatus;
  activity: string | null;
  activity_updated_at: string | null;
  retries: number;
  max_retries: number;
  started_at: string | null;
  completed_at: string | null;
  build_passed: boolean | null;
  build_output: string | null;
  error: string | null;
  /** Estimated effort in milliseconds (from feature's ISO 8601 duration) */
  effort_estimate_ms: number | null;
  /** Stream index this agent belongs to (for dependency-aware scheduling) */
  stream_index: number | null;
  /** IDs of features this agent depends on (within the current wave) */
  depends_on: string[];
  /** IDs of features that depend on this agent (within the current wave) */
  depended_on_by: string[];
  /**
   * Override agent name for this specific agent (from registry).
   * When set, uses this agent definition instead of the default generalist.
   * e.g. "engineering-frontend-developer"
   */
  agent_name: string | null;
  /**
   * The agent_type from the task (e.g. "engineering/engineering-frontend-developer").
   * Stored for informational purposes and to support resume with re-fetch.
   */
  agent_type: string | null;
}

export interface WaveState {
  wave_id: string;
  base_branch: string;
  started_at: string;
  updated_at: string;
  max_concurrent: number;
  model: string | null;
  interactive: boolean;
  agents: AgentState[];
  /** Dependency-aware scheduling plan (null if no dependencies exist) */
  schedule_plan: SerializedSchedulePlan | null;
  /** Quest ID this wave belongs to (null if not quest-scoped) */
  quest_id: string | null;
}

/**
 * Serialized schedule plan stored in wave state JSON.
 * Uses plain arrays instead of the rich SchedulePlan type for JSON compatibility.
 */
export interface SerializedSchedulePlan {
  /** Streams: each is a list of feature IDs to execute sequentially */
  streams: string[][];
  /** Merge gates: features that must wait for multiple deps from different streams */
  merge_gates: Array<{ feature_id: string; wait_for: string[] }>;
  /** Topological order of all features */
  topological_order: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILE = ".wombo-combo/state.json";

// ---------------------------------------------------------------------------
// Wave ID Generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique wave ID based on current timestamp.
 * Format: wave-YYYY-MM-DD-NNN
 */
export function generateWaveId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const seq = String(now.getHours() * 60 + now.getMinutes()).padStart(3, "0");
  return `wave-${date}-${seq}`;
}

// ---------------------------------------------------------------------------
// State Path
// ---------------------------------------------------------------------------

function statePath(projectRoot: string): string {
  return resolve(projectRoot, STATE_FILE);
}

// ---------------------------------------------------------------------------
// Read State
// ---------------------------------------------------------------------------

/**
 * Load the current wave state from disk. Returns null if no state file exists.
 */
export function loadState(projectRoot: string): WaveState | null {
  const p = statePath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as WaveState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write State
// ---------------------------------------------------------------------------

/**
 * Save wave state to disk atomically (write to tmp then rename).
 */
export function saveState(projectRoot: string, state: WaveState): void {
  const dir = resolve(projectRoot, WOMBO_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  state.updated_at = new Date().toISOString();
  const p = statePath(projectRoot);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
}

/**
 * Flush wave state to disk with integrity verification.
 *
 * Like saveState(), but reads back the written file and verifies it parses
 * as valid JSON. This is the "safe shutdown" variant — use it before
 * process.exit() or screen.destroy() to guarantee the state file is not
 * left in a partial/corrupt state.
 *
 * If the integrity check fails, a second write attempt is made. If that
 * also fails, the error is logged but not thrown (we're shutting down).
 *
 * @returns true if the state was written and verified successfully.
 */
export function flushState(projectRoot: string, state: WaveState): boolean {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      saveState(projectRoot, state);

      // Read back and verify JSON integrity
      const p = statePath(projectRoot);
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as WaveState;

      // Sanity check: wave_id and agents array must survive the round-trip
      if (parsed.wave_id !== state.wave_id) {
        throw new Error(
          `wave_id mismatch after write: expected "${state.wave_id}", got "${parsed.wave_id}"`
        );
      }
      if (!Array.isArray(parsed.agents) || parsed.agents.length !== state.agents.length) {
        throw new Error(
          `agents array mismatch after write: expected ${state.agents.length} agents, got ${Array.isArray(parsed.agents) ? parsed.agents.length : "non-array"}`
        );
      }

      return true;
    } catch (err: any) {
      if (attempt === 1) {
        // First failure — retry once
        try {
          // Log to stderr so it doesn't corrupt TUI output
          process.stderr.write(
            `[wombo] state flush attempt ${attempt} failed: ${err.message} — retrying...\n`
          );
        } catch {
          // stderr may be closed during shutdown
        }
      } else {
        // Second failure — give up but don't throw (we're shutting down)
        try {
          process.stderr.write(
            `[wombo] state flush failed after 2 attempts: ${err.message}\n`
          );
        } catch {
          // stderr may be closed during shutdown
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// State Mutations
// ---------------------------------------------------------------------------

/**
 * Create a fresh wave state.
 */
export function createWaveState(opts: {
  baseBranch: string;
  maxConcurrent: number;
  model: string | null;
  interactive: boolean;
  questId?: string | null;
}): WaveState {
  return {
    wave_id: generateWaveId(),
    base_branch: opts.baseBranch,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    max_concurrent: opts.maxConcurrent,
    model: opts.model,
    interactive: opts.interactive,
    agents: [],
    schedule_plan: null,
    quest_id: opts.questId ?? null,
  };
}

/**
 * Create an initial agent state for a feature.
 */
export function createAgentState(
  featureId: string,
  branch: string,
  worktreePath: string,
  maxRetries: number = 2
): AgentState {
  return {
    feature_id: featureId,
    branch,
    worktree: worktreePath,
    session_id: null,
    pid: null,
    status: "queued",
    activity: null,
    activity_updated_at: null,
    retries: 0,
    max_retries: maxRetries,
    started_at: null,
    completed_at: null,
    build_passed: null,
    build_output: null,
    error: null,
    effort_estimate_ms: null,
    stream_index: null,
    depends_on: [],
    depended_on_by: [],
    agent_name: null,
    agent_type: null,
  };
}

/**
 * Find an agent state by feature ID.
 */
export function getAgent(
  state: WaveState,
  featureId: string
): AgentState | undefined {
  return state.agents.find((a) => a.feature_id === featureId);
}

/**
 * Update an agent's state fields.
 */
export function updateAgent(
  state: WaveState,
  featureId: string,
  updates: Partial<AgentState>
): void {
  const agent = state.agents.find((a) => a.feature_id === featureId);
  if (!agent) throw new Error(`Agent not found for feature: ${featureId}`);
  Object.assign(agent, updates);
}

/**
 * Get counts of agents by status.
 */
export function agentCounts(state: WaveState): Record<AgentStatus, number> {
  const counts: Record<AgentStatus, number> = {
    queued: 0,
    installing: 0,
    running: 0,
    completed: 0,
    verified: 0,
    failed: 0,
    merged: 0,
    retry: 0,
    resolving_conflict: 0,
  };
  for (const a of state.agents) {
    counts[a.status]++;
  }
  return counts;
}

/**
 * Get agents that are currently running or installing.
 */
export function activeAgents(state: WaveState): AgentState[] {
  return state.agents.filter(
    (a) => a.status === "running" || a.status === "installing" || a.status === "resolving_conflict"
  );
}

/**
 * Get agents that are queued and ready to be launched.
 */
export function queuedAgents(state: WaveState): AgentState[] {
  return state.agents.filter((a) => a.status === "queued");
}

/**
 * Check if the wave is fully complete (no queued, installing, running, or retry agents).
 */
export function isWaveComplete(state: WaveState): boolean {
  return state.agents.every(
    (a) =>
      a.status === "completed" ||
      a.status === "verified" ||
      a.status === "failed" ||
      a.status === "merged"
  );
}

// ---------------------------------------------------------------------------
// Dependency-Aware Helpers
// ---------------------------------------------------------------------------

/**
 * Terminal statuses that count as "dependency satisfied" for downstream features.
 * A dependency is satisfied when it has been verified or merged.
 */
const DEP_SATISFIED_STATUSES: Set<AgentStatus> = new Set(["verified", "merged"]);

/**
 * Check if an agent's dependencies within the wave are all satisfied.
 * Dependencies are satisfied when their agents reach "verified" or "merged" status.
 *
 * If the agent has no depends_on entries, it's always ready.
 */
export function areAgentDepsReady(
  state: WaveState,
  agent: AgentState
): boolean {
  if (agent.depends_on.length === 0) return true;

  for (const depId of agent.depends_on) {
    const depAgent = state.agents.find((a) => a.feature_id === depId);
    if (depAgent && !DEP_SATISFIED_STATUSES.has(depAgent.status)) {
      return false;
    }
    // If depAgent doesn't exist in this wave, the dep is external — assumed satisfied
  }
  return true;
}

/**
 * Get queued agents whose dependencies are all satisfied.
 * This is the dependency-aware replacement for plain queuedAgents().
 */
export function readyToLaunchAgents(state: WaveState): AgentState[] {
  return state.agents.filter(
    (a) => a.status === "queued" && areAgentDepsReady(state, a)
  );
}

/**
 * Get all agents that are downstream (depend on) a given feature, directly or transitively.
 * Used for failure cascading — when a feature fails, cancel all downstream.
 */
export function getDownstreamAgents(
  state: WaveState,
  featureId: string
): AgentState[] {
  const visited = new Set<string>();
  const result: AgentState[] = [];

  function collect(id: string): void {
    const agent = state.agents.find((a) => a.feature_id === id);
    if (!agent) return;

    for (const downstreamId of agent.depended_on_by) {
      if (visited.has(downstreamId)) continue;
      visited.add(downstreamId);

      const downstream = state.agents.find((a) => a.feature_id === downstreamId);
      if (downstream) {
        result.push(downstream);
        collect(downstreamId);
      }
    }
  }

  collect(featureId);
  return result;
}

/**
 * Cancel all downstream agents when an upstream dependency fails.
 * Sets status to "failed" with an error explaining the dependency failure.
 * Returns the list of cancelled agent IDs.
 */
export function cancelDownstream(
  state: WaveState,
  failedFeatureId: string
): string[] {
  const downstream = getDownstreamAgents(state, failedFeatureId);
  const cancelled: string[] = [];

  for (const agent of downstream) {
    // Only cancel agents that haven't already reached a terminal state
    if (
      agent.status === "queued" ||
      agent.status === "installing" ||
      agent.status === "running" ||
      agent.status === "retry"
    ) {
      updateAgent(state, agent.feature_id, {
        status: "failed",
        error: `Dependency "${failedFeatureId}" failed — downstream cancelled`,
        activity: null,
        completed_at: new Date().toISOString(),
      });
      cancelled.push(agent.feature_id);
    }
  }

  return cancelled;
}
