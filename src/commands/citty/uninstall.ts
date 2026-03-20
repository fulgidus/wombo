/**
 * uninstall.ts — Citty command definition for `woco uninstall`.
 *
 * Wraps the existing cmdUninstall() with citty's defineCommand() for typed args.
 * Config-independent: does not require project initialization.
 */

import { defineCommand } from "citty";
import { cmdUninstall } from "../uninstall";

export const uninstallCommand = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove .wombo-combo/ directory, git hooks, and optionally the global binary",
  },
  args: {
    force: {
      type: "boolean",
      description: "Skip confirmation prompt",
      required: false,
    },
    dryRun: {
      type: "boolean",
      alias: "dry-run",
      description: "Show what would be removed without doing it",
      required: false,
    },
    keepData: {
      type: "boolean",
      alias: "keep-data",
      description: "Preserve history and tasks data (only remove config/state/logs)",
      required: false,
    },
    removeBinary: {
      type: "boolean",
      alias: "remove-binary",
      description: "Also remove the global woco binary",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = process.cwd();

    const result = await cmdUninstall({
      projectRoot,
      force: args.force,
      dryRun: args.dryRun,
      keepData: args.keepData,
      removeBinary: args.removeBinary,
    });

    if (result.dry_run) {
      console.log("\n[dry-run] Would perform the following uninstall:\n");

      if (!result.wombo_dir_exists) {
        console.log("  .wombo-combo/ directory not found — nothing to remove.");
      } else {
        for (const item of result.items_to_remove) {
          console.log(`  Would remove: ${item}`);
        }
      }

      for (const hook of result.hooks_found) {
        console.log(`  Would remove hook: .git/hooks/${hook}`);
      }

      if (result.data_preserved) {
        console.log("\n  Data preserved: .wombo-combo/tasks/, .wombo-combo/archive/, .wombo-combo/history/");
      }

      if (result.items_to_remove.length === 0 && result.hooks_found.length === 0) {
        console.log("  Nothing to remove.");
      }
    } else {
      if (!result.wombo_dir_exists && result.hooks_found.length === 0) {
        // Already logged in cmdUninstall
        return;
      }

      if (result.wombo_dir_removed) {
        console.log("\nRemoved: .wombo-combo/");
      } else if (result.wombo_dir_exists) {
        if (result.data_preserved) {
          console.log("\nPreserved: .wombo-combo/tasks/, .wombo-combo/archive/, .wombo-combo/history/");
          for (const item of result.items_to_remove) {
            console.log(`Removed: ${item}`);
          }
        } else {
          // User cancelled
          return;
        }
      }

      if (result.hooks_removed && result.hooks_removed.length > 0) {
        for (const hook of result.hooks_removed) {
          console.log(`Removed hook: .git/hooks/${hook}`);
        }
      }

      if (result.wombo_dir_removed || (result.hooks_removed && result.hooks_removed.length > 0)) {
        console.log("\nUninstall complete.");
        if (result.data_preserved) {
          console.log("Note: Task and history data was preserved. Delete .wombo-combo/ manually to remove everything.");
        }
      }
    }
  },
});
