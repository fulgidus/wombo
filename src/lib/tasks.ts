/**
 * tasks.ts -- Parse tasks YAML and provide task selection/filtering.
 *
 * Responsibilities:
 *   - Load and parse the tasks file with full type safety
 *   - Load and parse the archive file separately
 *   - Parse ISO 8601 durations into comparable minutes
 *   - Filter tasks by status, priority, difficulty, dependency readiness
 *   - Select tasks by various strategies (top-priority, quickest-wins, etc.)
 *   - Resolve dependency graphs to determine which tasks are ready to start
 *   - Write-back capability for task management commands
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { WomboConfig } from "../config";
import { WOMBO_DIR, isProjectInitialized } from "../config";
import {
  loadTasksFromStore,
  loadArchiveFromStore,
  saveAllTasksToStore,
  saveAllArchiveToStore,
  saveTaskToStore,
  saveTaskToArchive,
  removeTaskFromStore,
  tasksStoreExists,
  saveTasksMetaToStore,
  saveArchiveMetaToStore,
  getTasksDir,
  getArchiveDir,
  saveTaskFile,
  deleteTaskFile,
} from "./task-store";

// ---------------------------------------------------------------------------
// Template path (resolved relative to this source file)
// ---------------------------------------------------------------------------

export const META_TEMPLATE_PATH = join(dirname(import.meta.dir), "templates", "_meta.yml");
/** @deprecated Use META_TEMPLATE_PATH — the old monolithic template no longer exists. */
export const TASKS_TEMPLATE_PATH = META_TEMPLATE_PATH;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "backlog"
  | "planned"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "cancelled";

export type Priority = "critical" | "high" | "medium" | "low" | "wishlist";

export type Difficulty = "trivial" | "easy" | "medium" | "hard" | "very_hard";

/**
 * Unified task type. Previously split into Feature and Subtask, but the shapes
 * are identical so there is no reason to maintain two names.
 */
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  completion: number;
  difficulty: Difficulty;
  priority: Priority;
  depends_on: string[];
  effort: string;
  started_at: string | null;
  ended_at: string | null;
  constraints: string[];
  forbidden: string[];
  references: string[];
  notes: string[];
  subtasks: Task[];
  /**
   * Optional agent type from an external registry (e.g. agency-agents).
   * Format: "category/agent-name" (e.g. "engineering/engineering-frontend-developer").
   * When set, wombo downloads and patches the specified agent definition
   * instead of using the default generalist agent.
   */
  agent_type?: string;
  /**
   * Optional local agent definition file name (without extension).
   * References a file in `.opencode/agents/<agent>.md`.
   * When omitted, defaults to the config's `agent.name` (typically "generalist-agent").
   * This is independent of `agent_type` which references external registry agents.
   */
  agent?: string;
  /**
   * Optional quest ID this task belongs to.
   * When set, the task is part of the named quest and will automatically
   * fork from / merge into the quest branch during launch.
   * The quest's `depends_on` array creates transitive dependencies:
   * all tasks in a dependent quest implicitly depend on all tasks in the
   * prerequisite quest.
   */
  quest?: string;
}

/**
 * Shape of tasks.yml (active tasks).
 */
export interface TasksFile {
  version: string;
  meta: {
    created_at: string;
    updated_at: string;
    project: string;
    generator: string;
    maintainer: string;
  };
  tasks: Task[];
}

/**
 * Shape of archive.yml (archived tasks). Same structure as TasksFile.
 */
export type ArchiveFile = TasksFile;

// Backward-compat aliases (ease migration in consuming code)
export type Feature = Task;
export type Subtask = Task;
export type FeatureStatus = TaskStatus;
export type FeaturesFile = TasksFile & { archive: Task[] };

// Re-export ordering maps from the canonical source (task-schema.ts)
import { PRIORITY_ORDER, DIFFICULTY_ORDER } from "./task-schema";
export { PRIORITY_ORDER, DIFFICULTY_ORDER };

// ---------------------------------------------------------------------------
// ISO 8601 Duration Parser
// ---------------------------------------------------------------------------

/**
 * Parse an ISO 8601 duration string into total minutes.
 * Supports: P[nY][nM][nD][T[nH][nM][nS]]
 * Examples: PT1H -> 60, PT30M -> 30, P1D -> 1440, P2DT4H -> 3360, PT1H30M -> 90
 *           P1Y -> 525600, P2M -> 86400
 * Year/month approximations: 1Y = 365D, 1M = 30D
 */
