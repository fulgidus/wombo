#!/usr/bin/env bun
/**
 * index.ts — CLI entry point for the Wombo agent orchestration system.
 *
 * Usage:
 *   wombo init
 *   wombo launch --top-priority 3
 *   wombo launch --quickest-wins 5
 *   wombo launch --priority high
 *   wombo launch --difficulty easy
 *   wombo launch --features "feat-a,feat-b"
 *   wombo launch --all-ready
 *   wombo launch ... --max-concurrent 3 --model "anthropic/claude-sonnet-4-20250514"
 *   wombo launch ... --interactive
 *   wombo resume
 *   wombo status
 *   wombo verify [feature-id]
 *   wombo merge [feature-id]
 *   wombo retry <feature-id>
 *   wombo cleanup
 *   wombo features list [--status <s>] [--priority <p>] [--difficulty <d>] [--ready] [--include-archive]
 *   wombo features add <id> <title> [options]
 *   wombo features set-status <feature-id> <status>
 *   wombo features check
 *   wombo features archive [feature-id] [--dry-run]
 *   wombo features show <feature-id>
 *   wombo help
 */

import { resolve } from "node:path";
import { loadConfig, validateConfig } from "./config.js";
import { loadState, saveState } from "./lib/state.js";

import { cmdInit } from "./commands/init.js";
import { cmdLaunch } from "./commands/launch.js";
import { cmdResume } from "./commands/resume.js";
import { cmdStatus } from "./commands/status.js";
import { cmdVerify } from "./commands/verify.js";
import { cmdMerge } from "./commands/merge.js";
import { cmdRetry } from "./commands/retry.js";
import { cmdCleanup } from "./commands/cleanup.js";
import { cmdFeaturesList } from "./commands/features/list.js";
import { cmdFeaturesAdd } from "./commands/features/add.js";
import { cmdFeaturesSetStatus } from "./commands/features/set-status.js";
import { cmdFeaturesCheck } from "./commands/features/check.js";
import { cmdFeaturesArchive } from "./commands/features/archive.js";
import { cmdFeaturesShow } from "./commands/features/show.js";

import type { Priority, Difficulty, FeatureStatus } from "./lib/features.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CLIArgs {
  command: string;
  subcommand?: string;
  // Selection options (launch)
  topPriority?: number;
  quickestWins?: number;
  priority?: Priority;
  difficulty?: Difficulty;
  features?: string[];
  allReady?: boolean;
  // Launch / runtime options
  maxConcurrent?: number;
  model?: string;
  interactive: boolean;
  dryRun: boolean;
  baseBranch?: string;
  maxRetries?: number;
  noTui: boolean;
  autoPush: boolean;
  // General
  featureId?: string;
  force: boolean;
  // Features subcommand extras
  status?: string;
  ready?: boolean;
  includeArchive?: boolean;
  title?: string;
  description?: string;
  effort?: string;
  dependsOn?: string[];
}

