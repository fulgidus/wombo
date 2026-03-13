/**
 * merge.ts — Merge verified branches into the base branch.
 *
 * Usage: woco merge [feature-id]
 *
 * Merges all verified agents (or a specific one) into the base branch.
 * Uses the full merge pipeline including pre-flight conflict detection,
 * automatic conflict resolution, and configurable retry attempts.
 */

import type { WomboConfig } from "../config.js";
import {
  loadState,
} from "../lib/state.js";
import { pushBaseBranch } from "../lib/merger.js";
import type { Feature } from "../lib/tasks.js";
import { loadFeatures } from "../lib/tasks.js";
import { printDashboard, printAgentUpdate } from "../lib/ui.js";
import { attemptMerge } from "./launch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId?: string;
  autoPush?: boolean;
  dryRun?: boolean;
  model?: string;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdMerge(opts: MergeCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;

  const state = loadState(projectRoot);
  if (!state) {
    console.log("No active wave.");
    return;
  }

  const toMerge = opts.featureId
    ? state.agents.filter(
        (a) => a.feature_id === opts.featureId && a.status === "verified"
      )
    : state.agents.filter((a) => a.status === "verified");

  if (toMerge.length === 0) {
    console.log("No verified agents to merge.");
    return;
  }

  // Dry-run: show what would be merged without merging
  if (opts.dryRun) {
    console.log(`\n[dry-run] Would merge ${toMerge.length} branch(es):\n`);
    for (const agent of toMerge) {
      console.log(`  ${agent.feature_id} — branch: ${agent.branch}`);
    }
    if (opts.autoPush) {
      console.log(`\n  Would push ${state.base_branch} to remote after merge.`);
    }
    return;
  }

  // Load features for conflict resolution prompt generation.
  // Build a flat map of all feature/subtask IDs so we can look up any agent.
  const data = loadFeatures(projectRoot, config);
  const featureMap = new Map<string, Feature>();
  function indexFeatures(items: Feature[]) {
    for (const f of items) {
      featureMap.set(f.id, f);
      if (f.subtasks) {
        indexFeatures(f.subtasks as unknown as Feature[]);
      }
    }
  }
  indexFeatures(data.tasks);
  indexFeatures(data.archive);

  console.log(`\nMerging ${toMerge.length} branch(es)...\n`);

  for (const agent of toMerge) {
    const feature = featureMap.get(agent.feature_id);
    if (!feature) {
      printAgentUpdate(agent, `SKIP — feature "${agent.feature_id}" not found in features file`);
      continue;
    }

    // Use the full merge pipeline (pre-flight, conflict resolution, retry)
    await attemptMerge(projectRoot, state, agent, feature, config, opts.model);
  }

  // Auto-push if requested
  if (opts.autoPush) {
    const anyMerged = state.agents.some((a) => a.status === "merged");
    if (anyMerged) {
      await pushBaseBranch(projectRoot, state.base_branch, config);
    }
  }

  printDashboard(state);
}
