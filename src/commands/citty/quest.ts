/**
 * quest.ts — Citty command definition for `woco quest`.
 *
 * Parent command with 8 subcommands: create, list, show, plan, activate,
 * pause, complete, abandon.
 *
 * Each subcommand delegates to the existing handleQuestSubcommand() router
 * in `src/commands/quest.ts`. The parent command defaults to `list` when
 * invoked without a subcommand.
 */

import { defineCommand } from "citty";
import { resolve } from "node:path";
import { loadConfig, validateConfig, isProjectInitialized, WOMBO_DIR } from "../../config.js";
import { ensureTasksFile } from "../../lib/tasks.js";
import type { Priority, Difficulty } from "../../lib/tasks.js";
import type { QuestHitlMode } from "../../lib/quest.js";
import { resolveOutputFormat } from "../../lib/output.js";
import { handleQuestSubcommand } from "../quest.js";

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
// Subcommand: create
// ---------------------------------------------------------------------------

const createCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create a new quest (also: c)",
  },
  args: {
    id: {
      type: "positional",
      description: "Quest ID (kebab-case)",
      required: true,
    },
    title: {
      type: "positional",
      description: "Quest title",
      required: true,
    },
    goal: {
      type: "string",
      description: "Quest goal description (required)",
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
    hitl: {
      type: "string",
      description: "HITL mode (yolo|cautious|supervised)",
      required: false,
    },
    agent: {
      type: "string",
      description: "Agent definition override for all tasks in this quest",
      required: false,
    },
    dryRun: {
      type: "boolean",
      description: "Show what would be created without writing",
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

    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "create",
      questId: args.id,
      title: args.title,
      goal: args.goal,
      priority: args.priority as Priority | undefined,
      difficulty: args.difficulty as Difficulty | undefined,
      hitlMode: args.hitl as QuestHitlMode | undefined,
      agent: args.agent,
      dryRun: args.dryRun,
      outputFmt: fmt,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all quests (also: ls)",
  },
  args: {
    status: {
      type: "string",
      description: "Filter by status (draft|planning|active|paused|completed|abandoned)",
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

    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "list",
      status: args.status,
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
    description: "Show full quest details (also: sh)",
  },
  args: {
    questId: {
      type: "positional",
      description: "Quest ID to display",
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

    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "show",
      questId: args.questId,
      outputFmt: fmt,
      fields: args.fields
        ? args.fields.split(",").map((s: string) => s.trim())
        : undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: plan
// ---------------------------------------------------------------------------

const planCommand = defineCommand({
  meta: {
    name: "plan",
    description: "Run planner agent to decompose quest into tasks (also: pl)",
  },
  args: {
    questId: {
      type: "positional",
      description: "Quest ID to plan",
      required: true,
    },
    model: {
      type: "string",
      alias: "m",
      description: "Model to use for planner agent",
      required: false,
    },
    dryRun: {
      type: "boolean",
      description: "Show proposed tasks without writing",
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

    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "plan",
      questId: args.questId,
      dryRun: args.dryRun,
      outputFmt: fmt,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: activate
// ---------------------------------------------------------------------------

const activateCommand = defineCommand({
  meta: {
    name: "activate",
    description: "Activate a quest — creates branch, sets status to active (also: a)",
  },
  args: {
    questId: {
      type: "positional",
      description: "Quest ID to activate",
      required: true,
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

    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "activate",
      questId: args.questId,
      outputFmt: fmt,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: pause
// ---------------------------------------------------------------------------

const pauseCommand = defineCommand({
  meta: {
    name: "pause",
    description: "Pause an active quest (also: p)",
  },
  args: {
    questId: {
      type: "positional",
      description: "Quest ID to pause",
      required: true,
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

    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "pause",
      questId: args.questId,
      outputFmt: fmt,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: complete
// ---------------------------------------------------------------------------

const completeCommand = defineCommand({
  meta: {
    name: "complete",
    description: "Complete quest — merges branch into base (also: co)",
  },
  args: {
    questId: {
      type: "positional",
      description: "Quest ID to complete",
      required: true,
    },
    force: {
      type: "boolean",
      description: "Force completion even if merge fails",
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

    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "complete",
      questId: args.questId,
      force: args.force,
      outputFmt: fmt,
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: abandon
// ---------------------------------------------------------------------------

const abandonCommand = defineCommand({
  meta: {
    name: "abandon",
    description: "Abandon quest without merging (also: ab)",
  },
  args: {
    questId: {
      type: "positional",
      description: "Quest ID to abandon",
      required: true,
    },
    force: {
      type: "boolean",
      description: "Also delete the quest branch",
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

    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "abandon",
      questId: args.questId,
      force: args.force,
      outputFmt: fmt,
    });
  },
});

// ---------------------------------------------------------------------------
// Parent command: quest
// ---------------------------------------------------------------------------

export const questCommand = defineCommand({
  meta: {
    name: "quest",
    description: "Manage quests — multi-task epics with branches and planning (also: q)",
  },
  subCommands: {
    create: createCommand,
    list: listCommand,
    show: showCommand,
    plan: planCommand,
    activate: activateCommand,
    pause: pauseCommand,
    complete: completeCommand,
    abandon: abandonCommand,
  },
  // Default behavior: when invoked as bare `woco quest`, run `quest list`
  async run() {
    const { projectRoot, config } = await loadProjectContext();
    const fmt = resolveOutputFormat(undefined);

    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "list",
      outputFmt: fmt,
    });
  },
});