// ---------------------------------------------------------------------------
// Arg Parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): CLIArgs {
  const args = argv.slice(2); // skip 'bun' and script path
  const result: CLIArgs = {
    command: args[0] || "help",
    interactive: false,
    dryRun: false,
    noTui: false,
    autoPush: false,
    force: false,
  };

  // If the first arg is "features", treat the second positional as the subcommand
  let startIdx = 1;
  if (result.command === "features") {
    result.subcommand = args[1] || "list";
    startIdx = 2;
  }

  for (let i = startIdx; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      // --- Selection options ---
      case "--top-priority":
        result.topPriority = parseInt(args[++i], 10);
        break;
      case "--quickest-wins":
        result.quickestWins = parseInt(args[++i], 10);
        break;
      case "--priority":
        result.priority = args[++i] as Priority;
        break;
      case "--difficulty":
        result.difficulty = args[++i] as Difficulty;
        break;
      case "--features":
        result.features = args[++i].split(",").map((s) => s.trim());
        break;
      case "--all-ready":
        result.allReady = true;
        break;

      // --- Launch / runtime options ---
      case "--max-concurrent":
        result.maxConcurrent = parseInt(args[++i], 10);
        break;
      case "--model":
      case "-m":
        result.model = args[++i];
        break;
      case "--interactive":
        result.interactive = true;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--no-tui":
        result.noTui = true;
        break;
      case "--auto-push":
        result.autoPush = true;
        break;
      case "--base-branch":
        result.baseBranch = args[++i];
        break;
      case "--max-retries":
        result.maxRetries = parseInt(args[++i], 10);
        break;

      // --- General flags ---
      case "--force":
        result.force = true;
        break;

      // --- Features subcommand options ---
      case "--status":
        result.status = args[++i];
        break;
      case "--ready":
        result.ready = true;
        break;
      case "--include-archive":
        result.includeArchive = true;
        break;
      case "--title":
        result.title = args[++i];
        break;
      case "--description":
      case "--desc":
        result.description = args[++i];
        break;
      case "--effort":
        result.effort = args[++i];
        break;
      case "--depends-on":
        result.dependsOn = args[++i].split(",").map((s) => s.trim());
        break;

      // --- Positional (feature-id, title for add, etc.) ---
      default:
        if (!arg.startsWith("-")) {
          if (!result.featureId) {
            result.featureId = arg;
          } else if (!result.title) {
            result.title = arg;
          }
        }
        break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function cmdHelp(): void {
  console.log(`
Wombo — AI Agent Orchestration System

  WOMBO COMBO! Parallel feature development with AI agents.

Commands:
  init           Generate wombo.json config in the current project
  launch         Launch a wave of agents to implement features
  resume         Resume a previously stopped wave
  status         Show the status of the current wave
  verify         Run build verification on completed agents
  merge          Merge verified branches into the base branch
  retry          Retry a failed agent
  cleanup        Remove all wave worktrees and tmux sessions
  features       Manage .features.yml (see below)
  help           Show this help

Features Subcommands:
  features list            List features (--status, --priority, --difficulty, --ready, --include-archive)
  features add <id> <title> [options]
                           Add a new feature (--desc, --priority, --difficulty, --effort, --depends-on)
  features set-status <id> <status>
                           Change a feature's status
  features check           Validate .features.yml (schema, deps, duplicates, cycles)
  features archive [id]    Move done/cancelled to archive (--dry-run)
  features show <id>       Show feature details

Selection Options (for launch):
  --top-priority N         Select top N features by priority
  --quickest-wins N        Select N features with lowest effort
  --priority <level>       Filter by priority (critical/high/medium/low/wishlist)
  --difficulty <level>     Filter by difficulty (trivial/easy/medium/hard/very_hard)
  --features "id1,id2"     Select specific features by ID
  --all-ready              Select all features whose dependencies are met

Launch Options:
  --max-concurrent N       Max agents running in parallel (default: from config)
  --model <model>          Model to use (e.g., "anthropic/claude-sonnet-4-20250514")
  --interactive            Use tmux TUI mode instead of headless
  --no-tui                 Headless mode without neo-blessed TUI (periodic console dashboard)
  --auto-push              Push base branch to remote after all merges complete
  --dry-run                Show what would be launched without launching
  --base-branch <branch>   Base branch (default: from config)
  --max-retries N          Max retries per agent (default: from config)

General:
  --force                  Force overwrite (e.g., for init)

Examples:
  wombo init
  wombo launch --quickest-wins 3
  wombo launch --priority high --interactive
  wombo launch --features "auth-flow,search-api" --max-concurrent 2
  wombo resume
  wombo status
  wombo verify
  wombo merge
  wombo retry auth-flow
  wombo cleanup
  wombo features list --status ready --priority high
  wombo features add my-feature "My Cool Feature" --priority high --difficulty easy
  wombo features set-status my-feature in-progress
  wombo features check
  wombo features archive --dry-run
  wombo features show my-feature
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const PROJECT_ROOT = resolve(process.cwd());
  const args = parseArgs(process.argv);

  // Commands that don't need config loading
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    cmdHelp();
    return;
  }

  if (args.command === "init") {
    await cmdInit({ projectRoot: PROJECT_ROOT, force: args.force });
    return;
  }

  // Everything else requires config
  const config = loadConfig(PROJECT_ROOT);
  validateConfig(config);

  switch (args.command) {
    case "launch":
      await cmdLaunch({
        projectRoot: PROJECT_ROOT,
        config,
        topPriority: args.topPriority,
        quickestWins: args.quickestWins,
        priority: args.priority,
        difficulty: args.difficulty,
        features: args.features,
        allReady: args.allReady,
        maxConcurrent: args.maxConcurrent ?? config.defaults.maxConcurrent,
        model: args.model,
        interactive: args.interactive,
        dryRun: args.dryRun,
        baseBranch: args.baseBranch ?? config.baseBranch,
        maxRetries: args.maxRetries ?? config.defaults.maxRetries,
        noTui: args.noTui,
        autoPush: args.autoPush,
      });
      break;

    case "resume":
      await cmdResume({
        projectRoot: PROJECT_ROOT,
        config,
        maxConcurrent: args.maxConcurrent,
        model: args.model,
        interactive: args.interactive,
        noTui: args.noTui,
        autoPush: args.autoPush,
        baseBranch: args.baseBranch,
        maxRetries: args.maxRetries,
      });
      break;

    case "status":
      await cmdStatus({ projectRoot: PROJECT_ROOT, config });
      break;

    case "verify":
      await cmdVerify({
        projectRoot: PROJECT_ROOT,
        config,
        featureId: args.featureId,
        model: args.model,
        maxRetries: args.maxRetries,
      });
      break;

    case "merge":
      await cmdMerge({
        projectRoot: PROJECT_ROOT,
        config,
        featureId: args.featureId,
        autoPush: args.autoPush,
      });
      break;

    case "retry": {
      if (!args.featureId) {
        console.error("Usage: wombo retry <feature-id>");
        process.exit(1);
        return;
      }
      await cmdRetry({
        projectRoot: PROJECT_ROOT,
        config,
        featureId: args.featureId,
        model: args.model,
        interactive: args.interactive,
      });
      break;
    }

    case "cleanup":
      await cmdCleanup({ projectRoot: PROJECT_ROOT, config });
      break;

    case "features":
      await handleFeaturesSubcommand(args, PROJECT_ROOT, config);
      break;

    default:
      console.error(`Unknown command: ${args.command}`);
      cmdHelp();
      process.exit(1);
      return;
  }
}

// ---------------------------------------------------------------------------
// Features Subcommand Router
// ---------------------------------------------------------------------------

async function handleFeaturesSubcommand(
  args: CLIArgs,
  projectRoot: string,
  config: import("./config.js").WomboConfig
): Promise<void> {
  switch (args.subcommand) {
    case "list":
    case "ls":
      await cmdFeaturesList({
        projectRoot,
        config,
        status: args.status as FeatureStatus | undefined,
        priority: args.priority,
        difficulty: args.difficulty,
        ready: args.ready,
        includeArchive: args.includeArchive,
      });
      break;

    case "add": {
      if (!args.featureId || !args.title) {
        console.error("Usage: wombo features add <id> <title> [--desc <desc>] [--priority <p>] [--difficulty <d>] [--effort <e>] [--depends-on <ids>]");
        process.exit(1);
        return;
      }
      await cmdFeaturesAdd({
        projectRoot,
        config,
        id: args.featureId,
        title: args.title,
        description: args.description,
        priority: args.priority,
        difficulty: args.difficulty,
        effort: args.effort,
        dependsOn: args.dependsOn,
      });
      break;
    }

    case "set-status": {
      if (!args.featureId || !args.title) {
        // title holds the second positional arg (the status value)
        // If not provided via positional, check --status flag
        const newStatus = args.title || args.status;
        if (!args.featureId || !newStatus) {
          console.error("Usage: wombo features set-status <feature-id> <status>");
          process.exit(1);
          return;
        }
        await cmdFeaturesSetStatus({
          projectRoot,
          config,
          featureId: args.featureId,
          newStatus,
        });
      } else {
        await cmdFeaturesSetStatus({
          projectRoot,
          config,
          featureId: args.featureId,
          newStatus: args.title, // second positional = new status
        });
      }
      break;
    }

    case "check":
    case "validate":
      await cmdFeaturesCheck({ projectRoot, config });
      break;

    case "archive":
      await cmdFeaturesArchive({
        projectRoot,
        config,
        featureId: args.featureId,
        dryRun: args.dryRun,
      });
      break;

    case "show": {
      if (!args.featureId) {
        console.error("Usage: wombo features show <feature-id>");
        process.exit(1);
        return;
      }
      await cmdFeaturesShow({
        projectRoot,
        config,
        featureId: args.featureId,
      });
      break;
    }

    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;

    default:
      console.error(`Unknown features subcommand: ${args.subcommand}`);
      console.error("Run 'wombo features help' or 'wombo help' for usage.");
      process.exit(1);
      return;
  }
}

// ---------------------------------------------------------------------------
// Error Handlers & Entry
// ---------------------------------------------------------------------------

// Global error handlers — prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error(`\n[FATAL] Uncaught exception: ${err.message}`);
  console.error(err.stack);
  try {
    const state = loadState(process.cwd());
    if (state) saveState(process.cwd(), state);
  } catch {}
  process.exit(1);
});

process.on("unhandledRejection", (reason: any) => {
  console.error(`\n[FATAL] Unhandled rejection: ${reason?.message || reason}`);
  if (reason?.stack) console.error(reason.stack);
  try {
    const state = loadState(process.cwd());
    if (state) saveState(process.cwd(), state);
  } catch {}
  process.exit(1);
});

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
