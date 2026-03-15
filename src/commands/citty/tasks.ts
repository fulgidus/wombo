/**
 * tasks.ts — Citty command definition for `woco tasks`.
 *
 * Parent command with 9 subcommands: list, add, set-status, set-priority,
 * set-difficulty, check, archive, show, graph.
 *
 * Each subcommand delegates to the existing cmd* implementation in
 * `src/commands/tasks/`. The parent command defaults to `list` when
 * invoked without a subcommand.
 */

import { defineCommand } from "citty";
import { resolve } from "node:path";
import { loadConfig, validateConfig, isProjectInitialized, WOMBO_DIR } from "../../config.js";
import { ensureTasksFile } from "../../lib/tasks.js";
import type { FeatureStatus, Priority, Difficulty } from "../../lib/tasks.js";
import { resolveOutputFormat, outputError, type OutputFormat } from "../../lib/output.js";
import { cmdTasksList } from "../tasks/list.js";
import { cmdTasksAdd } from "../tasks/add.js";
import { cmdTasksSetStatus } from "../tasks/set-status.js";
import { cmdTasksSetPriority } from "../tasks/set-priority.js";
import { cmdTasksSetDifficulty } from "../tasks/set-difficulty.js";
import { cmdTasksCheck } from "../tasks/check.js";
import { cmdTasksArchive } from "../tasks/archive.js";
import { cmdTasksShow } from "../tasks/show.js";
import { cmdTasksGraph } from "../tasks/graph.js";

// ---------------------------------------------------------------------------
// Shared: load config + ensure project is initialized
// ---------------------------------------------------------------------------

