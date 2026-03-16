/**
 * merger.ts — Merge completed feature branches to base branch.
 *
 * Responsibilities:
 *   - Merge a verified feature branch into the base branch
 *   - Merge a task branch into a quest branch
 *   - Merge a quest branch into the base branch
 *   - Handle merge conflicts gracefully
 *   - All git configuration comes from WomboConfig
 *
 * IMPORTANT: All operations are ASYNC.
 */

import { exec } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { WomboConfig } from "../config";
import { runTier25, type Tier25Result, type FileHunkResult } from "./conflict-hunks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeResult {
  success: boolean;
  merged: boolean;
  error: string | null;
  commitHash: string | null;
}

/**
 * Result of the tiered merge pipeline.
 * Indicates which tier resolved the merge (or if it failed).
 */
export interface TieredMergeResult {
  /** Whether the merge succeeded at any tier */
  success: boolean;
  /** Which tier resolved the merge:
   *  1 = clean git merge (no conflicts)
   *  2 = trivial auto-resolve (whitespace/formatting only)
   *  2.5 = surgical per-hunk resolution (programmatic classification)
   *  3 = resolver agent needed (real conflicts remain)
   *  null = not resolved yet (needs agent or manual)
   */
  tier: 1 | 2 | 2.5 | 3 | null;
  /** Conflicting files (empty if tier 1 or 2 succeeded) */
  conflictFiles: string[];
  /** Error message if applicable */
  error: string | null;
  /** Commit hash if merge completed (tier 1, 2, or 2.5) */
  commitHash: string | null;
  /** Tier 2.5 detailed results — present when tier >= 2.5 was attempted */
  tier25Result?: Tier25Result;
}

// ---------------------------------------------------------------------------
// Merge Queue — serializes concurrent merge operations
// ---------------------------------------------------------------------------

/**
 * Promise-based mutex that ensures only one merge runs at a time.
 * Without this, concurrent `attemptMerge` calls fight over the base branch
 * checkout in the project root, causing phantom failures.
 */
let mergeQueueTail: Promise<void> = Promise.resolve();

export function enqueueMerge<T>(fn: () => Promise<T>): Promise<T> {
  const result = mergeQueueTail.then(fn, fn); // run even if previous failed
  // Update the tail — suppress rejections on the chain itself to prevent
  // unhandled promise rejection, but log the error for visibility
  mergeQueueTail = result.then(
    () => {},
    (err) => { console.warn(`[merge-queue] Queued merge operation failed: ${err?.message ?? err}`); }
  );
  return result;
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

/**
 * Parse untracked file paths from a git merge error message.
 *
 * Git emits this when a merge would overwrite untracked files:
 *   error: The following untracked working tree files would be overwritten by merge:
 *   	.opencode/agents/generalist-agent.md
 *   Please move or remove them before you merge.
 *   Aborting
 */
function parseUntrackedFiles(errorOutput: string): string[] {
  const lines = errorOutput.split("\n");
  const files: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (line.includes("untracked working tree files would be overwritten")) {
      capturing = true;
      continue;
    }
    if (capturing) {
      if (line.includes("Please move or remove") || line.includes("Aborting")) {
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        files.push(trimmed);
      }
    }
  }
  return files;
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
  // Use a temporary worktree for the merge so we never touch the user's
  // checkout.  The old approach did `git checkout <baseBranch>` in the
  // project root, which hijacked the user's working branch — especially
  // painful when merging into quest branches.
  const tmpDir = `${projectRoot}/.wombo-combo/.tmp-merge-${Date.now()}`;

  // Create a worktree checked out on the base branch
  const addResult = await runSafe(
    `git worktree add "${tmpDir}" "${baseBranch}"`,
    projectRoot
  );
  if (!addResult.ok) {
    return {
      success: false,
      merged: false,
      error: `Failed to create merge worktree: ${addResult.output}`,
      commitHash: null,
    };
  }

  try {
    // Pull latest into the temp worktree — if --ff-only fails (diverged
    // branches), fall back to fetch + reset so we merge against the current
    // remote state.
    const pull = await runSafe(
      `git pull --ff-only ${config.git.remote} "${baseBranch}"`,
      tmpDir
    );
    if (!pull.ok) {
      console.warn(`[merger] Fast-forward pull failed for ${baseBranch}, falling back to fetch+reset: ${pull.output.slice(0, 200)}`);
      const fetch = await runSafe(
        `git fetch ${config.git.remote} "${baseBranch}"`,
        tmpDir
      );
      if (fetch.ok) {
        const reset = await runSafe(
          `git reset --hard ${config.git.remote}/${baseBranch}`,
          tmpDir
        );
        if (!reset.ok) {
          console.warn(`[merger] git reset --hard failed after fetch: ${reset.output.slice(0, 200)}`);
        }
      } else {
        console.warn(`[merger] Fetch also failed for ${baseBranch} (offline?) — proceeding with local state: ${fetch.output.slice(0, 200)}`);
      }
    }

    // Attempt the merge
    const mergeCmd = `git merge ${config.git.mergeStrategy} "${featureBranch}" -m "Merge branch '${featureBranch}' into ${baseBranch}"`;
    let mergeResult = await runSafe(mergeCmd, tmpDir);

    // If merge failed because untracked files would be overwritten, remove
    // them and retry.  The merge will bring in the tracked versions.
    if (
      !mergeResult.ok &&
      mergeResult.output.includes("untracked working tree files would be overwritten")
    ) {
      const untrackedFiles = parseUntrackedFiles(mergeResult.output);
      if (untrackedFiles.length > 0) {
        for (const file of untrackedFiles) {
          await runSafe(`rm -f "${file}"`, tmpDir);
        }
        mergeResult = await runSafe(mergeCmd, tmpDir);
      }
    }

    if (!mergeResult.ok) {
      await runSafe("git merge --abort", tmpDir);
      return {
        success: false,
        merged: false,
        error: `Merge conflict: ${mergeResult.output}`,
        commitHash: null,
      };
    }

    const commitHash = await run("git rev-parse HEAD", tmpDir);

    return {
      success: true,
      merged: true,
      error: null,
      commitHash,
    };
  } finally {
    // Always clean up the temporary worktree
    await runSafe(`git worktree remove "${tmpDir}" --force`, projectRoot);
  }
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
  if (!result.ok) {
    console.warn(`[merger] Failed to delete branch ${branchName}: ${result.output.slice(0, 200)}`);
  }
  return result.ok;
}

