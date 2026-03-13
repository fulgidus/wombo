/**
 * task-schema.test.ts — Unit tests for task-schema.ts validation functions.
 *
 * Coverage:
 *   - validateTask with valid tasks, missing required fields, invalid enums
 *   - validateMeta with valid meta, missing fields, missing inner fields
 *   - VALID_STATUSES, VALID_PRIORITIES, VALID_DIFFICULTIES enums
 *   - PRIORITY_ORDER, DIFFICULTY_ORDER maps
 *   - TASK_REQUIRED_FIELDS, TASK_ARRAY_FIELDS, META_REQUIRED_FIELDS
 *   - SchemaIssue level classification (error vs warning)
 */

import { describe, test, expect } from "bun:test";
import {
  validateTask,
  validateMeta,
  VALID_STATUSES,
  VALID_PRIORITIES,
  VALID_DIFFICULTIES,
  PRIORITY_ORDER,
  DIFFICULTY_ORDER,
  TASK_REQUIRED_FIELDS,
  TASK_ARRAY_FIELDS,
  META_REQUIRED_FIELDS,
  META_INNER_REQUIRED_FIELDS,
} from "../src/lib/task-schema.js";
import type { SchemaIssue } from "../src/lib/task-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidTask(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "my-task",
    title: "My Task",
    description: "A valid test task",
    status: "backlog",
    completion: 0,
    difficulty: "medium",
    priority: "medium",
    depends_on: [],
    effort: "PT1H",
    started_at: null,
    ended_at: null,
    constraints: [],
    forbidden: [],
    references: [],
    notes: [],
    subtasks: [],
    ...overrides,
  };
}

function makeValidMeta(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "1.0",
    meta: {
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
      project: "test-project",
      generator: "wombo-combo",
      maintainer: "tester",
    },
    ...overrides,
  };
}

function errorMessages(issues: SchemaIssue[]): string[] {
  return issues.filter((i) => i.level === "error").map((i) => i.message);
}

function warningMessages(issues: SchemaIssue[]): string[] {
  return issues.filter((i) => i.level === "warning").map((i) => i.message);
}

// ---------------------------------------------------------------------------
// Enum arrays
// ---------------------------------------------------------------------------

