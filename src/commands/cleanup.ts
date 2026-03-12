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
import { cleanupAllWorktrees, listWomboWorktrees } from "../lib/worktree.js";

export interface CleanupOptions {
  projectRoot: string;
  config: WomboConfig;
  dryRun?: boolean;
}

export async function cmdCleanup(opts: CleanupOptions): Promise<void> {
  const { projectRoot, config } = opts;

  // Dry-run: show what would be cleaned up without doing it
  if (opts.dryRun) {
    console.log("\n[dry-run] Would perform the following cleanup:\n");

    // List tmux sessions that would be killed
    try {
      const sessions = execSync("tmux list-sessions -F '#{session_name}'", {
        encoding: "utf-8",
      }).trim();
      const prefix = config.agent.tmuxPrefix;
      const matching = sessions
        .split("\n")
        .filter((s) => s.startsWith(prefix));
      console.log(`  tmux sessions to kill: ${matching.length}`);
      for (const s of matching) {
        console.log(`    ${s}`);
      }
    } catch {
      console.log("  tmux sessions to kill: 0 (no tmux server running)");
    }

    // List worktrees that would be removed (using safe filtering)
    try {
      const matching = listWomboWorktrees(projectRoot, config);
      console.log(`  worktrees to remove: ${matching.length}`);
      for (const wt of matching) {
        console.log(`    ${wt.path}`);
      }
    } catch {
      console.log("  worktrees to remove: 0");
    }

    const statePath = resolve(projectRoot, ".wombo-state.json");
    const logDir = resolve(projectRoot, ".wombo-logs");
    if (existsSync(statePath)) console.log("  Would remove: .wombo-state.json");
    if (existsSync(logDir)) console.log("  Would remove: .wombo-logs/");

    return;
  }

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
