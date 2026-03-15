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

/**
 * Set of all command names / aliases that are handled by citty.
 */
const CITTY_COMMANDS = new Set([
  "version",
  "-v",
  "-V",
  "help",
  "--help",
  "-h",
  "describe",
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
 * @param cmd - The command name or alias (e.g. "version", "-v", "help", "describe")
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

    default:
      throw new Error(`Not a citty command: "${cmd}"`);
  }
}
