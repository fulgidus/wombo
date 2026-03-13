/**
 * quest.ts — Quest types, schema constants, and layered constraint resolution.
 *
 * A Quest is a scoped mission containing multiple Tasks. Quests sit between
 * Genesis (project-level decomposition) and Tasks (atomic work units):
 *
 *   Genesis → Quests → Tasks
 *
 * Quest branches fork from baseBranch. Task branches fork from their quest
 * branch. Completed tasks merge into the quest branch. A completed quest
 * merges its branch into baseBranch.
 *
 * Each quest can define constraints that layer on top of the project config:
 *   - add: extra constraints appended to every task
 *   - ban: extra forbidden items appended to every task
 *   - override: deep-merge fields that replace project config values
 */

import type { WomboConfig } from "../config.js";
import type { Priority, Difficulty, Task } from "./tasks.js";

// ---------------------------------------------------------------------------
// Quest Status
// ---------------------------------------------------------------------------

/** Quest lifecycle states */
export type QuestStatus =
  | "draft"        // Created but not yet planned/populated with tasks
  | "planning"     // Planner agent is decomposing the quest into tasks
  | "active"       // Tasks are being worked on
  | "paused"       // Temporarily suspended (agents stopped)
  | "completed"    // All tasks done, quest branch merged
  | "abandoned";   // Cancelled without merging

// ---------------------------------------------------------------------------
// HITL Mode
// ---------------------------------------------------------------------------

/**
 * Human-in-the-loop mode for agents working on a quest's tasks.
 *
 * - yolo:       query_human returns "proceed autonomously", no interruption
 * - cautious:   real-time IPC piping — agent blocks, TUI shows popup, user
 *               types answer, piped back. Agent never restarts.
 * - supervised: same pipe but prompt encourages asking before major decisions
 */
export type QuestHitlMode = "yolo" | "cautious" | "supervised";

// ---------------------------------------------------------------------------
// Quest Constraints (layered on top of project config)
// ---------------------------------------------------------------------------

/**
 * Constraints that a quest can define. These are merged with the project
 * config and applied to every task in the quest:
 *
 * - add:      appended to task.constraints
 * - ban:      appended to task.forbidden
 * - override: deep-merged into the effective WomboConfig for this quest
 */
export interface QuestConstraints {
  /** Extra constraints appended to every task in this quest */
  add: string[];
  /** Extra forbidden items appended to every task in this quest */
  ban: string[];
  /**
   * Deep-merge overrides for the project config. Only the fields specified
   * here replace the project defaults; everything else is inherited.
   *
   * Example: { build: { command: "npm run build" } } overrides only
   * build.command while keeping build.timeout and build.artifactDir.
   */
  override: Partial<WomboConfig>;
}

// ---------------------------------------------------------------------------
// Quest
// ---------------------------------------------------------------------------

/** A Quest — a scoped mission containing multiple tasks. */
export interface Quest {
  /** Unique quest identifier (kebab-case, e.g. "auth-overhaul") */
  id: string;
  /** Human-readable title */
  title: string;
  /** Goal description — what this quest aims to achieve */
  goal: string;
  /** Current lifecycle status */
  status: QuestStatus;
  /** Priority relative to other quests */
  priority: Priority;
  /** Estimated difficulty of the overall quest */
  difficulty: Difficulty;

  /** Quest IDs this quest depends on (must be completed first) */
  depends_on: string[];

  /** Branch name for this quest (auto-derived: quest/<id>) */
  branch: string;
  /** Base branch this quest forks from (defaults to project baseBranch) */
  baseBranch: string;

  /** HITL mode for agents working on this quest's tasks */
  hitlMode: QuestHitlMode;

  /** Layered constraints applied to all tasks in this quest */
  constraints: QuestConstraints;

  /** Task IDs that belong to this quest (references into the task store) */
  taskIds: string[];

  /** ISO 8601 timestamps */
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;

  /** Free-form notes */
  notes: string[];

  /**
   * Optional agent type override for all tasks in this quest.
   * Individual task agent_type takes precedence if set.
   */
  agent_type?: string;