/**
 * Merge the base branch INTO a feature worktree to create conflict markers.
 *
 * This is the inverse of `mergeBranch()` — instead of merging the feature into
 * base (in the project root), we merge the base into the feature branch (in the
 * worktree). The merge is NOT aborted on conflict; the conflict markers are left
 * in the working tree so an agent can resolve them.
 *
 * Returns:
 *   - { conflicting: true, files: [...] } if there are conflicts to resolve
 *   - { conflicting: false } if the merge completed cleanly (no conflicts)
 */
export async function mergeBaseIntoFeature(
  worktreePath: string,
  baseBranch: string,
  config: WomboConfig
): Promise<{ conflicting: boolean; files: string[]; error?: string }> {
  // Fetch latest from remote so the base branch ref is up to date.
  // The fetch may fail if the branch doesn't exist on the remote (e.g. a
  // quest branch that was never pushed). In that case we fall back to the
  // local ref so merges still work for local-only branches.
  const fetchResult = await runSafe(`git fetch ${config.git.remote} "${baseBranch}"`, worktreePath);
  if (!fetchResult.ok) {
    console.warn(`[merger] Fetch failed for ${baseBranch} — falling back to local ref: ${fetchResult.output.slice(0, 200)}`);
  }

  // Use remote ref when available, otherwise fall back to local branch ref
  const remoteRef = `${config.git.remote}/${baseBranch}`;
  const refCheck = await runSafe(`git rev-parse --verify "${remoteRef}"`, worktreePath);
  const mergeRef = refCheck.ok ? remoteRef : baseBranch;

  const result = await runSafe(
    `git merge "${mergeRef}" -m "Merge ${baseBranch} into feature branch for conflict resolution"`,
    worktreePath
  );

  if (result.ok) {
    // Clean merge — no conflicts
    return { conflicting: false, files: [] };
  }

  // Check if there are actually conflict markers (vs some other merge error)
  const statusResult = await runSafe("git diff --name-only --diff-filter=U", worktreePath);
  if (!statusResult.ok || !statusResult.output.trim()) {
    // Merge failed but no unmerged files — something else went wrong
    await runSafe("git merge --abort", worktreePath);
    return { conflicting: false, files: [], error: result.output };
  }

  const conflictingFiles = statusResult.output
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);

  return { conflicting: true, files: conflictingFiles };
}

