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
 *   wombo launch --tasks "feat-a,feat-b"
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
 *   wombo history [wave-id] [--output json]
 *   wombo tasks list [--status <s>] [--priority <p>] [--difficulty <d>] [--ready] [--include-archive]
 *   wombo tasks add <id> <title> [options]
 *   wombo tasks set-status <task-id> <status>
 *   wombo tasks set-priority <task-id> <priority>
 *   wombo tasks set-difficulty <task-id> <difficulty>
 *   wombo tasks check
 *   wombo tasks archive [task-id] [--dry-run]
 *   wombo tasks show <task-id>
 *   wombo tasks graph [--ascii] [--mermaid] [--subtasks] [--status <s>]
 *   wombo help
 *   wombo version
 *   wombo -v
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
  if (pkgName !== "wombo-combo") return;

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
import { cmdHistory } from "./commands/history.js";
import { cmdTasksList } from "./commands/tasks/list.js";
import { cmdTasksAdd } from "./commands/tasks/add.js";
import { cmdTasksSetStatus } from "./commands/tasks/set-status.js";
import { cmdTasksSetPriority } from "./commands/tasks/set-priority.js";
import { cmdTasksSetDifficulty } from "./commands/tasks/set-difficulty.js";
import { cmdTasksCheck } from "./commands/tasks/check.js";
import { cmdTasksArchive } from "./commands/tasks/archive.js";
import { cmdTasksShow } from "./commands/tasks/show.js";
import { cmdTasksGraph } from "./commands/tasks/graph.js";

