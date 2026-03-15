/**
 * router.ts — Bridge module that routes commands to citty definitions.
 *
 * This module provides:
 *   - `isCittyCommand(cmd)` — checks if a command is handled by citty
 *   - `runCittyCommand(cmd, rawArgs)` — runs the appropriate citty command
 *
 * It acts as the integration point between the existing hand-rolled CLI
 * in index.ts and the new citty command definitions.
 */

import { runCommand } from "citty";
import { versionCommand } from "./version.js";
import { helpCommand } from "./help.js";
import { describeCommand } from "./describe.js";
import { launchCommand } from "./launch.js";
import { resumeCommand } from "./resume.js";
import { retryCommand } from "./retry.js";

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
  "launch",
  "l",
  "resume",
  "r",
  "retry",
  "re",
]);

/**
 * Check if a command string is handled by a citty command definition.
 */
export function isCittyCommand(cmd: string): boolean {
  return CITTY_COMMANDS.has(cmd);
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

    default:
      throw new Error(`Not a citty command: "${cmd}"`);
  }
}
