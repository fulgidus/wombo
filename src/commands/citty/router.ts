/**
 * router.ts — Bridge module that routes commands to citty definitions.
 *
 * This module provides:
 *   - `isCittyCommand(cmd)` — checks if a command is handled by citty
 *   - `runCittyCommand(cmd, rawArgs)` — runs the appropriate citty command
 *   - `resolveGlobalFlagsAndCommand(args)` — extracts global flags and
 *     determines the command from raw args
 *
 * It acts as the integration point between the existing hand-rolled CLI
 * in index.ts and the new citty command definitions.
 */

import { runCommand } from "citty";
import { versionCommand } from "./version.js";
import { helpCommand } from "./help.js";
import { describeCommand } from "./describe.js";
import { extractGlobalFlags, type GlobalFlags } from "./global-flags.js";
import { initCommand } from "./init.js";
import { statusCommand } from "./status.js";
import { verifyCommand } from "./verify.js";
import { mergeCommand } from "./merge.js";
import { abortCommand } from "./abort.js";
import { cleanupCommand } from "./cleanup.js";
import { historyCommand } from "./history.js";
import { logsCommand } from "./logs.js";
import { usageCommand } from "./usage.js";
import { upgradeCommand } from "./upgrade.js";
import { completionCommand } from "./completion.js";
import { launchCommand } from "./launch.js";
import { resumeCommand } from "./resume.js";
import { retryCommand } from "./retry.js";
import { tasksCommand } from "./tasks.js";
import { questCommand } from "./quest.js";
import { wishlistCommand } from "./wishlist.js";

/**
 * Set of all command names / aliases that are handled by citty.
 */
const CITTY_COMMANDS = new Set([
  // Existing commands
  "version",
  "-v",
  "-V",
  "help",
  "--help",
  "-h",
  "describe",
  // Core commands
  "init",
  "i",          // alias for init
  "status",
  "s",          // alias for status
  "verify",
  "v",          // alias for verify
  "merge",
  "m",          // alias for merge
  "abort",
  "a",          // alias for abort
  "cleanup",
  "c",          // alias for cleanup
  "history",
  "h",          // alias for history
  "logs",
  "lo",         // alias for logs
  "usage",
  "us",         // alias for usage
  "upgrade",
  "u",          // alias for upgrade (note: 'u' is for upgrade per schema)
  "completion",
  "comp",       // alias for completion
  // Launch/resume/retry commands
  "launch",
  "l",
  "resume",
  "r",
  "retry",
  "re",
  // Subcommand groups
  "tasks",
  "t",          // alias for tasks
  "features",   // alias for tasks (backward compat)
  "quest",
  "q",          // alias for quest
  "wishlist",
  "w",          // alias for wishlist
  "wl",         // alias for wishlist
]);

/**
 * Check if a command string is handled by a citty command definition.
 */
export function isCittyCommand(cmd: string): boolean {
  return CITTY_COMMANDS.has(cmd);
}

/**
 * Result of resolving global flags and command from raw args.
 */
export interface ResolvedCommand {
  /** The resolved command name (first non-flag arg, or "tui" if none) */
  command: string;
  /** Extracted global flags */
  globalFlags: GlobalFlags;
  /** Remaining args after global flags and command are stripped */
  remaining: string[];
}

/**
 * Extract global flags from raw args and determine the command.
 *
 * This is the citty-layer equivalent of the parseArgs pre-scan in index.ts.
 * It uses extractGlobalFlags() to pull out global flags, then treats the
 * first remaining arg as the command name.
 *
 * @param args - Raw CLI arguments (after slicing off bun/script path)
 * @returns The resolved command, global flags, and remaining args
 */
export function resolveGlobalFlagsAndCommand(args: string[]): ResolvedCommand {
  const { flags, remaining } = extractGlobalFlags(args);

  // First remaining arg is the command, rest are command-specific args
  const command = remaining[0] || "tui";
  const commandArgs = remaining.slice(1);

  return {
    command,
    globalFlags: flags,
    remaining: commandArgs,
  };
}

/**
 * Route a command to the appropriate citty command definition and run it.
 *
 * @param cmd - The command name or alias (e.g. "version", "-v", "help", "describe", "init", etc.)
 * @param rawArgs - The remaining raw CLI arguments to pass through
 */
export async function runCittyCommand(
  cmd: string,
  rawArgs: string[]
): Promise<void> {
  switch (cmd) {
    case "version":
    case "-v":
    case "-V":
      await runCommand(versionCommand, { rawArgs });
      break;

    case "help":
    case "--help":
    case "-h":
      await runCommand(helpCommand, { rawArgs });
      break;

    case "describe":
      await runCommand(describeCommand, { rawArgs });
      break;

    case "init":
    case "i":
      await runCommand(initCommand, { rawArgs });
      break;

    case "status":
    case "s":
      await runCommand(statusCommand, { rawArgs });
      break;

    case "verify":
    case "v":
      await runCommand(verifyCommand, { rawArgs });
      break;

    case "merge":
    case "m":
      await runCommand(mergeCommand, { rawArgs });
      break;

    case "abort":
    case "a":
      await runCommand(abortCommand, { rawArgs });
      break;

    case "cleanup":
    case "c":
      await runCommand(cleanupCommand, { rawArgs });
      break;

    case "history":
    case "h":
      await runCommand(historyCommand, { rawArgs });
      break;

    case "logs":
    case "lo":
      await runCommand(logsCommand, { rawArgs });
      break;

    case "usage":
    case "us":
      await runCommand(usageCommand, { rawArgs });
      break;

    case "upgrade":
    case "u":
      await runCommand(upgradeCommand, { rawArgs });
      break;

    case "completion":
    case "comp":
      await runCommand(completionCommand, { rawArgs });
      break;

    case "launch":
    case "l":
      await runCommand(launchCommand, { rawArgs });
      break;

    case "resume":
    case "r":
      await runCommand(resumeCommand, { rawArgs });
      break;

    case "retry":
    case "re":
      await runCommand(retryCommand, { rawArgs });
      break;

    case "tasks":
    case "t":
    case "features":
      await runCommand(tasksCommand, { rawArgs });
      break;

    case "quest":
    case "q":
      await runCommand(questCommand, { rawArgs });
      break;

    case "wishlist":
    case "w":
    case "wl":
      await runCommand(wishlistCommand, { rawArgs });
      break;

    default:
      throw new Error(`Not a citty command: "${cmd}"`);
  }
}
