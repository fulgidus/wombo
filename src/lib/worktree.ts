/**
 * worktree.ts — Git worktree lifecycle management.
 *
 * Responsibilities:
 *   - Create feature branches from a base branch
 *   - Create git worktrees for each feature branch
 *   - Run install command in worktrees
 *   - List and remove worktrees
 *   - Copy agent config files into worktrees
 *
 * IMPORTANT: Heavy operations (createWorktree, installDeps) are async
 * to allow true parallelism with Promise.all.
 */

import { exec, execSync } from "node:child_process";
import { existsSync, cpSync, statSync, readdirSync, rmdirSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import type { WomboConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
}

// ---------------------------------------------------------------------------
// Diagnostic Logger
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

export function log(featureId: string, msg: string): void {
  console.log(`  [${ts()}] ${featureId}: ${msg}`);
}

// ---------------------------------------------------------------------------
// Async Command Runner
// ---------------------------------------------------------------------------

/**
 * Run a command asynchronously. Returns stdout on success, throws on failure.
 */
function runAsync(
  cmd: string,
  opts?: { cwd?: string; timeoutMs?: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      {
        cwd: opts?.cwd,
        encoding: "utf-8",
        timeout: opts?.timeoutMs ?? 0,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const errMsg = stderr?.trim() || stdout?.trim() || error.message;
          reject(new Error(`Command failed: ${cmd}\n${errMsg}`));
        } else {
          resolve((stdout ?? "").trim());
        }
      }
    );
  });
}

/**
 * Synchronous run — only for quick, non-blocking operations.
 */