export function parseDurationMinutes(iso: string): number {
  const match = iso.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
  );
  if (!match) return Infinity; // unparseable -> sort to end
  const years = parseInt(match[1] || "0", 10);
  const months = parseInt(match[2] || "0", 10);
  const days = parseInt(match[3] || "0", 10);
  const hours = parseInt(match[4] || "0", 10);
  const minutes = parseInt(match[5] || "0", 10);
  const seconds = parseInt(match[6] || "0", 10);
  const totalDays = years * 365 + months * 30 + days;
  return totalDays * 24 * 60 + hours * 60 + minutes + Math.ceil(seconds / 60);
}

/**
 * Format minutes into a human-readable string.
 */
export function formatDuration(minutes: number): string {
  if (minutes === Infinity) return "unknown";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    if (rh === 0 && m === 0) return `${d}d`;
    if (m === 0) return `${d}d ${rh}h`;
    return `${d}d ${rh}h ${m}m`;
  }
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// .wombo-combo directory helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the .wombo-combo directory exists.
 */
export function ensureWomboDir(projectRoot: string): string {
  const dir = resolve(projectRoot, WOMBO_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Resolve a file path within the .wombo-combo directory.
 */
function womboPath(projectRoot: string, filename: string): string {
  return resolve(projectRoot, WOMBO_DIR, filename);
}

// ---------------------------------------------------------------------------
// Tasks File Existence Guard
// ---------------------------------------------------------------------------

/**
 * Ensure the tasks store exists before any command that needs it.
 *
 * If the project hasn't been initialized at all (no .wombo-combo/config.json),
 * tell the user to run `woco init` and exit — don't patch individual pieces.
 *
 * If the project IS initialized but the tasks store directory is missing,
 * auto-create it (this can happen after manual config edits or migration).
 */
export async function ensureTasksFile(
  projectRoot: string,
  config: WomboConfig
): Promise<void> {
  if (tasksStoreExists(projectRoot, config)) return;

  // Try loading — this triggers auto-migration from legacy files
  const data = loadTasksFromStore(projectRoot, config);
  if (data.tasks.length > 0 || tasksStoreExists(projectRoot, config)) return;

  // Project not initialized at all — tell the user to run init
  if (!isProjectInitialized(projectRoot)) {
    console.error(
      `\nThis project hasn't been initialized yet.\n` +
      `Run \`woco init\` to set up ${WOMBO_DIR}/ with config, tasks, and archive stores.\n`
    );
    process.exit(1);
  }

  // Project IS initialized (config.json exists) but tasks store is missing.
  // Auto-create it — this is a partial state, not a "never initialized" state.
  console.log(`\nTasks store not found: ${WOMBO_DIR}/${config.tasksDir}/`);
  console.log(`Creating empty tasks store...`);

  ensureWomboDir(projectRoot);

  const now = new Date().toISOString();
  saveTasksMetaToStore(projectRoot, config, {
    version: "1.0",
    meta: {
      created_at: now,
      updated_at: now,
      project: "unknown",
      generator: "wombo-combo",
      maintainer: "unknown",
    },
  });
  console.log(`Created ${WOMBO_DIR}/${config.tasksDir}/ with empty task store.`);

  // Also create empty archive store if missing
  const archivePath = resolve(projectRoot, WOMBO_DIR, config.archiveDir);
  if (!existsSync(archivePath)) {
    saveArchiveMetaToStore(projectRoot, config, {
      version: "1.0",
      meta: {
        created_at: now,
        updated_at: now,
        project: "unknown",
        generator: "wombo-combo",
        maintainer: "unknown",
      },
    });
    console.log(`Created ${WOMBO_DIR}/${config.archiveDir}/.`);
  }
  console.log(); // trailing blank line
}

// Backward-compat alias
export const ensureFeaturesFile = ensureTasksFile;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and parse tasks from the folder-based store.
 */
export function loadTasks(
  projectRoot: string,
  config: WomboConfig
): TasksFile {
  return loadTasksFromStore(projectRoot, config);
}

/**
 * Load archived tasks from the folder-based store.
 * Returns an empty ArchiveFile if the store doesn't exist.
 */
export function loadArchive(
  projectRoot: string,
  config: WomboConfig
): ArchiveFile {
  return loadArchiveFromStore(projectRoot, config);
}

/**
 * Backward-compat: load tasks + archive merged into a single FeaturesFile shape.
 * This eases migration — callers that used loadFeatures() keep working.
 */
export function loadFeatures(
  projectRoot: string,
  config: WomboConfig
): FeaturesFile {
  const tasksData = loadTasks(projectRoot, config);
  const archiveData = loadArchive(projectRoot, config);
  return {
    ...tasksData,
    // Map "tasks" to "features" for backward compat (FeaturesFile has .features)
    // Actually FeaturesFile extends TasksFile which has .tasks, but add .archive
    archive: archiveData.tasks,
  };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Save all tasks to the folder-based store.
 * Writes _meta.yml + one file per task.
 */
export function saveTasks(
  projectRoot: string,
  config: WomboConfig,
  data: TasksFile
): void {
  saveAllTasksToStore(projectRoot, config, data);
}

/**
 * Save all archived tasks to the folder-based store.
 */
export function saveArchive(
  projectRoot: string,
  config: WomboConfig,
  data: ArchiveFile
): void {
  saveAllArchiveToStore(projectRoot, config, data);
}

/**
 * Backward-compat: save a FeaturesFile (tasks + archive in one object).
 * Splits and writes to both tasks.yml and archive.yml.
 */
export function saveFeatures(
  projectRoot: string,
  config: WomboConfig,
  data: FeaturesFile
): void {
  const tasksData: TasksFile = {
    version: data.version,
    meta: { ...data.meta },
    tasks: data.tasks,
  };
  saveTasks(projectRoot, config, tasksData);

  if (data.archive && data.archive.length > 0) {
    const archiveData: ArchiveFile = {
      version: data.version,
      meta: { ...data.meta },
      tasks: data.archive,
    };
    saveArchive(projectRoot, config, archiveData);
  }
}


// ---------------------------------------------------------------------------
// Dependency Resolution
// ---------------------------------------------------------------------------

/**
 * Get all task IDs that are done (status === "done" or completion === 100).
 */
function getDoneIds(tasks: Task[], archive: Task[]): Set<string> {
  const done = new Set<string>();
  const collectDone = (items: Task[]) => {
    for (const item of items) {
      if (item.status === "done" || item.completion === 100) {
        done.add(item.id);
      }
      if (item.subtasks?.length) {
        collectDone(item.subtasks);
      }
    }
  };
  collectDone(tasks);
  collectDone(archive);
  return done;
}

/**
 * Check if a task's dependencies are all satisfied.
 */
export function areDependenciesMet(
  task: Task,
  doneIds: Set<string>
): boolean {
  return task.depends_on.every((dep) => doneIds.has(dep));
}

/**
 * Get all tasks that are ready to start (planned + deps met).
 * "planned" = user has explicitly queued the task for execution.
 * "backlog" = parked, not yet scheduled.
 */
export function getReadyTasks(data: TasksFile, archive?: Task[]): Task[] {
  const doneIds = getDoneIds(data.tasks, archive ?? []);
  return data.tasks.filter(
    (t) =>
      t.status === "planned" &&
      (t.completion === undefined || t.completion === 0) &&
      areDependenciesMet(t, doneIds)
  );
}

/**
 * Get done IDs (exported for use in selection error messages).
 */
export function getDoneTaskIds(data: TasksFile, archive?: Task[]): Set<string> {
  return getDoneIds(data.tasks, archive ?? []);
}

// Backward-compat aliases
export function getReadyFeatures(data: FeaturesFile): Task[] {
  return getReadyTasks(data, data.archive);
}

export function getDoneFeatureIds(data: FeaturesFile): Set<string> {
  return getDoneTaskIds(data, data.archive);
}

// ---------------------------------------------------------------------------
// Selection Strategies
// ---------------------------------------------------------------------------

export interface SelectionOptions {
  /** Select top N by priority (highest priority first, then lowest effort) */
  topPriority?: number;
  /** Select N quickest wins (lowest effort first) */
  quickestWins?: number;
  /** Select all tasks matching this priority level */
  priority?: Priority;
  /** Select all tasks matching this difficulty level */
  difficulty?: Difficulty;
  /** Select specific task IDs (comma-separated) */
  taskIds?: string[];
  /** Select all ready tasks */
  allReady?: boolean;
}

/**
 * Select tasks based on the given strategy.
 * Always filters to only ready tasks (planned + deps met) first.
 */
export function selectTasks(
  data: TasksFile,
  options: SelectionOptions,
  archive?: Task[]
): Task[] {
  const ready = getReadyTasks(data, archive);

  if (options.allReady) {
    return sortByPriorityThenEffort(ready);
  }

  if (options.taskIds?.length) {
    const idSet = new Set(options.taskIds);
    const selected = ready.filter((t) => idSet.has(t.id));
    const missing = options.taskIds.filter(
      (id) => !selected.find((t) => t.id === id)
    );
    if (missing.length) {
      const allIds = data.tasks.map((t) => t.id);
      const doneIds = getDoneIds(data.tasks, archive ?? []);
      for (const m of missing) {
        if (!allIds.includes(m)) {
          console.error(`  Task "${m}" does not exist in the tasks file`);
        } else {
          const task = data.tasks.find((t) => t.id === m)!;
          console.error(
            `  Task "${m}" is not ready (status: ${task.status}, deps met: ${areDependenciesMet(task, doneIds)})`
          );
        }
      }
    }
    return sortByPriorityThenEffort(selected);
  }

  if (options.priority) {
    return sortByPriorityThenEffort(
      ready.filter((t) => t.priority === options.priority)
    );
  }

  if (options.difficulty) {
    return sortByEffort(ready.filter((t) => t.difficulty === options.difficulty));
  }

  if (options.topPriority) {
    return sortByPriorityThenEffort(ready).slice(0, options.topPriority);
  }

  if (options.quickestWins) {
    return sortByEffort(ready).slice(0, options.quickestWins);
  }

  // Default: return all ready, sorted by priority
  return sortByPriorityThenEffort(ready);
}

// Backward-compat alias
export function selectFeatures(
  data: FeaturesFile,
  options: SelectionOptions & { featureIds?: string[] }
): Task[] {
  // Map featureIds -> taskIds for backward compat
  const opts: SelectionOptions = {
    ...options,
    taskIds: options.taskIds ?? options.featureIds,
  };
  return selectTasks(data, opts, data.archive);
}

// ---------------------------------------------------------------------------
// Sorting Helpers
// ---------------------------------------------------------------------------

export function sortByPriorityThenEffort(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pDiff !== 0) return pDiff;
    return parseDurationMinutes(a.effort) - parseDurationMinutes(b.effort);
  });
}