/**
 * Sync a quest branch with its base branch by merging baseBranch into the
 * quest branch. This ensures task statuses and code changes from the base
 * branch are available on the quest branch before launching new agents.
 *
 * Uses a temporary worktree to perform the merge without disturbing the
 * current checkout. If the quest branch is already up-to-date with the
 * base branch, this is a no-op.
 *
 * Returns { synced, conflicting, error }:
 *   - synced: true if a merge was performed (or was already up-to-date)
 *   - conflicting: true if the merge had conflicts (merge is aborted)
 *   - error: error message if something went wrong
 */
export async function syncQuestBranch(
  projectRoot: string,
  questBranch: string,
  baseBranch: string
): Promise<{ synced: boolean; conflicting: boolean; error?: string }> {
  // Check if baseBranch is already an ancestor of questBranch (no merge needed)
  const ancestorCheck = await runSafe(
    `git merge-base --is-ancestor "${baseBranch}" "${questBranch}"`,
    projectRoot
  );
  if (ancestorCheck.ok) {
    // Already up-to-date
    return { synced: true, conflicting: false };
  }

  // Need to merge. Use a temporary worktree for the quest branch.
  const tmpDir = `${projectRoot}/.wombo-combo/.tmp-quest-sync`;
  const addResult = await runSafe(
    `git worktree add "${tmpDir}" "${questBranch}"`,
    projectRoot
  );
  if (!addResult.ok) {
    return { synced: false, conflicting: false, error: `Failed to create temp worktree: ${addResult.output}` };
  }

  try {
    // Merge baseBranch into the quest branch
    const mergeResult = await runSafe(
      `git merge "${baseBranch}" -m "Sync ${baseBranch} into ${questBranch}"`,
      tmpDir
    );

    if (mergeResult.ok) {
      return { synced: true, conflicting: false };
    }

    // Check for merge conflicts
    const statusResult = await runSafe("git diff --name-only --diff-filter=U", tmpDir);
    if (statusResult.ok && statusResult.output.trim()) {
      // Abort the merge — user needs to resolve manually
      await runSafe("git merge --abort", tmpDir);
      return {
        synced: false,
        conflicting: true,
        error: `Merge conflicts between ${baseBranch} and ${questBranch}. ` +
          `Resolve manually:\n  git checkout ${questBranch}\n  git merge ${baseBranch}\n  # resolve conflicts, then commit`,
      };
    }

    // Some other merge error
    await runSafe("git merge --abort", tmpDir);
    return { synced: false, conflicting: false, error: mergeResult.output };
  } finally {
    // Always clean up the temporary worktree
    await runSafe(`git worktree remove "${tmpDir}" --force`, projectRoot);
  }
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

// ---------------------------------------------------------------------------
// Trivial Conflict Auto-Resolution (Tier 2)
// ---------------------------------------------------------------------------

/**
 * Regex to match a single conflict block in a file.
 *
 * Captures:
 *   group 1: "ours" content (HEAD / feature side)
 *   group 2: "theirs" content (base branch side)
 *
 * Handles the standard 3-section format:
 *   <<<<<<< HEAD
 *   ... ours ...
 *   =======
 *   ... theirs ...
 *   >>>>>>> branch-name
 */
const CONFLICT_RE = /^<{7}\s+\S+\r?\n([\s\S]*?)^={7}\r?\n([\s\S]*?)^>{7}\s+\S+\r?\n?/gm;

/**
 * Normalize a string for whitespace comparison: collapse all runs of
 * whitespace (spaces, tabs, newlines) into single spaces and trim.
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Check if a conflict is trivial — both sides are semantically identical
 * when whitespace differences are ignored.
 */
function isConflictTrivial(ours: string, theirs: string): boolean {
  return normalizeWhitespace(ours) === normalizeWhitespace(theirs);
}

/**
 * Attempt to auto-resolve trivial conflicts in a single file.
 *
 * A conflict is "trivial" if the ours and theirs sides differ only in
 * whitespace (indentation, blank lines, trailing spaces, line endings).
 * For trivial conflicts, we keep the "ours" (feature) side since the
 * agent's implementation is the intended version.
 *
 * @returns { resolved: true, content } if ALL conflicts in the file were trivial
 * @returns { resolved: false } if any conflict is non-trivial
 */
function tryAutoResolveFile(content: string): { resolved: boolean; content?: string } {
  let hasConflicts = false;
  let allTrivial = true;

  // Check all conflicts first
  const matches = [...content.matchAll(CONFLICT_RE)];
  if (matches.length === 0) {
    return { resolved: false }; // no conflicts found
  }

  for (const match of matches) {
    hasConflicts = true;
    const ours = match[1];
    const theirs = match[2];
    if (!isConflictTrivial(ours, theirs)) {
      allTrivial = false;
      break;
    }
  }

  if (!hasConflicts || !allTrivial) {
    return { resolved: false };
  }

  // All conflicts are trivial — resolve by keeping "ours" (feature side)
  const resolved = content.replace(CONFLICT_RE, "$1");
  return { resolved: true, content: resolved };
}

/**
 * Attempt to auto-resolve ALL trivial conflicts in a worktree.
 *
 * For each unmerged file:
 *   - If ALL its conflicts are trivial (whitespace-only) → auto-resolve
 *   - If ANY conflict is non-trivial → leave the file untouched
 *
 * @returns Object with:
 *   - `allResolved`: true if every conflicting file was auto-resolved
 *   - `resolvedFiles`: files that were auto-resolved
 *   - `unresolvedFiles`: files with real (non-trivial) conflicts
 */
export async function tryAutoResolveTrivialConflicts(
  worktreePath: string
): Promise<{
  allResolved: boolean;
  resolvedFiles: string[];
  unresolvedFiles: string[];
}> {
  // Get list of unmerged (conflicting) files
  const statusResult = await runSafe("git diff --name-only --diff-filter=U", worktreePath);
  if (!statusResult.ok || !statusResult.output.trim()) {
    return { allResolved: false, resolvedFiles: [], unresolvedFiles: [] };
  }

  const conflictFiles = statusResult.output
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);

  const resolvedFiles: string[] = [];
  const unresolvedFiles: string[] = [];

  for (const file of conflictFiles) {
    const filePath = `${worktreePath}/${file}`;
    try {
      const content = readFileSync(filePath, "utf-8");
      const result = tryAutoResolveFile(content);

      if (result.resolved && result.content !== undefined) {
        writeFileSync(filePath, result.content);
        await runSafe(`git add "${file}"`, worktreePath);
        resolvedFiles.push(file);
      } else {
        unresolvedFiles.push(file);
      }
    } catch (err: any) {
      // Can't read/write the file — treat as unresolved
      console.warn(`[merger] Failed to read/write conflict file ${file}: ${err?.message ?? err}`);
      unresolvedFiles.push(file);
    }
  }

  return {
    allResolved: unresolvedFiles.length === 0,
    resolvedFiles,
    unresolvedFiles,
  };
}

