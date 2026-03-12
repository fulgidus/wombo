/**
 * features.ts — Parse features YAML and provide feature selection/filtering.
 *
 * Responsibilities:
 *   - Load and parse the features file with full type safety
 *   - Parse ISO 8601 durations into comparable minutes
 *   - Filter features by status, priority, difficulty, dependency readiness
 *   - Select features by various strategies (top-priority, quickest-wins, etc.)
 *   - Resolve dependency graphs to determine which features are ready to start
 *   - Write-back capability for feature management commands
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createInterface } from "node:readline";
import type { WomboConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Template path (resolved relative to this source file)
// ---------------------------------------------------------------------------

export const FEATURES_TEMPLATE_PATH = join(dirname(import.meta.dir), "templates", ".features.yml");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeatureStatus =
  | "backlog"
  | "planned"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "cancelled";

export type Priority = "critical" | "high" | "medium" | "low" | "wishlist";

export type Difficulty = "trivial" | "easy" | "medium" | "hard" | "very_hard";

export interface Subtask {
  id: string;
  title: string;
  description: string;
  status: FeatureStatus;
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
  subtasks: Subtask[];
}

export interface Feature {
  id: string;
  title: string;
  description: string;
  status: FeatureStatus;
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
  subtasks: Subtask[];
}

export interface FeaturesFile {
  version: string;
  meta: {
    created_at: string;
    updated_at: string;
    project: string;
    generator: string;
    maintainer: string;
  };
  features: Feature[];
  archive: Feature[];
}

// Priority ordering (lower = more important)
const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  wishlist: 4,
};

// Difficulty ordering (lower = easier)
const DIFFICULTY_ORDER: Record<Difficulty, number> = {
  trivial: 0,
  easy: 1,
  medium: 2,
  hard: 3,
  very_hard: 4,
};

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
// Features File Existence Guard
// ---------------------------------------------------------------------------

/**
 * Prompt the user with a yes/no question via stdin.
 */
function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

/**
 * Ensure the features file exists before any command that needs it.
 * If the file is missing, prompt the user to generate one from the template.
 */
export async function ensureFeaturesFile(
  projectRoot: string,
  config: WomboConfig
): Promise<void> {
  const filePath = resolve(projectRoot, config.featuresFile);

  if (existsSync(filePath)) return;

  console.log(`\nFeatures file not found: ${config.featuresFile}`);

  const generate = await promptYesNo(
    "Generate a new features file from template? (y/N): "
  );

  if (!generate) {
    console.error(
      `Cannot proceed without a features file. Create one manually or run again and accept the prompt.`
    );
    process.exit(1);
  }

  // Read template, update timestamps, write to project root
  const template = readFileSync(FEATURES_TEMPLATE_PATH, "utf-8");
  const now = new Date().toISOString();
  const content = template
    .replace(/created_at:\s*".*?"/, `created_at: "${now}"`)
    .replace(/updated_at:\s*".*?"/, `updated_at: "${now}"`);

  writeFileSync(filePath, content, "utf-8");
  console.log(`Created ${config.featuresFile} from template.\n`);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and parse the features YAML file from the project root.
 * Uses config.featuresFile for the file path.
 */
export function loadFeatures(
  projectRoot: string,
  config: WomboConfig
): FeaturesFile {
  const filePath = resolve(projectRoot, config.featuresFile);
  const raw = readFileSync(filePath, "utf-8");

  let parsed: FeaturesFile;
  try {
    parsed = parseYaml(raw) as FeaturesFile;
  } catch (err: any) {
    const reason = err?.message ?? String(err);
    throw new Error(
      `Failed to parse ${config.featuresFile}: ${reason}`
    );
  }

  // Validate basic schema: parsed must be an object with features as array (or null)
  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    throw new Error(
      `Invalid ${config.featuresFile}: file must contain a YAML mapping with a "features" key, ` +
      `but got ${parsed === null ? "null" : typeof parsed}.`
    );
  }

  if (
    parsed.features !== null &&
    parsed.features !== undefined &&
    !Array.isArray(parsed.features)
  ) {
    throw new Error(
      `Invalid ${config.featuresFile}: "features" must be a list (array), ` +
      `but got ${typeof parsed.features}. Check the file structure.`
    );
  }

  if (
    parsed.archive !== null &&
    parsed.archive !== undefined &&
    !Array.isArray(parsed.archive)
  ) {
    throw new Error(
      `Invalid ${config.featuresFile}: "archive" must be a list (array), ` +
      `but got ${typeof parsed.archive}. Check the file structure.`
    );
  }

  // Normalize: ensure top-level arrays are never null/undefined (YAML parses
  // empty keys as null).
  parsed.features = parsed.features ?? [];
  parsed.archive = parsed.archive ?? [];

  for (const f of [...parsed.features, ...parsed.archive]) {
    normalizeFeature(f);
  }

  return parsed;
}