  /**
   * Optional local agent definition override for all tasks in this quest.
   * Individual task agent takes precedence if set.
   */
  agent?: string;
}

// ---------------------------------------------------------------------------
// Quest File (YAML shape)
// ---------------------------------------------------------------------------

/**
 * Shape of a single quest YAML file (.wombo-combo/quests/<quest-id>.yml).
 * Unlike tasks which are bare objects, quest files include the quest data
 * directly (no wrapper — the file IS the quest).
 */
export type QuestFile = Quest;

// ---------------------------------------------------------------------------
// Schema Constants
// ---------------------------------------------------------------------------

export const VALID_QUEST_STATUSES: readonly QuestStatus[] = [
  "draft",
  "planning",
  "active",
  "paused",
  "completed",
  "abandoned",
] as const;

export const VALID_HITL_MODES: readonly QuestHitlMode[] = [
  "yolo",
  "cautious",
  "supervised",
] as const;

export const QUEST_REQUIRED_FIELDS = ["id", "title", "goal", "status"] as const;

/** Fields that must be arrays; YAML may parse absent values as null */
export const QUEST_ARRAY_FIELDS = [
  "depends_on",
  "taskIds",
  "notes",
] as const;

/** Quest status ordering for display (active first, abandoned last) */
export const QUEST_STATUS_ORDER: Readonly<Record<QuestStatus, number>> = {
  active: 0,
  planning: 1,
  draft: 2,
  paused: 3,
  completed: 4,
  abandoned: 5,
};

// ---------------------------------------------------------------------------
// Quest Defaults / Factory
// ---------------------------------------------------------------------------

/** Default empty constraints */
export function emptyConstraints(): QuestConstraints {
  return {
    add: [],
    ban: [],
    override: {},
  };
}

/**
 * Create a blank quest with all required fields initialized.
 */
export function createBlankQuest(
  id: string,
  title: string,
  goal: string,
  baseBranch: string,
  opts?: {
    priority?: Priority;
    difficulty?: Difficulty;
    hitlMode?: QuestHitlMode;
    agent_type?: string;
    agent?: string;
  }
): Quest {
  const now = new Date().toISOString();
  return {
    id,
    title,
    goal,
    status: "draft",
    priority: opts?.priority ?? "medium",
    difficulty: opts?.difficulty ?? "medium",
    depends_on: [],
    branch: `quest/${id}`,
    baseBranch,
    hitlMode: opts?.hitlMode ?? "yolo",
    constraints: emptyConstraints(),
    taskIds: [],
    created_at: now,
    updated_at: now,
    started_at: null,
    ended_at: null,
    notes: [],
    agent_type: opts?.agent_type,
    agent: opts?.agent,
  };
}

// ---------------------------------------------------------------------------
// Normalize (handle YAML nulls, missing arrays, etc.)
// ---------------------------------------------------------------------------

/**
 * Normalize a parsed quest object: fill in missing arrays, sanitize nulls.
 * Mutates in place.
 */