/**
 * Complete a merge after all conflicts have been auto-resolved.
 * Stages everything and commits with the merge message.
 */
export async function commitAutoResolvedMerge(
  worktreePath: string,
): Promise<{ success: boolean; error?: string }> {
  // Commit the merge (--no-edit uses the default merge message)
  const commitResult = await runSafe("git commit --no-edit", worktreePath);
  if (!commitResult.ok) {
    return { success: false, error: commitResult.output };
  }
  return { success: true };
}

/**
 * Run the tiered merge pipeline for merging base into a feature worktree.
 *
 * Tier 1: git merge (fast, free) — if clean, done.
 * Tier 2: If conflicts, check if ALL are trivial (whitespace-only) → auto-resolve.
 * Tier 2.5: Surgical per-hunk resolution — classify each conflict hunk and resolve
 *           trivial, one-side-only, and additive hunks programmatically.
 * Tier 3: Real conflicts remain → return structured hunk data for a resolver agent.
 *
 * This function handles tiers 1, 2, and 2.5. The caller is responsible for tier 3+
 * (launching a resolver agent) if this returns `tier: 3`.
 */
export async function tieredMergeBaseIntoFeature(
  worktreePath: string,
  baseBranch: string,
  config: WomboConfig
): Promise<TieredMergeResult> {
  // Tier 1: Attempt clean merge
  const mergeResult = await mergeBaseIntoFeature(worktreePath, baseBranch, config);

  if (mergeResult.error && !mergeResult.conflicting) {
    // Merge setup failed entirely
    return {
      success: false,
      tier: null,
      conflictFiles: [],
      error: mergeResult.error,
      commitHash: null,
    };
  }

  if (!mergeResult.conflicting) {
    // Clean merge — tier 1 success
    const hash = await runSafe("git rev-parse HEAD", worktreePath);
    return {
      success: true,
      tier: 1,
      conflictFiles: [],
      error: null,
      commitHash: hash.ok ? hash.output : null,
    };
  }

  // Tier 2: Try auto-resolving trivial conflicts (all-or-nothing per file)
  const autoResult = await tryAutoResolveTrivialConflicts(worktreePath);

  if (autoResult.allResolved) {
    // All conflicts were trivial — commit and done
    const commitResult = await commitAutoResolvedMerge(worktreePath);
    if (commitResult.success) {
      const hash = await runSafe("git rev-parse HEAD", worktreePath);
      return {
        success: true,
        tier: 2,
        conflictFiles: [],
        error: null,
        commitHash: hash.ok ? hash.output : null,
      };
    }
    // Auto-resolve commit failed — fall through to tier 2.5
    console.warn(`[merger] Tier 2 auto-resolve succeeded but commit failed — falling through to tier 2.5`);
  }

  // Tier 2.5: Surgical per-hunk resolution
  // Only process files that tier 2 didn't fully resolve
  const remainingConflictFiles = autoResult.unresolvedFiles;

  if (remainingConflictFiles.length > 0) {
    // Determine build command for additive hunk verification
    const buildCommand = config.build.command;

    const tier25 = await runTier25(worktreePath, remainingConflictFiles, buildCommand);

    if (tier25.allResolved) {
      // Tier 2.5 resolved everything — commit and done
      const commitResult = await commitAutoResolvedMerge(worktreePath);
      if (commitResult.success) {
        const hash = await runSafe("git rev-parse HEAD", worktreePath);
        return {
          success: true,
          tier: 2.5,
          conflictFiles: [],
          error: null,
          commitHash: hash.ok ? hash.output : null,
          tier25Result: tier25,
        };
      }
      // Commit failed — fall through to tier 3 with the structured data
      console.warn(`[merger] Tier 2.5 resolved all hunks but commit failed — falling through to tier 3`);
    }

    // Tier 3: Real conflicts remain — caller must launch resolver agent
    // We pass along the structured tier 2.5 data so the LLM gets better context
    return {
      success: false,
      tier: 3,
      conflictFiles: tier25.unresolvedFiles,
      error: `${tier25.unresolvedHunkCount} unresolved hunk(s) in ${tier25.unresolvedFiles.length} file(s) ` +
        `(${tier25.resolvedHunkCount}/${tier25.totalHunks} hunks resolved programmatically)`,
      commitHash: null,
      tier25Result: tier25,
    };
  }

  // Edge case: tier 2 resolved some files but commit failed, no remaining files
  return {
    success: false,
    tier: 3,
    conflictFiles: autoResult.unresolvedFiles,
    error: `${autoResult.unresolvedFiles.length} file(s) with non-trivial conflicts (${autoResult.resolvedFiles.length} trivial conflicts auto-resolved)`,
    commitHash: null,
  };
}

