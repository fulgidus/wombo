/**
 * task-store.ts — Folder-based task storage.
 *
 * Layout inside .wombo-combo/:
 *   tasks/
 *     _meta.yml           — version + meta (project, generator, maintainer, timestamps)
 *     <task-id>.yml       — one file per task
 *   archive/
 *     _meta.yml
 *     <task-id>.yml
 *
 * Each task file is a plain YAML mapping of a single Task object.
 * The _meta.yml file holds the TasksFile-level metadata (version, meta block).
 *
 * Migration:
 *   If the old single-file (tasks.yml / archive.yml) exists and the folder
 *   does not, migrateToFolderStorage() converts automatically, flattening
 *   nested subtasks to top-level tasks with depends_on references.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { WomboConfig } from "../config.js";
import { WOMBO_DIR } from "../config.js";
import type { Task, TasksFile, ArchiveFile } from "./tasks.js";
import { validateTask, validateMeta as validateMetaSchema } from "./task-schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_FILE = "_meta.yml";

const YAML_OPTS = {
  lineWidth: 120,
  defaultKeyType: "PLAIN" as const,
  defaultStringType: "PLAIN" as const,
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function tasksDir(projectRoot: string, config: WomboConfig): string {
  return resolve(projectRoot, WOMBO_DIR, config.tasksDir);
}

function archiveDir(projectRoot: string, config: WomboConfig): string {
  return resolve(projectRoot, WOMBO_DIR, config.archiveDir);
}

/** Legacy single-file path (for migration detection) */
function legacyTasksFile(projectRoot: string): string {
  return resolve(projectRoot, WOMBO_DIR, "tasks.yml");
}

function legacyArchiveFile(projectRoot: string): string {
  return resolve(projectRoot, WOMBO_DIR, "archive.yml");
}

/** Even older legacy paths */
function legacyFeaturesFile(projectRoot: string): string {
  return resolve(projectRoot, ".features.yml");
}

// ---------------------------------------------------------------------------
// Meta I/O
// ---------------------------------------------------------------------------

export interface TasksMeta {
  version: string;
  meta: {
    created_at: string;
    updated_at: string;
    project: string;
    generator: string;
    maintainer: string;
  };
}

function defaultMeta(): TasksMeta {
  const now = new Date().toISOString();
  return {
    version: "1.0",
    meta: {
      created_at: now,
      updated_at: now,
      project: "unknown",
      generator: "wombo-combo",
      maintainer: "unknown",
    },
  };
}

function loadMeta(dir: string): TasksMeta {
  const metaPath = join(dir, META_FILE);
  if (!existsSync(metaPath)) return defaultMeta();
  try {
    const raw = readFileSync(metaPath, "utf-8");
    const parsed = parseYaml(raw);

    // Validate and warn
    const issues = validateMetaSchema(parsed);
    for (const issue of issues) {
      if (issue.level === "error") {
        console.error(`  [schema] ${issue.taskId}: ${issue.message}`);
      } else {
        console.warn(`  [schema] ${issue.taskId}: ${issue.message}`);
      }
    }

    return {
      version: parsed?.version ?? "1.0",
      meta: parsed?.meta ?? defaultMeta().meta,
    };
  } catch {
    return defaultMeta();
  }
}

function saveMeta(dir: string, meta: TasksMeta): void {
  ensureDir(dir);
  meta.meta.updated_at = new Date().toISOString();
  const yaml = stringifyYaml(meta, YAML_OPTS);
  const metaPath = join(dir, META_FILE);
  atomicWrite(metaPath, yaml);
}

// ---------------------------------------------------------------------------
// Task file I/O
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

/**
 * List all task YAML files in a directory (excluding _meta.yml).
 */
function listTaskFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") && f !== META_FILE)
    .sort();
}

/**
 * Load a single task from a YAML file.
 */
function loadTaskFile(filePath: string): Task | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw);
    if (!parsed || typeof parsed !== "object") return null;
    normalizeTask(parsed as Task);

    // Validate and warn (but still return the task)
    const issues = validateTask(parsed);
    for (const issue of issues) {
      if (issue.level === "error") {
        console.error(`  [schema] ${issue.taskId}: ${issue.message}`);
      } else {
        console.warn(`  [schema] ${issue.taskId}: ${issue.message}`);
      }
    }

    return parsed as Task;
  } catch {
    return null;
  }
}

