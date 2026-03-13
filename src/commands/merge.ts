/**
 * merge.ts — Merge verified branches into the base branch.
 *
 * Usage: woco merge [feature-id] [--output json]
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
import { output, outputMessage, type OutputFormat } from "../lib/output.js";
import { renderMerge } from "../lib/toon.js";

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
  outputFmt?: OutputFormat;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdMerge(opts: MergeCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  const state = loadState(projectRoot);
  if (!state) {
    outputMessage(fmt, "No active wave.", {
      wave_id: null,
      agents: [],
      merged: 0,
    });
    return;
  }

  const toMerge = opts.featureId
    ? state.agents.filter(
        (a) => a.feature_id === opts.featureId && a.status === "verified"
      )
    : state.agents.filter((a) => a.status === "verified");

  if (toMerge.length === 0) {
    outputMessage(fmt, "No verified agents to merge.", {
      wave_id: state.wave_id,
      agents: [],
      merged: 0,
    });
    return;
  }

  // Dry-run: show what would be merged without merging
  if (opts.dryRun) {
    const dryRunResult = {
      dry_run: true,
      wave_id: state.wave_id,
      base_branch: state.base_branch,
      count: toMerge.length,
      agents: toMerge.map((a) => ({
        feature_id: a.feature_id,
        branch: a.branch,
      })),
      auto_push: !!opts.autoPush,
    };

    output(fmt, dryRunResult, () => {
      console.log(`\n[dry-run] Would merge ${toMerge.length} branch(es):\n`);
      for (const agent of toMerge) {
        console.log(`  ${agent.feature_id} — branch: ${agent.branch}`);
      }
      if (opts.autoPush) {
        console.log(`\n  Would push ${state.base_branch} to remote after merge.`);
      }
    }, () => {
      console.log(renderMerge(dryRunResult));
    });
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

  if (fmt === "text") {
    console.log(`\nMerging ${toMerge.length} branch(es)...\n`);
  }

  for (const agent of toMerge) {
    const feature = featureMap.get(agent.feature_id);
    if (!feature) {
      if (fmt === "text") {
        printAgentUpdate(agent, `SKIP — feature "${agent.feature_id}" not found in features file`);
      }
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

  // Collect results for JSON output
  const results = toMerge.map((agent) => {
    const updatedAgent = state.agents.find((a) => a.feature_id === agent.feature_id);
    return {
      feature_id: agent.feature_id,
      branch: agent.branch,
      status: updatedAgent?.status ?? agent.status,
      error: updatedAgent?.error ?? agent.error,
    };
  });

  output(fmt, {
    wave_id: state.wave_id,
    base_branch: state.base_branch,
    merged: results.filter((r) => r.status === "merged").length,
    failed: results.filter((r) => r.status === "failed").length,
    agents: results,
  }, () => {
    printDashboard(state);
  }, () => {
    console.log(renderMerge({
      wave_id: state.wave_id,
      base_branch: state.base_branch,
      merged: results.filter((r) => r.status === "merged").length,
      failed: results.filter((r) => r.status === "failed").length,
      agents: results,
    }));
  });
}
