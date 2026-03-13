/**
 * schema.ts — Declarative command/flag registry for schema introspection.
 *
 * Every command and flag is described in a single registry. This registry is
 * the source of truth for:
 *   1. `woco describe <command>` — emits a JSON schema of accepted args
 *   2. Future help text generation
 *
 * The registry is NOT used for actual arg parsing (that's still the hand-rolled
 * switch in index.ts), but the two must stay in sync. If they drift, `woco
 * tasks check` should eventually catch it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VALID_STATUSES, VALID_PRIORITIES, VALID_DIFFICULTIES } from "./task-schema.js";

// ---------------------------------------------------------------------------
// Dynamic version reader
// ---------------------------------------------------------------------------

function getVersion(): string {
  try {
    const pkgPath = resolve(import.meta.dir, "../../package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    return JSON.parse(raw).version as string;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlagDef {
  /** Primary flag name, e.g. "--dry-run" */
  name: string;
  /** Short alias, e.g. "-o" */
  alias?: string;
  /** Description shown in help / schema */
  description: string;
  /** Type of the value: "boolean" flags take no value, others consume next arg */
  type: "string" | "number" | "boolean" | "string[]";
  /** Default value (undefined = required or absent) */
  default?: unknown;
  /** For enum-like flags, the set of allowed values */
  enum?: readonly string[];
  /** If true, this flag is required */
  required?: boolean;
}

export interface PositionalDef {
  /** Name used in usage strings, e.g. "feature-id" */
  name: string;
  description: string;
  required?: boolean;
}

export interface CommandDef {
  /** Command name as typed by the user, e.g. "launch" or "features list" */
  name: string;
  /** One-line summary */
  summary: string;
  /** Longer description */
  description?: string;
  /** Positional arguments */
  positionals: PositionalDef[];
  /** Named flags */
  flags: FlagDef[];
  /** Whether this command mutates state (used for dry-run indication) */
  mutating: boolean;
  /** Whether this command supports --dry-run */
  supportsDryRun: boolean;
  /** Subcommands (for "tasks" parent) */
  subcommands?: CommandDef[];
}

// ---------------------------------------------------------------------------
// Global flags (available on every command)
// ---------------------------------------------------------------------------

const GLOBAL_FLAGS: FlagDef[] = [
  {
    name: "--output",
    alias: "-o",
    description: "Output format: text (default) or json",
    type: "string",
    default: "text",
    enum: ["text", "json", "toon"],
  },
  {
    name: "--force",
    description: "Force overwrite / skip safety prompts",
    type: "boolean",
    default: false,
  },
];

// ---------------------------------------------------------------------------
// Command Registry
// ---------------------------------------------------------------------------