// ---------------------------------------------------------------------------
// Tier 3.5: Rebase Strategy
// ---------------------------------------------------------------------------

/** Result of one commit during rebase */
export interface RebaseCommitResult {
  /** The commit hash being replayed */
  commitHash: string;
  /** One-line commit message */
  commitMessage: string;
  /** Whether this commit applied cleanly */
  clean: boolean;
  /** Conflicting files (if not clean) */
  conflictFiles: string[];
  /** Whether the LLM resolved the conflicts for this commit */
  resolvedByLLM: boolean;
}

/** Result of the full rebase strategy */
export interface RebaseStrategyResult {
  /** Whether the rebase completed successfully */
  success: boolean;
  /** The throwaway branch name */
  tempBranch: string;
  /** Per-commit results */
  commitResults: RebaseCommitResult[];
  /** Error message if the strategy failed */
  error: string | null;
}

/**
 * Start a rebase on a throwaway branch.
 *
 * Creates `temp/rebase-{featureId}` from the feature branch, then runs
 * `git rebase {baseBranch}`. Returns the list of commits that need to be
 * replayed so the caller can handle per-commit conflict resolution.
 *
 * The rebase is started with --no-autosquash to preserve commit order.
 *
 * @returns The temp branch name and the list of feature-only commits to replay
 */
