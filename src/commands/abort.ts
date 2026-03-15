/**
 * abort.ts — Kill a single running agent without nuking the entire wave.
 *
 * Usage: woco abort <feature-id> [--requeue] [--output json]
 *
 * Kills the tmux session (if any) and the agent process, then updates
 * wave state to mark the agent as "failed" (default) or "queued"
 * (if --requeue is passed, returning it to the queue for retry).
 */

import type { WomboConfig } from "../config.js";
import {
  loadState,
  saveState,
  updateAgent,
  type AgentState,
} from "../lib/state.js";
import {
  killMuxSession,
  isProcessRunning,
} from "../lib/launcher.js";
import { output, outputError, type OutputFormat } from "../lib/output.js";
import { renderAbort } from "../lib/toon.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AbortCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId: string;
  /** Return the feature to "queued" instead of marking it "failed" */
  requeue?: boolean;
  outputFmt: OutputFormat;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdAbort(opts: AbortCommandOptions): Promise<void> {
  const { projectRoot, config, featureId, outputFmt } = opts;

  // Load wave state
  const state = loadState(projectRoot);
  if (!state) {
    outputError(outputFmt, "No active wave. Nothing to abort.");
    return; // unreachable — helps TypeScript narrow
  }

  // Find the agent
  const agent = state.agents.find((a: AgentState) => a.feature_id === featureId);
  if (!agent) {
    outputError(
      outputFmt,
      `Agent not found for feature: ${featureId}. Use 'woco status' to see active agents.`
    );
    return; // unreachable — helps TypeScript narrow
  }

  // Only abort agents that are actually active (running, installing, queued, resolving_conflict)
  const abortable = new Set(["running", "installing", "queued", "resolving_conflict"]);
  if (!abortable.has(agent.status)) {
    outputError(
      outputFmt,
      `Agent ${featureId} is not in an abortable state (current: ${agent.status}). ` +
        `Only running, installing, queued, or resolving_conflict agents can be aborted.`
    );
    return; // unreachable — helps TypeScript narrow
  }

  // 1. Kill the tmux session (if any)
  let muxKilled = false;
  try {
    killMuxSession(featureId, config);
    muxKilled = true;
  } catch {
    // Session may not exist — that's fine
  }

  // 2. Kill the process by PID (if any and still running)
  let processKilled = false;
  if (agent.pid && isProcessRunning(agent.pid)) {
    try {
      process.kill(agent.pid, "SIGTERM");
      processKilled = true;
    } catch {
      // Process may have already exited
    }
  }

  // 3. Update wave state
  const newStatus = opts.requeue ? "queued" : "failed";
  const updates: Partial<AgentState> = {
    status: newStatus as AgentState["status"],
    error: opts.requeue ? null : "Aborted by user",
    completed_at: opts.requeue ? null : new Date().toISOString(),
  };

  // If requeuing, reset retry-related fields so the agent gets a fresh start
  if (opts.requeue) {
    updates.retries = 0;
    updates.build_passed = null;
    updates.build_output = null;
    updates.started_at = null;
    updates.completed_at = null;
    updates.activity = null;
    updates.activity_updated_at = null;
  }

  updateAgent(state, featureId, updates);
  saveState(projectRoot, state);

  // 4. Output result
  const result = {
    feature_id: featureId,
    previous_status: agent.status,
    new_status: newStatus,
    mux_killed: muxKilled,
    process_killed: processKilled,
    requeued: !!opts.requeue,
  };

  output(outputFmt, result, () => {
    console.log(`\nAborted agent: ${featureId}`);
    console.log(`  Previous status: ${agent.status}`);
    console.log(`  New status: ${newStatus}`);
    if (muxKilled) console.log(`  Killed tmux session: ${config.agent.tmuxPrefix}-${featureId}`);
    if (processKilled) console.log(`  Killed process: PID ${agent.pid}`);
    if (opts.requeue) {
      console.log(`  Feature returned to queue for retry.`);
    } else {
      console.log(`  Feature marked as failed.`);
    }
  }, () => {
    console.log(renderAbort(result));
  });
}