function sortByEffort(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) => parseDurationMinutes(a.effort) - parseDurationMinutes(b.effort)
  );
}

// ---------------------------------------------------------------------------
// Utility Exports
// ---------------------------------------------------------------------------

/**
 * Get a compact summary of a task for display.
 */
export function taskSummary(t: Task): string {
  const effort = formatDuration(parseDurationMinutes(t.effort));
  return `[${t.priority}/${t.difficulty}] ${t.id} -- ${t.title} (${effort})`;
}

// Backward-compat alias
export const featureSummary = taskSummary;

/**
 * Recursively search a list of tasks (and their subtasks) for a matching ID.
 */
function findInList(tasks: Task[], id: string): Task | undefined {
  for (const t of tasks) {
    if (t.id === id) return t;
    if (t.subtasks?.length) {
      const found = findInList(t.subtasks, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Find a task by ID across active tasks, their subtasks
 * (recursively), and the archive list.
 */
export function findTaskById(
  data: TasksFile,
  id: string,
  archive?: Task[]
): Task | undefined {
  return (
    findInList(data.tasks, id) ??
    (archive ? findInList(archive, id) : undefined)
  );
}

// Backward-compat alias
export function findFeatureById(
  data: FeaturesFile,
  id: string
): Task | undefined {
  return findTaskById(data, id, data.archive);
}

/**
 * Create a blank task with all required fields initialized.
 */
export function createBlankTask(
  id: string,
  title: string,
  description: string = "",
  opts?: {
    priority?: Priority;
    difficulty?: Difficulty;
    effort?: string;
  }
): Task {
  return {
    id,
    title,
    description,
    status: "backlog",
    completion: 0,
    difficulty: opts?.difficulty ?? "medium",
    priority: opts?.priority ?? "medium",
    depends_on: [],
    effort: opts?.effort ?? "PT1H",
    started_at: null,
    ended_at: null,
    constraints: [],
    forbidden: [],
    references: [],
    notes: [],
    subtasks: [],
  };
}

// Backward-compat alias
export const createBlankFeature = createBlankTask;

/**
 * Get all task IDs (active + archive), useful for validation.
 */
export function allTaskIds(data: TasksFile, archive?: Task[]): string[] {
  const ids: string[] = [];
  const collect = (items: Task[]) => {
    for (const item of items) {
      ids.push(item.id);
      if (item.subtasks?.length) collect(item.subtasks);
    }
  };
  collect(data.tasks);
  collect(archive ?? []);
  return ids;
}

// Backward-compat alias
export function allFeatureIds(data: FeaturesFile): string[] {
  return allTaskIds(data, data.archive);
}

// Re-export the old template path name for migration
export const FEATURES_TEMPLATE_PATH = TASKS_TEMPLATE_PATH;

// Re-export store functions for single-task operations
export {
  saveTaskToStore,
  saveTaskToArchive,
  removeTaskFromStore,
  getTasksDir,
  getArchiveDir,
} from "./task-store";