export const COMMAND_REGISTRY: CommandDef[] = [
  // --- init ---------------------------------------------------------------
  {
    name: "init",
    summary: "Generate .wombo-combo/config.json in the current project",
    description:
      "Interactive guided setup that walks through every config section. " +
      "Creates .wombo-combo/config.json and .wombo-combo/tasks.yml from template.",
    positionals: [],
    flags: [
      {
        name: "--force",
        description: "Overwrite existing config files",
        type: "boolean",
        default: false,
      },
      {
        name: "--dry-run",
        description: "Show what would be created without writing files",
        type: "boolean",
        default: false,
      },
    ],
    mutating: true,
    supportsDryRun: true,
  },

  // --- launch -------------------------------------------------------------
  {
    name: "launch",
    summary: "Launch a wave of agents to implement features",
    description:
      "Select features from the tasks file, create worktrees, and spawn agents. " +
      "Supports multiple selection strategies.",
    positionals: [],
    flags: [
      { name: "--top-priority", description: "Select top N features by priority", type: "number" },
      { name: "--quickest-wins", description: "Select N features with lowest effort", type: "number" },
      { name: "--priority", description: "Filter by priority level", type: "string", enum: VALID_PRIORITIES },
      { name: "--difficulty", description: "Filter by difficulty level", type: "string", enum: VALID_DIFFICULTIES },
      { name: "--features", description: "Select specific features by comma-separated IDs (alias for --tasks)", type: "string" },
      { name: "--tasks", description: "Select specific tasks by comma-separated IDs", type: "string" },
      { name: "--all-ready", description: "Select all features whose dependencies are met", type: "boolean", default: false },
      { name: "--max-concurrent", description: "Max agents running in parallel", type: "number" },
      { name: "--model", alias: "-m", description: "Model to use (e.g., anthropic/claude-sonnet-4-20250514)", type: "string" },
      { name: "--interactive", description: "Use multiplexer (dmux/tmux) TUI mode instead of headless", type: "boolean", default: false },
      { name: "--no-tui", description: "Headless mode without neo-blessed TUI", type: "boolean", default: false },
      { name: "--auto-push", description: "Push base branch to remote after all merges", type: "boolean", default: false },
      { name: "--dry-run", description: "Show what would be launched without launching", type: "boolean", default: false },
      { name: "--base-branch", description: "Base branch (default: from config)", type: "string" },
      { name: "--max-retries", description: "Max retries per agent", type: "number" },
      { name: "--browser", description: "Enable browser-based verification after build passes", type: "boolean", default: false },
    ],
    mutating: true,
    supportsDryRun: true,
  },

  // --- resume -------------------------------------------------------------
  {
    name: "resume",
    summary: "Resume a previously stopped wave",
    positionals: [],
    flags: [
      { name: "--max-concurrent", description: "Max agents running in parallel", type: "number" },
      { name: "--model", alias: "-m", description: "Model to use", type: "string" },
      { name: "--interactive", description: "Use multiplexer (dmux/tmux) TUI mode", type: "boolean", default: false },
      { name: "--no-tui", description: "Headless mode without neo-blessed TUI", type: "boolean", default: false },
      { name: "--auto-push", description: "Push base branch to remote after merges", type: "boolean", default: false },
      { name: "--base-branch", description: "Base branch override", type: "string" },
      { name: "--max-retries", description: "Max retries per agent", type: "number" },
    ],
    mutating: true,
    supportsDryRun: false,
  },

  // --- status -------------------------------------------------------------
  {
    name: "status",
    summary: "Show the status of the current wave",
    positionals: [],
    flags: [],
    mutating: false,
    supportsDryRun: false,
  },

  // --- verify -------------------------------------------------------------
  {
    name: "verify",
    summary: "Run build verification on completed agents",
    positionals: [
      { name: "feature-id", description: "Specific feature to verify (optional)", required: false },
    ],
    flags: [
      { name: "--model", alias: "-m", description: "Model to use for verification", type: "string" },
      { name: "--max-retries", description: "Max retries", type: "number" },
      { name: "--browser", description: "Enable browser-based verification after build passes", type: "boolean", default: false },
    ],
    mutating: true,
    supportsDryRun: false,
  },

  // --- merge --------------------------------------------------------------
  {
    name: "merge",
    summary: "Merge verified branches into the base branch",
    positionals: [
      { name: "feature-id", description: "Specific feature to merge (optional)", required: false },
    ],
    flags: [
      { name: "--auto-push", description: "Push base branch to remote after merge", type: "boolean", default: false },
      { name: "--dry-run", description: "Show what would be merged without merging", type: "boolean", default: false },
    ],
    mutating: true,
    supportsDryRun: true,
  },

  // --- retry --------------------------------------------------------------
  {
    name: "retry",
    summary: "Retry a failed agent",
    positionals: [
      { name: "feature-id", description: "Feature ID of the failed agent", required: true },
    ],
    flags: [
      { name: "--model", alias: "-m", description: "Model to use", type: "string" },
      { name: "--interactive", description: "Use multiplexer (dmux/tmux) TUI mode", type: "boolean", default: false },
      { name: "--dry-run", description: "Show what would be retried without retrying", type: "boolean", default: false },
    ],
    mutating: true,
    supportsDryRun: true,
  },

  // --- cleanup ------------------------------------------------------------
  {
    name: "cleanup",
    summary: "Remove all wave worktrees and multiplexer sessions",
    description: "Kills multiplexer sessions, removes worktrees, removes state and log files.",
    positionals: [],
    flags: [
      { name: "--dry-run", description: "Show what would be cleaned up without removing", type: "boolean", default: false },
    ],
    mutating: true,
    supportsDryRun: true,
  },

  // --- history ------------------------------------------------------------
  {
    name: "history",
    summary: "List/view past wave results from .wombo-combo/history/",
    description:
      "Wave history is auto-exported when a wave completes. Records are stored " +
      "separately from .wombo-combo/state.json and survive cleanup. Use without arguments " +
      "to list all waves, or pass a wave ID to see detailed results.",
    positionals: [
      { name: "wave-id", description: "Specific wave ID to show details for (optional)", required: false },
    ],
    flags: [],
    mutating: false,
    supportsDryRun: false,
  },

  // --- abort --------------------------------------------------------------
  {
    name: "abort",
    summary: "Kill a single running agent without affecting the rest of the wave",
    description:
      "Kills the multiplexer session and agent process for a specific feature, then " +
      "marks the agent as failed. Use --requeue to return the feature to the " +
      "queue instead of marking it failed.",
    positionals: [
      { name: "feature-id", description: "Feature ID of the agent to abort", required: true },
    ],
    flags: [
      { name: "--requeue", description: "Return the feature to queued instead of marking it failed", type: "boolean", default: false },
    ],
    mutating: true,
    supportsDryRun: false,
  },

  // --- upgrade ------------------------------------------------------------
  {
    name: "upgrade",
    summary: "Check for updates and upgrade wombo",
    positionals: [],
    flags: [
      { name: "--check", description: "Only check for updates, don't install", type: "boolean", default: false },
      { name: "--tag", alias: "--release", description: "Install a specific version (e.g., v0.1.0)", type: "string" },
      { name: "--force", description: "Force reinstall even if up to date", type: "boolean", default: false },
    ],
    mutating: true,
    supportsDryRun: false,
  },

  // --- logs ---------------------------------------------------------------
  {
    name: "logs",
    summary: "Pretty-print agent logs from .wombo-combo/logs/<feature-id>.log",
    description:
      "Reads log files written by agents during headless runs and displays " +
      "them with colorized output. Supports tailing and following.",
    positionals: [
      { name: "feature-id", description: "Feature ID whose logs to display", required: true },
    ],
    flags: [
      { name: "--tail", description: "Show only the last N lines", type: "number" },
      { name: "--follow", alias: "-f", description: "Stream new output as it arrives (like tail -f)", type: "boolean", default: false },
    ],
    mutating: false,
    supportsDryRun: false,
  },

  // --- tasks (parent with subcommands) — also accepts "features" as alias ---
  {
    name: "tasks",
    summary: "Manage tasks file",
    positionals: [],
    flags: [],
    mutating: false,
    supportsDryRun: false,
    subcommands: [
      {
        name: "tasks list",
        summary: "List tasks with optional filtering",
        positionals: [],
        flags: [
          { name: "--status", description: "Filter by status", type: "string", enum: VALID_STATUSES },
          { name: "--priority", description: "Filter by priority", type: "string", enum: VALID_PRIORITIES },
          { name: "--difficulty", description: "Filter by difficulty", type: "string", enum: VALID_DIFFICULTIES },
          { name: "--ready", description: "Show only ready tasks (backlog + deps met)", type: "boolean", default: false },
          { name: "--include-archive", description: "Include archived tasks", type: "boolean", default: false },
          { name: "--fields", description: "Comma-separated list of fields to include in output", type: "string" },
        ],
        mutating: false,
        supportsDryRun: false,
      },
      {
        name: "tasks add",
        summary: "Add a new task",
        positionals: [
          { name: "id", description: "Task ID (kebab-case)", required: true },
          { name: "title", description: "Task title", required: true },
        ],
        flags: [
          { name: "--description", alias: "--desc", description: "Task description", type: "string" },
          { name: "--priority", description: "Priority level", type: "string", default: "medium", enum: VALID_PRIORITIES },
          { name: "--difficulty", description: "Difficulty level", type: "string", default: "medium", enum: VALID_DIFFICULTIES },
          { name: "--effort", description: "Effort estimate (ISO 8601 duration, e.g. PT2H)", type: "string", default: "PT1H" },
          { name: "--depends-on", description: "Comma-separated dependency IDs", type: "string" },
          { name: "--dry-run", description: "Show what would be added without writing", type: "boolean", default: false },
        ],
        mutating: true,
        supportsDryRun: true,
      },
      {
        name: "tasks set-status",
        summary: "Change a task's status",
        positionals: [
          { name: "task-id", description: "Task ID to update", required: true },
          { name: "status", description: "New status value", required: true },
        ],
        flags: [
          { name: "--dry-run", description: "Show what would change without writing", type: "boolean", default: false },
        ],
        mutating: true,
        supportsDryRun: true,
      },
      {
        name: "tasks set-priority",
        summary: "Change a task's priority",
        positionals: [
          { name: "task-id", description: "Task ID to update", required: true },
          { name: "priority", description: "New priority value", required: true },
        ],
        flags: [
          { name: "--dry-run", description: "Show what would change without writing", type: "boolean", default: false },
        ],
        mutating: true,
        supportsDryRun: true,
      },
      {
        name: "tasks set-difficulty",
        summary: "Change a task's difficulty",
        positionals: [
          { name: "task-id", description: "Task ID to update", required: true },
          { name: "difficulty", description: "New difficulty value", required: true },
        ],
        flags: [
          { name: "--dry-run", description: "Show what would change without writing", type: "boolean", default: false },
        ],
        mutating: true,
        supportsDryRun: true,
      },
      {
        name: "tasks check",
        summary: "Validate tasks file (schema, deps, duplicates, cycles)",
        positionals: [],
        flags: [],
        mutating: false,
        supportsDryRun: false,
      },
      {
        name: "tasks archive",
        summary: "Move done/cancelled tasks to archive section",
        positionals: [
          { name: "task-id", description: "Specific task to archive (optional)", required: false },
        ],
        flags: [
          { name: "--dry-run", description: "Show what would be archived without moving", type: "boolean", default: false },
        ],
        mutating: true,
        supportsDryRun: true,
      },
      {
        name: "tasks show",
        summary: "Show detailed information about a specific task",
        positionals: [
          { name: "task-id", description: "Task ID to display", required: true },
        ],
        flags: [
          { name: "--fields", description: "Comma-separated list of fields to include in output", type: "string" },
        ],
        mutating: false,
        supportsDryRun: false,
      },
      {
        name: "tasks graph",
        summary: "Visualize the task dependency graph as a terminal diagram",
        description:
          "Builds a Mermaid flowchart from the tasks dependency graph and renders " +
          "it as a Unicode box diagram. Shows dependency edges, status badges, orphan " +
          "detection, dangling dependency warnings, and cycle detection.",
        positionals: [],
        flags: [
          { name: "--status", description: "Filter graph to tasks with this status", type: "string", enum: VALID_STATUSES },
          { name: "--ascii", description: "Use ASCII-only rendering (no Unicode box chars)", type: "boolean", default: false },
          { name: "--mermaid", description: "Emit raw Mermaid source instead of rendered graph", type: "boolean", default: false },
          { name: "--subtasks", description: "Include subtask-level nodes in the graph", type: "boolean", default: false },
        ],
        mutating: false,
        supportsDryRun: false,
      },
    ],
  },

  // --- help ---------------------------------------------------------------
  {
    name: "help",
    summary: "Show help text",
    positionals: [],
    flags: [],
    mutating: false,
    supportsDryRun: false,
  },

  // --- version -----------------------------------------------------------
  {
    name: "version",
    summary: "Print version and exit (also: -v, -V)",
    positionals: [],
    flags: [],
    mutating: false,
    supportsDryRun: false,
  },

  // --- describe -----------------------------------------------------------
  {
    name: "describe",
    summary: "Emit JSON schema of a command's arguments and flags",
    description:
      "Machine-readable introspection for AI agents. Outputs the accepted " +
      "positionals, flags, types, defaults, and constraints for a command.",
    positionals: [
      { name: "command", description: "Command to describe (e.g. 'launch', 'features add')", required: false },
    ],
    flags: [],
    mutating: false,
    supportsDryRun: false,
  },
];

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Find a command definition by name. Supports compound names like "tasks list".
 * Also supports "features" as a backward-compat alias for "tasks".
 */
