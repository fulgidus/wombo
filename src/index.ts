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
 *   wombo abort <feature-id> [--requeue] [--output json]
 *   wombo logs <feature-id> [--tail N] [--follow] [--output json]
 *   wombo cleanup
 *   wombo features list [--status <s>] [--priority <p>] [--difficulty <d>] [--ready] [--include-archive]
 *   wombo features add <id> <title> [options]
 *   wombo features set-status <feature-id> <status>
 *   wombo features set-priority <feature-id> <priority>
 *   wombo features set-difficulty <feature-id> <difficulty>
 *   wombo features check
 *   wombo features archive [feature-id] [--dry-run]
 *   wombo features show <feature-id>
 *   wombo features graph [--ascii] [--mermaid] [--subtasks] [--status <s>]
 *   wombo help
 *   wombo --version
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, validateConfig } from "./config.js";
import { loadState, saveState } from "./lib/state.js";

// ---------------------------------------------------------------------------
// Dev-mode guard: warn if running the global binary inside the wombo repo
// ---------------------------------------------------------------------------

function checkDevModeGuard(): void {
  const cwd = process.cwd();
  const pkgPath = resolve(cwd, "package.json");

  // Are we inside the wombo repo?
  if (!existsSync(pkgPath)) return;

  let pkgName: string | undefined;
  try {
    const raw = readFileSync(pkgPath, "utf-8");
    pkgName = JSON.parse(raw).name;
  } catch {
    return;
  }
  if (pkgName !== "wombo") return;

  // We're in the wombo repo. Is the source being run from a different location?
  // import.meta.dir = directory of THIS file (index.ts). If it's under cwd,
  // we're running local source (bun dev). If it's elsewhere (e.g. ~/.bun/install),
  // we're running the globally installed binary.
  const sourceDir = resolve(import.meta.dir);
  const projectSrc = resolve(cwd, "src");

  if (!sourceDir.startsWith(projectSrc)) {
    console.warn(
      "\x1b[33m[WARNING]\x1b[0m You are running the globally installed wombo binary " +
      "inside the wombo repo.\n" +
      "  Use \x1b[1mbun dev <command>\x1b[0m instead to run from local source.\n" +
      "  See AGENTS.md for details.\n"
    );
  }
}

import { cmdInit } from "./commands/init.js";
import { cmdLaunch } from "./commands/launch.js";
import { cmdResume } from "./commands/resume.js";
import { cmdStatus } from "./commands/status.js";
import { cmdVerify } from "./commands/verify.js";
import { cmdMerge } from "./commands/merge.js";
import { cmdRetry } from "./commands/retry.js";
import { cmdCleanup } from "./commands/cleanup.js";
import { cmdAbort } from "./commands/abort.js";
import { cmdLogs } from "./commands/logs.js";
import { cmdUpgrade } from "./commands/upgrade.js";
import { cmdFeaturesList } from "./commands/features/list.js";
import { cmdFeaturesAdd } from "./commands/features/add.js";
import { cmdFeaturesSetStatus } from "./commands/features/set-status.js";
import { cmdFeaturesSetPriority } from "./commands/features/set-priority.js";
import { cmdFeaturesSetDifficulty } from "./commands/features/set-difficulty.js";
import { cmdFeaturesCheck } from "./commands/features/check.js";
import { cmdFeaturesArchive } from "./commands/features/archive.js";
import { cmdFeaturesShow } from "./commands/features/show.js";
import { cmdFeaturesGraph } from "./commands/features/graph.js";

import { ensureFeaturesFile } from "./lib/features.js";
import type { Priority, Difficulty, FeatureStatus } from "./lib/features.js";
import { resolveOutputFormat, type OutputFormat } from "./lib/output.js";
import { validateId, validateText, validateBranchName, validateDuration, assertValid } from "./lib/validate.js";
import { findCommandDef, commandToSchema, allCommandSchemas } from "./lib/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CLIArgs {
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
  // Abort options
  requeue: boolean;
  // General
  featureId?: string;
  force: boolean;
  // Output format
  outputFmt: OutputFormat;
  // Upgrade options
  checkOnly: boolean;
  version?: string;
  // Features subcommand extras
  status?: string;
  ready?: boolean;
  includeArchive?: boolean;
  title?: string;
  description?: string;
  effort?: string;
  dependsOn?: string[];
  // Logs options
  tail?: number;
  follow?: boolean;
  // Compact output
  fields?: string[];
  // Graph options
  ascii?: boolean;
  mermaidRaw?: boolean;
  graphSubtasks?: boolean;
}

