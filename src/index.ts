#!/usr/bin/env bun
/**
 * index.ts — CLI entry point for the wombo-combo agent orchestration system.
 *
 * Every command has a short alias (e.g., woco i = woco init, woco t ls = woco tasks list).
 *
 * Usage:
 *   woco init                                         (alias: i)
 *   woco launch --top-priority 3                      (alias: l)
 *   woco launch --quickest-wins 5
 *   woco launch --priority high
 *   woco launch --difficulty easy
 *   woco launch --tasks "feat-a,feat-b"
 *   woco launch --all-ready
 *   woco launch ... --max-concurrent 3 --model "anthropic/claude-sonnet-4-20250514"
 *   woco launch ... --interactive
 *   woco resume                                       (alias: r)
 *   woco status                                       (alias: s)
 *   woco verify [feature-id]                          (alias: v)
 *   woco merge [feature-id]                           (alias: m)
 *   woco retry <feature-id>                           (alias: re)
 *   woco abort <feature-id> [--requeue] [--output json]  (alias: a)
 *   woco logs <feature-id> [--tail N] [--follow]      (alias: lo)
 *   woco cleanup                                      (alias: c)
 *   woco history [wave-id] [--output json]            (alias: h)
 *   woco tasks list [--status <s>] [--priority <p>]   (alias: t ls)
 *   woco tasks add <id> <title> [options]             (alias: t a)
 *   woco tasks set-status <task-id> <status>          (alias: t ss)
 *   woco tasks set-priority <task-id> <priority>      (alias: t sp)
 *   woco tasks set-difficulty <task-id> <difficulty>   (alias: t sd)
 *   woco tasks check                                  (alias: t ch)
 *   woco tasks archive [task-id] [--dry-run]          (alias: t ar)
 *   woco tasks show <task-id>                         (alias: t sh)
 *   woco tasks graph [--ascii] [--mermaid]            (alias: t g)
 *   woco completion <bash|zsh|fish>                   (alias: comp)
 *   woco help
 *   woco version
 *   woco -v
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, validateConfig } from "./config.js";
import { loadState, saveState } from "./lib/state.js";

// ---------------------------------------------------------------------------
// Dev-mode guard: warn if running the global binary inside the wombo-combo repo
// ---------------------------------------------------------------------------

function checkDevModeGuard(): void {
  const cwd = process.cwd();
  const pkgPath = resolve(cwd, "package.json");

  // Are we inside the wombo-combo repo?
  if (!existsSync(pkgPath)) return;

  let pkgName: string | undefined;
  try {
    const raw = readFileSync(pkgPath, "utf-8");
    pkgName = JSON.parse(raw).name;
  } catch {
    return;
  }
  if (pkgName !== "wombo-combo") return;

  // We're in the wombo-combo repo. Is the source being run from a different location?
  // import.meta.dir = directory of THIS file (index.ts). If it's under cwd,
  // we're running local source (bun dev). If it's elsewhere (e.g. ~/.bun/install),
  // we're running the globally installed binary.
  const sourceDir = resolve(import.meta.dir);
  const projectSrc = resolve(cwd, "src");

  if (!sourceDir.startsWith(projectSrc)) {
    console.warn(
      "\x1b[33m[WARNING]\x1b[0m You are running the globally installed woco binary " +
      "inside the wombo-combo repo.\n" +
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
import { cmdCompletion } from "./commands/completion.js";
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
// Command & Subcommand Aliases
// ---------------------------------------------------------------------------

/** Map of short aliases → canonical top-level command names. */
export const COMMAND_ALIASES: Record<string, string> = {
  i: "init",
  l: "launch",
  r: "resume",
  s: "status",
  v: "verify",
  m: "merge",
  re: "retry",
  a: "abort",
  c: "cleanup",
  h: "history",
  lo: "logs",
  t: "tasks",
  features: "tasks", // backward-compat full-word alias
  u: "upgrade",
  d: "describe",
  comp: "completion",
};

