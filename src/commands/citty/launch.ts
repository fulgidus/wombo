/**
 * launch.ts — Citty command definition for `woco launch`.
 *
 * Parses all launch-related flags using citty's declarative args schema,
 * then delegates to the existing `cmdLaunch()` implementation in
 * `src/commands/launch.ts`.
 *
 * Flags:
 *   Selection: --top-priority, --quickest-wins, --priority, --difficulty,
 *              --tasks/--features, --all-ready
 *   Launch:    --max-concurrent, --model/-m, --interactive, --dry-run,
 *              --base-branch, --max-retries, --no-tui, --auto-push,
 *              --agent, --quest, --browser
 *   Output:    --output/-o
 */

import { defineCommand } from "citty";
import { resolve } from "node:path";
import { loadConfig, validateConfig, isProjectInitialized, WOMBO_DIR } from "../../config.js";
import { ensureTasksFile } from "../../lib/tasks.js";
import type { Priority, Difficulty } from "../../lib/tasks.js";
import { resolveOutputFormat, outputError, type OutputFormat } from "../../lib/output.js";
import { cmdLaunch, type LaunchCommandOptions } from "../launch.js";

// ---------------------------------------------------------------------------
// Parsed launch args (intermediate representation before config merge)
// ---------------------------------------------------------------------------

export interface ParsedLaunchArgs {
  // Selection
  topPriority?: number;
  quickestWins?: number;
  priority?: Priority;
  difficulty?: Difficulty;
  features?: string[];
  allReady: boolean;
  // Launch
  maxConcurrent?: number;
  model?: string;
  interactive: boolean;
  dryRun: boolean;
  baseBranch?: string;
  maxRetries?: number;
  noTui: boolean;
  autoPush: boolean;
  agent?: string;
  questId?: string;
  browser?: boolean;
  // Output
  outputFmt?: OutputFormat;
}

/**
 * Parse raw citty args into a typed intermediate representation.
 * Numeric values are parsed from strings, booleans get defaults,
 * and comma-separated lists are split.
 *
 * Exported for testing — the citty `run()` handler calls this internally.
 */
export function parseLaunchArgs(args: Record<string, any>): ParsedLaunchArgs {
  return {
    // Selection
    topPriority: args.topPriority ? parseInt(args.topPriority, 10) : undefined,
    quickestWins: args.quickestWins ? parseInt(args.quickestWins, 10) : undefined,
    priority: args.priority as Priority | undefined,
    difficulty: args.difficulty as Difficulty | undefined,
    features: args.tasks
      ? (args.tasks as string).split(",").map((s: string) => s.trim())
      : undefined,
    allReady: args.allReady ?? false,
    // Launch
    maxConcurrent: args.maxConcurrent
      ? parseInt(args.maxConcurrent, 10)
      : undefined,
    model: args.model ?? undefined,
    interactive: args.interactive ?? false,
    dryRun: args.dryRun ?? false,
    baseBranch: args.baseBranch ?? undefined,
    maxRetries: args.maxRetries
      ? parseInt(args.maxRetries, 10)
      : undefined,
    noTui: args.noTui ?? false,
    autoPush: args.autoPush ?? false,
    agent: args.agent ?? undefined,
    questId: args.quest ?? undefined,
    browser: args.browser ?? undefined,
    // Output
    outputFmt: args.output
      ? resolveOutputFormat(args.output)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Citty command definition
// ---------------------------------------------------------------------------

export const launchCommand = defineCommand({
  meta: {
    name: "launch",
    description: "Launch a wave of agents (also: l)",
  },
  args: {
    // --- Selection options ---
    topPriority: {
      type: "string",
      description: "Launch N highest-priority ready tasks",
      required: false,
    },
    quickestWins: {
      type: "string",
      description: "Launch N easiest/fastest ready tasks",
      required: false,
    },
    priority: {
      type: "string",
      description: "Filter tasks by priority (critical|high|medium|low|wishlist)",
      required: false,
    },
    difficulty: {
      type: "string",
      description: "Filter tasks by difficulty (trivial|easy|medium|hard|very_hard)",
      required: false,
    },
    tasks: {
      type: "string",
      description: "Comma-separated list of task IDs to launch",
      required: false,
    },
    allReady: {
      type: "boolean",
      description: "Launch all tasks with status 'ready'",
      required: false,
    },

    // --- Launch / runtime options ---
    maxConcurrent: {
      type: "string",
      description: "Maximum number of concurrent agents",
      required: false,
    },
    model: {
      type: "string",
      alias: "m",
      description: "AI model to use for agents",
      required: false,
    },
    interactive: {
      type: "boolean",
      description: "Launch agents in interactive (multiplexer) mode",
      required: false,
    },
    dryRun: {
      type: "boolean",
      description: "Show what would be launched without actually launching",
      required: false,
    },
    baseBranch: {
      type: "string",
      description: "Base branch to create feature branches from",
      required: false,
    },
    maxRetries: {
      type: "string",
      description: "Maximum number of retries per agent",
      required: false,
    },
    noTui: {
      type: "boolean",
      description: "Disable TUI dashboard, use plain console output",
      required: false,
    },
    autoPush: {
      type: "boolean",
      description: "Automatically push branches after merge",
      required: false,
    },
    agent: {
      type: "string",
      description: "Use a specific local agent definition for all tasks",
      required: false,
    },
    quest: {
      type: "string",
      description: "Quest ID to scope this launch to",
      required: false,
    },
    browser: {
      type: "boolean",
      description: "Enable browser verification for launched agents",
      required: false,
    },

    // --- Output ---
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text (default), json, or toon",
      required: false,
    },

    // --- Global ---
    dev: {
      type: "boolean",
      description: "Enable developer mode (hidden TUI features, etc.)",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(process.cwd());
    const parsed = parseLaunchArgs(args);
    const fmt = parsed.outputFmt ?? "text";

    // Load and validate config
    const config = loadConfig(projectRoot);
    validateConfig(config);

    // Apply --dev flag (global pre-command flag)
    if (args.dev) {
      config.devMode = true;
    }

    // Guard: project must be initialized
    if (!isProjectInitialized(projectRoot)) {
      console.error(
        `\nThis project hasn't been initialized yet.\n` +
          `Run \`woco init\` to set up ${WOMBO_DIR}/ with config, tasks, and archive stores.\n`
      );
      process.exit(1);
    }

    // Ensure tasks file exists
    await ensureTasksFile(projectRoot, config);

    // Apply browser verification override
    if (parsed.browser !== undefined) {
      config.browser.enabled = parsed.browser;
    }

    // Build LaunchCommandOptions, merging parsed args with config defaults
    const opts: LaunchCommandOptions = {
      projectRoot,
      config,
      topPriority: parsed.topPriority,
      quickestWins: parsed.quickestWins,
      priority: parsed.priority,
      difficulty: parsed.difficulty,
      features: parsed.features,
      allReady: parsed.allReady,
      maxConcurrent: parsed.maxConcurrent ?? config.defaults.maxConcurrent,
      model: parsed.model,
      interactive: parsed.interactive,
      dryRun: parsed.dryRun,
      baseBranch: parsed.baseBranch ?? config.baseBranch,
      maxRetries: parsed.maxRetries ?? config.defaults.maxRetries,
      noTui: parsed.noTui,
      autoPush: parsed.autoPush,
      outputFmt: parsed.outputFmt,
      agent: parsed.agent,
      questId: parsed.questId,
    };

    try {
      await cmdLaunch(opts);
    } catch (err: any) {
      outputError(fmt, err.message);
    }
  },
});
