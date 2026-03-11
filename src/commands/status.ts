/**
 * status.ts — Show the status of the current wave.
 *
 * Usage: wombo status
 *
 * Loads the wave state, checks for dead processes, and prints a dashboard.
 */

import type { WomboConfig } from "../config.js";
import { loadState, saveState, updateAgent } from "../lib/state.js";
import { isProcessRunning } from "../lib/launcher.js";
import { printDashboard } from "../lib/ui.js";

export interface StatusOptions {
  projectRoot: string;
  config: WomboConfig;
}

export async function cmdStatus(opts: StatusOptions): Promise<void> {
  const state = loadState(opts.projectRoot);
  if (!state) {
    console.log("No active wave. Use 'wombo launch' to start one.");
    return;
  }

  // Update running agent status from process state
  for (const agent of state.agents) {
    if (agent.status === "running" && agent.pid) {
      if (!isProcessRunning(agent.pid)) {
        updateAgent(state, agent.feature_id, {
          status: "completed",
          completed_at: new Date().toISOString(),
        });
      }
    }
  }
  saveState(opts.projectRoot, state);

  printDashboard(state);
}