// ---------------------------------------------------------------------------
// Arg Parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CLIArgs {
  const args = argv.slice(2); // skip 'bun' and script path
  const result: CLIArgs = {
    command: args[0] || "help",
    interactive: false,
    dryRun: false,
    noTui: false,
    autoPush: false,
    requeue: false,
    force: false,
    checkOnly: false,
    outputFmt: resolveOutputFormat(undefined), // auto-detect until --output overrides
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
      case "--requeue":
        result.requeue = true;
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
      case "--check":
        result.checkOnly = true;
        break;
      case "--version":
        result.version = args[++i];
        break;
      case "--output":
      case "-o":
        result.outputFmt = resolveOutputFormat(args[++i]);
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
      case "--fields":
        result.fields = args[++i].split(",").map((s) => s.trim());
        break;

      // --- Graph options ---
      case "--ascii":
        result.ascii = true;
        break;
      case "--mermaid":
        result.mermaidRaw = true;
        break;
      case "--subtasks":
        result.graphSubtasks = true;
        break;

      // --- Logs options ---
      case "--tail":
        result.tail = parseInt(args[++i], 10);
        break;
      case "--follow":
      case "-f":
        result.follow = true;
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
  abort          Kill a single running agent (--requeue to return to queue)
  logs           Pretty-print agent logs for a feature
  cleanup        Remove all wave worktrees and tmux sessions
  features       Manage .features.yml (see below)
  upgrade        Check for updates and upgrade wombo
  describe       Emit JSON schema of a command (for AI agents)
  help           Show this help

Features Subcommands:
  features list            List features (--status, --priority, --difficulty, --ready, --include-archive)
  features add <id> <title> [options]
                           Add a new feature (--desc, --priority, --difficulty, --effort, --depends-on)
  features set-status <id> <status>
                            Change a feature's status
  features set-priority <id> <priority>
                            Change a feature's priority (critical/high/medium/low/wishlist)
  features set-difficulty <id> <difficulty>
                            Change a feature's difficulty (trivial/easy/medium/hard/very_hard)
  features check           Validate .features.yml (schema, deps, duplicates, cycles)
  features archive [id]    Move done/cancelled to archive (--dry-run)
  features show <id>       Show feature details
  features graph           Visualize dependency graph (--ascii, --mermaid, --subtasks)

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
  --version, -V            Print version and exit
  --force                  Force overwrite (e.g., for init) / skip prompts (e.g., for upgrade)
  --output <fmt>           Output format: text (default on TTY) or json (default when piped)
  -o <fmt>                 Alias for --output
  --dry-run                Show what would happen without performing the action
  --fields <list>          Comma-separated fields to include (e.g., id,status,priority)

Upgrade Options:
  --check                  Only check for updates, don't install
  --version <tag>          Install a specific version (e.g., v0.1.0)

Logs Options:
  --tail N                 Show only the last N lines
  --follow, -f             Stream new output as it arrives (like tail -f)

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
  wombo abort auth-flow
  wombo abort auth-flow --requeue
  wombo abort auth-flow --output json
  wombo logs auth-flow
  wombo logs auth-flow --tail 50
  wombo logs auth-flow --follow
  wombo logs auth-flow --output json
  wombo cleanup
  wombo features list --status ready --priority high
  wombo features list --fields id,status,priority --output json
  wombo features add my-feature "My Cool Feature" --priority high --difficulty easy
  wombo features set-status my-feature in-progress
  wombo features check
  wombo features archive --dry-run
  wombo features show my-feature
  wombo describe                           # list all commands as JSON
  wombo describe launch                    # describe a specific command
  wombo describe features add              # describe a subcommand
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  checkDevModeGuard();

  const PROJECT_ROOT = resolve(process.cwd());
  const args = parseArgs(process.argv);

  // -----------------------------------------------------------------------
  // Input validation at the CLI boundary
  // -----------------------------------------------------------------------
  if (args.featureId) {
    assertValid(validateId(args.featureId, "feature ID"));
  }
  if (args.title) {
    assertValid(validateText(args.title, "title"));
  }
  if (args.description) {
    assertValid(validateText(args.description, "description"));
  }
  if (args.baseBranch) {
    assertValid(validateBranchName(args.baseBranch, "base branch"));
  }
  if (args.effort) {
    assertValid(validateDuration(args.effort, "effort"));
  }
  if (args.features) {
    for (const fid of args.features) {
      assertValid(validateId(fid, "feature ID in --features"));
    }
  }
  if (args.dependsOn) {
    for (const dep of args.dependsOn) {
      assertValid(validateId(dep, "dependency ID in --depends-on"));
    }
  }

  // Commands that don't need config loading
  if (args.command === "--version" || args.command === "-V") {
    const pkgPath = resolve(import.meta.dir, "..", "package.json");
    const pkgFile = Bun.file(pkgPath);
    try {
      const pkg = await pkgFile.json();
      console.log(`wombo ${pkg.version ?? "(unknown version)"}`);
    } catch {
      console.log("wombo (unknown version)");
    }
    return;
  }

  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    cmdHelp();
    return;
  }

  if (args.command === "describe") {
    // Schema introspection: `wombo describe [command]`
    if (!args.featureId) {
      // No command specified — list all commands
      console.log(JSON.stringify(allCommandSchemas(), null, 2));
    } else {
      // Describe a specific command. Handle compound names: "features list"
      const cmdName = args.title
        ? `${args.featureId} ${args.title}`
        : args.featureId;
      const def = findCommandDef(cmdName);
      if (!def) {
        console.error(`Unknown command: "${cmdName}"`);
        console.error("Run 'wombo describe' to list all commands.");
        process.exit(1);
        return;
      }
      console.log(JSON.stringify(commandToSchema(def), null, 2));
    }
    return;
  }

  if (args.command === "init") {
    await cmdInit({ projectRoot: PROJECT_ROOT, force: args.force });
    return;
  }

  if (args.command === "upgrade") {
    await cmdUpgrade({
      force: args.force,
      version: args.version,
      checkOnly: args.checkOnly,
    });
    return;
  }

  if (args.command === "logs") {
    if (!args.featureId) {
      console.error("Usage: wombo logs <feature-id> [--tail N] [--follow] [--output json]");
      process.exit(1);
      return;
    }
    await cmdLogs({
      projectRoot: PROJECT_ROOT,
      featureId: args.featureId,
      tail: args.tail,
      follow: args.follow,
      outputFmt: args.outputFmt,
    });
    return;
  }

  // Everything else requires config
  const config = loadConfig(PROJECT_ROOT);
  validateConfig(config);

  // Commands that operate on the features file — ensure it exists first
  const needsFeatures = new Set(["launch", "resume", "verify", "retry", "features"]);
  if (needsFeatures.has(args.command)) {
    await ensureFeaturesFile(PROJECT_ROOT, config);
  }

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
        outputFmt: args.outputFmt,
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
        dryRun: args.dryRun,
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
        dryRun: args.dryRun,
      });
      break;
    }

    case "cleanup":
      await cmdCleanup({ projectRoot: PROJECT_ROOT, config, dryRun: args.dryRun });
      break;

    case "abort": {
      if (!args.featureId) {
        console.error("Usage: wombo abort <feature-id> [--requeue] [--output json]");
        process.exit(1);
        return;
      }
      await cmdAbort({
        projectRoot: PROJECT_ROOT,
        config,
        featureId: args.featureId,
        requeue: args.requeue,
        outputFmt: args.outputFmt,
      });
      break;
    }

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
        outputFmt: args.outputFmt,
        fields: args.fields,
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
        outputFmt: args.outputFmt,
        dryRun: args.dryRun,
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
          outputFmt: args.outputFmt,
          dryRun: args.dryRun,
        });
      } else {
        await cmdFeaturesSetStatus({
          projectRoot,
          config,
          featureId: args.featureId,
          newStatus: args.title, // second positional = new status
          outputFmt: args.outputFmt,
          dryRun: args.dryRun,
        });
      }
      break;
    }

    case "set-priority": {
      if (!args.featureId || !args.title) {
        // title holds the second positional arg (the priority value)
        // If not provided via positional, check --priority flag
        const newPriority = args.title || (args.priority as string | undefined);
        if (!args.featureId || !newPriority) {
          console.error("Usage: wombo features set-priority <feature-id> <priority>");
          process.exit(1);
          return;
        }
        await cmdFeaturesSetPriority({
          projectRoot,
          config,
          featureId: args.featureId,
          newPriority,
          outputFmt: args.outputFmt,
          dryRun: args.dryRun,
        });
      } else {
        await cmdFeaturesSetPriority({
          projectRoot,
          config,
          featureId: args.featureId,
          newPriority: args.title, // second positional = new priority
          outputFmt: args.outputFmt,
          dryRun: args.dryRun,
        });
      }
      break;
    }

    case "set-difficulty": {
      if (!args.featureId || !args.title) {
        // title holds the second positional arg (the difficulty value)
        // If not provided via positional, check --difficulty flag
        const newDifficulty = args.title || (args.difficulty as string | undefined);
        if (!args.featureId || !newDifficulty) {
          console.error("Usage: wombo features set-difficulty <feature-id> <difficulty>");
          process.exit(1);
          return;
        }
        await cmdFeaturesSetDifficulty({
          projectRoot,
          config,
          featureId: args.featureId,
          newDifficulty,
          outputFmt: args.outputFmt,
          dryRun: args.dryRun,
        });
      } else {
        await cmdFeaturesSetDifficulty({
          projectRoot,
          config,
          featureId: args.featureId,
          newDifficulty: args.title, // second positional = new difficulty
          outputFmt: args.outputFmt,
          dryRun: args.dryRun,
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
        outputFmt: args.outputFmt,
        fields: args.fields,
      });
      break;
    }

    case "graph":
      await cmdFeaturesGraph({
        projectRoot,
        config,
        status: args.status as FeatureStatus | undefined,
        ascii: args.ascii,
        mermaid: args.mermaidRaw,
        subtasks: args.graphSubtasks,
        outputFmt: args.outputFmt,
      });
      break;

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
