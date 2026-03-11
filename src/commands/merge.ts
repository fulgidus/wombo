/**
 * merge.ts — Merge verified branches into the base branch.
 *
 * Usage: wombo merge [feature-id]
 *
 * Merges all verified agents (or a specific one) into the base branch.
 * After merging, cleans up the worktree as best-effort.
 */

import type { WomboConfig } from "../config.js";
import {
  loadState,
  saveState,
  updateAgent,
} from "../lib/state.js";
import { mergeBranch, pushBaseBranch } from "../lib/merger.js";
import { removeWorktree } from "../lib/worktree.js";
import { printDashboard, printAgentUpdate } from "../lib/ui.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId?: string;
  autoPush?: boolean;
  dryRun?: boolean;
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

  console.log(`\nMerging ${toMerge.length} branch(es)...\n`);

  for (const agent of toMerge) {
    printAgentUpdate(agent, "merging...");
    const result = await mergeBranch(projectRoot, agent.branch, state.base_branch, config);

    if (result.success) {
      updateAgent(state, agent.feature_id, {
        status: "merged",
      });
      saveState(projectRoot, state);
      printAgentUpdate(agent, `MERGED (${result.commitHash?.slice(0, 7)})`);

      // Clean up worktree
      try {
        removeWorktree(projectRoot, agent.worktree, false);
        printAgentUpdate(agent, "worktree removed");
      } catch {
        // Not critical
      }
    } else {
      printAgentUpdate(agent, `MERGE FAILED: ${result.error}`);
    }
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
