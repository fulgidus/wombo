/**
 * verify.ts — Run build verification on completed agents.
 *
 * Usage: wombo verify [feature-id] [--browser]
 *
 * Runs the build command in each completed agent's worktree. If a specific
 * feature-id is given, verifies only that agent. Otherwise verifies all
 * agents with status "completed".
 *
 * When --browser is passed (or browser.enabled is true in config), also
 * runs browser-based verification after the build passes.
 */

import type { WomboConfig } from "../config.js";
import { loadFeatures } from "../lib/features.js";
import { loadState, saveState } from "../lib/state.js";
import { printDashboard } from "../lib/ui.js";
import { handleBuildVerification } from "./launch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifyCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId?: string;
  model?: string;
  maxRetries?: number;
  /** Enable browser verification (overrides config.browser.enabled) */
  browserVerify?: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdVerify(opts: VerifyCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;

  // Apply browser verification override if --browser flag was passed
  if (opts.browserVerify !== undefined) {
    config.browser.enabled = opts.browserVerify;
  }

  const state = loadState(projectRoot);
  if (!state) {
    console.log("No active wave.");
    return;
  }

  const toVerify = opts.featureId
    ? state.agents.filter((a) => a.feature_id === opts.featureId)
    : state.agents.filter((a) => a.status === "completed");

  if (toVerify.length === 0) {
    console.log("No agents to verify.");
    return;
  }

  console.log(`\nVerifying ${toVerify.length} agent(s)...\n`);

  const data = loadFeatures(projectRoot, config);

  for (const agent of toVerify) {
    const feature = data.features.find((f) => f.id === agent.feature_id);
    if (!feature) continue;

    await handleBuildVerification(projectRoot, state, agent, feature, config, opts.model);
  }

  printDashboard(state);
}
