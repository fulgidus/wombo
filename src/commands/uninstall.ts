/**
 * uninstall.ts — Remove all wombo-combo files from a project.
 *
 * Usage:
 *   woco uninstall              # Prompt for confirmation, then remove all
 *   woco uninstall --force      # Skip confirmation prompt
 *   woco uninstall --keep-data  # Preserve history and tasks, remove config only
 *   woco uninstall --dry-run    # Show what would be removed without doing it
 *
 * This command:
 *   - Shows a confirmation prompt listing what will be deleted
 *   - Removes .wombo-combo/ directory (or selective subdirs with --keep-data)
 *   - Uninstalls git hooks (pre-push, post-merge) if they were installed
 *   - Optionally removes the global binary (when --remove-binary is set)
 */

import { existsSync, rmSync, unlinkSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { WOMBO_DIR } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UninstallOptions {
  /** Project root directory */
  projectRoot: string;
  /** Skip confirmation prompt */
  force?: boolean;
  /** Only show what would be removed, don't actually remove */
  dryRun?: boolean;
  /** Preserve history and tasks data (only remove config/state/logs) */
  keepData?: boolean;
  /** Also remove the global woco binary */
  removeBinary?: boolean;
}

/** Names of git hooks that wombo-combo may install */
const WOMBO_HOOKS = ["pre-push", "post-merge"] as const;

/**
 * Result of the uninstall operation.
 */
export interface UninstallResult {
  /** Whether this was a dry-run */
  dry_run: boolean;
  /** Whether the .wombo-combo directory existed */
  wombo_dir_exists: boolean;
  /** Whether the .wombo-combo directory was removed (non-dry-run only) */
  wombo_dir_removed?: boolean;
  /** Items that would be (dry-run) or were removed */
  items_to_remove: string[];
  /** Git hooks found in .git/hooks/ */
  hooks_found: string[];
  /** Git hooks that were removed (non-dry-run only) */
  hooks_removed?: string[];
  /** Whether data (history, tasks) was preserved (keepData mode) */
  data_preserved: boolean;
  /** Whether the global binary was removed */
  binary_removed?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find wombo-combo git hooks installed in .git/hooks/.
 * A hook is considered "wombo" if it exists in our hooks list.
 * We don't try to detect if it was installed by wombo-combo specifically,
 * since hooks may have been modified after installation.
 */
function findInstalledHooks(projectRoot: string): string[] {
  const hooksDir = join(projectRoot, ".git", "hooks");
  if (!existsSync(hooksDir)) return [];

  const found: string[] = [];
  for (const hookName of WOMBO_HOOKS) {
    const hookPath = join(hooksDir, hookName);
    if (existsSync(hookPath)) {
      found.push(hookName);
    }
  }
  return found;
}

/**
 * Remove a git hook by name.
 * Returns true if removed, false if it didn't exist.
 */
function removeHook(projectRoot: string, hookName: string): boolean {
  const hookPath = join(projectRoot, ".git", "hooks", hookName);
  if (!existsSync(hookPath)) return false;
  unlinkSync(hookPath);
  return true;
}

/**
 * Prompt the user for yes/no confirmation.
 * Returns true if the user confirms.
 */
async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // non-interactive → deny by default

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

/**
 * Get items that would be removed for display purposes.
 * Returns array of relative paths.
 */
function getItemsToRemove(projectRoot: string, keepData: boolean): string[] {
  const womboDir = resolve(projectRoot, WOMBO_DIR);
  if (!existsSync(womboDir)) return [];

  if (!keepData) {
    // Remove everything
    return [".wombo-combo"];
  }

  // keepData: only remove config/state/logs, preserve tasks/archive/history
  const items: string[] = [];
  const toCheck = [
    ".wombo-combo/config.json",
    ".wombo-combo/state.json",
    ".wombo-combo/logs",
    ".wombo-combo/tui-session.json",
    ".wombo-combo/usage.jsonl",
    ".wombo-combo/agents-cache",
  ];

  for (const item of toCheck) {
    if (existsSync(resolve(projectRoot, item))) {
      items.push(item);
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Uninstall wombo-combo from a project.
 *
 * Removes .wombo-combo/ and git hooks. Optionally preserves task/history data.
 *
 * @param opts - Uninstall options
 * @returns UninstallResult with details of what was/would be removed
 */
export async function cmdUninstall(opts: UninstallOptions): Promise<UninstallResult> {
  const { projectRoot, dryRun = false, force = false, keepData = false } = opts;

  const womboDir = resolve(projectRoot, WOMBO_DIR);
  const womboDirExists = existsSync(womboDir);
  const hooksFound = findInstalledHooks(projectRoot);
  const itemsToRemove = getItemsToRemove(projectRoot, keepData);

  // -------------------------------------------------------------------------
  // Dry-run mode: report without removing
  // -------------------------------------------------------------------------
  if (dryRun) {
    return {
      dry_run: true,
      wombo_dir_exists: womboDirExists,
      items_to_remove: itemsToRemove,
      hooks_found: hooksFound,
      data_preserved: keepData,
    };
  }

  // -------------------------------------------------------------------------
  // Interactive confirmation (unless --force)
  // -------------------------------------------------------------------------
  if (!force) {
    console.log("\n--- wombo-combo: Uninstall ---\n");

    if (!womboDirExists && hooksFound.length === 0) {
      console.log("Nothing to uninstall. .wombo-combo/ directory not found.");
      return {
        dry_run: false,
        wombo_dir_exists: false,
        wombo_dir_removed: false,
        items_to_remove: [],
        hooks_found: [],
        hooks_removed: [],
        data_preserved: false,
      };
    }

    console.log("The following will be removed:\n");
    for (const item of itemsToRemove) {
      console.log(`  ${item}`);
    }
    for (const hook of hooksFound) {
      console.log(`  .git/hooks/${hook}`);
    }

    if (keepData) {
      console.log("\nData preserved: .wombo-combo/tasks/, .wombo-combo/archive/, .wombo-combo/history/");
    }

    console.log("");

    const ok = await confirm("Proceed with uninstall?");
    if (!ok) {
      console.log("Uninstall cancelled.");
      return {
        dry_run: false,
        wombo_dir_exists: womboDirExists,
        wombo_dir_removed: false,
        items_to_remove: itemsToRemove,
        hooks_found: hooksFound,
        hooks_removed: [],
        data_preserved: keepData,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Perform uninstall
  // -------------------------------------------------------------------------
  const hooksRemoved: string[] = [];
  let womboDirRemoved = false;

  // Remove git hooks
  for (const hookName of hooksFound) {
    if (removeHook(projectRoot, hookName)) {
      hooksRemoved.push(hookName);
    }
  }

  // Remove .wombo-combo directory
  if (womboDirExists) {
    if (!keepData) {
      // Remove everything
      rmSync(womboDir, { recursive: true, force: true });
      womboDirRemoved = true;
    } else {
      // keepData: remove only config/state/logs, preserve tasks/archive/history
      for (const item of itemsToRemove) {
        const itemPath = resolve(projectRoot, item);
        if (existsSync(itemPath)) {
          rmSync(itemPath, { recursive: true, force: true });
        }
      }
      // Don't mark wombo_dir_removed because we preserved data
      womboDirRemoved = false;
    }
  }

  return {
    dry_run: false,
    wombo_dir_exists: womboDirExists,
    wombo_dir_removed: womboDirRemoved,
    items_to_remove: itemsToRemove,
    hooks_found: hooksFound,
    hooks_removed: hooksRemoved,
    data_preserved: keepData,
  };
}