/**
 * Save the features file back to disk (for management commands).
 * Before writing:
 *   1. Creates a timestamped backup of the existing file
 *   2. Rotates old backups to keep only the last N (config.backup.maxBackups)
 *   3. Writes atomically via tmp file + rename (like saveState)
 */
export function saveFeatures(
  projectRoot: string,
  config: WomboConfig,
  data: FeaturesFile
): void {
  const filePath = resolve(projectRoot, config.featuresFile);

  // --- Backup existing file before overwriting ---
  if (existsSync(filePath)) {
    createTimestampedBackup(filePath, config.backup.maxBackups);
  }

  // --- Atomic write: serialize → tmp file → rename ---
  data.meta.updated_at = new Date().toISOString();
  const yaml = stringifyYaml(data, {
    lineWidth: 120,
    defaultKeyType: "PLAIN",
    defaultStringType: "PLAIN",
  });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, yaml, "utf-8");
  renameSync(tmp, filePath);
}

/**
 * Create a timestamped backup of the features file and rotate old backups.
 * Backup filename format: .features.yml.YYYY-MM-DDTHH-MM-SS.bak
 */
function createTimestampedBackup(filePath: string, maxBackups: number): void {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "");
  const backupName = `${base}.${timestamp}.bak`;
  const backupPath = join(dir, backupName);

  // Copy current file to timestamped backup
  copyFileSync(filePath, backupPath);

  // Rotate: keep only the last N backups
  rotateBackups(dir, base, maxBackups);
}

/**
 * Remove old backup files, keeping only the most recent `maxBackups`.
 * Backups are sorted lexicographically by filename (timestamps sort naturally).
 */
function rotateBackups(dir: string, baseName: string, maxBackups: number): void {
  if (maxBackups <= 0) {
    // maxBackups === 0 means keep none — delete all backups
    const pattern = new RegExp(
      `^${escapeRegExp(baseName)}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.bak$`
    );
    const entries = readdirSync(dir).filter((f) => pattern.test(f));
    for (const entry of entries) {
      unlinkSync(join(dir, entry));
    }
    return;
  }

  const pattern = new RegExp(
    `^${escapeRegExp(baseName)}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.bak$`
  );
  const backups = readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort(); // lexicographic sort works because ISO timestamps sort naturally

  while (backups.length > maxBackups) {
    const oldest = backups.shift()!;
    unlinkSync(join(dir, oldest));
  }
}

/**
 * Escape a string for use in a RegExp.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeFeature(f: Feature | Subtask): void {
  f.depends_on = f.depends_on ?? [];
  f.constraints = f.constraints ?? [];
  f.forbidden = f.forbidden ?? [];
  f.references = f.references ?? [];
  f.notes = f.notes ?? [];
  f.subtasks = f.subtasks ?? [];
  for (const s of f.subtasks) {
    normalizeFeature(s);
  }
}

// ---------------------------------------------------------------------------
// Dependency Resolution
// ---------------------------------------------------------------------------

/**
 * Get all feature IDs that are done (status === "done" or completion === 100).
 */
function getDoneIds(features: Feature[], archive: Feature[]): Set<string> {
  const done = new Set<string>();
  const collectDone = (items: (Feature | Subtask)[]) => {
    for (const item of items) {
      if (item.status === "done" || item.completion === 100) {
        done.add(item.id);
      }
      if (item.subtasks?.length) {
        collectDone(item.subtasks);
      }
    }
  };
  collectDone(features);
  collectDone(archive);
  return done;
}

/**
 * Check if a feature's dependencies are all satisfied.
 */
export function areDependenciesMet(
  feature: Feature,
  doneIds: Set<string>
): boolean {
  return feature.depends_on.every((dep) => doneIds.has(dep));
}

/**
 * Get all features that are ready to start (backlog + deps met).
 */
export function getReadyFeatures(data: FeaturesFile): Feature[] {
  const doneIds = getDoneIds(data.features, data.archive);
  return data.features.filter(
    (f) =>
      f.status === "backlog" &&
      f.completion === 0 &&
      areDependenciesMet(f, doneIds)
  );
}

