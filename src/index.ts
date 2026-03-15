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
 *   woco usage [--by <key>] [--since <date>] [--until <date>] [--format table|json]  (alias: us)
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
 *   woco tui                                          (default when no args)
 *   woco wishlist add "idea" [--tag <t>]               (alias: w a, wl a)
 *   woco wishlist list                                 (alias: w ls, wl ls)
 *   woco wishlist delete <id>                          (alias: w rm, wl d)
 *   woco help                                         (alias: -h, --help)
 *   woco version
 *   woco -v
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, validateConfig, isProjectInitialized, WOMBO_DIR } from "./config.js";
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
import { isCittyCommand, runCittyCommand } from "./commands/citty/router.js";
import { cmdTasksList } from "./commands/tasks/list.js";
import { cmdTasksAdd } from "./commands/tasks/add.js";
import { cmdTasksSetStatus } from "./commands/tasks/set-status.js";
import { cmdTasksSetPriority } from "./commands/tasks/set-priority.js";
import { cmdTasksSetDifficulty } from "./commands/tasks/set-difficulty.js";
import { cmdTasksCheck } from "./commands/tasks/check.js";
import { cmdTasksArchive } from "./commands/tasks/archive.js";
import { cmdTasksShow } from "./commands/tasks/show.js";
import { cmdTasksGraph } from "./commands/tasks/graph.js";
import { cmdTui } from "./commands/tui.js";
import { handleQuestSubcommand } from "./commands/quest.js";
import { cmdGenesis } from "./commands/genesis.js";
import { cmdUsage, type UsageGroupBy } from "./commands/usage.js";
import { ensureTasksFile } from "./lib/tasks.js";
import type { Priority, Difficulty, FeatureStatus } from "./lib/tasks.js";
import type { QuestHitlMode } from "./lib/quest.js";
import { resolveOutputFormat, output, outputError, type OutputFormat } from "./lib/output.js";
import { validateId, validateText, validateBranchName, validateDuration, assertValid } from "./lib/validate.js";
import { findCommandDef, commandToSchema, allCommandSchemas, renderCommandHelp, renderGlobalHelp, COMMAND_REGISTRY, buildAliasMap } from "./lib/schema.js";
import { buildToonSpec, renderToonLegend } from "./lib/toon-spec.js";
import { addItem as addWishlistItem, deleteItem as deleteWishlistItem, listItems as listWishlistItems, moveItem as moveWishlistItem } from "./lib/wishlist-store.js";

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
  // TDD verification
  skipTests?: boolean;
  strictTdd?: boolean;
  // Agent selection (per-task override)
  agent?: string;
  // Quest-specific options
  goal?: string;
  hitlMode?: QuestHitlMode;
  /** Quest ID to scope a launch to (--quest <id>) */
  questId?: string;
  /** Tech stack description for genesis (--tech-stack) */
  techStack?: string;
  /** Constraints for genesis (--constraint, can be repeated) */
  genesisConstraints?: string[];
  /** Skip TUI review (--no-tui for genesis) */
  genesisNoTui?: boolean;
  /** Tags for wishlist items (--tag, can be repeated) */
  wishlistTags?: string[];
  /** Usage command: group by field (--by) */
  usageBy?: UsageGroupBy;
  /** Usage command: start date filter (--since) */
  usageSince?: string;
  /** Usage command: end date filter (--until) */
  usageUntil?: string;
  /** Usage command: output format (--format table|json) */
  usageFormat?: "table" | "json";
  /** Developer mode: enables hidden TUI features like fake task seeding */
  dev?: boolean;
  /** Per-command help requested (-h / --help after a command) */
  help?: boolean;
}

// ---------------------------------------------------------------------------
// Command & Subcommand Aliases (derived from COMMAND_REGISTRY)
// ---------------------------------------------------------------------------

/** Map of short aliases → canonical top-level command names. */
export const COMMAND_ALIASES: Record<string, string> = buildAliasMap(COMMAND_REGISTRY);

/** Map of short aliases → canonical tasks subcommand names. */
export const SUBCOMMAND_ALIASES: Record<string, string> = buildAliasMap(
  COMMAND_REGISTRY.find((c) => c.name === "tasks")?.subcommands ?? [],
);

/** Map of short aliases → canonical quest subcommand names. */
export const QUEST_SUBCOMMAND_ALIASES: Record<string, string> = buildAliasMap(
  COMMAND_REGISTRY.find((c) => c.name === "quest")?.subcommands ?? [],
);