import { ensureTasksFile } from "./lib/tasks.js";
import type { Priority, Difficulty, FeatureStatus } from "./lib/tasks.js";
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
  tasks?: string[];
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
  tag?: string;
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
  // Browser verification
  browser?: boolean;
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

  // If the first arg is "tasks" or "features" (backward-compat alias), treat the second positional as the subcommand
  let startIdx = 1;
  if (result.command === "tasks" || result.command === "features") {
    result.command = "tasks"; // normalize to "tasks"
    result.subcommand = args[1] || "list";
    startIdx = 2;
  }

  for (let i = startIdx; i < args.length; i++) {
    const arg = args[i];

    // Helper: consume the next argument, or exit with a clear error
    function requireValue(flag: string): string {
      if (i + 1 >= args.length) {
        console.error(`Flag ${flag} requires a value.`);
        process.exit(1);
      }
      return args[++i];
    }

    switch (arg) {
      // --- Selection options ---
      case "--top-priority":
        result.topPriority = parseInt(requireValue(arg), 10);
        break;
      case "--quickest-wins":
        result.quickestWins = parseInt(requireValue(arg), 10);
        break;
      case "--priority":
        result.priority = requireValue(arg) as Priority;
        break;
      case "--difficulty":
        result.difficulty = requireValue(arg) as Difficulty;
        break;
      case "--tasks":
      case "--features": // backward-compat alias
        result.tasks = requireValue(arg).split(",").map((s) => s.trim());
        break;
      case "--all-ready":
        result.allReady = true;
        break;

      // --- Launch / runtime options ---
      case "--max-concurrent":
        result.maxConcurrent = parseInt(requireValue(arg), 10);
        break;
      case "--model":
      case "-m":
        result.model = requireValue(arg);
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
        result.baseBranch = requireValue(arg);
        break;
      case "--max-retries":
        result.maxRetries = parseInt(requireValue(arg), 10);
        break;

      // --- General flags ---
      case "--force":
        result.force = true;
        break;
      case "--check":
        result.checkOnly = true;
        break;
      case "--tag":
      case "--release":
        result.tag = requireValue(arg);
        break;
      case "--output":
      case "-o":
        result.outputFmt = resolveOutputFormat(requireValue(arg));
        break;

      // --- Tasks subcommand options ---
      case "--status":
        result.status = requireValue(arg);
        break;
      case "--ready":
        result.ready = true;
        break;
      case "--include-archive":
        result.includeArchive = true;
        break;
      case "--title":
        result.title = requireValue(arg);
        break;
      case "--description":
      case "--desc":
        result.description = requireValue(arg);
        break;
      case "--effort":
        result.effort = requireValue(arg);
        break;
      case "--depends-on":
        result.dependsOn = requireValue(arg).split(",").map((s) => s.trim());
        break;
      case "--fields":
        result.fields = requireValue(arg).split(",").map((s) => s.trim());
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

      // --- Browser verification ---
      case "--browser":
        result.browser = true;
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
  init           Generate .wombo-combo/config.json in the current project
  launch         Launch a wave of agents to implement features
  resume         Resume a previously stopped wave
  status         Show the status of the current wave
  verify         Run build verification on completed agents
  merge          Merge verified branches into the base branch
  retry          Retry a failed agent
  abort          Kill a single running agent (--requeue to return to queue)
  logs           Pretty-print agent logs for a feature
  cleanup        Remove all wave worktrees and multiplexer sessions
  history        List/view past wave results (stored in .wombo-combo/history/)
  tasks          Manage tasks file (see below; 'features' also accepted)
  upgrade        Check for updates and upgrade wombo
  describe       Emit JSON schema of a command (for AI agents)
  version        Print version and exit
  help           Show this help

Tasks Subcommands (also available as 'features' for backward compatibility):
  tasks list               List tasks (--status, --priority, --difficulty, --ready, --include-archive)
  tasks add <id> <title> [options]
                           Add a new task (--desc, --priority, --difficulty, --effort, --depends-on)
  tasks set-status <id> <status>
                            Change a task's status
  tasks set-priority <id> <priority>
                            Change a task's priority (critical/high/medium/low/wishlist)
  tasks set-difficulty <id> <difficulty>
                            Change a task's difficulty (trivial/easy/medium/hard/very_hard)
  tasks check              Validate tasks file (schema, deps, duplicates, cycles)
  tasks archive [id]       Move done/cancelled to archive (--dry-run)
  tasks show <id>          Show task details
  tasks graph              Visualize dependency graph (--ascii, --mermaid, --subtasks)

Selection Options (for launch):
  --top-priority N         Select top N tasks by priority
  --quickest-wins N        Select N tasks with lowest effort
  --priority <level>       Filter by priority (critical/high/medium/low/wishlist)
  --difficulty <level>     Filter by difficulty (trivial/easy/medium/hard/very_hard)
  --tasks "id1,id2"        Select specific tasks by ID (--features also accepted)
  --all-ready              Select all tasks whose dependencies are met

Launch Options:
  --max-concurrent N       Max agents running in parallel (default: from config)
  --model <model>          Model to use (e.g., "anthropic/claude-sonnet-4-20250514")
  --interactive            Use multiplexer (dmux/tmux) TUI mode instead of headless
  --no-tui                 Headless mode without neo-blessed TUI (periodic console dashboard)
  --auto-push              Push base branch to remote after all merges complete
  --dry-run                Show what would be launched without launching
  --base-branch <branch>   Base branch (default: from config)
  --max-retries N          Max retries per agent (default: from config)
  --browser                Enable browser-based verification (run after build passes)

General:
  --force                  Force overwrite (e.g., for init) / skip prompts (e.g., for upgrade)
  --output <fmt>           Output format: text (default on TTY) or json (default when piped)
  -o <fmt>                 Alias for --output
  --dry-run                Show what would happen without performing the action
  --fields <list>          Comma-separated fields to include (e.g., id,status,priority)

Upgrade Options:
  --check                  Only check for updates, don't install
  --tag <tag>              Install a specific version (e.g., v0.1.0)

Logs Options:
  --tail N                 Show only the last N lines
  --follow, -f             Stream new output as it arrives (like tail -f)

Examples:
  wombo init
  wombo launch --quickest-wins 3
  wombo launch --priority high --interactive
  wombo launch --tasks "auth-flow,search-api" --max-concurrent 2
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
  wombo tasks list --status ready --priority high
  wombo tasks list --fields id,status,priority --output json
  wombo tasks add my-task "My Cool Task" --priority high --difficulty easy
  wombo tasks set-status my-task in-progress
  wombo tasks check
  wombo tasks archive --dry-run
  wombo tasks show my-task
  wombo history
  wombo history wave-2026-03-12-420
  wombo history --output json
  wombo describe                           # list all commands as JSON
  wombo describe launch                    # describe a specific command
  wombo describe tasks add                 # describe a subcommand
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
  if (args.tasks) {
    for (const fid of args.tasks) {
      assertValid(validateId(fid, "task ID in --tasks"));
    }
  }
  if (args.dependsOn) {
    for (const dep of args.dependsOn) {
      assertValid(validateId(dep, "dependency ID in --depends-on"));
    }
  }

  // Commands that don't need config loading
  if (args.command === "version" || args.command === "-v" || args.command === "-V") {
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
      tag: args.tag,
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

  // Commands that operate on the tasks file — ensure it exists first
  const needsTasksFile = new Set(["launch", "resume", "verify", "retry", "tasks"]);
  if (needsTasksFile.has(args.command)) {
    await ensureTasksFile(PROJECT_ROOT, config);
  }

  switch (args.command) {
    case "launch":
      // Apply browser verification override if --browser flag was passed
      if (args.browser !== undefined) {
        config.browser.enabled = args.browser;
      }
      await cmdLaunch({
        projectRoot: PROJECT_ROOT,
        config,
        topPriority: args.topPriority,
        quickestWins: args.quickestWins,
        priority: args.priority,
        difficulty: args.difficulty,
        features: args.tasks,
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
      await cmdStatus({ projectRoot: PROJECT_ROOT, config, outputFmt: args.outputFmt });
      break;

    case "verify":
      await cmdVerify({
        projectRoot: PROJECT_ROOT,
        config,
        featureId: args.featureId,
        model: args.model,
        maxRetries: args.maxRetries,
        browserVerify: args.browser,
      });
      break;

    case "merge":
      await cmdMerge({
        projectRoot: PROJECT_ROOT,
        config,
        featureId: args.featureId,
        autoPush: args.autoPush,
        dryRun: args.dryRun,
        model: args.model,
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

    case "history":
      await cmdHistory({
        projectRoot: PROJECT_ROOT,
        config,
        waveId: args.featureId,
        outputFmt: args.outputFmt,
      });
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

    case "tasks":
      await handleTasksSubcommand(args, PROJECT_ROOT, config);
      break;

    default:
      console.error(`Unknown command: ${args.command}`);
      cmdHelp();
      process.exit(1);
      return;
  }
}

// ---------------------------------------------------------------------------
// Tasks Subcommand Router
// ---------------------------------------------------------------------------

async function handleTasksSubcommand(
  args: CLIArgs,
  projectRoot: string,
  config: import("./config.js").WomboConfig
): Promise<void> {
  switch (args.subcommand) {
    case "list":
    case "ls":
      await cmdTasksList({
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
        console.error("Usage: wombo tasks add <id> <title> [--desc <desc>] [--priority <p>] [--difficulty <d>] [--effort <e>] [--depends-on <ids>]");
        process.exit(1);
        return;
      }
      await cmdTasksAdd({
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
          console.error("Usage: wombo tasks set-status <task-id> <status>");
          process.exit(1);
          return;
        }
        await cmdTasksSetStatus({
          projectRoot,
          config,
          featureId: args.featureId,
          newStatus,
          outputFmt: args.outputFmt,
          dryRun: args.dryRun,
        });
      } else {
        await cmdTasksSetStatus({
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
          console.error("Usage: wombo tasks set-priority <task-id> <priority>");
          process.exit(1);
          return;
        }
        await cmdTasksSetPriority({
          projectRoot,
          config,
          featureId: args.featureId,
          newPriority,
          outputFmt: args.outputFmt,
          dryRun: args.dryRun,
        });
      } else {
        await cmdTasksSetPriority({
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
          console.error("Usage: wombo tasks set-difficulty <task-id> <difficulty>");
          process.exit(1);
          return;
        }
        await cmdTasksSetDifficulty({
          projectRoot,
          config,
          featureId: args.featureId,
          newDifficulty,
          outputFmt: args.outputFmt,
          dryRun: args.dryRun,
        });
      } else {
        await cmdTasksSetDifficulty({
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
      await cmdTasksCheck({ projectRoot, config });
      break;

    case "archive":
      await cmdTasksArchive({
        projectRoot,
        config,
        featureId: args.featureId,
        dryRun: args.dryRun,
        outputFmt: args.outputFmt,
      });
      break;

    case "show": {
      if (!args.featureId) {
        console.error("Usage: wombo tasks show <task-id>");
        process.exit(1);
        return;
      }
      await cmdTasksShow({
        projectRoot,
        config,
        featureId: args.featureId,
        outputFmt: args.outputFmt,
        fields: args.fields,
      });
      break;
    }

    case "graph":
      await cmdTasksGraph({
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
      console.error(`Unknown tasks subcommand: ${args.subcommand}`);
      console.error("Run 'wombo tasks help' or 'wombo help' for usage.");
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
