/**
 * citty-registry.ts — Complete command registry derived from citty definitions.
 *
 * This module is the bridge's output: a BRIDGE_REGISTRY array of CommandDef[]
 * that replaces the hand-maintained COMMAND_REGISTRY in schema.ts.
 *
 * Each entry pairs a citty command (from src/commands/citty/) with its
 * wombo-specific extended metadata (aliases, mutating, supportsDryRun, etc.)
 * and runs it through cittyCommandToCommandDef() to produce the final
 * CommandDef.
 *
 * For commands not yet migrated to citty (e.g. genesis), the CommandDef
 * is specified directly.
 */

import type { CommandDef as CittyCommandDef } from "citty";
import { cittyCommandToCommandDef, type BridgeCommandMeta } from "./citty-bridge";
import type { CommandDef } from "./schema-types";
import { VALID_STATUSES, VALID_PRIORITIES, VALID_DIFFICULTIES } from "./task-schema";

// ---------------------------------------------------------------------------
// Citty command imports
// ---------------------------------------------------------------------------

import { initCommand } from "../commands/citty/init";
import { launchCommand } from "../commands/citty/launch";
import { resumeCommand } from "../commands/citty/resume";
import { retryCommand } from "../commands/citty/retry";
import { statusCommand } from "../commands/citty/status";
import { verifyCommand } from "../commands/citty/verify";
import { mergeCommand } from "../commands/citty/merge";
import { abortCommand } from "../commands/citty/abort";
import { cleanupCommand } from "../commands/citty/cleanup";
import { historyCommand } from "../commands/citty/history";
import { logsCommand } from "../commands/citty/logs";
import { usageCommand } from "../commands/citty/usage";
import { upgradeCommand } from "../commands/citty/upgrade";
import { completionCommand } from "../commands/citty/completion";
import { tasksCommand } from "../commands/citty/tasks";
import { questCommand } from "../commands/citty/quest";
import { wishlistCommand } from "../commands/citty/wishlist";
import { helpCommand } from "../commands/citty/help";
import { versionCommand } from "../commands/citty/version";
import { describeCommand } from "../commands/citty/describe";

// ---------------------------------------------------------------------------
// Registry entry type
// ---------------------------------------------------------------------------

/**
 * A pairing of a citty command with its extended metadata.
 * Used to build the final CommandDef via the bridge.
 *
 * We use `any` for cittyCmd because citty's CommandDef is generic over
 * its args type, and each command has a different args shape. The bridge
 * only reads the `meta` and `args` properties (both are plain objects),
 * so the generic type parameter doesn't matter for our purposes.
 */
interface RegistryEntry {
  cittyCmd: any;
  meta: BridgeCommandMeta;
  /** Subcommand entries (for parent commands like tasks, quest, wishlist) */
  subEntries?: Array<{
    /** Key in citty's subCommands map (e.g. "list", "add") */
    subKey: string;
    /** The parent command name (for compound name generation) */
    parentName: string;
    meta: BridgeCommandMeta;
  }>;
}

// ---------------------------------------------------------------------------
// Helper: extract a subcommand from a parent citty command
// ---------------------------------------------------------------------------

function getSubCommand(
  parentCmd: CittyCommandDef,
  key: string,
): CittyCommandDef | undefined {
  const subs = (parentCmd as any).subCommands;
  if (!subs || typeof subs !== "object") return undefined;
  return subs[key] as CittyCommandDef | undefined;
}

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

