/**
 * cleanup.ts — Remove all wave-related resources.
 *
 * Usage: woco cleanup
 *
 * Kills multiplexer sessions (dmux/tmux), removes worktrees, removes state and log files.
 *
 * NOTE: .wombo-combo/history/ is intentionally NOT removed by cleanup.
 * Wave history records are meant to survive cleanup for retrospective
 * analysis. See src/lib/history.ts.
 */

import { existsSync, unlinkSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type { WomboConfig } from "../config.js";
import { WOMBO_DIR } from "../config.js";
import { killAllMuxSessions, getMultiplexerName } from "../lib/launcher.js";
import { cleanupAllWorktrees, listWomboWorktrees } from "../lib/worktree.js";
import {
  detectMultiplexer,
  muxListSessions,
} from "../lib/multiplexer.js";
import { output, outputMessage, type OutputFormat } from "../lib/output.js";
import { renderCleanup } from "../lib/toon.js";

export interface CleanupOptions {
  projectRoot: string;
  config: WomboConfig;
  dryRun?: boolean;
  outputFmt?: OutputFormat;
}

export async function cmdCleanup(opts: CleanupOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  // Dry-run: show what would be cleaned up without doing it
  if (opts.dryRun) {
    // List multiplexer sessions that would be killed
    const muxName = getMultiplexerName(config);
    let matchingSessions: string[] = [];
    try {
      const mux = detectMultiplexer(config.agent.multiplexer);
      const sessions = muxListSessions(mux);
      const prefix = config.agent.tmuxPrefix;
      matchingSessions = sessions.filter((s) => s.startsWith(prefix));
    } catch {
      // no mux server running
    }

    // List worktrees that would be removed (using safe filtering)
    let matchingWorktrees: { path: string }[] = [];
    try {
      matchingWorktrees = listWomboWorktrees(projectRoot, config);
    } catch {
      // no worktrees
    }

    const statePath = resolve(projectRoot, WOMBO_DIR, "state.json");
    const logDir = resolve(projectRoot, WOMBO_DIR, "logs");
    const filesToRemove: string[] = [];
    if (existsSync(statePath)) filesToRemove.push(".wombo-combo/state.json");
    if (existsSync(logDir)) filesToRemove.push(".wombo-combo/logs/");

    const dryRunResult = {
      dry_run: true,
      mux_sessions: matchingSessions,
      mux_sessions_count: matchingSessions.length,
      worktrees: matchingWorktrees.map((wt) => wt.path),
      worktrees_count: matchingWorktrees.length,
      files_to_remove: filesToRemove,
    };

    output(fmt, dryRunResult, () => {
      console.log("\n[dry-run] Would perform the following cleanup:\n");
      console.log(`  ${muxName} sessions to kill: ${matchingSessions.length}`);
      for (const s of matchingSessions) {
        console.log(`    ${s}`);
      }
      console.log(`  worktrees to remove: ${matchingWorktrees.length}`);
      for (const wt of matchingWorktrees) {
        console.log(`    ${wt.path}`);
      }
      for (const f of filesToRemove) {
        console.log(`  Would remove: ${f}`);
      }
    }, () => {
      console.log(renderCleanup(dryRunResult));
    });

    return;
  }

  // Kill multiplexer sessions
  const muxName = getMultiplexerName(config);
  const killed = killAllMuxSessions(config);

  // Remove worktrees
  const removed = cleanupAllWorktrees(projectRoot, config);

  // List remaining feature branches
  let remainingBranches: string[] = [];
  try {
    const branchPattern = `"${config.git.branchPrefix}*"`;
    const branchesRaw = execSync(`git branch --list ${branchPattern}`, {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
    if (branchesRaw) {
      remainingBranches = branchesRaw.split("\n").map((b) => b.trim());
    }
  } catch {}

  // Remove state file
  const statePath = resolve(projectRoot, WOMBO_DIR, "state.json");
  const stateRemoved = existsSync(statePath);
  if (stateRemoved) {
    unlinkSync(statePath);
  }

  // Remove log directory
  const logDir = resolve(projectRoot, WOMBO_DIR, "logs");
  const logsRemoved = existsSync(logDir);
  if (logsRemoved) {
    rmSync(logDir, { recursive: true, force: true });
  }

  // Check if history is preserved
  const historyDir = resolve(projectRoot, WOMBO_DIR, "history");
  const historyPreserved = existsSync(historyDir);

  const result = {
    mux_sessions_killed: killed,
    worktrees_removed: removed,
    state_removed: stateRemoved,
    logs_removed: logsRemoved,
    remaining_branches: remainingBranches,
    history_preserved: historyPreserved,
  };

  output(fmt, result, () => {
    console.log("\n--- wombo-combo: Cleanup ---\n");
    console.log(`Killed ${killed} ${muxName} session(s)`);
    console.log(`Removed ${removed} worktree(s)`);

    if (remainingBranches.length > 0) {
      console.log(`\nRemaining feature branches:\n${remainingBranches.map((b) => `  ${b}`).join("\n")}`);
      console.log('Use "git branch -D <branch>" to remove manually.');
    }

    if (stateRemoved) console.log("Removed .wombo-combo/state.json");
    if (logsRemoved) console.log("Removed .wombo-combo/logs/");

    console.log("\nCleanup complete.");

    if (historyPreserved) {
      console.log("Note: .wombo-combo/history/ is preserved. Use 'woco history' to view past waves.");
    }
  }, () => {
    console.log(renderCleanup(result));
  });
}