/** Map of short aliases → canonical wishlist subcommand names. */
export const WISHLIST_SUBCOMMAND_ALIASES: Record<string, string> = buildAliasMap(
  COMMAND_REGISTRY.find((c) => c.name === "wishlist")?.subcommands ?? [],
);

// ---------------------------------------------------------------------------
// Arg Parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CLIArgs {
  const args = argv.slice(2); // skip 'bun' and script path

  // Pre-scan for global flags that can appear before the command.
  // Strip them from the args array so args[0] is always the command.
  // Global flags: --dev, --force, --output/-o <value>, -h/--help
  const globalFlags: { dev?: boolean; help?: boolean; force?: boolean; output?: string } = {};
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dev") {
      globalFlags.dev = true;
    } else if (a === "-h" || a === "--help") {
      globalFlags.help = true;
    } else if (a === "--force") {
      globalFlags.force = true;
    } else if (a === "--output" || a === "-o") {
      // Only consume as a global flag if followed by a value (not another flag)
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        globalFlags.output = next;
        i++; // skip the value
      } else {
        // No value follows — pass through for command-level parsing
        filtered.push(a);
      }
    } else {
      filtered.push(a);
    }
  }

  const result: CLIArgs = {
    command: filtered[0] || "tui",
    interactive: false,
    dryRun: false,
    noTui: false,
    autoPush: false,
    requeue: false,
    force: globalFlags.force ?? false,
    checkOnly: false,
    outputFmt: resolveOutputFormat(globalFlags.output), // use global --output if provided
    dev: globalFlags.dev,
    help: globalFlags.help,
  };

  // Resolve top-level command alias (e.g., "i" → "init", "t" → "tasks")
  result.command = COMMAND_ALIASES[result.command] ?? result.command;

  // If the command is "tasks", treat the second positional as the subcommand
  let startIdx = 1;
  if (result.command === "tasks") {
    result.subcommand = filtered[1] || "list";
    // Resolve subcommand alias (e.g., "ls" → "list", "ss" → "set-status")
    result.subcommand = SUBCOMMAND_ALIASES[result.subcommand] ?? result.subcommand;
    startIdx = 2;
  } else if (result.command === "quest") {
    result.subcommand = filtered[1] || "list";
    // Resolve quest subcommand alias (e.g., "c" → "create", "sh" → "show")
    result.subcommand = QUEST_SUBCOMMAND_ALIASES[result.subcommand] ?? result.subcommand;
    startIdx = 2;
  } else if (result.command === "wishlist") {
    result.subcommand = filtered[1] || "list";
    // Resolve wishlist subcommand alias (e.g., "a" → "add", "ls" → "list")
    result.subcommand = WISHLIST_SUBCOMMAND_ALIASES[result.subcommand] ?? result.subcommand;
    startIdx = 2;
  }

  for (let i = startIdx; i < filtered.length; i++) {
    const arg = filtered[i];

    // Helper: consume the next argument, or exit with a clear error
    function requireValue(flag: string): string {
      if (i + 1 >= filtered.length) {
        outputError(result.outputFmt, `Flag ${flag} requires a value.`);
      }
      return filtered[++i];
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
        // --tag is overloaded: for 'upgrade' it's a release tag (single string),
        // for 'wishlist' it's a categorization tag (repeatable array).
        if (result.command === "wishlist") {
          if (!result.wishlistTags) result.wishlistTags = [];
          result.wishlistTags.push(requireValue(arg));
        } else {
          result.tag = requireValue(arg);
        }
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

      // --- TDD verification ---
      case "--skip-tests":
        result.skipTests = true;
        break;
      case "--strict-tdd":
        result.strictTdd = true;
        break;

      // --- Agent selection ---
      case "--agent":
        result.agent = requireValue(arg);
        break;

      // --- Quest-specific options ---
      case "--goal":
        result.goal = requireValue(arg);
        break;
      case "--hitl":
        result.hitlMode = requireValue(arg) as QuestHitlMode;
        break;
      case "--quest":
        result.questId = requireValue(arg);
        break;

      // --- Genesis-specific options ---
      case "--tech-stack":
        result.techStack = requireValue(arg);
        break;
      case "--constraint":
        if (!result.genesisConstraints) result.genesisConstraints = [];
        result.genesisConstraints.push(requireValue(arg));
        break;

      // --- Usage-specific options ---
      case "--by":
        result.usageBy = requireValue(arg) as UsageGroupBy;
        break;
      case "--since":
        result.usageSince = requireValue(arg);
        break;
      case "--until":
        result.usageUntil = requireValue(arg);
        break;
      case "--format":
        result.usageFormat = requireValue(arg) as "table" | "json";
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
  console.log(renderGlobalHelp());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  checkDevModeGuard();

  const PROJECT_ROOT = resolve(process.cwd());
  const args = parseArgs(process.argv);

  // -----------------------------------------------------------------------
  // Citty-routed commands — delegate to citty for arg parsing & execution
  // -----------------------------------------------------------------------
  // Commands migrated to citty handle their own config loading, validation,
  // and arg parsing. We only use parseArgs() here for alias resolution
  // (e.g., "l" → "launch") and --dev detection.
  const CITTY_ROUTED = new Set(["launch", "resume", "retry"]);
  if (CITTY_ROUTED.has(args.command)) {
    // Build rawArgs for citty: everything after the command name.
    // parseArgs strips --dev from the arg list, so we need to re-add it
    // for citty commands that define --dev as a flag.
    const rawArgv = process.argv.slice(2); // skip 'bun' and script path
    const cmdIdx = rawArgv.findIndex(
      (a) => a !== "--dev" && a !== "-h" && a !== "--help" && !a.startsWith("-")
    );
    const rawArgs = cmdIdx >= 0 ? rawArgv.slice(cmdIdx + 1) : [];
    // Ensure --dev is passed through if it was present
    if (args.dev && !rawArgs.includes("--dev")) {
      rawArgs.push("--dev");
    }
    await runCittyCommand(args.command, rawArgs);
    return;
  }

  // -----------------------------------------------------------------------
  // Input validation at the CLI boundary
  // -----------------------------------------------------------------------
  // Skip ID validation for wishlist — its first positional is free-form text, not a kebab-case ID.
  const needsIdValidation = args.command !== "wishlist";
  if (args.featureId && needsIdValidation) {
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

  // Validate numeric args are not NaN
  const numericArgs: [string, number | undefined][] = [
    ["--top-priority", args.topPriority],
    ["--quickest-wins", args.quickestWins],
    ["--max-concurrent", args.maxConcurrent],
    ["--max-retries", args.maxRetries],
    ["--tail", args.tail],
  ];
  for (const [flag, value] of numericArgs) {
    if (value !== undefined && isNaN(value)) {
      outputError(args.outputFmt, `${flag} requires a numeric value.`);
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

  // Per-command help: `woco launch -h`, `woco tasks list -h`, etc.
  // If the command is "tui" (the default when no command is typed), and help was
  // requested, the user typed `woco -h` — show global help.
  if (args.help) {
    if (args.command === "tui") {
      cmdHelp();
      return;
    }

    // For commands with subcommands (tasks, quest, wishlist), `woco tasks -h`
    // should show the parent overview (all subcommands), not the default subcommand.
    // Only pass the subcommand if the user explicitly typed one (i.e., there's a
    // second positional before the -h).
    const parentCmdsWithSubs = new Set(["tasks", "quest", "wishlist"]);
    let effectiveSubcommand = args.subcommand;
    if (parentCmdsWithSubs.has(args.command)) {
      // Filter out all global flags (and their values) from raw args to detect
      // if an explicit subcommand was typed.
      const rawArgsFull = process.argv.slice(2);
      const rawArgs: string[] = [];
      for (let ri = 0; ri < rawArgsFull.length; ri++) {
        const ra = rawArgsFull[ri];
        if (ra === "--dev" || ra === "--force" || ra === "-h" || ra === "--help") {
          continue; // skip boolean global flags
        }
        if (ra === "--output" || ra === "-o") {
          ri++; // skip the value too
          continue;
        }
        rawArgs.push(ra);
      }
      const explicitSub = rawArgs[1] && !rawArgs[1].startsWith("-") ? rawArgs[1] : undefined;
      // If no explicit subcommand was typed, show parent help.
      // Otherwise, use the resolved subcommand (alias-expanded by parseArgs).
      effectiveSubcommand = explicitSub ? args.subcommand : undefined;
    }

    const helpText = renderCommandHelp(args.command, effectiveSubcommand);
    if (helpText) {
      console.log(helpText);
    } else {
      console.error(`No help available for: ${args.command}${effectiveSubcommand ? " " + effectiveSubcommand : ""}`);
      cmdHelp();
    }
    return;
  }

  if (args.command === "describe") {
    // Schema introspection: `woco describe [command]`
    if (args.outputFmt === "toon") {
      // Emit TOON format legend — self-describing, cacheable by agents
      const pkgPath = resolve(import.meta.dir, "..", "package.json");
      let version = "unknown";
      try {
        const pkg = await Bun.file(pkgPath).json();
        version = pkg.version ?? "unknown";
      } catch {}

      if (!args.featureId) {
        // Full TOON spec (legend + all commands)
        console.log(renderToonLegend(version));
      } else {
        // JSON structure for the full spec (--output toon with a specific command
        // still emits JSON since TOON is a line-oriented data format, not a schema format)
        const spec = buildToonSpec(version);
        const cmdName = args.title
          ? `${args.featureId} ${args.title}`
          : args.featureId;
        const cmdSpec = spec.commands.find((c) => c.command === cmdName);
        if (!cmdSpec) {
          outputError(args.outputFmt, `Unknown command: "${cmdName}". Run 'woco describe --output toon' to see the full TOON spec.`);
          return;
        }
        console.log(JSON.stringify(cmdSpec, null, 2));
      }
      return;
    }

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
        outputError(args.outputFmt, `Unknown command: "${cmdName}". Run 'woco describe' to list all commands.`);
        return;
      }
      console.log(JSON.stringify(commandToSchema(def), null, 2));
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Citty-managed commands: route through the citty router for typed args
  // -----------------------------------------------------------------------
  // Commands migrated to citty handle their own arg parsing, config loading,
  // and validation. Extract raw CLI args (without --dev and -h/--help which
  // parseArgs already consumed) and delegate to the citty router.
  if (isCittyCommand(args.command)) {
    const rawCliArgs = process.argv.slice(2).filter(
      (a) => a !== "--dev" && a !== "-h" && a !== "--help"
    );
    // First non-flag arg is the command name/alias; everything after is for citty
    const cmdIndex = rawCliArgs.findIndex((a) => !a.startsWith("-"));
    const cittyRawArgs = cmdIndex >= 0 ? rawCliArgs.slice(cmdIndex + 1) : [];
    await runCittyCommand(args.command, cittyRawArgs);
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
    const sub = args.featureId;
    if (sub === "install") {
      const { installCompletions } = await import("./commands/completion.js");
      installCompletions();
    } else if (sub === "uninstall") {
      const { uninstallCompletions } = await import("./commands/completion.js");
      uninstallCompletions();
    } else {
      cmdCompletion({ shell: sub }); // first positional = shell name
    }
    return;
  }

  if (args.command === "logs") {
    if (!args.featureId) {
      outputError(args.outputFmt, "Usage: woco logs <feature-id> [--tail N] [--follow] [--output json]");
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

  // Guard: project must be initialized for all config-dependent commands
  if (!isProjectInitialized(PROJECT_ROOT)) {
    console.error(
      `\nThis project hasn't been initialized yet.\n` +
      `Run \`woco init\` to set up ${WOMBO_DIR}/ with config, tasks, and archive stores.\n`
    );
    process.exit(1);
  }

  // Apply --dev flag (CLI override for devMode, merges with config.devMode)
  if (args.dev) {
    config.devMode = true;
  }

  // Commands that operate on the tasks file — ensure it exists first
  const needsTasksFile = new Set(["launch", "resume", "verify", "retry", "tasks", "tui"]);
  if (needsTasksFile.has(args.command)) {
    await ensureTasksFile(PROJECT_ROOT, config);
  }

  switch (args.command) {
    case "launch":
      // Apply browser verification override if --browser flag was passed
      if (args.browser !== undefined) {
        config.browser.enabled = args.browser;
      }
      try {
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
          agent: args.agent,
          questId: args.questId,
        });
      } catch (err: any) {
        outputError(args.outputFmt ?? "text", err.message);
      }
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
        outputFmt: args.outputFmt,
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
        skipTests: args.skipTests,
        strictTdd: args.strictTdd,
        outputFmt: args.outputFmt,
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
        outputFmt: args.outputFmt,
      });
      break;

    case "retry": {
      if (!args.featureId) {
        outputError(args.outputFmt, "Usage: woco retry <feature-id>");
        return;
      }
      await cmdRetry({
        projectRoot: PROJECT_ROOT,
        config,
        featureId: args.featureId,
        model: args.model,
        interactive: args.interactive,
        dryRun: args.dryRun,
        outputFmt: args.outputFmt,
      });
      break;
    }

    case "cleanup":
      await cmdCleanup({ projectRoot: PROJECT_ROOT, config, dryRun: args.dryRun, outputFmt: args.outputFmt });
      break;

    case "history":
      await cmdHistory({
        projectRoot: PROJECT_ROOT,
        config,
        waveId: args.featureId,
        outputFmt: args.outputFmt,
      });
      break;

    case "usage":
      await cmdUsage({
        projectRoot: PROJECT_ROOT,
        config,
        by: args.usageBy,
        since: args.usageSince,
        until: args.usageUntil,
        usageFormat: args.usageFormat ?? "table",
        outputFmt: args.outputFmt,
      });
      break;

    case "abort": {
      if (!args.featureId) {
        outputError(args.outputFmt, "Usage: woco abort <feature-id> [--requeue] [--output json]");
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

    case "quest":
      await handleQuestSubcommand({
        projectRoot: PROJECT_ROOT,
        config,
        subcommand: args.subcommand ?? "list",
        questId: args.featureId,
        title: args.title,
        goal: args.goal,
        priority: args.priority,
        difficulty: args.difficulty,
        hitlMode: args.hitlMode,
        status: args.status,
        agent: args.agent,
        dryRun: args.dryRun,
        force: args.force,
        outputFmt: args.outputFmt,
        fields: args.fields,
      });
      break;

    case "genesis":
      await cmdGenesis({
        projectRoot: PROJECT_ROOT,
        config,
        vision: args.featureId,  // first positional arg is the vision text
        techStack: args.techStack,
        constraints: args.genesisConstraints,
        model: args.model,
        dryRun: args.dryRun,
        noTui: args.noTui,
        outputFmt: args.outputFmt,
      });
      break;

    case "wishlist":
      handleWishlistSubcommand(args, PROJECT_ROOT, config);
      break;

    case "tui":
      await cmdTui({
        projectRoot: PROJECT_ROOT,
        config,
        maxConcurrent: args.maxConcurrent,
        model: args.model,
        baseBranch: args.baseBranch,
        maxRetries: args.maxRetries,
        autoPush: args.autoPush,
        skipTests: args.skipTests,
        strictTdd: args.strictTdd,
        agent: args.agent,
      });
      break;

    default:
      if (args.outputFmt !== "text") {
        outputError(args.outputFmt, `Unknown command: ${args.command}`);
      }
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
        outputError(args.outputFmt, "Usage: woco tasks add <id> <title> [--desc <desc>] [--priority <p>] [--difficulty <d>] [--effort <e>] [--depends-on <ids>]");
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
      // The new status can come from the second positional (stored in args.title)
      // or from the --status flag
      const newStatus = args.title || args.status;
      if (!args.featureId || !newStatus) {
        outputError(args.outputFmt, "Usage: woco tasks set-status <task-id> <status>");
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
      break;
    }

    case "set-priority": {
      // The new priority can come from the second positional (stored in args.title)
      // or from the --priority flag
      const newPriority = args.title || (args.priority as string | undefined);
      if (!args.featureId || !newPriority) {
        outputError(args.outputFmt, "Usage: woco tasks set-priority <task-id> <priority>");
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
      break;
    }

    case "set-difficulty": {
      // The new difficulty can come from the second positional (stored in args.title)
      // or from the --difficulty flag
      const newDifficulty = args.title || (args.difficulty as string | undefined);
      if (!args.featureId || !newDifficulty) {
        outputError(args.outputFmt, "Usage: woco tasks set-difficulty <task-id> <difficulty>");
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
      break;
    }

    case "check":
      await cmdTasksCheck({ projectRoot, config, outputFmt: args.outputFmt });
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
        outputError(args.outputFmt, "Usage: woco tasks show <task-id>");
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
    case "-h": {
      const helpText = renderCommandHelp("tasks");
      if (helpText) {
        console.log(helpText);
      } else {
        cmdHelp();
      }
      break;
    }

    default:
      outputError(args.outputFmt, `Unknown tasks subcommand: ${args.subcommand}. Run 'woco tasks help' or 'woco help' for usage.`);
      return;
  }
}

// ---------------------------------------------------------------------------
// Wishlist Subcommand Router
// ---------------------------------------------------------------------------

function handleWishlistSubcommand(
  args: CLIArgs,
  projectRoot: string,
  _config: import("./config.js").WomboConfig
): void {
  switch (args.subcommand) {
    case "add": {
      // The wishlist text comes from the first positional arg (featureId)
      // and optionally continues into the second positional (title).
      // Combine them if both are present.
      const textParts: string[] = [];
      if (args.featureId) textParts.push(args.featureId);
      if (args.title) textParts.push(args.title);
      const text = textParts.join(" ");

      if (!text) {
        outputError(args.outputFmt, 'Usage: woco wishlist add "Your idea here" [--tag <tag>]');
        return;
      }

      try {
        const item = addWishlistItem(projectRoot, text, args.wishlistTags);
        output(
          args.outputFmt,
          item,
          () => {
            console.log(`Added wishlist item: ${item.text}`);
            console.log(`  ID: ${item.id}`);
            if (item.tags.length > 0) {
              console.log(`  Tags: ${item.tags.join(", ")}`);
            }
          }
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputError(args.outputFmt, `Failed to add wishlist item: ${msg}`);
      }
      break;
    }

    case "list": {
      const items = listWishlistItems(projectRoot);
      output(
        args.outputFmt,
        items,
        () => {
          if (items.length === 0) {
            console.log("No wishlist items yet. Add one with: woco wishlist add \"Your idea\"");
            return;
          }
          console.log(`Wishlist (${items.length} item${items.length === 1 ? "" : "s"}):\n`);
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const pos = String(i + 1).padStart(2, " ");
            const tags = item.tags.length > 0 ? ` [${item.tags.join(", ")}]` : "";
            const date = new Date(item.created_at).toLocaleDateString();
            console.log(`  ${pos}. ${item.id.slice(0, 8)}  ${item.text}${tags}  (${date})`);
          }
        }
      );
      break;
    }

    case "move": {
      if (!args.featureId) {
        outputError(args.outputFmt, "Usage: woco wishlist move <id> <position>");
        return;
      }

      const posStr = args.title; // second positional arg is the target position
      const position = posStr ? parseInt(posStr, 10) : NaN;
      if (isNaN(position) || position < 1) {
        outputError(args.outputFmt, "Position must be a positive integer. Usage: woco wishlist move <id> <position>");
        return;
      }

      // Support both full UUIDs and short prefixes
      const allItems = listWishlistItems(projectRoot);
      const moveMatch = allItems.find(
        (item) => item.id === args.featureId || item.id.startsWith(args.featureId!)
      );

      if (!moveMatch) {
        outputError(args.outputFmt, `No wishlist item found matching: ${args.featureId}`);
        return;
      }

      const moved = moveWishlistItem(projectRoot, moveMatch.id, position);
      if (moved) {
        output(
          args.outputFmt,
          { moved: true, id: moved.id, text: moved.text, order: moved.order },
          () => {
            console.log(`Moved "${moved.text}" to position ${moved.order}`);
          }
        );
      } else {
        outputError(args.outputFmt, `Failed to move wishlist item: ${moveMatch.id}`);
      }
      break;
    }

    case "delete": {
      if (!args.featureId) {
        outputError(args.outputFmt, "Usage: woco wishlist delete <id>");
        return;
      }

      // Support both full UUIDs and short prefixes
      const items = listWishlistItems(projectRoot);
      const match = items.find(
        (item) => item.id === args.featureId || item.id.startsWith(args.featureId!)
      );

      if (!match) {
        outputError(args.outputFmt, `No wishlist item found matching: ${args.featureId}`);
        return;
      }

      const deleted = deleteWishlistItem(projectRoot, match.id);
      if (deleted) {
        output(
          args.outputFmt,
          { deleted: true, id: match.id, text: match.text },
          () => {
            console.log(`Deleted wishlist item: ${match.text}`);
          }
        );
      } else {
        outputError(args.outputFmt, `Failed to delete wishlist item: ${match.id}`);
      }
      break;
    }

    case "help":
    case "--help":
    case "-h": {
      const helpText = renderCommandHelp("wishlist");
      if (helpText) {
        console.log(helpText);
      } else {
        cmdHelp();
      }
      break;
    }

    default:
      outputError(args.outputFmt, `Unknown wishlist subcommand: ${args.subcommand}. Run 'woco wishlist help' or 'woco help' for usage.`);
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

// Only run main() when executed directly, not when imported as a module
// (e.g. by tests that import parseArgs).
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
}