export async function startRebaseStrategy(
  worktreePath: string,
  featureBranch: string,
  baseBranch: string,
  featureId: string,
  config: WomboConfig
): Promise<{
  tempBranch: string;
  commitsToReplay: Array<{ hash: string; message: string }>;
  error?: string;
}> {
  const tempBranch = `temp/rebase-${featureId}`;
  const remote = config.git.remote;

  // First, ensure we're on the feature branch
  const checkoutResult = await runSafe(`git checkout "${featureBranch}"`, worktreePath);
  if (!checkoutResult.ok) {
    return { tempBranch, commitsToReplay: [], error: `Failed to checkout ${featureBranch}: ${checkoutResult.output}` };
  }

  // Create the throwaway branch from the feature branch
  const branchResult = await runSafe(`git checkout -b "${tempBranch}"`, worktreePath);
  if (!branchResult.ok) {
    // Branch might already exist — delete and recreate
    await runSafe(`git branch -D "${tempBranch}"`, worktreePath);
    const retryResult = await runSafe(`git checkout -b "${tempBranch}"`, worktreePath);
    if (!retryResult.ok) {
      return { tempBranch, commitsToReplay: [], error: `Failed to create temp branch: ${retryResult.output}` };
    }
  }

  // Get the list of commits on the feature branch that aren't on the base branch.
  // These are the commits that will be replayed during rebase.
  const mergeBaseResult = await runSafe(
    `git merge-base "${remote}/${baseBranch}" "${tempBranch}"`,
    worktreePath
  );
  if (!mergeBaseResult.ok) {
    await cleanupRebaseBranch(worktreePath, tempBranch, featureBranch);
    return { tempBranch, commitsToReplay: [], error: `Failed to find merge base: ${mergeBaseResult.output}` };
  }

  const mergeBase = mergeBaseResult.output.trim();

  // List commits from merge-base to HEAD (oldest first)
  const logResult = await runSafe(
    `git log --format="%H %s" --reverse "${mergeBase}..HEAD"`,
    worktreePath
  );
  if (!logResult.ok || !logResult.output.trim()) {
    await cleanupRebaseBranch(worktreePath, tempBranch, featureBranch);
    return { tempBranch, commitsToReplay: [], error: "No commits to replay" };
  }

  const commitsToReplay = logResult.output.trim().split("\n").map((line) => {
    const spaceIdx = line.indexOf(" ");
    return {
      hash: line.substring(0, spaceIdx),
      message: line.substring(spaceIdx + 1),
    };
  });

  return { tempBranch, commitsToReplay };
}

/**
 * Begin the actual rebase operation.
 *
 * This starts `git rebase` which will stop at the first conflict.
 * The caller should then inspect the state and resolve conflicts
 * before calling `continueRebase()`.
 *
 * @returns true if the rebase completed without any conflicts,
 *          false if it stopped at a conflict (check getRebaseConflicts)
 */
export async function beginRebase(
  worktreePath: string,
  baseBranch: string,
  config: WomboConfig
): Promise<{ clean: boolean; error?: string }> {
  const remote = config.git.remote;
  const result = await runSafe(
    `git rebase "${remote}/${baseBranch}"`,
    worktreePath
  );

  if (result.ok) {
    return { clean: true };
  }

  // Check if it's a conflict (rebase paused) or an error
  const statusResult = await runSafe("git diff --name-only --diff-filter=U", worktreePath);
  if (statusResult.ok && statusResult.output.trim()) {
    // Rebase paused at a conflict
    return { clean: false };
  }

  return { clean: false, error: result.output };
}

/**
 * Get the list of conflicting files during an active rebase.
 */
export async function getRebaseConflicts(
  worktreePath: string
): Promise<string[]> {
  const result = await runSafe("git diff --name-only --diff-filter=U", worktreePath);
  if (!result.ok || !result.output.trim()) return [];
  return result.output.trim().split("\n").filter((f) => f.length > 0);
}