describe("enum arrays", () => {
  test("VALID_STATUSES contains all expected values", () => {
    expect(VALID_STATUSES).toContain("backlog");
    expect(VALID_STATUSES).toContain("planned");
    expect(VALID_STATUSES).toContain("in_progress");
    expect(VALID_STATUSES).toContain("blocked");
    expect(VALID_STATUSES).toContain("in_review");
    expect(VALID_STATUSES).toContain("done");
    expect(VALID_STATUSES).toContain("cancelled");
    expect(VALID_STATUSES).toHaveLength(7);
  });

  test("VALID_PRIORITIES contains all expected values", () => {
    expect(VALID_PRIORITIES).toContain("critical");
    expect(VALID_PRIORITIES).toContain("high");
    expect(VALID_PRIORITIES).toContain("medium");
    expect(VALID_PRIORITIES).toContain("low");
    expect(VALID_PRIORITIES).toContain("wishlist");
    expect(VALID_PRIORITIES).toHaveLength(5);
  });

  test("VALID_DIFFICULTIES contains all expected values", () => {
    expect(VALID_DIFFICULTIES).toContain("trivial");
    expect(VALID_DIFFICULTIES).toContain("easy");
    expect(VALID_DIFFICULTIES).toContain("medium");
    expect(VALID_DIFFICULTIES).toContain("hard");
    expect(VALID_DIFFICULTIES).toContain("very_hard");
    expect(VALID_DIFFICULTIES).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Ordering maps
// ---------------------------------------------------------------------------

describe("ordering maps", () => {
  test("PRIORITY_ORDER assigns ascending values (lower = more important)", () => {
    expect(PRIORITY_ORDER.critical).toBe(0);
    expect(PRIORITY_ORDER.high).toBe(1);
    expect(PRIORITY_ORDER.medium).toBe(2);
    expect(PRIORITY_ORDER.low).toBe(3);
    expect(PRIORITY_ORDER.wishlist).toBe(4);
  });

  test("DIFFICULTY_ORDER assigns ascending values (lower = easier)", () => {
    expect(DIFFICULTY_ORDER.trivial).toBe(0);
    expect(DIFFICULTY_ORDER.easy).toBe(1);
    expect(DIFFICULTY_ORDER.medium).toBe(2);
    expect(DIFFICULTY_ORDER.hard).toBe(3);
    expect(DIFFICULTY_ORDER.very_hard).toBe(4);
  });

  test("every VALID_PRIORITY has an order entry", () => {
    for (const p of VALID_PRIORITIES) {
      expect(PRIORITY_ORDER[p]).toBeDefined();
    }
  });

  test("every VALID_DIFFICULTY has an order entry", () => {
    for (const d of VALID_DIFFICULTIES) {
      expect(DIFFICULTY_ORDER[d]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Required field constants
// ---------------------------------------------------------------------------

describe("field constants", () => {
  test("TASK_REQUIRED_FIELDS includes id, title, status", () => {
    expect(TASK_REQUIRED_FIELDS).toContain("id");
    expect(TASK_REQUIRED_FIELDS).toContain("title");
    expect(TASK_REQUIRED_FIELDS).toContain("status");
  });

  test("TASK_ARRAY_FIELDS includes all array fields", () => {
    expect(TASK_ARRAY_FIELDS).toContain("depends_on");
    expect(TASK_ARRAY_FIELDS).toContain("constraints");
    expect(TASK_ARRAY_FIELDS).toContain("forbidden");
    expect(TASK_ARRAY_FIELDS).toContain("references");
    expect(TASK_ARRAY_FIELDS).toContain("notes");
    expect(TASK_ARRAY_FIELDS).toContain("subtasks");
  });

  test("META_REQUIRED_FIELDS includes version and meta", () => {
    expect(META_REQUIRED_FIELDS).toContain("version");
    expect(META_REQUIRED_FIELDS).toContain("meta");
  });

  test("META_INNER_REQUIRED_FIELDS includes all meta sub-fields", () => {
    expect(META_INNER_REQUIRED_FIELDS).toContain("created_at");
    expect(META_INNER_REQUIRED_FIELDS).toContain("updated_at");
    expect(META_INNER_REQUIRED_FIELDS).toContain("project");
    expect(META_INNER_REQUIRED_FIELDS).toContain("generator");
    expect(META_INNER_REQUIRED_FIELDS).toContain("maintainer");
  });
});

// ---------------------------------------------------------------------------
// validateTask
// ---------------------------------------------------------------------------

describe("validateTask", () => {
  test("returns no issues for a fully valid task", () => {
    const issues = validateTask(makeValidTask());
    const errors = errorMessages(issues);
    expect(errors).toHaveLength(0);
  });

  test("reports error for missing id", () => {
    const task = makeValidTask();
    delete task.id;
    const errors = errorMessages(validateTask(task));
    expect(errors.some((m) => m.includes("id"))).toBe(true);
  });

  test("reports error for missing title", () => {
    const task = makeValidTask();
    delete task.title;
    const errors = errorMessages(validateTask(task));
    expect(errors.some((m) => m.includes("title"))).toBe(true);
  });

  test("reports error for missing status", () => {
    const task = makeValidTask();
    delete task.status;
    const errors = errorMessages(validateTask(task));
    expect(errors.some((m) => m.includes("status"))).toBe(true);
  });

  test("reports error for invalid status enum", () => {
    const issues = validateTask(makeValidTask({ status: "unknown_status" }));
    const errors = errorMessages(issues);
    expect(errors.some((m) => m.includes("Invalid status"))).toBe(true);
    expect(errors.some((m) => m.includes("unknown_status"))).toBe(true);
  });

  test("accepts all valid statuses", () => {
    for (const status of VALID_STATUSES) {
      const issues = validateTask(makeValidTask({ status }));
      const errors = errorMessages(issues);
      expect(errors.filter((m) => m.includes("status"))).toHaveLength(0);
    }
  });

  test("reports error for invalid priority enum", () => {
    const issues = validateTask(makeValidTask({ priority: "ultra-high" }));
    const errors = errorMessages(issues);
    expect(errors.some((m) => m.includes("Invalid priority"))).toBe(true);
  });

  test("accepts all valid priorities", () => {
    for (const priority of VALID_PRIORITIES) {
      const issues = validateTask(makeValidTask({ priority }));
      const errors = errorMessages(issues);
      expect(errors.filter((m) => m.includes("priority"))).toHaveLength(0);
    }
  });

  test("reports error for invalid difficulty enum", () => {
    const issues = validateTask(makeValidTask({ difficulty: "impossible" }));
    const errors = errorMessages(issues);
    expect(errors.some((m) => m.includes("Invalid difficulty"))).toBe(true);
  });

  test("accepts all valid difficulties", () => {
    for (const difficulty of VALID_DIFFICULTIES) {
      const issues = validateTask(makeValidTask({ difficulty }));
      const errors = errorMessages(issues);
      expect(errors.filter((m) => m.includes("difficulty"))).toHaveLength(0);
    }
  });

  test("reports warning for unparseable effort duration", () => {
    const issues = validateTask(makeValidTask({ effort: "not-a-duration" }));
    const warnings = warningMessages(issues);
    expect(warnings.some((m) => m.includes("Unparseable effort duration"))).toBe(true);
  });

  test("reports warning for no effort estimate", () => {
    const issues = validateTask(makeValidTask({ effort: undefined }));
    const warnings = warningMessages(issues);
    expect(warnings.some((m) => m.includes("No effort estimate"))).toBe(true);
  });

  test("does not warn for PT0S effort (parseable but zero)", () => {
    // PT0S is a valid ISO 8601 duration that parses to 0 minutes.
    // The "No effort estimate" branch only triggers when effort is falsy.
    const issues = validateTask(makeValidTask({ effort: "PT0S" }));
    const warnings = warningMessages(issues);
    expect(warnings.filter((m) => m.includes("effort"))).toHaveLength(0);
  });

  test("accepts valid ISO 8601 effort durations", () => {
    for (const effort of ["PT1H", "PT30M", "PT2H30M", "P1D", "P1DT4H"]) {
      const issues = validateTask(makeValidTask({ effort }));
      const warnings = warningMessages(issues);
      expect(warnings.filter((m) => m.includes("effort") || m.includes("duration"))).toHaveLength(0);
    }
  });

  test("reports warning for completion out of range", () => {
    const issuesHigh = validateTask(makeValidTask({ completion: 150 }));
    expect(warningMessages(issuesHigh).some((m) => m.includes("out of range"))).toBe(true);

    const issuesLow = validateTask(makeValidTask({ completion: -10 }));
    expect(warningMessages(issuesLow).some((m) => m.includes("out of range"))).toBe(true);
  });

  test("accepts completion in valid range", () => {
    for (const completion of [0, 50, 100]) {
      const issues = validateTask(makeValidTask({ completion }));
      const warnings = warningMessages(issues);
      expect(warnings.filter((m) => m.includes("out of range"))).toHaveLength(0);
    }
  });

  test("reports error when depends_on is not an array", () => {
    const issues = validateTask(makeValidTask({ depends_on: "some-task" }));
    const errors = errorMessages(issues);
    expect(errors.some((m) => m.includes("depends_on must be an array"))).toBe(true);
  });

  test("accepts depends_on as an array", () => {
    const issues = validateTask(makeValidTask({ depends_on: ["task-a", "task-b"] }));
    const errors = errorMessages(issues);
    expect(errors.filter((m) => m.includes("depends_on"))).toHaveLength(0);
  });

  test("reports error for invalid id format", () => {
    const issues = validateTask(makeValidTask({ id: "UPPERCASE" }));
    const errors = errorMessages(issues);
    expect(errors.some((m) => m.includes("invalid") || m.includes("Invalid") || m.includes("kebab-case"))).toBe(true);
  });

  test("reports error for id with path traversal", () => {
    const issues = validateTask(makeValidTask({ id: "../etc/passwd" }));
    const errors = errorMessages(issues);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("handles null/undefined input gracefully", () => {
    const issues = validateTask(null);
    expect(issues.length).toBeGreaterThan(0);
    const errors = errorMessages(issues);
    expect(errors.some((m) => m.includes("id") || m.includes("title") || m.includes("status"))).toBe(true);
  });

  test("handles empty object", () => {
    const issues = validateTask({});
    const errors = errorMessages(issues);
    // Should report missing id, title, status
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  test("uses task id in SchemaIssue.taskId", () => {
    const issues = validateTask(makeValidTask({ id: "test-id", status: "invalid" }));
    expect(issues.every((i) => i.taskId === "test-id")).toBe(true);
  });

  test("uses <unknown> when task has no id", () => {
    const issues = validateTask({ status: "invalid" });
    expect(issues.some((i) => i.taskId === "<unknown>")).toBe(true);
  });

  test("accumulates multiple issues", () => {
    const issues = validateTask({
      id: "INVALID ID!",
      status: "bogus",
      priority: "ultra",
      difficulty: "impossible",
      completion: 200,
      effort: "not-a-duration",
      depends_on: "not-array",
    });
    // Should have multiple errors and warnings
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// validateMeta
// ---------------------------------------------------------------------------

describe("validateMeta", () => {
  test("returns no issues for a fully valid meta", () => {
    const issues = validateMeta(makeValidMeta());
    const errors = errorMessages(issues);
    expect(errors).toHaveLength(0);
  });

  test("reports error for missing version", () => {
    const meta = makeValidMeta();
    delete meta.version;
    const errors = errorMessages(validateMeta(meta));
    expect(errors.some((m) => m.includes("version"))).toBe(true);
  });

  test("reports error for missing meta block", () => {
    const errors = errorMessages(validateMeta({ version: "1.0" }));
    expect(errors.some((m) => m.includes("meta"))).toBe(true);
  });

  test("reports error for non-object meta block", () => {
    const errors = errorMessages(validateMeta({ version: "1.0", meta: "not-an-object" }));
    expect(errors.some((m) => m.includes("meta"))).toBe(true);
  });

  test("reports warnings for missing inner meta fields", () => {
    const meta = makeValidMeta({ meta: {} });
    const warnings = warningMessages(validateMeta(meta));
    // Should warn about missing created_at, updated_at, project, generator, maintainer
    expect(warnings.length).toBeGreaterThanOrEqual(5);
    expect(warnings.some((m) => m.includes("created_at"))).toBe(true);
    expect(warnings.some((m) => m.includes("updated_at"))).toBe(true);
    expect(warnings.some((m) => m.includes("project"))).toBe(true);
    expect(warnings.some((m) => m.includes("generator"))).toBe(true);
    expect(warnings.some((m) => m.includes("maintainer"))).toBe(true);
  });

  test("uses _meta.yml as taskId in issues", () => {
    const issues = validateMeta({});
    expect(issues.every((i) => i.taskId === "_meta.yml")).toBe(true);
  });

  test("handles null input", () => {
    const issues = validateMeta(null);
    expect(issues.length).toBeGreaterThan(0);
  });

  test("handles empty object", () => {
    const issues = validateMeta({});
    const errors = errorMessages(issues);
    expect(errors.some((m) => m.includes("version"))).toBe(true);
    expect(errors.some((m) => m.includes("meta"))).toBe(true);
  });

  test("early returns when meta block is missing (can't check inner fields)", () => {
    // When meta is missing, we get errors for version + meta but no warnings
    // for inner fields because we can't check them
    const issues = validateMeta({ version: "1.0" });
    const errors = errorMessages(issues);
    const warnings = warningMessages(issues);
    expect(errors.some((m) => m.includes("meta"))).toBe(true);
    expect(warnings.filter((m) => m.includes("created_at"))).toHaveLength(0);
  });
});
