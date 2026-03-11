/**
 * cleanup.ts — Remove all wave-related resources.
 *
 * Usage: wombo cleanup
 *
 * Kills tmux sessions, removes worktrees, removes state and log files.
 */

import { existsSync, unlinkSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type { WomboConfig } from "../config.js";
import { killAllTmuxSessions } from "../lib/launcher.js";
import { cleanupAllWorktrees } from "../lib/worktree.js";

export interface CleanupOptions {
  projectRoot: string;
  config: WomboConfig;
}

export async function cmdCleanup(opts: CleanupOptions): Promise<void> {
  const { projectRoot, config } = opts;

  console.log("\n--- Wombo: Cleanup ---\n");

  // Kill tmux sessions
  const killed = killAllTmuxSessions(config);
  console.log(`Killed ${killed} tmux session(s)`);

  // Remove worktrees
  const removed = cleanupAllWorktrees(projectRoot, config);
  console.log(`Removed ${removed} worktree(s)`);

  // List remaining feature branches
  try {
    const branchPattern = `"${config.git.branchPrefix}*"`;
    const branches = execSync(`git branch --list ${branchPattern}`, {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
    if (branches) {
      console.log(`\nRemaining feature branches:\n${branches}`);
      console.log('Use "git branch -D <branch>" to remove manually.');
    }
  } catch {}

  // Remove state file
  const statePath = resolve(projectRoot, ".wombo-state.json");
  if (existsSync(statePath)) {
    unlinkSync(statePath);
    console.log("Removed .wombo-state.json");
  }

  // Remove log directory
  const logDir = resolve(projectRoot, ".wombo-logs");
  if (existsSync(logDir)) {
    rmSync(logDir, { recursive: true, force: true });
    console.log("Removed .wombo-logs/");
  }

  console.log("\nCleanup complete.");
}
