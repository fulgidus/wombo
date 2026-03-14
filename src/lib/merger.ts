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
   *  3 = resolver agent needed (real conflicts)
   *  null = not resolved yet (needs agent or manual)
   */
  tier: 1 | 2 | 3 | null;
  /** Conflicting files (empty if tier 1 or 2 succeeded) */
  conflictFiles: string[];
  /** Error message if applicable */
  error: string | null;
  /** Commit hash if merge completed (tier 1 or 2) */
  commitHash: string | null;
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
  // Update the tail but suppress rejections on the chain itself
  mergeQueueTail = result.then(() => {}, () => {});
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
  // Stash any dirty tracked files in the project root before we touch the
  // working tree.  The merge target directory should ideally be clean, but
  // agents, TUI state files, or prior failed resolution attempts can leave
  // uncommitted modifications that cause `git checkout` / `git merge` to
  // refuse with "Your local changes … would be overwritten".
  const stashResult = await runSafe("git stash push -m wombo-merge-guard --include-untracked", projectRoot);
  const didStash = stashResult.ok && !stashResult.output.includes("No local changes to save");

  try {
    return await _mergeBranchInner(projectRoot, featureBranch, baseBranch, config);
  } finally {
    // Restore the stash regardless of merge outcome so the user's working
    // tree is returned to its previous state.
    if (didStash) {
      await runSafe("git stash pop", projectRoot);
    }
  }
}

/** Internal merge implementation — always called with a clean worktree. */
async function _mergeBranchInner(
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

  // Pull latest — if --ff-only fails (diverged branches), fall back to
  // fetch + reset so we always merge against the current remote state.
  const pull = await runSafe(`git pull --ff-only ${config.git.remote} "${baseBranch}"`, projectRoot);
  if (!pull.ok) {
    // Fast-forward failed — fetch and hard-reset to remote tip instead.
    // This is safe because the project root's base branch is a merge target,
    // not a working tree where anyone edits files directly.
    const fetch = await runSafe(`git fetch ${config.git.remote} "${baseBranch}"`, projectRoot);
    if (fetch.ok) {
      await runSafe(`git reset --hard ${config.git.remote}/${baseBranch}`, projectRoot);
    }
    // If fetch also fails (offline?), proceed with whatever we have locally.
  }

  // Attempt the merge
  const mergeCmd = `git merge ${config.git.mergeStrategy} "${featureBranch}" -m "Merge branch '${featureBranch}' into ${baseBranch}"`;
  let mergeResult = await runSafe(mergeCmd, projectRoot);

  // If merge failed because untracked files would be overwritten, remove them
  // and retry. The merge will bring in the tracked versions of these files, so
  // the untracked copies are redundant (typically agent/ config files created
  // by ensureAgentDefinition that the feature branch also committed).
  if (
    !mergeResult.ok &&
    mergeResult.output.includes("untracked working tree files would be overwritten")
  ) {
    const untrackedFiles = parseUntrackedFiles(mergeResult.output);
    if (untrackedFiles.length > 0) {
      for (const file of untrackedFiles) {
        await runSafe(`rm -f "${file}"`, projectRoot);
      }
      mergeResult = await runSafe(mergeCmd, projectRoot);
    }
  }

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
  // Fetch latest from remote so the base branch ref is up to date
  await runSafe(`git fetch ${config.git.remote} "${baseBranch}"`, worktreePath);

  // Attempt the merge — use remote ref to get latest base
  const mergeRef = `${config.git.remote}/${baseBranch}`;
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
    } catch {
      // Can't read/write the file — treat as unresolved
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
 * Tier 3: Real conflicts remain → return them for a resolver agent.
 *
 * This function handles tiers 1 & 2. The caller is responsible for tier 3
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

  // Tier 2: Try auto-resolving trivial conflicts
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
    // Auto-resolve commit failed — fall through to tier 3
    return {
      success: false,
      tier: 3,
      conflictFiles: autoResult.unresolvedFiles,
      error: commitResult.error ?? "Auto-resolve commit failed",
      commitHash: null,
    };
  }

  // Tier 3: Real conflicts remain — caller must launch resolver agent
  return {
    success: false,
    tier: 3,
    conflictFiles: autoResult.unresolvedFiles,
    error: `${autoResult.unresolvedFiles.length} file(s) with non-trivial conflicts (${autoResult.resolvedFiles.length} trivial conflicts auto-resolved)`,
    commitHash: null,
  };
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
