/**
 * merger.ts — Merge completed feature branches to base branch.
 *
 * Responsibilities:
 *   - Merge a verified feature branch into the base branch
 *   - Handle merge conflicts gracefully
 *   - All git configuration comes from WomboConfig
 *
 * IMPORTANT: All operations are ASYNC.
 */

import { exec } from "node:child_process";
import type { WomboConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeResult {
  success: boolean;
  merged: boolean;
  error: string | null;
  commitHash: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const errMsg = stderr?.trim() || stdout?.trim() || error.message;
        reject(new Error(errMsg));
      } else {
        resolve((stdout ?? "").trim());
      }
    });
  });
}

async function runSafe(cmd: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    return { ok: true, output: await run(cmd, cwd) };
  } catch (err: any) {
    return { ok: false, output: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Merge Operations
// ---------------------------------------------------------------------------

/**
 * Merge a feature branch into the base branch.
 * Uses config.git.mergeStrategy (e.g. "--no-ff") and config.git.remote.
 */
export async function mergeBranch(
  projectRoot: string,
  featureBranch: string,
  baseBranch: string,
  config: WomboConfig
): Promise<MergeResult> {
  // Ensure we're on the base branch
  const currentBranch = await run("git branch --show-current", projectRoot);
  if (currentBranch !== baseBranch) {
    const checkout = await runSafe(`git checkout "${baseBranch}"`, projectRoot);
    if (!checkout.ok) {
      return {
        success: false,
        merged: false,
        error: `Failed to checkout ${baseBranch}: ${checkout.output}`,
        commitHash: null,
      };
    }
  }

  // Pull latest
  await runSafe(`git pull --ff-only ${config.git.remote} "${baseBranch}"`, projectRoot);

  // Attempt the merge
  const mergeResult = await runSafe(
    `git merge ${config.git.mergeStrategy} "${featureBranch}" -m "Merge branch '${featureBranch}' into ${baseBranch}"`,
    projectRoot
  );

  if (!mergeResult.ok) {
    await runSafe("git merge --abort", projectRoot);
    return {
      success: false,
      merged: false,
      error: `Merge conflict: ${mergeResult.output}`,
      commitHash: null,
    };
  }

  const commitHash = await run("git rev-parse HEAD", projectRoot);

  return {
    success: true,
    merged: true,
    error: null,
    commitHash,
  };
}

/**
 * Check if a branch can be merged without conflicts.
 */
export async function canMerge(
  projectRoot: string,
  featureBranch: string,
  baseBranch: string
): Promise<{ canMerge: boolean; reason: string }> {
  const branchExists = await runSafe(
    `git rev-parse --verify "${featureBranch}"`,
    projectRoot
  );
  if (!branchExists.ok) {
    return { canMerge: false, reason: `Branch ${featureBranch} does not exist` };
  }

  const result = await runSafe(
    `git merge-tree $(git merge-base "${baseBranch}" "${featureBranch}") "${baseBranch}" "${featureBranch}"`,
    projectRoot
  );

  if (result.output.includes("<<<<<<<") || result.output.includes(">>>>>>>")) {
    return { canMerge: false, reason: "Merge would result in conflicts" };
  }

  return { canMerge: true, reason: "Clean merge possible" };
}

/**
 * Merge multiple verified branches sequentially.
 */
export async function mergeAll(
  projectRoot: string,
  featureBranches: string[],
  baseBranch: string,
  config: WomboConfig
): Promise<Map<string, MergeResult>> {
  const results = new Map<string, MergeResult>();

  for (const branch of featureBranches) {
    const result = await mergeBranch(projectRoot, branch, baseBranch, config);
    results.set(branch, result);

    if (!result.success) {
      break;
    }
  }

  return results;
}

/**
 * Delete a feature branch after successful merge.
 */
export async function deleteBranch(
  projectRoot: string,
  branchName: string
): Promise<boolean> {
  const result = await runSafe(`git branch -d "${branchName}"`, projectRoot);
  return result.ok;
}

/**
 * Push the base branch to its remote.
 */
export async function pushBaseBranch(
  projectRoot: string,
  baseBranch: string,
  config: WomboConfig
): Promise<boolean> {
  console.log(`\nPushing ${baseBranch} to ${config.git.remote}...`);
  const result = await runSafe(
    `git push ${config.git.remote} "${baseBranch}"`,
    projectRoot
  );
  if (result.ok) {
    console.log(`Pushed ${baseBranch} to ${config.git.remote}.`);
  } else {
    console.error(`Push failed: ${result.output}`);
  }
  return result.ok;
}
