/**
 * router.ts — Bridge module that routes ALL commands to citty definitions.
 *
 * This module provides:
 *   - `isCittyCommand(cmd)` — checks if a command is handled by citty
 *   - `runCittyCommand(cmd, rawArgs)` — runs the appropriate citty command
 *   - `resolveGlobalFlagsAndCommand(args)` — extracts global flags and
 *     determines the command from raw args
 *
 * All CLI commands are now routed through citty. The hand-rolled parser
 * in index.ts has been removed.
 */

import { runCommand } from "citty";
import { versionCommand } from "./version";
import { helpCommand } from "./help";
import { describeCommand } from "./describe";
import { extractGlobalFlags, type GlobalFlags } from "./global-flags";
import { initCommand } from "./init";
import { statusCommand } from "./status";
import { verifyCommand } from "./verify";
import { mergeCommand } from "./merge";
import { abortCommand } from "./abort";
import { cleanupCommand } from "./cleanup";
import { historyCommand } from "./history";
import { logsCommand } from "./logs";
import { usageCommand } from "./usage";
import { upgradeCommand } from "./upgrade";
import { completionCommand } from "./completion";
import { launchCommand } from "./launch";
import { resumeCommand } from "./resume";
import { retryCommand } from "./retry";
import { tasksCommand } from "./tasks";
import { questCommand } from "./quest";
import { genesisCommand } from "./genesis";
import { wishlistCommand } from "./wishlist";
import { tuiCommand } from "./tui";
import { daemonCommand } from "./daemon";
import { uninstallCommand } from "./uninstall";

/**
 * Set of all command names / aliases that are handled by citty.
 */
const CITTY_COMMANDS = new Set([
    // --- Utility commands ---
    "version",
    "-v",
    "-V",
    "help",
    "--help",
    "-h",
    "describe",
    "d",          // alias for describe
    // --- Core commands ---
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
    "u",          // alias for upgrade
    "completion",
    "comp",       // alias for completion
    // --- Launch/resume/retry commands ---
    "launch",
    "l",
    "resume",
    "r",
    "retry",
    "re",
    // --- Tasks command (with subcommands) ---
    "tasks",
    "t",          // alias for tasks
    "features",   // backward-compat alias for tasks
    // --- Quest command (with subcommands) ---
    "quest",
    "q",          // alias for quest
    // --- Genesis command ---
    "genesis",
    "g",          // alias for genesis
    // --- Wishlist command (with subcommands) ---
    "wishlist",
    "w",          // alias for wishlist
    "wl",         // alias for wishlist
    // --- TUI (default command) ---
    "tui",
    // --- Daemon management ---
    "daemon",
    "dm",         // alias for daemon
    // --- Uninstall ---
    "uninstall",
    "un",         // alias for uninstall
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
 * Commands whose parent `run()` has been removed because citty always
 * executes both the matched subcommand AND the parent run(), causing
 * double output. For these commands, if no subcommand is provided we
 * inject the default ("list") before calling citty.
 */
const DEFAULT_SUBCOMMAND: Record<string, string> = {
    tasks: "list",
    quest: "list",
    wishlist: "list",
    daemon: "status",
};

/**
 * If rawArgs is empty or starts with a flag (no subcommand positional),
 * prepend the default subcommand so citty routes correctly.
 */
function injectDefaultSubcommand(cmd: string, rawArgs: string[]): string[] {
    const defaultSub = DEFAULT_SUBCOMMAND[cmd];
    if (!defaultSub) return rawArgs;

    // If there are no args, or the first arg is a flag, inject the default
    if (rawArgs.length === 0 || rawArgs[0].startsWith("-")) {
        return [defaultSub, ...rawArgs];
    }
    return rawArgs;
}

/**
 * Route a command to the appropriate citty command definition and run it.
 *
 * @param cmd - The command name or alias (e.g. "version", "-v", "tasks", "t", etc.)
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
        case "d":
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
            // case "features": // Deprecated. We can remove this alias after a few releases.
            await runCommand(tasksCommand, { rawArgs: injectDefaultSubcommand("tasks", rawArgs) });
            break;

        case "quest":
        case "q":
            await runCommand(questCommand, { rawArgs: injectDefaultSubcommand("quest", rawArgs) });
            break;

        case "genesis":
        case "g":
            await runCommand(genesisCommand, { rawArgs });
            break;

        case "wishlist":
        case "w":
        case "wl":
            await runCommand(wishlistCommand, { rawArgs: injectDefaultSubcommand("wishlist", rawArgs) });
            break;

        case "tui":
            await runCommand(tuiCommand, { rawArgs });
            break;

        case "daemon":
        case "dm":
            await runCommand(daemonCommand, { rawArgs: injectDefaultSubcommand("daemon", rawArgs) });
            break;

        case "uninstall":
        case "un":
            await runCommand(uninstallCommand, { rawArgs });
            break;

        default:
            throw new Error(`Not a citty command: "${cmd}"`);
    }
}
