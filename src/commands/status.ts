/**
 * status.ts — Show the status of the current wave.
 *
 * Usage:
 *   woco status                  # human-readable dashboard
 *   woco status --output json    # structured JSON for programmatic access
 *
 * Loads the wave state, checks for dead processes, and prints a dashboard
 * or emits structured JSON with wave metadata, agent states, timing info,
 * and summary statistics.
 */

import type { WomboConfig } from "../config.js";
import { loadState, saveState, updateAgent, agentCounts, isWaveComplete } from "../lib/state.js";
import type { WaveState, AgentState, AgentStatus } from "../lib/state.js";
import { isProcessRunning } from "../lib/launcher.js";
import { branchHasChanges } from "../lib/worktree.js";
import { printDashboard } from "../lib/ui.js";
import { output, outputMessage, type OutputFormat } from "../lib/output.js";
import { renderStatus } from "../lib/toon.js";

export interface StatusOptions {
  projectRoot: string;
  config: WomboConfig;
  outputFmt?: OutputFormat;
}

// ---------------------------------------------------------------------------
// JSON Output Builder
// ---------------------------------------------------------------------------

/**
 * Compute elapsed time in milliseconds from a start ISO timestamp to now.
 */
function elapsedMs(startedAt: string | null): number | null {
  if (!startedAt) return null;
  return Date.now() - new Date(startedAt).getTime();
}

/**
 * Format milliseconds as a human-readable duration string (e.g. "2h15m", "3m").
 */
function formatElapsed(ms: number | null): string | null {
  if (ms === null) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h${remMins}m`;
}

/**
 * Build the structured JSON representation of an agent's state.
 */
function agentToJson(agent: AgentState): Record<string, unknown> {
  const elapsed = elapsedMs(agent.started_at);
  return {
    feature_id: agent.feature_id,
    branch: agent.branch,
    worktree: agent.worktree,
    status: agent.status,
    pid: agent.pid,
    retries: agent.retries,
    max_retries: agent.max_retries,
    started_at: agent.started_at,
    completed_at: agent.completed_at,
    elapsed_ms: elapsed,
    elapsed_formatted: formatElapsed(elapsed),
    build_passed: agent.build_passed,
    error: agent.error,
    activity: agent.activity,
    activity_updated_at: agent.activity_updated_at,
    effort_estimate_ms: agent.effort_estimate_ms,
  };
}

/**
 * Build the full structured JSON for the wave status.
 * Schema:
 *   {
 *     wave_id: string,
 *     base_branch: string,
 *     started_at: string (ISO 8601),
 *     updated_at: string (ISO 8601),
 *     elapsed_ms: number,
 *     elapsed_formatted: string,
 *     max_concurrent: number,
 *     model: string | null,
 *     interactive: boolean,
 *     is_complete: boolean,
 *     agents: Agent[],
 *     summary: { total, queued, installing, running, completed, verified, failed, merged, retry, resolving_conflict }
 *   }
 */
function buildStatusJson(state: WaveState): Record<string, unknown> {
  const counts = agentCounts(state);
  const waveElapsed = elapsedMs(state.started_at);

  return {
    wave_id: state.wave_id,
    base_branch: state.base_branch,
    started_at: state.started_at,
    updated_at: state.updated_at,
    elapsed_ms: waveElapsed,
    elapsed_formatted: formatElapsed(waveElapsed),
    max_concurrent: state.max_concurrent,
    model: state.model,
    interactive: state.interactive,
    is_complete: isWaveComplete(state),
    agents: state.agents.map(agentToJson),
    summary: {
      total: state.agents.length,
      ...counts,
    },
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdStatus(opts: StatusOptions): Promise<void> {
  const fmt = opts.outputFmt ?? "text";
  const state = loadState(opts.projectRoot);

  if (!state) {
    outputMessage(fmt, "No active wave. Use 'woco launch' to start one.", {
      wave_id: null,
      agents: [],
      summary: { total: 0 },
    });
    return;
  }

  // Update running agent status from process state
  for (const agent of state.agents) {
    if (agent.status === "running" && agent.pid) {
      if (!isProcessRunning(agent.pid)) {
        // Check if the agent actually made any commits before marking completed
        if (branchHasChanges(opts.projectRoot, agent.branch, state.base_branch)) {
          updateAgent(state, agent.feature_id, {
            status: "completed",
            completed_at: new Date().toISOString(),
          });
        } else {
          // Agent died without producing any code — mark as failed, not completed
          updateAgent(state, agent.feature_id, {
            status: "failed",
            error: "Agent process exited without making any commits",
            completed_at: new Date().toISOString(),
          });
        }
      }
    }
  }

  // Repair pass: re-check agents marked "completed" but never verified.
  // Catches agents falsely promoted to completed by older versions of status.ts
  // that didn't check branchHasChanges.
  for (const agent of state.agents) {
    if (agent.status === "completed" && agent.build_passed === null) {
      if (!branchHasChanges(opts.projectRoot, agent.branch, state.base_branch)) {
        updateAgent(state, agent.feature_id, {
          status: "failed",
          error: "Agent process exited without making any commits",
        });
      }
    }
  }
  saveState(opts.projectRoot, state);

  output(fmt, buildStatusJson(state), () => {
    printDashboard(state);
  }, () => {
    // TOON renderer
    console.log(renderStatus(state));
  });
}