export function findCommandDef(name: string): CommandDef | undefined {
  // Normalize "features" -> "tasks" for backward compatibility
  const normalized = name.replace(/^features(\s|$)/, "tasks$1");

  // Try direct match first
  const direct = COMMAND_REGISTRY.find((c) => c.name === normalized);
  if (direct) return direct;

  // Try compound: "tasks list" -> look in tasks subcommands
  const parts = normalized.split(/\s+/);
  if (parts.length === 2) {
    const parent = COMMAND_REGISTRY.find((c) => c.name === parts[0]);
    if (parent?.subcommands) {
      return parent.subcommands.find((sc) => sc.name === normalized || sc.name === parts[1]);
    }
  }

  return undefined;
}

/**
 * Produce the JSON schema object for a command, suitable for agent consumption.
 */
export function commandToSchema(cmd: CommandDef): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    command: cmd.name,
    summary: cmd.summary,
    mutating: cmd.mutating,
    supports_dry_run: cmd.supportsDryRun,
  };

  if (cmd.description) {
    schema.description = cmd.description;
  }

  if (cmd.positionals.length > 0) {
    schema.positionals = cmd.positionals.map((p) => ({
      name: p.name,
      description: p.description,
      required: p.required ?? false,
    }));
  }

  const allFlags = [...cmd.flags, ...GLOBAL_FLAGS];
  schema.flags = allFlags.map((f) => {
    const entry: Record<string, unknown> = {
      name: f.name,
      type: f.type,
      description: f.description,
    };
    if (f.alias) entry.alias = f.alias;
    if (f.default !== undefined) entry.default = f.default;
    if (f.enum) entry.enum = f.enum;
    if (f.required) entry.required = true;
    return entry;
  });

  if (cmd.subcommands?.length) {
    schema.subcommands = cmd.subcommands.map((sc) => sc.name);
  }

  return schema;
}

/**
 * Produce a listing of all commands (for `woco describe` with no args).
 */
export function allCommandSchemas(): Record<string, unknown> {
  const commands: Record<string, unknown>[] = [];

  for (const cmd of COMMAND_REGISTRY) {
    const entry: Record<string, unknown> = {
      name: cmd.name,
      summary: cmd.summary,
      mutating: cmd.mutating,
      supports_dry_run: cmd.supportsDryRun,
    };
    if (cmd.subcommands) {
      entry.subcommands = cmd.subcommands.map((sc) => ({
        name: sc.name,
        summary: sc.summary,
        mutating: sc.mutating,
        supports_dry_run: sc.supportsDryRun,
      }));
    }
    commands.push(entry);
  }

  return {
    tool: "wombo-combo",
    version: getVersion(),
    global_flags: GLOBAL_FLAGS.map((f) => ({
      name: f.name,
      alias: f.alias,
      type: f.type,
      description: f.description,
      default: f.default,
    })),
    commands,
  };
}
