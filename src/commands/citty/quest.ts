/**
 * quest.ts — Citty command definition for `woco quest`.
 *
 * Defines the quest parent command with all subcommands using citty's
 * native subCommands support. Each subcommand delegates to the existing
 * `handleQuestSubcommand()` implementation in `src/commands/quest.ts`.
 *
 * Subcommands:
 *   create (c)    — Create a new quest
 *   list (ls)     — List all quests
 *   show (sh)     — Show full quest details
 *   plan (pl)     — Run planner agent to decompose quest into tasks
 *   activate (a)  — Activate a quest
 *   pause (p)     — Pause an active quest
 *   complete (co) — Complete quest (merges branch)
 *   abandon (ab)  — Abandon quest without merging
 */

import { defineCommand } from "citty";
import { resolve } from "node:path";
import { loadConfig, validateConfig, isProjectInitialized, WOMBO_DIR } from "../../config";
import { resolveOutputFormat } from "../../lib/output";
import type { Priority, Difficulty } from "../../lib/tasks";
import type { QuestHitlMode } from "../../lib/quest";
import { handleQuestSubcommand } from "../quest";

// ---------------------------------------------------------------------------
// Shared: load config, validate
// ---------------------------------------------------------------------------

function loadProjectConfigSync(projectRoot: string) {
  if (!isProjectInitialized(projectRoot)) {
    console.error(
      `\nThis project hasn't been initialized yet.\n` +
        `Run \`woco init\` to set up ${WOMBO_DIR}/ with config, tasks, and archive stores.\n`
    );
    process.exit(1);
  }
  const config = loadConfig(projectRoot);
  validateConfig(config);
  return config;
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
      description: "Quest goal (required)",
      required: true,
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
      description: "Agent definition override for all tasks",
      required: false,
    },
    dryRun: {
      type: "boolean",
      description: "Show what would happen without creating",
      required: false,
    },
    force: {
      type: "boolean",
      description: "Force overwrite",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text (default), json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(process.cwd());
    const config = loadProjectConfigSync(projectRoot);
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
      force: args.force,
      outputFmt: resolveOutputFormat(args.output),
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
      description: "Filter by status",
      required: false,
    },
    fields: {
      type: "string",
      description: "Comma-separated list of fields to include",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text (default), json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(process.cwd());
    const config = loadProjectConfigSync(projectRoot);
    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "list",
      status: args.status,
      fields: args.fields ? args.fields.split(",").map((s: string) => s.trim()) : undefined,
      outputFmt: resolveOutputFormat(args.output),
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
      description: "Comma-separated list of fields to include",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text (default), json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(process.cwd());
    const config = loadProjectConfigSync(projectRoot);
    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "show",
      questId: args.questId,
      fields: args.fields ? args.fields.split(",").map((s: string) => s.trim()) : undefined,
      outputFmt: resolveOutputFormat(args.output),
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
      description: "Output format: text (default), json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(process.cwd());
    const config = loadProjectConfigSync(projectRoot);
    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "plan",
      questId: args.questId,
      dryRun: args.dryRun,
      outputFmt: resolveOutputFormat(args.output),
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: activate
// ---------------------------------------------------------------------------

const activateCommand = defineCommand({
  meta: {
    name: "activate",
    description: "Activate a quest (creates branch, sets status to active) (also: a)",
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
      description: "Output format: text (default), json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(process.cwd());
    const config = loadProjectConfigSync(projectRoot);
    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "activate",
      questId: args.questId,
      outputFmt: resolveOutputFormat(args.output),
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
      description: "Output format: text (default), json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(process.cwd());
    const config = loadProjectConfigSync(projectRoot);
    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "pause",
      questId: args.questId,
      outputFmt: resolveOutputFormat(args.output),
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: complete
// ---------------------------------------------------------------------------

const completeCommand = defineCommand({
  meta: {
    name: "complete",
    description: "Complete quest (merges branch into base) (also: co)",
  },
  args: {
    questId: {
      type: "positional",
      description: "Quest ID to complete",
      required: true,
    },
    force: {
      type: "boolean",
      description: "Skip merge, just mark as complete",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text (default), json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(process.cwd());
    const config = loadProjectConfigSync(projectRoot);
    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "complete",
      questId: args.questId,
      force: args.force,
      outputFmt: resolveOutputFormat(args.output),
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
      description: "Delete branch when abandoning",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text (default), json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(process.cwd());
    const config = loadProjectConfigSync(projectRoot);
    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "abandon",
      questId: args.questId,
      force: args.force,
      outputFmt: resolveOutputFormat(args.output),
    });
  },
});

// ---------------------------------------------------------------------------
// Subcommand: archive
// ---------------------------------------------------------------------------

const archiveCommand = defineCommand({
  meta: {
    name: "archive",
    description: "Archive completed/abandoned quests",
  },
  args: {
    questId: {
      type: "positional",
      description: "Quest ID to archive (omit to archive all completed/abandoned)",
      required: false,
    },
    dryRun: {
      type: "boolean",
      description: "Show what would be archived without doing it",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text (default), json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(process.cwd());
    const config = loadProjectConfigSync(projectRoot);
    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "archive",
      questId: args.questId,
      dryRun: args.dryRun,
      outputFmt: resolveOutputFormat(args.output),
    });
  },
});

// ---------------------------------------------------------------------------
// Parent command: quest
// ---------------------------------------------------------------------------

/**
 * Quest parent command with all subcommands.
 * Citty handles subcommand routing natively via `subCommands`.
 * Aliases are registered as additional keys in the subCommands map.
 */
export const questCommand = defineCommand({
  meta: {
    name: "quest",
    description: "Manage quests (scoped missions) (also: q)",
  },
  // Default behavior when no subcommand is given: list quests
  async run() {
    const projectRoot = resolve(process.cwd());
    const config = loadProjectConfigSync(projectRoot);
    await handleQuestSubcommand({
      projectRoot,
      config,
      subcommand: "list",
    });
  },
  subCommands: {
    // Canonical names
    create: createCommand,
    list: listCommand,
    show: showCommand,
    plan: planCommand,
    activate: activateCommand,
    pause: pauseCommand,
    complete: completeCommand,
    abandon: abandonCommand,
    archive: archiveCommand,
    // Aliases
    c: createCommand,
    ls: listCommand,
    sh: showCommand,
    pl: planCommand,
    a: activateCommand,
    p: pauseCommand,
    co: completeCommand,
    ab: abandonCommand,
    ar: archiveCommand,
  },
});
