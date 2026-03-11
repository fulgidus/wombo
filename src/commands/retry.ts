/**
 * retry.ts — Retry a specific failed agent.
 *
 * Usage: wombo retry <feature-id> [--interactive] [--model <model>]
 *
 * Resets the agent's retry count and re-launches it. Can launch in either
 * headless mode (default) or interactive (tmux) mode.
 */

import type { WomboConfig } from "../config.js";
import { loadFeatures, type Feature } from "../lib/features.js";
import {
  loadState,
  saveState,
  updateAgent,
} from "../lib/state.js";
import { worktreeReady } from "../lib/worktree.js";
import { generatePrompt } from "../lib/prompt.js";
import { launchInteractive } from "../lib/launcher.js";
import { ProcessMonitor } from "../lib/monitor.js";
import { launchSingleHeadless } from "./launch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId: string;
  model?: string;
  interactive: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdRetry(opts: RetryCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;

  if (!opts.featureId) {
    console.error("Usage: wombo retry <feature-id>");
    process.exit(1);
    return; // unreachable — helps TypeScript narrow
  }

  const state = loadState(projectRoot);
  if (!state) {
    console.log("No active wave.");
    return;
  }

  const agent = state.agents.find((a) => a.feature_id === opts.featureId);
  if (!agent) {
    console.error(`Agent not found for feature: ${opts.featureId}`);
    process.exit(1);
    return; // unreachable — helps TypeScript narrow
  }

  if (agent.status !== "failed") {
    console.error(
      `Agent ${opts.featureId} is not in failed state (current: ${agent.status})`
    );
    process.exit(1);
    return; // unreachable — helps TypeScript narrow
  }

  // Reset retry count and re-run
  updateAgent(state, agent.feature_id, {
    status: "queued",
    retries: 0,
    error: null,
    build_passed: null,
    build_output: null,
    completed_at: null,
  });
  saveState(projectRoot, state);

  const data = loadFeatures(projectRoot, config);
  const feature = data.features.find((f) => f.id === opts.featureId);
  if (!feature) {
    console.error(`Feature ${opts.featureId} not found in ${config.featuresFile}`);
    process.exit(1);
    return; // unreachable — helps TypeScript narrow
  }

  if (opts.interactive) {
    const prompt = generatePrompt(feature, state.base_branch, config);
    launchInteractive({
      worktreePath: agent.worktree,
      featureId: feature.id,
      prompt,
      model: opts.model,
      interactive: true,
      config,
    });

    updateAgent(state, agent.feature_id, {
      status: "running",
      started_at: new Date().toISOString(),
    });
    saveState(projectRoot, state);
    console.log(`Retrying ${opts.featureId} in tmux session ${config.agent.tmuxPrefix}-${opts.featureId}`);
  } else {
    const monitor = new ProcessMonitor(projectRoot);
    await launchSingleHeadless(projectRoot, state, agent, feature, monitor, config, opts.model);
    console.log(`Retrying ${opts.featureId} in headless mode`);
  }
}