const ENTRIES: RegistryEntry[] = [
  // --- init ---------------------------------------------------------------
  {
    cittyCmd: initCommand,
    meta: {
      summary: "Generate .wombo-combo/config.json in the current project",
      aliases: ["i"],
      mutating: true,
      supportsDryRun: false,
      completionSummary: "Generate config",
      description:
        "Minimal Ink confirmation screen that auto-detects project settings. " +
        "Creates .wombo-combo/config.json, tasks/, and archive/ folder stores.",
      flagOverrides: {
        force: { description: "Overwrite existing config files", default: false },
      },
    },
  },

  // --- launch -------------------------------------------------------------
  {
    cittyCmd: launchCommand,
    meta: {
      summary: "Launch a wave of agents to implement features",
      aliases: ["l"],
      mutating: true,
      supportsDryRun: true,
      completionSummary: "Launch agents",
      description:
        "Select features from the tasks file, create worktrees, and spawn agents. " +
        "Supports multiple selection strategies.",
      flagOverrides: {
        topPriority: { type: "number", description: "Select top N features by priority" },
        quickestWins: { type: "number", description: "Select N features with lowest effort" },
        priority: { description: "Filter by priority level", enum: VALID_PRIORITIES },
        difficulty: { description: "Filter by difficulty level", enum: VALID_DIFFICULTIES },
        tasks: { name: "--tasks", description: "Select specific tasks by comma-separated IDs" },
        allReady: { description: "Select all features whose dependencies are met", default: false },
        maxConcurrent: { type: "number", description: "Max agents running in parallel" },
        model: { description: "Model to use (e.g., anthropic/claude-sonnet-4-20250514)" },
        interactive: { description: "Use tmux TUI mode instead of headless", default: false },
        dryRun: { description: "Show what would be launched without launching", default: false },
        noTui: { description: "Headless mode without neo-blessed TUI", default: false },
        autoPush: { description: "Push base branch to remote after all merges", default: false },
        baseBranch: { description: "Base branch (default: from config)" },
        maxRetries: { type: "number", description: "Max retries per agent" },
        browser: { description: "Enable browser-based verification after build passes", default: false },
        skipTests: { description: "Skip running tests during TDD verification", default: false },
        strictTdd: { description: "Strict TDD mode: fail verification if new files are missing tests", default: false },
        dev: { description: "Enable developer mode (hidden TUI features like fake task seeding)", default: false },
      },
      extraFlags: [
        { name: "--features", description: "Select specific features by comma-separated IDs (alias for --tasks)", type: "string" },
        { name: "--skip-tests", description: "Skip running tests during TDD verification", type: "boolean", default: false },
        { name: "--strict-tdd", description: "Strict TDD mode: fail verification if new files are missing tests", type: "boolean", default: false },
      ],
    },
  },

  // --- resume -------------------------------------------------------------
  {
    cittyCmd: resumeCommand,
    meta: {
      summary: "Resume a previously stopped wave",
      aliases: ["r"],
      mutating: true,
      supportsDryRun: false,
      completionSummary: "Resume wave",
      flagOverrides: {
        maxConcurrent: { type: "number", description: "Max agents running in parallel" },
        model: { description: "Model to use" },
        interactive: { description: "Use tmux TUI mode", default: false },
        noTui: { description: "Headless mode without neo-blessed TUI", default: false },
        autoPush: { description: "Push base branch to remote after merges", default: false },
        baseBranch: { description: "Base branch override" },
        maxRetries: { type: "number", description: "Max retries per agent" },
        dev: { description: "Enable developer mode (hidden TUI features)", default: false },
      },
    },
  },

  // --- status -------------------------------------------------------------
  {
    cittyCmd: statusCommand,
    meta: {
      summary: "Show the status of the current wave",
      aliases: ["s"],
      mutating: false,
      supportsDryRun: false,
      completionSummary: "Show wave status",
    },
  },

  // --- verify -------------------------------------------------------------
  {
    cittyCmd: verifyCommand,
    meta: {
      summary: "Run build verification on completed agents",
      aliases: ["v"],
      mutating: true,
      supportsDryRun: false,
      completionSummary: "Build verification",
      positionalOverrides: {
        featureId: { description: "Specific feature to verify (optional)" },
      },
      flagOverrides: {
        model: { description: "Model to use for verification" },
        maxRetries: { type: "number", description: "Max retries" },
        browser: { description: "Enable browser-based verification after build passes", default: false },
        skipTests: { description: "Skip running tests during TDD verification", default: false },
        strictTdd: { description: "Strict TDD mode: fail verification if new files are missing tests", default: false },
      },
    },
  },

  // --- merge --------------------------------------------------------------
  {
    cittyCmd: mergeCommand,
    meta: {
      summary: "Merge verified branches into the base branch",
      aliases: ["m"],
      mutating: true,
      supportsDryRun: true,
      completionSummary: "Merge branches",
      positionalOverrides: {
        featureId: { description: "Specific feature to merge (optional)" },
      },
      flagOverrides: {
        autoPush: { description: "Push base branch to remote after merge", default: false },
        dryRun: { description: "Show what would be merged without merging", default: false },
      },
    },
  },

  // --- retry --------------------------------------------------------------
  {
    cittyCmd: retryCommand,
    meta: {
      summary: "Retry a failed agent",
      aliases: ["re"],
      mutating: true,
      supportsDryRun: true,
      positionalOverrides: {
        featureId: { description: "Feature ID of the failed agent", required: true },
      },
      flagOverrides: {
        model: { description: "Model to use" },
        interactive: { description: "Use tmux TUI mode", default: false },
        dryRun: { description: "Show what would be retried without retrying", default: false },
      },
    },
  },

  // --- cleanup ------------------------------------------------------------
  {
    cittyCmd: cleanupCommand,
    meta: {
      summary: "Remove all wave worktrees and tmux sessions",
      aliases: ["c"],
      mutating: true,
      supportsDryRun: true,
      completionSummary: "Remove worktrees",
      description: "Kills tmux sessions, removes worktrees, removes state and log files.",
      flagOverrides: {
        dryRun: { description: "Show what would be cleaned up without removing", default: false },
      },
    },
  },

  // --- history ------------------------------------------------------------
  {
    cittyCmd: historyCommand,
    meta: {
      summary: "List/view past wave results from .wombo-combo/history/",
      aliases: ["h"],
      mutating: false,
      supportsDryRun: false,
      completionSummary: "View past waves",
      description:
        "Wave history is auto-exported when a wave completes. Records are stored " +
        "separately from .wombo-combo/state.json and survive cleanup. Use without arguments " +
        "to list all waves, or pass a wave ID to see detailed results.",
      positionalOverrides: {
        waveId: { name: "wave-id", description: "Specific wave ID to show details for (optional)" },
      },
    },
  },

  // --- usage --------------------------------------------------------------
  {
    cittyCmd: usageCommand,
    meta: {
      summary: "Show token usage statistics from .wombo-combo/usage.jsonl",
      aliases: ["us"],
      mutating: false,
      supportsDryRun: false,
      completionSummary: "Token usage stats",
      description:
        "Displays aggregated token usage data collected during agent runs. " +
        "Can show totals or group by task, quest, model, provider, or harness. " +
        "Supports date range filtering and table or JSON output.",
      flagOverrides: {
        by: { description: "Group usage by field (default: total — no grouping)", enum: ["task", "quest", "model", "provider", "harness"] },
        since: { description: "Filter records from this date (ISO 8601, inclusive)" },
        until: { description: "Filter records until this date (ISO 8601, inclusive)" },
        format: { description: "Output format for usage data: table (default) or json", default: "table", enum: ["table", "json"] },
      },
    },
  },

  // --- abort --------------------------------------------------------------
  {
    cittyCmd: abortCommand,
    meta: {
      summary: "Kill a single running agent without affecting the rest of the wave",
      aliases: ["a"],
      mutating: true,
      supportsDryRun: false,
      completionSummary: "Kill running agent",
      description:
        "Kills the tmux session and agent process for a specific feature, then " +
        "marks the agent as failed. Use --requeue to return the feature to the " +
        "queue instead of marking it failed.",
      positionalOverrides: {
        featureId: { description: "Feature ID of the agent to abort" },
      },
      flagOverrides: {
        requeue: { description: "Return the feature to queued instead of marking it failed", default: false },
      },
    },
  },

  // --- upgrade ------------------------------------------------------------
  {
    cittyCmd: upgradeCommand,
    meta: {
      summary: "Check for updates and upgrade wombo",
      aliases: ["u"],
      mutating: true,
      supportsDryRun: false,
      completionSummary: "Check for updates",
      flagOverrides: {
        check: { description: "Only check for updates, don't install", default: false },
        tag: { alias: "--release", description: "Install a specific version (e.g., v0.1.0)" },
        force: { description: "Force reinstall even if up to date", default: false },
      },
    },
  },

  // --- logs ---------------------------------------------------------------
  {
    cittyCmd: logsCommand,
    meta: {
      summary: "Pretty-print agent logs from .wombo-combo/logs/<feature-id>.log",
      aliases: ["lo"],
      mutating: false,
      supportsDryRun: false,
      completionSummary: "Agent logs",
      description:
        "Reads log files written by agents during headless runs and displays " +
        "them with colorized output. Supports tailing and following.",
      flagOverrides: {
        tail: { type: "number", description: "Show only the last N lines" },
        follow: { description: "Stream new output as it arrives (like tail -f)", default: false },
      },
    },
  },

  // --- tasks (parent with subcommands) ------------------------------------
  {
    cittyCmd: tasksCommand,
    meta: {
      summary: "Manage tasks file",
      aliases: ["t", "features"],
      mutating: false,
      supportsDryRun: false,
      completionSummary: "Manage tasks",
    },
    subEntries: [
      {
        subKey: "list",
        parentName: "tasks",
        meta: {
          summary: "List tasks with optional filtering",
          aliases: ["ls"],
          mutating: false,
          supportsDryRun: false,
          completionSummary: "List tasks",
          flagOverrides: {
            status: { description: "Filter by status", enum: VALID_STATUSES },
            priority: { description: "Filter by priority", enum: VALID_PRIORITIES },
            difficulty: { description: "Filter by difficulty", enum: VALID_DIFFICULTIES },
            ready: { description: "Show only ready tasks (backlog + deps met)", default: false },
            includeArchive: { description: "Include archived tasks", default: false, name: "--include-archive" },
            fields: { description: "Comma-separated list of fields to include in output" },
          },
        },
      },
      {
        subKey: "add",
        parentName: "tasks",
        meta: {
          summary: "Add a new task",
          aliases: ["a"],
          mutating: true,
          supportsDryRun: true,
          flagOverrides: {
            description: { alias: "--desc", description: "Task description" },
            priority: { description: "Priority level", default: "medium", enum: VALID_PRIORITIES },
            difficulty: { description: "Difficulty level", default: "medium", enum: VALID_DIFFICULTIES },
            effort: { description: "Effort estimate (ISO 8601 duration, e.g. PT2H)", default: "PT1H" },
            dependsOn: { name: "--depends-on", description: "Comma-separated dependency IDs" },
            dryRun: { description: "Show what would be added without writing", default: false },
          },
        },
      },
      {
        subKey: "set-status",
        parentName: "tasks",
        meta: {
          summary: "Change a task's status",
          aliases: ["ss"],
          mutating: true,
          supportsDryRun: true,
          positionalOverrides: {
            taskId: { name: "task-id", description: "Task ID to update" },
            status: { description: "New status value" },
          },
          flagOverrides: {
            dryRun: { description: "Show what would change without writing", default: false },
          },
        },
      },
      {
        subKey: "set-priority",
        parentName: "tasks",
        meta: {
          summary: "Change a task's priority",
          aliases: ["sp"],
          mutating: true,
          supportsDryRun: true,
          positionalOverrides: {
            taskId: { name: "task-id", description: "Task ID to update" },
            priority: { description: "New priority value" },
          },
          flagOverrides: {
            dryRun: { description: "Show what would change without writing", default: false },
          },
        },
      },
      {
        subKey: "set-difficulty",
        parentName: "tasks",
        meta: {
          summary: "Change a task's difficulty",
          aliases: ["sd"],
          mutating: true,
          supportsDryRun: true,
          positionalOverrides: {
            taskId: { name: "task-id", description: "Task ID to update" },
            difficulty: { description: "New difficulty value" },
          },
          flagOverrides: {
            dryRun: { description: "Show what would change without writing", default: false },
          },
        },
      },
      {
        subKey: "check",
        parentName: "tasks",
        meta: {
          summary: "Validate tasks file (schema, deps, duplicates, cycles)",
          aliases: ["ch", "validate"],
          mutating: false,
          supportsDryRun: false,
          completionSummary: "Validate tasks",
          // check's --output is a command-specific flag, not global
          extraFlags: [
            { name: "--output", description: "Output format: text (default), json, or toon", type: "string", default: "text" },
          ],
        },
      },
      {
        subKey: "archive",
        parentName: "tasks",
        meta: {
          summary: "Move done/cancelled tasks to archive section",
          aliases: ["ar"],
          mutating: true,
          supportsDryRun: true,
          completionSummary: "Archive done tasks",
          positionalOverrides: {
            taskId: { name: "task-id", description: "Specific task to archive (optional)" },
          },
          flagOverrides: {
            dryRun: { description: "Show what would be archived without moving", default: false },
          },
        },
      },
      {
        subKey: "show",
        parentName: "tasks",
        meta: {
          summary: "Show detailed information about a specific task",
          aliases: ["sh"],
          mutating: false,
          supportsDryRun: false,
          completionSummary: "Show task details",
          positionalOverrides: {
            taskId: { name: "task-id", description: "Task ID to display" },
          },
          flagOverrides: {
            fields: { description: "Comma-separated list of fields to include in output" },
          },
        },
      },
      {
        subKey: "graph",
        parentName: "tasks",
        meta: {
          summary: "Visualize the task dependency graph as a terminal diagram",
          aliases: ["g"],
          mutating: false,
          supportsDryRun: false,
          completionSummary: "Dependency graph",
          description:
            "Builds a Mermaid flowchart from the tasks dependency graph and renders " +
            "it as a Unicode box diagram. Shows dependency edges, status badges, orphan " +
            "detection, dangling dependency warnings, and cycle detection.",
          flagOverrides: {
            status: { description: "Filter graph to tasks with this status", enum: VALID_STATUSES },
            ascii: { description: "Use ASCII-only rendering (no Unicode box chars)", default: false },
            mermaid: { description: "Emit raw Mermaid source instead of rendered graph", default: false },
            subtasks: { description: "Include subtask-level nodes in the graph", default: false },
          },
        },
      },
    ],
  },

  // --- help ---------------------------------------------------------------
  {
    cittyCmd: helpCommand,
    meta: {
      mutating: false,
      supportsDryRun: false,
      summary: "Show help text",
    },
  },

  // --- version -----------------------------------------------------------
  {
    cittyCmd: versionCommand,
    meta: {
      name: "version",
      summary: "Print version and exit (also: -v, -V)",
      mutating: false,
      supportsDryRun: false,
    },
  },

  // --- describe -----------------------------------------------------------
  {
    cittyCmd: describeCommand,
    meta: {
      summary: "Emit JSON schema of a command's arguments and flags",
      aliases: ["d"],
      mutating: false,
      supportsDryRun: false,
      completionSummary: "Emit JSON schema",
      description:
        "Machine-readable introspection for AI agents. Outputs the accepted " +
        "positionals, flags, types, defaults, and constraints for a command.",
      positionalOverrides: {
        command: { description: "Command to describe (e.g. 'launch', 'features add')" },
      },
    },
  },

  // --- quest (parent with subcommands) -----------------------------------
  {
    cittyCmd: questCommand,
    meta: {
      summary: "Manage quests (scoped missions with their own task sets)",
      aliases: ["q"],
      mutating: false,
      supportsDryRun: false,
      completionSummary: "Manage quests",
    },
    subEntries: [
      {
        subKey: "create",
        parentName: "quest",
        meta: {
          summary: "Create a new quest",
          aliases: ["c"],
          mutating: true,
          supportsDryRun: true,
          flagOverrides: {
            goal: { description: "Quest goal (required)", required: true },
            priority: { description: "Priority level", default: "medium", enum: VALID_PRIORITIES },
            difficulty: { description: "Difficulty level", default: "medium", enum: VALID_DIFFICULTIES },
            hitl: { description: "HITL mode (yolo/cautious/supervised)", default: "yolo", enum: ["yolo", "cautious", "supervised"] },
            agent: { description: "Agent definition override for all tasks" },
            dryRun: { description: "Show what would happen without creating", default: false },
          },
        },
      },
      {
        subKey: "list",
        parentName: "quest",
        meta: {
          summary: "List all quests",
          aliases: ["ls"],
          mutating: false,
          supportsDryRun: false,
          flagOverrides: {
            status: { description: "Filter by status" },
          },
        },
      },
      {
        subKey: "show",
        parentName: "quest",
        meta: {
          summary: "Show full quest details",
          aliases: ["sh"],
          mutating: false,
          supportsDryRun: false,
          positionalOverrides: {
            questId: { name: "quest-id", description: "Quest ID to display" },
          },
          flagOverrides: {
            fields: { description: "Comma-separated list of fields to include" },
          },
        },
      },
      {
        subKey: "plan",
        parentName: "quest",
        meta: {
          summary: "Run planner agent to decompose quest into tasks",
          aliases: ["pl"],
          mutating: true,
          supportsDryRun: true,
          positionalOverrides: {
            questId: { name: "quest-id", description: "Quest ID to plan" },
          },
          flagOverrides: {
            model: { description: "Model to use for planner agent" },
            dryRun: { description: "Show proposed tasks without writing", default: false },
          },
        },
      },
      {
        subKey: "activate",
        parentName: "quest",
        meta: {
          summary: "Activate a quest (creates branch, sets status to active)",
          aliases: ["a"],
          mutating: true,
          supportsDryRun: false,
          positionalOverrides: {
            questId: { name: "quest-id", description: "Quest ID to activate" },
          },
        },
      },
      {
        subKey: "pause",
        parentName: "quest",
        meta: {
          summary: "Pause an active quest",
          aliases: ["p"],
          mutating: true,
          supportsDryRun: false,
          positionalOverrides: {
            questId: { name: "quest-id", description: "Quest ID to pause" },
          },
        },
      },
      {
        subKey: "complete",
        parentName: "quest",
        meta: {
          summary: "Complete quest (merges branch into base)",
          aliases: ["co"],
          mutating: true,
          supportsDryRun: false,
          positionalOverrides: {
            questId: { name: "quest-id", description: "Quest ID to complete" },
          },
          flagOverrides: {
            force: { description: "Skip merge, just mark as complete", default: false },
          },
        },
      },
      {
        subKey: "abandon",
        parentName: "quest",
        meta: {
          summary: "Abandon quest without merging",
          aliases: ["ab"],
          mutating: true,
          supportsDryRun: false,
          positionalOverrides: {
            questId: { name: "quest-id", description: "Quest ID to abandon" },
          },
          flagOverrides: {
            force: { description: "Delete branch when abandoning", default: false },
          },
        },
      },
      {
        subKey: "archive",
        parentName: "quest",
        meta: {
          summary: "Archive completed/abandoned quests",
          aliases: ["ar"],
          mutating: true,
          supportsDryRun: true,
          positionalOverrides: {
            questId: { name: "quest-id", description: "Quest ID to archive (omit to archive all completed/abandoned)" },
          },
        },
      },
    ],
  },

  // --- wishlist -----------------------------------------------------------
  {
    cittyCmd: wishlistCommand,
    meta: {
      summary: "Quick-capture ideas for later",
      aliases: ["w", "wl"],
      mutating: false,
      supportsDryRun: false,
      completionSummary: "Capture ideas",
    },
    subEntries: [
      {
        subKey: "add",
        parentName: "wishlist",
        meta: {
          summary: "Add a wishlist item",
          aliases: ["a"],
          mutating: true,
          supportsDryRun: false,
          flagOverrides: {
            tag: { description: "Categorization tag (can be repeated)" },
          },
        },
      },
      {
        subKey: "list",
        parentName: "wishlist",
        meta: {
          summary: "List all wishlist items",
          aliases: ["ls"],
          mutating: false,
          supportsDryRun: false,
        },
      },
      {
        subKey: "move",
        parentName: "wishlist",
        meta: {
          summary: "Move a wishlist item to a new position",
          aliases: ["mv"],
          mutating: true,
          supportsDryRun: false,
        },
      },
      {
        subKey: "delete",
        parentName: "wishlist",
        meta: {
          summary: "Delete a wishlist item",
          aliases: ["rm", "del", "d"],
          mutating: true,
          supportsDryRun: false,
        },
      },
    ],
  },

  // --- completion ---------------------------------------------------------
  {
    cittyCmd: completionCommand,
    meta: {
      summary: "Shell completions (install, uninstall, or emit script)",
      aliases: ["comp"],
      mutating: true,
      supportsDryRun: false,
      completionSummary: "Shell completions",
      description:
        "Manage shell completion scripts. Use 'install' to auto-configure your " +
        "shell, 'uninstall' to remove, or pass a shell name to emit the raw script.",
      positionalOverrides: {
        shell: { name: "action", description: "Action: install, uninstall, bash, zsh, or fish" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Build the bridge registry
// ---------------------------------------------------------------------------

// --- genesis (not yet migrated to citty) ------------------------------------
// This is a direct CommandDef since there's no citty definition yet.
const GENESIS_DEF: CommandDef = {
  name: "genesis",
  aliases: ["g"],
  summary: "Decompose a project vision into quests",
  completionSummary: "Vision to quests",
  description:
    "Top of the Quest hierarchy: Genesis -> Quests -> Tasks. Takes a project " +
    "vision and produces a set of scoped quests via an AI planner agent.",
  positionals: [
    { name: "vision", description: "Project vision text", required: false },
  ],
  flags: [
    { name: "--tech-stack", description: "Tech stack description (e.g. \"React, Node, Postgres\")", type: "string" },
    { name: "--constraint", description: "Constraint (can be repeated)", type: "string" },
    { name: "--model", alias: "-m", description: "Model for the planner agent", type: "string" },
    { name: "--no-tui", description: "Skip TUI review, auto-approve all quests", type: "boolean", default: false },
    { name: "--dry-run", description: "Show what would happen without creating quests", type: "boolean", default: false },
  ],
  mutating: true,
  supportsDryRun: true,
};

/** Insert genesis after "quest" to match COMMAND_REGISTRY ordering */
const GENESIS_INSERT_AFTER = "quest";

function buildRegistry(): CommandDef[] {
  const registry: CommandDef[] = [];

  for (const entry of ENTRIES) {
    const cmd = cittyCommandToCommandDef(entry.cittyCmd, entry.meta);

    // Process subcommands if present
    if (entry.subEntries?.length) {
      cmd.subcommands = [];
      for (const sub of entry.subEntries) {
        const subCmd = getSubCommand(entry.cittyCmd, sub.subKey);
        if (!subCmd) {
          throw new Error(
            `Subcommand "${sub.subKey}" not found on citty command "${cmd.name}"`
          );
        }
        const subDef = cittyCommandToCommandDef(subCmd, sub.meta);
        // Set compound name: "tasks list", "quest create", etc.
        subDef.name = `${sub.parentName} ${subDef.name}`;
        cmd.subcommands.push(subDef);
      }
    }

    registry.push(cmd);

    // Insert genesis after quest to match COMMAND_REGISTRY order
    if (cmd.name === GENESIS_INSERT_AFTER) {
      registry.push(GENESIS_DEF);
    }
  }

  return registry;
}

/**
 * The bridge-generated command registry.
 * Drop-in replacement for COMMAND_REGISTRY in schema.ts.
 */
export const BRIDGE_REGISTRY: CommandDef[] = buildRegistry();

// ---------------------------------------------------------------------------
// Lookup helpers (mirrors schema.ts API)
// ---------------------------------------------------------------------------

/**
 * Match a registry entry by canonical name OR any alias.
 */
function matchByNameOrAlias(
  entries: CommandDef[],
  token: string
): CommandDef | undefined {
  return entries.find(
    (c) => c.name === token || c.aliases?.includes(token)
  );
}

/**
 * Find a command definition by name or alias.
 * Supports compound names like "tasks list" and aliases like "t ls".
 */
export function findBridgeCommandDef(name: string): CommandDef | undefined {
  // Try direct match (name or alias) first
  const direct = matchByNameOrAlias(BRIDGE_REGISTRY, name);
  if (direct) return direct;

  // Try compound: "tasks list" or "t ls" -> look in parent's subcommands
  const parts = name.split(/\s+/);
  if (parts.length === 2) {
    const parent = matchByNameOrAlias(BRIDGE_REGISTRY, parts[0]);
    if (parent?.subcommands) {
      // Match subcommand by its compound name, short name, or alias
      return parent.subcommands.find(
        (sc) =>
          sc.name === name ||
          sc.name === parts[1] ||
          sc.aliases?.includes(parts[1])
      );
    }
  }

  return undefined;
}
