/**
 * history.ts — Wave history persistence.
 *
 * Responsibilities:
 *   - Define the shape of wave history records
 *   - Save wave history to .wombo-history/<wave-id>.json
 *   - Load individual history records
 *   - List all saved history records
 *   - Export wave state to history on completion
 *
 * History records survive `wombo cleanup` because they are stored
 * separately from .wombo-state.json. The .wombo-history/ directory
 * is gitignored.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { resolve, basename } from "node:path";
import type { WaveState, AgentState, AgentStatus } from "./state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentHistoryRecord {
  feature_id: string;
  branch: string;
  status: AgentStatus;
  /** Number of retries attempted */
  retries: number;
  max_retries: number;
  /** Whether the build passed (null if never verified) */
  build_passed: boolean | null;
  /** ISO 8601 timestamp when the agent started */
  started_at: string | null;
  /** ISO 8601 timestamp when the agent finished */
  completed_at: string | null;
  /** Duration in milliseconds (computed from started_at → completed_at) */
  duration_ms: number | null;
  /** Error message if failed */
  error: string | null;
  /** Whether the agent encountered merge conflicts */
  had_merge_conflict: boolean;
  /** Build output summary (only for failed builds) */
  build_output: string | null;
}

export interface WaveHistoryRecord {
  /** Unique wave identifier */
  wave_id: string;
  /** Base branch used for this wave */
  base_branch: string;
  /** ISO 8601 timestamp when the wave started */
  started_at: string;
  /** ISO 8601 timestamp when the history was exported */
  exported_at: string;
  /** Model used (if any) */
  model: string | null;
  /** Max concurrency setting */
  max_concurrent: number;
  /** Whether the wave ran in interactive mode */
  interactive: boolean;
  /** Summary statistics */
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    merged: number;
    verified: number;
    total_retries: number;
    total_duration_ms: number;
  };
  /** Per-agent results */
  agents: AgentHistoryRecord[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_DIR = ".wombo-history";

// ---------------------------------------------------------------------------
// History Directory
// ---------------------------------------------------------------------------

function historyDir(projectRoot: string): string {
  return resolve(projectRoot, HISTORY_DIR);
}

function ensureHistoryDir(projectRoot: string): string {
  const dir = historyDir(projectRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Export Wave State → History Record
// ---------------------------------------------------------------------------

/**
 * Convert a WaveState to a WaveHistoryRecord for persistence.
 */
export function waveStateToHistory(state: WaveState): WaveHistoryRecord {
  const agents: AgentHistoryRecord[] = state.agents.map((agent) => {
    const durationMs = computeDuration(agent.started_at, agent.completed_at);
    const hadConflict =
      agent.status === "resolving_conflict" ||
      (agent.error != null && agent.error.toLowerCase().includes("conflict"));

    return {
      feature_id: agent.feature_id,
      branch: agent.branch,
      status: agent.status,
      retries: agent.retries,
      max_retries: agent.max_retries,
      build_passed: agent.build_passed,
      started_at: agent.started_at,
      completed_at: agent.completed_at,
      duration_ms: durationMs,
      error: agent.error,
      had_merge_conflict: hadConflict,
      build_output: agent.build_passed === false ? agent.build_output : null,
    };
  });

  const succeeded = agents.filter(
    (a) => a.status === "merged" || a.status === "verified"
  ).length;
  const failed = agents.filter((a) => a.status === "failed").length;
  const merged = agents.filter((a) => a.status === "merged").length;
  const verified = agents.filter((a) => a.status === "verified").length;
  const totalRetries = agents.reduce((sum, a) => sum + a.retries, 0);
  const totalDuration = agents.reduce(
    (sum, a) => sum + (a.duration_ms ?? 0),
    0
  );

  return {
    wave_id: state.wave_id,
    base_branch: state.base_branch,
    started_at: state.started_at,
    exported_at: new Date().toISOString(),
    model: state.model,
    max_concurrent: state.max_concurrent,
    interactive: state.interactive,
    summary: {
      total: agents.length,
      succeeded,
      failed,
      merged,
      verified,
      total_retries: totalRetries,
      total_duration_ms: totalDuration,
    },
    agents,
  };
}

// ---------------------------------------------------------------------------
// Save History
// ---------------------------------------------------------------------------

/**
 * Save a wave history record to .wombo-history/<wave-id>.json.
 * Writes atomically (tmp + rename).
 */
export function saveHistory(
  projectRoot: string,
  record: WaveHistoryRecord
): string {
  const dir = ensureHistoryDir(projectRoot);
  const filename = `${record.wave_id}.json`;
  const filePath = resolve(dir, filename);
  const tmpPath = filePath + ".tmp";

  writeFileSync(tmpPath, JSON.stringify(record, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, filePath);

  return filePath;
}

/**
 * Export the current wave state to history. This is the main entry point
 * called when a wave completes.
 *
 * Returns the path to the saved history file.
 */
export function exportWaveHistory(
  projectRoot: string,
  state: WaveState
): string {
  const record = waveStateToHistory(state);
  const filePath = saveHistory(projectRoot, record);
  return filePath;
}

// ---------------------------------------------------------------------------
// Load History
// ---------------------------------------------------------------------------

/**
 * Load a single wave history record by wave ID.
 * Returns null if not found.
 */
export function loadHistory(
  projectRoot: string,
  waveId: string
): WaveHistoryRecord | null {
  const filePath = resolve(historyDir(projectRoot), `${waveId}.json`);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as WaveHistoryRecord;
  } catch {
    return null;
  }
}

/**
 * List all wave history records, sorted by start time (newest first).
 * Returns lightweight summaries without full agent details.
 */
export function listHistory(projectRoot: string): WaveHistoryRecord[] {
  const dir = historyDir(projectRoot);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
    .sort()
    .reverse(); // newest first (wave IDs contain dates)

  const records: WaveHistoryRecord[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(resolve(dir, file), "utf-8");
      const record = JSON.parse(raw) as WaveHistoryRecord;
      records.push(record);
    } catch {
      // Skip corrupt files
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute duration in milliseconds between two ISO timestamps.
 * Returns null if either timestamp is missing.
 */
function computeDuration(
  startedAt: string | null,
  completedAt: string | null
): number | null {
  if (!startedAt || !completedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (isNaN(start) || isNaN(end)) return null;
  return Math.max(0, end - start);
}
