/**
 * tasks/check.ts — Validate the tasks file for schema issues, broken deps, and orphans.
 *
 * Usage:
 *   woco tasks check
 *
 * Checks:
 *   - Required fields present on every task
 *   - No duplicate IDs
 *   - All depends_on references point to existing tasks
 *   - No circular dependencies
 *   - No orphaned subtasks (subtask IDs unique)
 *   - Priority/difficulty values are valid enums
 *   - Effort strings are parseable ISO 8601 durations
 */

import type { WomboConfig } from "../../config.js";
import {
  loadFeatures,
  allFeatureIds,
  parseDurationMinutes,
  type Feature,
  type Subtask,
  type FeaturesFile,
  type Priority,
  type Difficulty,
  type FeatureStatus,
} from "../../lib/tasks.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TasksCheckOptions {
  projectRoot: string;
  config: WomboConfig;
}

interface CheckResult {
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_STATUSES: FeatureStatus[] = [
  "backlog", "planned", "in_progress", "blocked", "in_review", "done", "cancelled",
];

const VALID_PRIORITIES: Priority[] = ["critical", "high", "medium", "low", "wishlist"];

const VALID_DIFFICULTIES: Difficulty[] = ["trivial", "easy", "medium", "hard", "very_hard"];

function collectAllItems(data: FeaturesFile): (Feature | Subtask)[] {
  const items: (Feature | Subtask)[] = [];
  const collect = (list: (Feature | Subtask)[]) => {
    for (const item of list) {
      items.push(item);
      if (item.subtasks?.length) collect(item.subtasks);
    }
  };
  collect(data.tasks ?? []);
  collect(data.archive ?? []);
  return items;
}

function checkTasks(data: FeaturesFile): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const allItems = collectAllItems(data);
  const allIds = allItems.map((i) => i.id);
  const idSet = new Set<string>();

  // Check for duplicates
  for (const id of allIds) {
    if (idSet.has(id)) {
      errors.push(`Duplicate ID: "${id}"`);
    }
    idSet.add(id);
  }

  // Check each item
  for (const item of allItems) {
    const prefix = `[${item.id}]`;

    // Required fields
    if (!item.id) errors.push(`${prefix} Missing required field: id`);
    if (!item.title) errors.push(`${prefix} Missing required field: title`);
    if (!item.status) errors.push(`${prefix} Missing required field: status`);

    // Validate enum values
    if (item.status && !VALID_STATUSES.includes(item.status)) {
      errors.push(`${prefix} Invalid status: "${item.status}"`);
    }
    if (item.priority && !VALID_PRIORITIES.includes(item.priority)) {
      errors.push(`${prefix} Invalid priority: "${item.priority}"`);
    }
    if (item.difficulty && !VALID_DIFFICULTIES.includes(item.difficulty)) {
      errors.push(`${prefix} Invalid difficulty: "${item.difficulty}"`);
    }

    // Validate effort
    if (item.effort) {
      const minutes = parseDurationMinutes(item.effort);
      if (minutes === Infinity) {
        warnings.push(`${prefix} Unparseable effort duration: "${item.effort}"`);
      }
    }

    // Check depends_on references
    if (item.depends_on?.length) {
      for (const dep of item.depends_on) {
        if (!idSet.has(dep)) {
          errors.push(`${prefix} Broken dependency: "${dep}" does not exist`);
        }
      }
    }
  }

  // Check for circular dependencies (simple DFS)
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const depMap = new Map<string, string[]>();
  for (const item of allItems) {
    depMap.set(item.id, item.depends_on ?? []);
  }

  function hasCycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of depMap.get(id) ?? []) {
      if (hasCycle(dep)) {
        errors.push(`Circular dependency detected involving: "${id}" → "${dep}"`);
        return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const id of idSet) {
    hasCycle(id);
  }

  // Warn about features with no effort estimate
  for (const item of allItems) {
    if (!item.effort || item.effort === "PT0S") {
      warnings.push(`[${item.id}] No effort estimate`);
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdTasksCheck(opts: TasksCheckOptions): Promise<void> {
  const { projectRoot, config } = opts;

  const data = loadFeatures(projectRoot, config);
  const result = checkTasks(data);

  const allItems = collectAllItems(data);
  console.log(`\nChecking ${config.tasksFile} (${allItems.length} items)...\n`);

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log("  All checks passed. No issues found.");
    return;
  }

  if (result.errors.length > 0) {
    console.log(`  ERRORS (${result.errors.length}):`);
    for (const e of result.errors) {
      console.log(`    \x1b[31m✗\x1b[0m ${e}`);
    }
    console.log("");
  }

  if (result.warnings.length > 0) {
    console.log(`  WARNINGS (${result.warnings.length}):`);
    for (const w of result.warnings) {
      console.log(`    \x1b[33m⚠\x1b[0m ${w}`);
    }
    console.log("");
  }

  if (result.errors.length > 0) {
    process.exit(1);
  }
}