/** Map of short aliases → canonical tasks subcommand names. */
export const SUBCOMMAND_ALIASES: Record<string, string> = {
  ls: "list",
  a: "add",
  ss: "set-status",
  sp: "set-priority",
  sd: "set-difficulty",
  ch: "check",
  validate: "check", // backward-compat full-word alias
  ar: "archive",
  sh: "show",
  g: "graph",
};

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

  // Resolve top-level command alias (e.g., "i" → "init", "t" → "tasks")
  result.command = COMMAND_ALIASES[result.command] ?? result.command;

  // If the command is "tasks", treat the second positional as the subcommand
  let startIdx = 1;
  if (result.command === "tasks") {
    result.subcommand = args[1] || "list";
    // Resolve subcommand alias (e.g., "ls" → "list", "ss" → "set-status")
    result.subcommand = SUBCOMMAND_ALIASES[result.subcommand] ?? result.subcommand;
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
        result.tail = parseInt(requireValue(arg), 10);
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
wombo-combo — AI Agent Orchestration System

  WOMBO COMBO! Parallel feature development with AI agents.

Commands:                        (alias)
  init                           (i)     Generate .wombo-combo/config.json in the current project
  launch                         (l)     Launch a wave of agents to implement features
  resume                         (r)     Resume a previously stopped wave
  status                         (s)     Show the status of the current wave
  verify                         (v)     Run build verification on completed agents
  merge                          (m)     Merge verified branches into the base branch
  retry                          (re)    Retry a failed agent
  abort                          (a)     Kill a single running agent (--requeue to return to queue)
  logs                           (lo)    Pretty-print agent logs for a feature
  cleanup                        (c)     Remove all wave worktrees and multiplexer sessions
  history                        (h)     List/view past wave results (stored in .wombo-combo/history/)
  tasks                          (t)     Manage tasks file (see below; 'features' also accepted)
  upgrade                        (u)     Check for updates and upgrade wombo-combo
  describe                       (d)     Emit JSON schema of a command (for AI agents)
  completion                     (comp)  Generate shell completions (bash, zsh, fish)
  version                                Print version and exit
  help                                   Show this help

Tasks Subcommands:               (alias)
  tasks list                     (ls)    List tasks (--status, --priority, --difficulty, --ready, --include-archive)
  tasks add <id> <title>         (a)     Add a new task (--desc, --priority, --difficulty, --effort, --depends-on)
  tasks set-status <id> <s>      (ss)    Change a task's status
  tasks set-priority <id> <p>    (sp)    Change a task's priority (critical/high/medium/low/wishlist)
  tasks set-difficulty <id> <d>  (sd)    Change a task's difficulty (trivial/easy/medium/hard/very_hard)
  tasks check                    (ch)    Validate tasks file (schema, deps, duplicates, cycles)
  tasks archive [id]             (ar)    Move done/cancelled to archive (--dry-run)
  tasks show <id>                (sh)    Show task details
  tasks graph                    (g)     Visualize dependency graph (--ascii, --mermaid, --subtasks)

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

Aliases (every command has a short form):
  woco i                         woco init
  woco l --all-ready             woco launch --all-ready
  woco t ls                      woco tasks list
  woco t a my-task "Title"       woco tasks add my-task "Title"
  woco t ss my-task done         woco tasks set-status my-task done

Shell Completion:
  eval "$(woco completion bash)"    # Bash: add to ~/.bashrc
  eval "$(woco completion zsh)"     # Zsh:  add to ~/.zshrc
  woco completion fish | source     # Fish (or save to ~/.config/fish/completions/woco.fish)

Examples:
  woco init
  woco launch --quickest-wins 3
  woco launch --priority high --interactive
  woco launch --tasks "auth-flow,search-api" --max-concurrent 2
  woco resume
  woco status
  woco verify
  woco merge
  woco retry auth-flow
  woco abort auth-flow
  woco abort auth-flow --requeue
  woco abort auth-flow --output json
  woco logs auth-flow
  woco logs auth-flow --tail 50
  woco logs auth-flow --follow
  woco logs auth-flow --output json
  woco cleanup
  woco tasks list --status ready --priority high
  woco tasks list --fields id,status,priority --output json
  woco tasks add my-task "My Cool Task" --priority high --difficulty easy
  woco tasks set-status my-task in-progress
  woco tasks check
  woco tasks archive --dry-run
  woco tasks show my-task
  woco history
  woco history wave-2026-03-12-420
  woco history --output json
  woco describe                           # list all commands as JSON
  woco describe launch                    # describe a specific command
  woco describe tasks add                 # describe a subcommand
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
      console.log(`wombo-combo ${pkg.version ?? "(unknown version)"}`);
    } catch {
      console.log("wombo-combo (unknown version)");
    }
    return;
  }

  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    cmdHelp();
    return;
  }

  if (args.command === "describe") {
    // Schema introspection: `woco describe [command]`
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
        console.error("Run 'woco describe' to list all commands.");
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

  if (args.command === "completion") {
    cmdCompletion({ shell: args.featureId }); // first positional = shell name
    return;
  }

  if (args.command === "logs") {
    if (!args.featureId) {
      console.error("Usage: woco logs <feature-id> [--tail N] [--follow] [--output json]");
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
        console.error("Usage: woco retry <feature-id>");
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
        console.error("Usage: woco abort <feature-id> [--requeue] [--output json]");
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
        console.error("Usage: woco tasks add <id> <title> [--desc <desc>] [--priority <p>] [--difficulty <d>] [--effort <e>] [--depends-on <ids>]");
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
          console.error("Usage: woco tasks set-status <task-id> <status>");
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
          console.error("Usage: woco tasks set-priority <task-id> <priority>");
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
          console.error("Usage: woco tasks set-difficulty <task-id> <difficulty>");
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
        console.error("Usage: woco tasks show <task-id>");
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
      console.error("Run 'woco tasks help' or 'woco help' for usage.");
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