export function normalizeQuest(q: Quest): void {
  q.depends_on = q.depends_on ?? [];
  q.taskIds = q.taskIds ?? [];
  q.notes = q.notes ?? [];
  q.constraints = q.constraints ?? emptyConstraints();
  q.constraints.add = q.constraints.add ?? [];
  q.constraints.ban = q.constraints.ban ?? [];
  q.constraints.override = q.constraints.override ?? {};

  // Derive branch if missing
  if (!q.branch) {
    q.branch = `quest/${q.id}`;
  }

  // Nullify empty optional strings
  if (q.agent_type === null || q.agent_type === "") {
    q.agent_type = undefined;
  }
  if (q.agent === null || q.agent === "") {
    q.agent = undefined;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface QuestSchemaIssue {
  level: "error" | "warning";
  questId: string;
  message: string;
}

/**
 * Validate a quest object against the schema. Returns issues (errors/warnings).
 * Does NOT throw.
 */
export function validateQuest(quest: unknown): QuestSchemaIssue[] {
  const issues: QuestSchemaIssue[] = [];
  const q = quest as Record<string, unknown>;
  const id = typeof q?.id === "string" ? q.id : "<unknown>";

  // Required fields
  for (const field of QUEST_REQUIRED_FIELDS) {
    if (!q?.[field]) {
      issues.push({ level: "error", questId: id, message: `Missing required field: ${field}` });
    }
  }

  // id format (kebab-case)
  if (typeof q?.id === "string") {
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(q.id)) {
      issues.push({ level: "error", questId: id, message: `Quest ID must be kebab-case: "${q.id}"` });
    }
  }

  // status enum
  if (q?.status && !(VALID_QUEST_STATUSES as readonly string[]).includes(q.status as string)) {
    issues.push({ level: "error", questId: id, message: `Invalid status: "${q.status}"` });
  }

  // hitlMode enum
  if (q?.hitlMode && !(VALID_HITL_MODES as readonly string[]).includes(q.hitlMode as string)) {
    issues.push({ level: "error", questId: id, message: `Invalid hitlMode: "${q.hitlMode}"` });
  }

  // depends_on structural check
  if (q?.depends_on != null && !Array.isArray(q.depends_on)) {
    issues.push({ level: "error", questId: id, message: "depends_on must be an array" });
  }

  // taskIds structural check
  if (q?.taskIds != null && !Array.isArray(q.taskIds)) {
    issues.push({ level: "error", questId: id, message: "taskIds must be an array" });
  }

  // constraints structural check
  if (q?.constraints != null && typeof q.constraints !== "object") {
    issues.push({ level: "error", questId: id, message: "constraints must be an object" });
  } else if (q?.constraints && typeof q.constraints === "object") {
    const c = q.constraints as Record<string, unknown>;
    if (c.add != null && !Array.isArray(c.add)) {
      issues.push({ level: "error", questId: id, message: "constraints.add must be an array" });
    }
    if (c.ban != null && !Array.isArray(c.ban)) {
      issues.push({ level: "error", questId: id, message: "constraints.ban must be an array" });
    }
    if (c.override != null && typeof c.override !== "object") {
      issues.push({ level: "error", questId: id, message: "constraints.override must be an object" });
    }
  }

  // branch format
  if (typeof q?.branch === "string" && !q.branch.startsWith("quest/")) {
    issues.push({ level: "warning", questId: id, message: `Branch "${q.branch}" should start with "quest/"` });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Layered Config Resolution
// ---------------------------------------------------------------------------

/**
 * Deep-merge source into target. Only merges plain objects, not arrays.
 * Same logic as config.ts deepMerge, duplicated here to avoid circular deps.
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== undefined &&
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal) &&
      tgtVal !== null
    ) {
      result[key] = deepMerge(tgtVal as any, srcVal as any);
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[keyof T];
    }
  }
  return result;
}

/**
 * Resolve the effective config for a quest by layering its overrides on top
 * of the project config. Returns a new WomboConfig — does NOT mutate the input.
 */
export function resolveQuestConfig(
  projectConfig: WomboConfig,
  quest: Quest
): WomboConfig {
  if (
    !quest.constraints.override ||
    Object.keys(quest.constraints.override).length === 0
  ) {
    return { ...projectConfig };
  }
  return deepMerge(projectConfig, quest.constraints.override);
}

/**
 * Apply quest constraints to a task. Returns a new task with the quest's
 * add/ban constraints merged in. Does NOT mutate the input task.
 *
 * - quest.constraints.add → appended to task.constraints
 * - quest.constraints.ban → appended to task.forbidden
 */
export function applyQuestConstraintsToTask(
  task: Task,
  quest: Quest
): Task {
  const extraConstraints = quest.constraints.add ?? [];
  const extraForbidden = quest.constraints.ban ?? [];

  if (extraConstraints.length === 0 && extraForbidden.length === 0) {
    return task;
  }

  return {
    ...task,
    constraints: [...task.constraints, ...extraConstraints],
    forbidden: [...task.forbidden, ...extraForbidden],
  };
}
