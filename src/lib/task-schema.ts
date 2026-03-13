/**
 * task-schema.ts — Single source of truth for task field enums, ordering,
 * required fields, and validation.
 *
 * Every command that needs to validate or enumerate task field values should
 * import from here. No more duplicated VALID_* arrays.
 */

import type { TaskStatus, Priority, Difficulty, Task } from "./tasks.js";
import { parseDurationMinutes } from "./tasks.js";
import { validateId, type ValidationResult } from "./validate.js";

// ---------------------------------------------------------------------------
// Canonical enum arrays (order matters: used for display and sorting)
// ---------------------------------------------------------------------------

export const VALID_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "planned",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "cancelled",
] as const;

export const VALID_PRIORITIES: readonly Priority[] = [
  "critical",
  "high",
  "medium",
  "low",
  "wishlist",
] as const;

export const VALID_DIFFICULTIES: readonly Difficulty[] = [
  "trivial",
  "easy",
  "medium",
  "hard",
  "very_hard",
] as const;

// ---------------------------------------------------------------------------
// Ordering maps (lower = more important / easier)
// ---------------------------------------------------------------------------

export const PRIORITY_ORDER: Readonly<Record<Priority, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  wishlist: 4,
};

export const DIFFICULTY_ORDER: Readonly<Record<Difficulty, number>> = {
  trivial: 0,
  easy: 1,
  medium: 2,
  hard: 3,
  very_hard: 4,
};

// ---------------------------------------------------------------------------
// _meta.yml schema
// ---------------------------------------------------------------------------

export interface MetaSchema {
  version: string;
  meta: {
    created_at: string;
    updated_at: string;
    project: string;
    generator: string;
    maintainer: string;
  };
}

export const META_REQUIRED_FIELDS = ["version", "meta"] as const;
export const META_INNER_REQUIRED_FIELDS = [
  "created_at",
  "updated_at",
  "project",
  "generator",
  "maintainer",
] as const;

// ---------------------------------------------------------------------------
// Task schema — required fields and array-defaulted fields
// ---------------------------------------------------------------------------

export const TASK_REQUIRED_FIELDS = ["id", "title", "status"] as const;

/** Fields that must be arrays; YAML may parse absent values as null */
export const TASK_ARRAY_FIELDS = [
  "depends_on",
  "constraints",
  "forbidden",
  "references",
  "notes",
  "subtasks",
] as const;

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface SchemaIssue {
  level: "error" | "warning";
  taskId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Validate a single task object
// ---------------------------------------------------------------------------

/**
 * Validate a task against the schema. Returns a list of issues (errors and
 * warnings). Does NOT throw — callers decide how to handle issues.
 *
 * Checks:
 *   - Required fields: id, title, status
 *   - id format (kebab-case via validateId)
 *   - status is a valid enum
 *   - priority is a valid enum (if present)
 *   - difficulty is a valid enum (if present)
 *   - effort is a parseable ISO 8601 duration (warning if not)
 *   - completion is 0-100 (warning if out of range)
 *   - depends_on entries are strings (structural check only; cross-ref is
 *     done by check.ts which has access to the full task set)
 */
export function validateTask(task: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const t = task as Record<string, unknown>;
  const id = typeof t?.id === "string" ? t.id : "<unknown>";

  // Required fields
  for (const field of TASK_REQUIRED_FIELDS) {
    if (!t?.[field]) {
      issues.push({ level: "error", taskId: id, message: `Missing required field: ${field}` });
    }
  }

  // id format
  if (typeof t?.id === "string") {
    const idResult: ValidationResult = validateId(t.id, "Task ID");
    if (!idResult.valid) {
      issues.push({ level: "error", taskId: id, message: idResult.error! });
    }
  }

  // status enum
  if (t?.status && !(VALID_STATUSES as readonly string[]).includes(t.status as string)) {
    issues.push({ level: "error", taskId: id, message: `Invalid status: "${t.status}"` });
  }

  // priority enum
  if (t?.priority && !(VALID_PRIORITIES as readonly string[]).includes(t.priority as string)) {
    issues.push({ level: "error", taskId: id, message: `Invalid priority: "${t.priority}"` });
  }

  // difficulty enum
  if (t?.difficulty && !(VALID_DIFFICULTIES as readonly string[]).includes(t.difficulty as string)) {
    issues.push({ level: "error", taskId: id, message: `Invalid difficulty: "${t.difficulty}"` });
  }

  // effort duration
  if (typeof t?.effort === "string" && t.effort.length > 0) {
    const minutes = parseDurationMinutes(t.effort);
    if (minutes === Infinity) {
      issues.push({ level: "warning", taskId: id, message: `Unparseable effort duration: "${t.effort}"` });
    }
  } else if (!t?.effort || t.effort === "PT0S") {
    issues.push({ level: "warning", taskId: id, message: "No effort estimate" });
  }

  // completion range
  if (typeof t?.completion === "number" && (t.completion < 0 || t.completion > 100)) {
    issues.push({ level: "warning", taskId: id, message: `Completion ${t.completion} is out of range 0-100` });
  }

  // depends_on structural check
  if (t?.depends_on != null && !Array.isArray(t.depends_on)) {
    issues.push({ level: "error", taskId: id, message: "depends_on must be an array" });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Validate _meta.yml
// ---------------------------------------------------------------------------

/**
 * Validate a parsed _meta.yml object. Returns issues.
 */
export function validateMeta(meta: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const m = meta as Record<string, unknown>;
  const id = "_meta.yml";

  if (!m?.version) {
    issues.push({ level: "error", taskId: id, message: "Missing required field: version" });
  }

  if (!m?.meta || typeof m.meta !== "object") {
    issues.push({ level: "error", taskId: id, message: "Missing required field: meta" });
    return issues; // Can't check inner fields
  }

  const inner = m.meta as Record<string, unknown>;
  for (const field of META_INNER_REQUIRED_FIELDS) {
    if (!inner[field]) {
      issues.push({ level: "warning", taskId: id, message: `Missing meta field: ${field}` });
    }
  }

  return issues;
}