/**
 * Get done IDs (exported for use in selection error messages).
 */
export function getDoneFeatureIds(data: FeaturesFile): Set<string> {
  return getDoneIds(data.features, data.archive);
}

// ---------------------------------------------------------------------------
// Selection Strategies
// ---------------------------------------------------------------------------

export interface SelectionOptions {
  /** Select top N by priority (highest priority first, then lowest effort) */
  topPriority?: number;
  /** Select N quickest wins (lowest effort first) */
  quickestWins?: number;
  /** Select all features matching this priority level */
  priority?: Priority;
  /** Select all features matching this difficulty level */
  difficulty?: Difficulty;
  /** Select specific feature IDs (comma-separated) */
  featureIds?: string[];
  /** Select all ready features */
  allReady?: boolean;
}

/**
 * Select features based on the given strategy.
 * Always filters to only ready features (backlog + deps met) first.
 */
export function selectFeatures(
  data: FeaturesFile,
  options: SelectionOptions
): Feature[] {
  const ready = getReadyFeatures(data);

  if (options.allReady) {
    return sortByPriorityThenEffort(ready);
  }

  if (options.featureIds?.length) {
    const idSet = new Set(options.featureIds);
    const selected = ready.filter((f) => idSet.has(f.id));
    const missing = options.featureIds.filter(
      (id) => !selected.find((f) => f.id === id)
    );
    if (missing.length) {
      const allIds = data.features.map((f) => f.id);
      const doneIds = getDoneIds(data.features, data.archive);
      for (const m of missing) {
        if (!allIds.includes(m)) {
          console.error(`  Feature "${m}" does not exist in the features file`);
        } else {
          const feat = data.features.find((f) => f.id === m)!;
          console.error(
            `  Feature "${m}" is not ready (status: ${feat.status}, deps met: ${areDependenciesMet(feat, doneIds)})`
          );
        }
      }
    }
    return sortByPriorityThenEffort(selected);
  }

  if (options.priority) {
    return sortByPriorityThenEffort(
      ready.filter((f) => f.priority === options.priority)
    );
  }

  if (options.difficulty) {
    return sortByEffort(ready.filter((f) => f.difficulty === options.difficulty));
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

// ---------------------------------------------------------------------------
// Sorting Helpers
// ---------------------------------------------------------------------------

function sortByPriorityThenEffort(features: Feature[]): Feature[] {
  return [...features].sort((a, b) => {
    const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pDiff !== 0) return pDiff;
    return parseDurationMinutes(a.effort) - parseDurationMinutes(b.effort);
  });
}

function sortByEffort(features: Feature[]): Feature[] {
  return [...features].sort(
    (a, b) => parseDurationMinutes(a.effort) - parseDurationMinutes(b.effort)
  );
}

// ---------------------------------------------------------------------------
// Utility Exports
// ---------------------------------------------------------------------------

export { PRIORITY_ORDER, DIFFICULTY_ORDER };

/**
 * Get a compact summary of a feature for display.
 */
export function featureSummary(f: Feature): string {
  const effort = formatDuration(parseDurationMinutes(f.effort));
  return `[${f.priority}/${f.difficulty}] ${f.id} -- ${f.title} (${effort})`;
}

/**
 * Recursively search a list of features (and their subtasks) for a matching ID.
 */
function findInList(features: Feature[], id: string): Feature | undefined {
  for (const f of features) {
    if (f.id === id) return f;
    if (f.subtasks?.length) {
      const found = findInList(f.subtasks, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Find a feature or subtask by ID across active features, their subtasks
 * (recursively), and the archive list.
 */
export function findFeatureById(
  data: FeaturesFile,
  id: string
): Feature | undefined {
  return (
    findInList(data.features, id) ??
    (data.archive ? findInList(data.archive, id) : undefined)
  );
}

/**
 * Create a blank feature with all required fields initialized.
 */
export function createBlankFeature(
  id: string,
  title: string,
  description: string = "",
  opts?: {
    priority?: Priority;
    difficulty?: Difficulty;
    effort?: string;
  }
): Feature {
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

/**
 * Get all feature IDs (active + archive), useful for validation.
 */
export function allFeatureIds(data: FeaturesFile): string[] {
  const ids: string[] = [];
  const collect = (items: (Feature | Subtask)[]) => {
    for (const item of items) {
      ids.push(item.id);
      if (item.subtasks?.length) collect(item.subtasks);
    }
  };
  collect(data.features);
  collect(data.archive ?? []);
  return ids;
}
