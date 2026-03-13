/**
 * verify.ts — Run build verification on completed agents.
 *
 * Usage: woco verify [feature-id] [--browser] [--skip-tests] [--strict-tdd]
 *
 * Runs the build command in each completed agent's worktree. If a specific
 * feature-id is given, verifies only that agent. Otherwise verifies all
 * agents with status "completed".
 *
 * When --browser is passed (or browser.enabled is true in config), also
 * runs browser-based verification after the build passes.
 *
 * When TDD is enabled (tdd.enabled in config), also runs tests and checks
 * for test coverage of new files. Use --skip-tests to skip or --strict-tdd
 * to fail on missing tests.
 */

import type { WomboConfig } from "../config.js";
import { loadFeatures, type Feature } from "../lib/tasks.js";
import { loadState } from "../lib/state.js";
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
  /** Skip running tests during TDD verification */
  skipTests?: boolean;
  /** Strict TDD mode: fail verification if new files are missing tests */
  strictTdd?: boolean;
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

  // Apply TDD overrides from CLI flags
  if (opts.strictTdd !== undefined) {
    config.tdd.strictTdd = opts.strictTdd;
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
    const feature = data.tasks.find((f: Feature) => f.id === agent.feature_id);
    if (!feature) continue;

    await handleBuildVerification(
      projectRoot,
      state,
      agent,
      feature,
      config,
      opts.model,
      undefined, // monitor
      { skipTests: opts.skipTests, strictTdd: opts.strictTdd }
    );
  }

  printDashboard(state);
}