/**
 * Continue a rebase after conflicts have been resolved.
 * The caller must have already resolved conflicts and staged the files.
 *
 * @returns true if the rebase continued/completed cleanly,
 *          false if another conflict was encountered
 */
export async function continueRebase(
  worktreePath: string
): Promise<{ clean: boolean; done: boolean; error?: string }> {
  const result = await runSafe(
    "git -c core.editor=true rebase --continue",
    worktreePath
  );

  if (result.ok) {
    // Check if rebase is complete
    const rebaseDir = await runSafe("test -d .git/rebase-merge || test -d .git/rebase-apply && echo yes || echo no", worktreePath);
    const done = !rebaseDir.output.includes("yes");
    return { clean: true, done };
  }

  // Check if another conflict
  const conflicts = await getRebaseConflicts(worktreePath);
  if (conflicts.length > 0) {
    return { clean: false, done: false };
  }

  return { clean: false, done: false, error: result.output };
}

/**
 * Abort an in-progress rebase.
 */
export async function abortRebase(
  worktreePath: string
): Promise<void> {
  const result = await runSafe("git rebase --abort", worktreePath);
  if (!result.ok) {
    console.warn(`[merger] git rebase --abort failed: ${result.output.slice(0, 200)}`);
  }
}

/**
 * Clean up the throwaway rebase branch and return to the original feature branch.
 */
export async function cleanupRebaseBranch(
  worktreePath: string,
  tempBranch: string,
  featureBranch: string
): Promise<void> {
  // Switch back to the original feature branch
  const checkout = await runSafe(`git checkout "${featureBranch}"`, worktreePath);
  if (!checkout.ok) {
    console.warn(`[merger] Failed to checkout ${featureBranch} during rebase cleanup: ${checkout.output.slice(0, 200)}`);
  }
  // Delete the throwaway branch
  const del = await runSafe(`git branch -D "${tempBranch}"`, worktreePath);
  if (!del.ok) {
    console.warn(`[merger] Failed to delete temp rebase branch ${tempBranch}: ${del.output.slice(0, 200)}`);
  }
}

/**
 * After a successful rebase on the temp branch, fast-forward the feature branch
 * to the rebased state, then merge into base.
 */
export async function finalizeRebase(
  worktreePath: string,
  tempBranch: string,
  featureBranch: string
): Promise<{ success: boolean; error?: string }> {
  // Update the feature branch to point to the rebased commits
  // First checkout the feature branch
  const checkoutResult = await runSafe(`git checkout "${featureBranch}"`, worktreePath);
  if (!checkoutResult.ok) {
    return { success: false, error: `Failed to checkout ${featureBranch}: ${checkoutResult.output}` };
  }

  // Reset feature branch to match the temp branch
  const resetResult = await runSafe(`git reset --hard "${tempBranch}"`, worktreePath);
  if (!resetResult.ok) {
    return { success: false, error: `Failed to reset ${featureBranch} to ${tempBranch}: ${resetResult.output}` };
  }

  // Delete the temp branch
  const delResult = await runSafe(`git branch -D "${tempBranch}"`, worktreePath);
  if (!delResult.ok) {
    console.warn(`[merger] Failed to delete temp rebase branch ${tempBranch}: ${delResult.output.slice(0, 200)}`);
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// Quest Merge Operations
// ---------------------------------------------------------------------------

/**
 * Merge a task branch into its quest branch.
 * Same as mergeBranch but semantically distinct — the "base" is the quest branch,
 * not the project's baseBranch.
 *
 * This is used when a task within a quest completes: its work goes into the quest
 * branch, not directly into baseBranch.
 */
export async function mergeTaskIntoQuest(
  projectRoot: string,
  taskBranch: string,
  questBranch: string,
  config: WomboConfig
): Promise<MergeResult> {
  return mergeBranch(projectRoot, taskBranch, questBranch, config);
}

/**
 * Merge a quest branch into the project's base branch.
 * Used when all tasks in a quest are complete and the quest is being finalized.
 */
export async function mergeQuestIntoBranch(
  projectRoot: string,
  questBranch: string,
  baseBranch: string,
  config: WomboConfig
): Promise<MergeResult> {
  return mergeBranch(projectRoot, questBranch, baseBranch, config);
}