async function loadProjectContext() {
  const projectRoot = resolve(process.cwd());

  if (!isProjectInitialized(projectRoot)) {
    console.error(
      `\nThis project hasn't been initialized yet.\n` +
        `Run \`woco init\` to set up ${WOMBO_DIR}/ with config, tasks, and archive stores.\n`
    );
    process.exit(1);
  }

  const config = loadConfig(projectRoot);
  validateConfig(config);
  await ensureTasksFile(projectRoot, config);

  return { projectRoot, config };
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List tasks with optional filtering (also: ls)",
  },
  args: {
    status: {
      type: "string",
      description: "Filter by status",
      required: false,
    },
    priority: {
      type: "string",
      description: "Filter by priority",
      required: false,
    },
    difficulty: {
      type: "string",
      description: "Filter by difficulty",
      required: false,
    },
    ready: {
      type: "boolean",
      description: "Show only ready tasks (backlog + deps met)",
      required: false,
    },
    includeArchive: {
      type: "boolean",
      description: "Include archived tasks",
      required: false,
    },
    fields: {
      type: "string",
      description: "Comma-separated list of fields to include in output",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot, config } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    await cmdTasksList({
      projectRoot,
      config,
      status: args.status as FeatureStatus | undefined,
      priority: args.priority as Priority | undefined,
      difficulty: args.difficulty as Difficulty | undefined,
      ready: args.ready,
      includeArchive: args.includeArchive,
      outputFmt: fmt,
      fields: args.fields
        ? args.fields.split(",").map((s: string) => s.trim())
        : undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: add
// ---------------------------------------------------------------------------

const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Add a new task (also: a)",
  },
  args: {
    id: {
      type: "positional",
      description: "Task ID (kebab-case)",
      required: true,
    },
    title: {
      type: "positional",
      description: "Task title",
      required: true,
    },
    description: {
      type: "string",
      alias: "desc",
      description: "Task description",
      required: false,
    },
    priority: {
      type: "string",
      description: "Priority level (critical|high|medium|low|wishlist)",
      required: false,
    },
    difficulty: {
      type: "string",
      description: "Difficulty level (trivial|easy|medium|hard|very_hard)",
      required: false,
    },
    effort: {
      type: "string",
      description: "Effort estimate (ISO 8601 duration, e.g. PT2H)",
      required: false,
    },
    dependsOn: {
      type: "string",
      description: "Comma-separated dependency IDs",
      required: false,
    },
    dryRun: {
      type: "boolean",
      description: "Show what would be added without writing",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot, config } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    if (!args.id || !args.title) {
      outputError(fmt, "Usage: woco tasks add <id> <title> [--desc <desc>] [--priority <p>] [--difficulty <d>] [--effort <e>] [--depends-on <ids>]");
      return;
    }

    await cmdTasksAdd({
      projectRoot,
      config,
      id: args.id,
      title: args.title,
      description: args.description,
      priority: args.priority as Priority | undefined,
      difficulty: args.difficulty as Difficulty | undefined,
      effort: args.effort,
      dependsOn: args.dependsOn
        ? args.dependsOn.split(",").map((s: string) => s.trim())
        : undefined,
      outputFmt: fmt,
      dryRun: args.dryRun,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: set-status
// ---------------------------------------------------------------------------

const setStatusCommand = defineCommand({
  meta: {
    name: "set-status",
    description: "Change a task's status (also: ss)",
  },
  args: {
    taskId: {
      type: "positional",
      description: "Task ID to update",
      required: true,
    },
    status: {
      type: "positional",
      description: "New status value",
      required: true,
    },
    dryRun: {
      type: "boolean",
      description: "Show what would change without writing",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot, config } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    if (!args.taskId || !args.status) {
      outputError(fmt, "Usage: woco tasks set-status <task-id> <status>");
      return;
    }

    await cmdTasksSetStatus({
      projectRoot,
      config,
      featureId: args.taskId,
      newStatus: args.status,
      outputFmt: fmt,
      dryRun: args.dryRun,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: set-priority
// ---------------------------------------------------------------------------

const setPriorityCommand = defineCommand({
  meta: {
    name: "set-priority",
    description: "Change a task's priority (also: sp)",
  },
  args: {
    taskId: {
      type: "positional",
      description: "Task ID to update",
      required: true,
    },
    priority: {
      type: "positional",
      description: "New priority value",
      required: true,
    },
    dryRun: {
      type: "boolean",
      description: "Show what would change without writing",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot, config } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    if (!args.taskId || !args.priority) {
      outputError(fmt, "Usage: woco tasks set-priority <task-id> <priority>");
      return;
    }

    await cmdTasksSetPriority({
      projectRoot,
      config,
      featureId: args.taskId,
      newPriority: args.priority,
      outputFmt: fmt,
      dryRun: args.dryRun,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: set-difficulty
// ---------------------------------------------------------------------------

const setDifficultyCommand = defineCommand({
  meta: {
    name: "set-difficulty",
    description: "Change a task's difficulty (also: sd)",
  },
  args: {
    taskId: {
      type: "positional",
      description: "Task ID to update",
      required: true,
    },
    difficulty: {
      type: "positional",
      description: "New difficulty value",
      required: true,
    },
    dryRun: {
      type: "boolean",
      description: "Show what would change without writing",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot, config } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    if (!args.taskId || !args.difficulty) {
      outputError(fmt, "Usage: woco tasks set-difficulty <task-id> <difficulty>");
      return;
    }

    await cmdTasksSetDifficulty({
      projectRoot,
      config,
      featureId: args.taskId,
      newDifficulty: args.difficulty,
      outputFmt: fmt,
      dryRun: args.dryRun,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: check
// ---------------------------------------------------------------------------

const checkCommand = defineCommand({
  meta: {
    name: "check",
    description: "Validate tasks file (schema, deps, duplicates, cycles) (also: ch, validate)",
  },
  args: {
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot, config } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    await cmdTasksCheck({
      projectRoot,
      config,
      outputFmt: fmt,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: archive
// ---------------------------------------------------------------------------

const archiveCommand = defineCommand({
  meta: {
    name: "archive",
    description: "Move done/cancelled tasks to archive section (also: ar)",
  },
  args: {
    taskId: {
      type: "positional",
      description: "Specific task to archive (optional)",
      required: false,
    },
    dryRun: {
      type: "boolean",
      description: "Show what would be archived without moving",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot, config } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    await cmdTasksArchive({
      projectRoot,
      config,
      featureId: args.taskId,
      dryRun: args.dryRun,
      outputFmt: fmt,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: show
// ---------------------------------------------------------------------------

const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show detailed information about a specific task (also: sh)",
  },
  args: {
    taskId: {
      type: "positional",
      description: "Task ID to display",
      required: true,
    },
    fields: {
      type: "string",
      description: "Comma-separated list of fields to include in output",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot, config } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    if (!args.taskId) {
      outputError(fmt, "Usage: woco tasks show <task-id>");
      return;
    }

    await cmdTasksShow({
      projectRoot,
      config,
      featureId: args.taskId,
      outputFmt: fmt,
      fields: args.fields
        ? args.fields.split(",").map((s: string) => s.trim())
        : undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: graph
// ---------------------------------------------------------------------------

const graphCommand = defineCommand({
  meta: {
    name: "graph",
    description: "Visualize the task dependency graph as a terminal diagram (also: g)",
  },
  args: {
    status: {
      type: "string",
      description: "Filter graph to tasks with this status",
      required: false,
    },
    ascii: {
      type: "boolean",
      description: "Use ASCII-only rendering (no Unicode box chars)",
      required: false,
    },
    mermaid: {
      type: "boolean",
      description: "Emit raw Mermaid source instead of rendered graph",
      required: false,
    },
    subtasks: {
      type: "boolean",
      description: "Include subtask-level nodes in the graph",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot, config } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    await cmdTasksGraph({
      projectRoot,
      config,
      status: args.status as FeatureStatus | undefined,
      ascii: args.ascii,
      mermaid: args.mermaid,
      subtasks: args.subtasks,
      outputFmt: fmt,
    });
  },
});

// ---------------------------------------------------------------------------
// Parent command: tasks
// ---------------------------------------------------------------------------

export const tasksCommand = defineCommand({
  meta: {
    name: "tasks",
    description: "Manage tasks file (also: t, features)",
  },
  subCommands: {
    list: listCommand,
    add: addCommand,
    "set-status": setStatusCommand,
    "set-priority": setPriorityCommand,
    "set-difficulty": setDifficultyCommand,
    check: checkCommand,
    archive: archiveCommand,
    show: showCommand,
    graph: graphCommand,
  },
  // Default behavior: when invoked as bare `woco tasks`, run `tasks list`
  async run({ rawArgs }) {
    // If no subcommand was specified, default to 'list'
    // Citty will have already routed to a subcommand if one was provided,
    // so this only fires when the user types `woco tasks` with no sub.
    const { projectRoot, config } = await loadProjectContext();
    const fmt = resolveOutputFormat(undefined);

    await cmdTasksList({
      projectRoot,
      config,
      outputFmt: fmt,
    });
  },
});