function runSync(
  cmd: string,
  opts?: { cwd?: string; silent?: boolean; timeoutMs?: number }
): string {
  try {
    return execSync(cmd, {
      cwd: opts?.cwd,
      encoding: "utf-8",
      stdio: opts?.silent ? "pipe" : ["pipe", "pipe", "pipe"],
      timeout: opts?.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim() || "";
    const stdout = err.stdout?.toString().trim() || "";
    throw new Error(
      `Command failed: ${cmd}\n${stderr || stdout || err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Branch Management
// ---------------------------------------------------------------------------

/**
 * Create a feature branch from the base branch.
 * If it already exists and is NOT checked out in a worktree, reset it.
 * If it's checked out in a worktree, leave it alone (resume case).
 */
async function createBranch(
  projectRoot: string,
  branchName: string,
  baseBranch: string
): Promise<void> {
  const existing = await runAsync(
    `git branch --list "${branchName}"`,
    { cwd: projectRoot }
  );
  if (existing.trim()) {
    // Branch exists — try to delete and recreate.
    // If deletion fails (e.g. checked out in worktree), that's fine —
    // we'll reuse the existing branch with its work intact.
    try {
      await runAsync(`git branch -D "${branchName}"`, { cwd: projectRoot });
    } catch {
      // Branch is checked out in a worktree — reuse as-is
      return;
    }
  }
  await runAsync(`git branch "${branchName}" "${baseBranch}"`, {
    cwd: projectRoot,
  });
}

/**
 * Generate the branch name for a feature using config prefix.
 */
export function featureBranchName(
  featureId: string,
  config: WomboConfig
): string {
  return `${config.git.branchPrefix}${featureId}`;
}

// ---------------------------------------------------------------------------
// Quest Branch Management
// ---------------------------------------------------------------------------

/**
 * Generate the branch name for a quest.
 * Quest branches always use the "quest/" prefix regardless of config.git.branchPrefix.
 */
export function questBranchName(questId: string): string {
  return `quest/${questId}`;
}

/**
 * Create a quest branch from the project's base branch.
 * If the branch already exists, reuses it (idempotent for resume).
 */
export async function createQuestBranch(
  projectRoot: string,
  questId: string,
  baseBranch: string
): Promise<string> {
  const branch = questBranchName(questId);
  await createBranch(projectRoot, branch, baseBranch);
  return branch;
}

/**
 * Check if a quest branch exists locally.
 */
export function questBranchExists(
  projectRoot: string,
  questId: string
): boolean {
  return branchExists(projectRoot, questBranchName(questId));
}

/**
 * Delete a quest branch. Used when abandoning a quest.
 * Safe: only deletes if the branch is not checked out.
 */
export function deleteQuestBranch(
  projectRoot: string,
  questId: string
): boolean {
  const branch = questBranchName(questId);
  try {
    runSync(`git branch -D "${branch}"`, { cwd: projectRoot, silent: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the path to the worktrees directory: a sibling directory to
 * the project root named `<project-basename>-worktrees/`.
 *
 * Example: /home/user/my-project → /home/user/my-project-worktrees/
 */
export function worktreesDir(projectRoot: string): string {
  const parentDir = dirname(projectRoot);
  const projectName = basename(projectRoot);
  return resolve(parentDir, `${projectName}-worktrees`);
}

/**
 * Generate the worktree path for a feature.
 * All worktrees live inside a sibling `-worktrees` directory:
 *   <parentDir>/<projectName>-worktrees/<featureId>
 *
 * The `config` parameter is kept for API compatibility but is no longer
 * used (the old worktreePrefix config value has been removed).
 */
export function worktreePath(
  projectRoot: string,
  featureId: string,
  _config: WomboConfig
): string {
  return resolve(worktreesDir(projectRoot), featureId);
}

/**
 * Check whether the worktrees directory is empty (no remaining worktrees).
 * Returns true if the directory doesn't exist or is empty — useful as a
 * completion double-check after all agents finish.
 */
export function isWorktreesDirEmpty(projectRoot: string): boolean {
  const dir = worktreesDir(projectRoot);
  if (!existsSync(dir)) return true;
  try {
    const entries = readdirSync(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Worktree Lifecycle (async)
// ---------------------------------------------------------------------------

/**
 * Create a git worktree for a feature branch.
 * Returns the absolute path to the worktree.
 *
 * If a valid worktree already exists at the expected path (has .git file),
 * reuses it — this is essential for the resume case where worktrees have
 * real work but may be missing node_modules.
 */
export async function createWorktree(
  projectRoot: string,
  featureId: string,
  baseBranch: string,
  config: WomboConfig
): Promise<string> {
  const branch = featureBranchName(featureId, config);
  const wtPath = worktreePath(projectRoot, featureId, config);

  // If a valid worktree already exists, reuse it (resume case).
  // A git worktree has a .git *file* (not directory) pointing to the main repo.
  if (existsSync(wtPath) && existsSync(resolve(wtPath, ".git"))) {
    log(featureId, "reusing existing worktree (has work)");
    // Still copy config files in case they're missing
    copyConfigFiles(projectRoot, wtPath, featureId, config);
    return wtPath;
  }

  // Create the branch if it doesn't exist
  log(featureId, "creating branch...");
  await createBranch(projectRoot, branch, baseBranch);

  // Remove existing worktree directory if present but invalid
  if (existsSync(wtPath)) {
    log(featureId, "removing old worktree...");
    try {
      await runAsync(`git worktree remove --force "${wtPath}"`, {
        cwd: projectRoot,
      });
    } catch {
      await runAsync(`rm -rf "${wtPath}"`);
      await runAsync(`git worktree prune`, { cwd: projectRoot });
    }
  }

  // Create the worktree
  log(featureId, "creating worktree...");
  // Ensure the -worktrees parent directory exists
  const wtParentDir = worktreesDir(projectRoot);
  if (!existsSync(wtParentDir)) {
    mkdirSync(wtParentDir, { recursive: true });
  }
  await runAsync(`git worktree add "${wtPath}" "${branch}"`, {
    cwd: projectRoot,
  });

  // Copy agent config files into worktree
  copyConfigFiles(projectRoot, wtPath, featureId, config);

  log(featureId, "worktree ready");
  return wtPath;
}

/**
 * Copy agent config files from project root into a worktree.
 * Best-effort — logs warnings but doesn't throw.
 */
function copyConfigFiles(
  projectRoot: string,
  wtPath: string,
  featureId: string,
  config: WomboConfig
): void {
  for (const configFile of config.agent.configFiles) {
    const srcPath = resolve(projectRoot, configFile);
    if (!existsSync(srcPath)) continue;

    const destPath = resolve(wtPath, configFile);
    try {
      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        cpSync(srcPath, destPath, { recursive: true });
      } else {
        cpSync(srcPath, destPath);
      }
    } catch {
      // Non-critical — best effort
    }
  }

  // Verify all config files were copied successfully
  verifyConfigFiles(projectRoot, wtPath, featureId, config);
}

// ---------------------------------------------------------------------------
// Config File Verification
// ---------------------------------------------------------------------------

/**
 * Verify that all expected config files were copied into the worktree.
 * Logs a warning for any that are missing. This is a safety net on top
 * of the best-effort cpSync logic in createWorktree.
 */
export function verifyConfigFiles(
  projectRoot: string,
  wtPath: string,
  featureId: string,
  config: WomboConfig
): void {
  const missing: string[] = [];

  for (const configFile of config.agent.configFiles) {
    const srcPath = resolve(projectRoot, configFile);
    const destPath = resolve(wtPath, configFile);

    // Only check files/dirs that exist in the source project
    if (!existsSync(srcPath)) continue;

    if (!existsSync(destPath)) {
      missing.push(configFile);
    }
  }

  if (missing.length > 0) {
    log(
      featureId,
      `\x1b[33mWARNING\x1b[0m: config files missing in worktree: ${missing.join(", ")}`
    );
  }
}

/**
 * Install dependencies in a worktree.
 */
export async function installDeps(
  wtPath: string,
  featureId: string,
  config: WomboConfig
): Promise<void> {
  log(featureId, `running ${config.install.command}...`);
  const start = Date.now();
  await runAsync(config.install.command, {
    cwd: wtPath,
    timeoutMs: config.install.timeout,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(featureId, `install done (${elapsed}s)`);
}

/**
 * Check if a worktree already exists and has node_modules (fully ready).
 */
export function worktreeReady(wtPath: string): boolean {
  return (
    existsSync(wtPath) &&
    existsSync(resolve(wtPath, "node_modules"))
  );
}

/**
 * Check if a valid git worktree exists at the path (may lack node_modules).
 * A git worktree has a .git *file* (not directory) pointing to the main repo.
 */
export function worktreeExists(wtPath: string): boolean {
  return existsSync(wtPath) && existsSync(resolve(wtPath, ".git"));
}

/**
 * Check if a local branch exists in the repository.
 * Uses `git rev-parse --verify` which is the canonical way to check branch existence.
 */
export function branchExists(projectRoot: string, branchName: string): boolean {
  try {
    runSync(`git rev-parse --verify "refs/heads/${branchName}"`, {
      cwd: projectRoot,
      silent: true,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Worktree Listing / Cleanup (sync)
// ---------------------------------------------------------------------------

/**
 * List all git worktrees.
 */
export function listWorktrees(projectRoot: string): WorktreeInfo[] {
  const output = runSync("git worktree list --porcelain", {
    cwd: projectRoot,
    silent: true,
  });
  if (!output) return [];

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current as WorktreeInfo);
      current = { path: line.slice(9), bare: false };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "" && current.path) {
      worktrees.push(current as WorktreeInfo);
      current = {};
    }
  }
  if (current.path) worktrees.push(current as WorktreeInfo);

  return worktrees;
}

/**
 * List only wombo-related worktrees.
 *
 * SAFETY: Filters by checking that the worktree path lives inside the
 * dedicated `<project>-worktrees/` directory. The main repo worktree
 * (projectRoot) is always excluded as a defensive guard.
 *
 * Also matches worktrees whose branch starts with the branch prefix,
 * to catch orphans that may have been created by older versions or
 * under different layouts.
 */
export function listWomboWorktrees(
  projectRoot: string,
  config: WomboConfig
): WorktreeInfo[] {
  const resolvedRoot = resolve(projectRoot);
  const wtDir = resolve(worktreesDir(projectRoot));
  return listWorktrees(projectRoot).filter((wt) => {
    // Never include the main project root
    if (resolve(wt.path) === resolvedRoot) return false;
    // Match worktrees whose path is inside the -worktrees directory
    if (resolve(wt.path).startsWith(wtDir + "/")) return true;
    // Also match worktrees whose branch starts with the branch prefix —
    // catches orphans from old waves or legacy worktree layouts
    if (wt.branch && wt.branch.startsWith(config.git.branchPrefix)) return true;
    // Also match quest branches
    if (wt.branch && wt.branch.startsWith("quest/")) return true;
    return false;
  });
}

/**
 * Remove a worktree and optionally delete its branch.
 *
 * SAFETY: Refuses to remove the project root itself. This is a hard guard
 * against bugs in worktree filtering that could otherwise destroy the main repo.
 */
export function removeWorktree(
  projectRoot: string,
  wtPath: string,
  deleteBranchToo: boolean = true
): void {
  // Hard safety check: never remove the main project root
  if (resolve(wtPath) === resolve(projectRoot)) {
    throw new Error(
      `SAFETY: refusing to remove project root as worktree: ${wtPath}`
    );
  }

  const worktrees = listWorktrees(projectRoot);
  const wt = worktrees.find((w) => w.path === wtPath);

  try {
    runSync(`git worktree remove --force "${wtPath}"`, { cwd: projectRoot });
  } catch {
    if (existsSync(wtPath)) {
      runSync(`rm -rf "${wtPath}"`);
    }
    runSync("git worktree prune", { cwd: projectRoot });
  }

  if (deleteBranchToo && wt?.branch) {
    try {
      runSync(`git branch -D "${wt.branch}"`, {
        cwd: projectRoot,
        silent: true,
      });
    } catch {
      // Branch may have been merged or already deleted
    }
  }
}

/**
 * Check if a feature branch has any commits beyond the base branch.
 * Returns true if the branch has diverged (i.e., the agent made commits).
 */
export function branchHasChanges(
  projectRoot: string,
  branch: string,
  baseBranch: string
): boolean {
  try {
    const count = runSync(
      `git rev-list --count "${baseBranch}..${branch}"`,
      { cwd: projectRoot, silent: true }
    );
    return parseInt(count, 10) > 0;
  } catch {
    // If the branch doesn't exist or git fails, assume no changes
    return false;
  }
}

/**
 * Remove all wombo-related worktrees and prune.
 * After removal, if the `-worktrees` directory is empty, removes it too.
 */
export function cleanupAllWorktrees(
  projectRoot: string,
  config: WomboConfig
): number {
  const womboWorktrees = listWomboWorktrees(projectRoot, config);
  let removed = 0;
  for (const wt of womboWorktrees) {
    try {
      removeWorktree(projectRoot, wt.path, false);
      removed++;
    } catch (err: any) {
      console.error(`Failed to remove worktree ${wt.path}: ${err.message}`);
    }
  }
  try {
    runSync("git worktree prune", { cwd: projectRoot });
  } catch {
    // Prune is best-effort — may fail if repo state is already clean
  }

  // Clean up the -worktrees directory if it's now empty
  const wtDir = worktreesDir(projectRoot);
  if (existsSync(wtDir)) {
    try {
      const entries = readdirSync(wtDir);
      if (entries.length === 0) {
        rmdirSync(wtDir);
      }
    } catch {
      // Best-effort — directory may not exist or may have lingering files
    }
  }

  return removed;
}
