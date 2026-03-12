/**
 * cleanup.ts — Remove all wave-related resources.
 *
 * Usage: wombo cleanup
 *
 * Kills multiplexer sessions (dmux/tmux), removes worktrees, removes state and log files.
 *
 * NOTE: .wombo-history/ is intentionally NOT removed by cleanup.
 * Wave history records are meant to survive cleanup for retrospective
 * analysis. See src/lib/history.ts.
 */

import { existsSync, unlinkSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type { WomboConfig } from "../config.js";
import { killAllMuxSessions, getMultiplexerName } from "../lib/launcher.js";
import { cleanupAllWorktrees, listWomboWorktrees } from "../lib/worktree.js";
import {
  detectMultiplexer,
  muxListSessions,
} from "../lib/multiplexer.js";

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

    // List multiplexer sessions that would be killed
    const muxName = getMultiplexerName(config);
    try {
      const mux = detectMultiplexer(config.agent.multiplexer);
      const sessions = muxListSessions(mux);
      const prefix = config.agent.tmuxPrefix;
      const matching = sessions.filter((s) => s.startsWith(prefix));
      console.log(`  ${muxName} sessions to kill: ${matching.length}`);
      for (const s of matching) {
        console.log(`    ${s}`);
      }
    } catch {
      console.log(`  ${muxName} sessions to kill: 0 (no ${muxName} server running)`);
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

  // Kill multiplexer sessions
  const muxName = getMultiplexerName(config);
  const killed = killAllMuxSessions(config);
  console.log(`Killed ${killed} ${muxName} session(s)`);

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

  // Inform the user that history is preserved
  const historyDir = resolve(projectRoot, ".wombo-history");
  if (existsSync(historyDir)) {
    console.log("Note: .wombo-history/ is preserved. Use 'wombo history' to view past waves.");
  }
}