/**
 * Save a single task to its YAML file.
 */
export function saveTaskFile(dir: string, task: Task): void {
  ensureDir(dir);
  const filePath = join(dir, `${task.id}.yml`);
  const yaml = stringifyYaml(task, YAML_OPTS);
  atomicWrite(filePath, yaml);
}

/**
 * Delete a task file from a directory.
 */
export function deleteTaskFile(dir: string, taskId: string): void {
  const filePath = join(dir, `${taskId}.yml`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

// ---------------------------------------------------------------------------
// Normalize (same logic as the original tasks.ts)
// ---------------------------------------------------------------------------

function normalizeTask(t: Task): void {
  t.depends_on = t.depends_on ?? [];
  t.constraints = t.constraints ?? [];
  t.forbidden = t.forbidden ?? [];
  t.references = t.references ?? [];
  t.notes = t.notes ?? [];
  t.subtasks = t.subtasks ?? [];
  if (t.agent_type === null || t.agent_type === "") {
    t.agent_type = undefined;
  }
  for (const s of t.subtasks) {
    normalizeTask(s);
  }
}

// ---------------------------------------------------------------------------
// Public API — Load
// ---------------------------------------------------------------------------

/**
 * Load all tasks from the folder-based store.
 * If the folder doesn't exist but the legacy single file does, migrate first.
 */
export function loadTasksFromStore(
  projectRoot: string,
  config: WomboConfig
): TasksFile {
  const dir = tasksDir(projectRoot, config);

  // Auto-migrate from legacy single-file if needed
  if (!existsSync(dir)) {
    const migrated = migrateTasksIfNeeded(projectRoot, config);
    if (!migrated) {
      // No legacy file either — return empty
      return { ...defaultMeta(), tasks: [] };
    }
  }

  const meta = loadMeta(dir);
  const files = listTaskFiles(dir);
  const tasks: Task[] = [];

  for (const file of files) {
    const task = loadTaskFile(join(dir, file));
    if (task) tasks.push(task);
  }

  return { ...meta, tasks };
}

/**
 * Load all archived tasks from the folder-based store.
 */
export function loadArchiveFromStore(
  projectRoot: string,
  config: WomboConfig
): ArchiveFile {
  const dir = archiveDir(projectRoot, config);

  // Auto-migrate from legacy single-file if needed
  if (!existsSync(dir)) {
    migrateArchiveIfNeeded(projectRoot, config);
  }

  if (!existsSync(dir)) {
    return { ...defaultMeta(), tasks: [] };
  }

  const meta = loadMeta(dir);
  const files = listTaskFiles(dir);
  const tasks: Task[] = [];

  for (const file of files) {
    const task = loadTaskFile(join(dir, file));
    if (task) tasks.push(task);
  }

  return { ...meta, tasks };
}

// ---------------------------------------------------------------------------
// Public API — Save
// ---------------------------------------------------------------------------

/**
 * Save a single task to the tasks folder. Updates _meta.yml timestamp.
 */
export function saveTaskToStore(
  projectRoot: string,
  config: WomboConfig,
  task: Task
): void {
  const dir = tasksDir(projectRoot, config);
  ensureDir(dir);
  saveTaskFile(dir, task);
  // Touch meta timestamp
  const meta = loadMeta(dir);
  saveMeta(dir, meta);
}

/**
 * Save a single task to the archive folder. Updates _meta.yml timestamp.
 */
export function saveTaskToArchive(
  projectRoot: string,
  config: WomboConfig,
  task: Task
): void {
  const dir = archiveDir(projectRoot, config);
  ensureDir(dir);
  saveTaskFile(dir, task);
  const meta = loadMeta(dir);
  saveMeta(dir, meta);
}

/**
 * Remove a task from the tasks folder (e.g. when archiving).
 */
export function removeTaskFromStore(
  projectRoot: string,
  config: WomboConfig,
  taskId: string
): void {
  const dir = tasksDir(projectRoot, config);
  deleteTaskFile(dir, taskId);
}

/**
 * Save the full TasksFile (all tasks + meta). Used for bulk operations.
 * Writes _meta.yml + one file per task.
 */
export function saveAllTasksToStore(
  projectRoot: string,
  config: WomboConfig,
  data: TasksFile
): void {
  const dir = tasksDir(projectRoot, config);
  ensureDir(dir);
  saveMeta(dir, { version: data.version, meta: data.meta });
  for (const task of data.tasks) {
    saveTaskFile(dir, task);
  }
}

/**
 * Save the full ArchiveFile (all archived tasks + meta).
 */
export function saveAllArchiveToStore(
  projectRoot: string,
  config: WomboConfig,
  data: ArchiveFile
): void {
  const dir = archiveDir(projectRoot, config);
  ensureDir(dir);
  saveMeta(dir, { version: data.version, meta: data.meta });
  for (const task of data.tasks) {
    saveTaskFile(dir, task);
  }
}

/**
 * Save tasks meta only (for ensureTasksFile that creates initial structure).
 */
export function saveTasksMetaToStore(
  projectRoot: string,
  config: WomboConfig,
  meta: TasksMeta
): void {
  const dir = tasksDir(projectRoot, config);
  ensureDir(dir);
  saveMeta(dir, meta);
}

/**
 * Save archive meta only.
 */
export function saveArchiveMetaToStore(
  projectRoot: string,
  config: WomboConfig,
  meta: TasksMeta
): void {
  const dir = archiveDir(projectRoot, config);
  ensureDir(dir);
  saveMeta(dir, meta);
}

/**
 * Check if the tasks directory exists (for ensureTasksFile guard).
 */
export function tasksStoreExists(
  projectRoot: string,
  config: WomboConfig
): boolean {
  const dir = tasksDir(projectRoot, config);
  return existsSync(dir) && existsSync(join(dir, META_FILE));
}

/**
 * Get the tasks directory path.
 */
export function getTasksDir(
  projectRoot: string,
  config: WomboConfig
): string {
  return tasksDir(projectRoot, config);
}

/**
 * Get the archive directory path.
 */
export function getArchiveDir(
  projectRoot: string,
  config: WomboConfig
): string {
  return archiveDir(projectRoot, config);
}

// ---------------------------------------------------------------------------
// Backup (per-file, stored alongside in backups/)
// ---------------------------------------------------------------------------

function createBackup(filePath: string, maxBackups: number): void {
  if (!existsSync(filePath)) return;
  const dir = dirname(filePath);
  const backupDir = join(dir, "backups");
  ensureDir(backupDir);

  const base = basename(filePath);
  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "");
  const backupName = `${base}.${timestamp}.bak`;
  copyFileSync(filePath, join(backupDir, backupName));

  // Rotate
  const pattern = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.bak$`
  );
  const backups = readdirSync(backupDir)
    .filter((f) => pattern.test(f))
    .sort();
  while (backups.length > maxBackups) {
    const oldest = backups.shift()!;
    unlinkSync(join(backupDir, oldest));
  }
}

// ---------------------------------------------------------------------------
// Migration — single-file → folder-based (with subtask flattening)
// ---------------------------------------------------------------------------

/**
 * Flatten a task's nested subtasks into a list of top-level tasks.
 * Returns [flattenedParent, ...promotedSubtasks].
 *
 * Rules:
 * - Each subtask becomes a top-level task, keeping its own depends_on.
 * - The parent task gains depends_on references to the "leaf" subtasks
 *   (those that nothing else depends on within the subtask group).
 * - All tasks get subtasks: [] (field kept for schema compat).
 */
function flattenTask(task: Task): Task[] {
  if (!task.subtasks || task.subtasks.length === 0) {
    return [{ ...task, subtasks: [] }];
  }

  // Recursively flatten all subtasks first
  const allPromoted: Task[] = [];
  for (const sub of task.subtasks) {
    const flat = flattenTask(sub);
    allPromoted.push(...flat);
  }

  // Find the chain endpoints: subtask IDs that no other subtask depends on
  const allIds = new Set(allPromoted.map((t) => t.id));
  const depTargets = new Set<string>();
  for (const t of allPromoted) {
    for (const dep of t.depends_on) {
      if (allIds.has(dep)) depTargets.add(dep);
    }
  }
  const endpoints = allPromoted
    .filter((t) => !depTargets.has(t.id))
    .map((t) => t.id);

  // Parent depends on endpoints (in addition to its existing deps)
  const parentDeps = [...task.depends_on];
  for (const ep of endpoints) {
    if (!parentDeps.includes(ep)) parentDeps.push(ep);
  }

  const flatParent: Task = {
    ...task,
    depends_on: parentDeps,
    subtasks: [],
  };

  return [flatParent, ...allPromoted];
}

/**
 * Migrate legacy tasks.yml → tasks/ folder with subtask flattening.
 * Returns true if migration occurred.
 */
function migrateTasksIfNeeded(
  projectRoot: string,
  config: WomboConfig
): boolean {
  // Check for legacy files in order of preference
  const candidates = [
    legacyTasksFile(projectRoot),
    resolve(projectRoot, WOMBO_DIR, "tasks.yml"),
  ];

  // Also check the very old .features.yml at project root
  const oldFeatures = legacyFeaturesFile(projectRoot);
  if (existsSync(oldFeatures)) candidates.push(oldFeatures);

  let legacyPath: string | null = null;
  for (const p of candidates) {
    if (existsSync(p)) {
      legacyPath = p;
      break;
    }
  }

  if (!legacyPath) return false;

  console.log(`Migrating ${legacyPath} → folder-based storage...`);

  const raw = readFileSync(legacyPath, "utf-8");
  let parsed: any;
  try {
    parsed = parseYaml(raw);
  } catch (err: any) {
    console.error(`Failed to parse legacy tasks file: ${err.message}`);
    return false;
  }

  if (!parsed || typeof parsed !== "object") return false;

  const legacyTasks: Task[] = parsed.tasks ?? parsed.features ?? [];
  if (!Array.isArray(legacyTasks)) return false;

  const meta: TasksMeta = {
    version: parsed.version ?? "1.0",
    meta: parsed.meta ?? defaultMeta().meta,
  };

  // Fix meta fields
  meta.meta.project = meta.meta.project || "wombo-combo";
  meta.meta.generator = "wombo-combo";

  const dir = tasksDir(projectRoot, config);
  ensureDir(dir);
  saveMeta(dir, meta);

  // Flatten and write each task
  let count = 0;
  for (const task of legacyTasks) {
    normalizeTask(task);
    const flat = flattenTask(task);
    for (const t of flat) {
      saveTaskFile(dir, t);
      count++;
    }
  }

  // Handle archive section in the same file (old format had archive: [...])
  const legacyArchive: Task[] = parsed.archive ?? [];
  if (Array.isArray(legacyArchive) && legacyArchive.length > 0) {
    const aDir = archiveDir(projectRoot, config);
    ensureDir(aDir);
    saveMeta(aDir, meta);
    for (const task of legacyArchive) {
      normalizeTask(task);
      const flat = flattenTask(task);
      for (const t of flat) {
        saveTaskFile(aDir, t);
      }
    }
  }

  console.log(`  Migrated ${count} tasks (flattened subtasks) to ${WOMBO_DIR}/${config.tasksDir}/`);

  // Rename legacy file to .bak (don't delete, in case something goes wrong)
  const bakPath = legacyPath + ".migrated.bak";
  if (!existsSync(bakPath)) {
    renameSync(legacyPath, bakPath);
    console.log(`  Renamed ${basename(legacyPath)} → ${basename(bakPath)}`);
  }

  return true;
}

/**
 * Migrate legacy archive.yml → archive/ folder.
 */
function migrateArchiveIfNeeded(
  projectRoot: string,
  config: WomboConfig
): boolean {
  const legacyPath = legacyArchiveFile(projectRoot);
  if (!existsSync(legacyPath)) return false;

  console.log(`Migrating ${legacyPath} → folder-based archive...`);

  const raw = readFileSync(legacyPath, "utf-8");
  let parsed: any;
  try {
    parsed = parseYaml(raw);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== "object") return false;

  const legacyTasks: Task[] = parsed.tasks ?? parsed.features ?? [];
  if (!Array.isArray(legacyTasks)) return false;

  const meta: TasksMeta = {
    version: parsed.version ?? "1.0",
    meta: parsed.meta ?? defaultMeta().meta,
  };

  const dir = archiveDir(projectRoot, config);
  ensureDir(dir);
  saveMeta(dir, meta);

  for (const task of legacyTasks) {
    normalizeTask(task);
    const flat = flattenTask(task);
    for (const t of flat) {
      saveTaskFile(dir, t);
    }
  }

  const bakPath = legacyPath + ".migrated.bak";
  if (!existsSync(bakPath)) {
    renameSync(legacyPath, bakPath);
  }

  return true;
}
