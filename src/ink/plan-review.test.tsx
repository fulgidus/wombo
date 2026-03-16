/**
 * plan-review.test.tsx — Tests for the plan review adapter.
 *
 * Verifies:
 *   - taskToReviewItem maps ProposedTask → ReviewItem correctly
 *   - reviewItemToTask maps ReviewItem back to ProposedTask
 *   - buildPlanConfig creates correct ReviewListConfig
 *   - Edit fields include title, priority, difficulty, depends_on, description
 *   - getEditFieldValue / setEditFieldValue work for all fields
 *   - Detail fields include effort
 *   - Detail sections include description, constraints, forbidden, references, notes, agent
 *   - Validation issues map taskId → itemId
 *   - PlanReviewApp renders without error
 */

import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import {
  taskToReviewItem,
  reviewItemToTask,
  buildPlanConfig,
  PLAN_EDIT_FIELDS,
  PlanReviewApp,
} from "./plan-review";
import type { ReviewItem } from "./review-list-types";
import type { ProposedTask, PlanResult, PlanValidationIssue } from "../lib/quest-planner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<ProposedTask>): ProposedTask {
  return {
    id: "setup-auth-db",
    title: "Setup Auth Database",
    description: "Create the auth database schema",
    priority: "medium",
    difficulty: "easy",
    effort: "2h",
    depends_on: [],
    constraints: [],
    forbidden: [],
    references: [],
    notes: [],
    ...overrides,
  };
}

function makePlanResult(overrides?: Partial<PlanResult>): PlanResult {
  return {
    success: true,
    tasks: [makeTask()],
    knowledge: "Some planner knowledge",
    issues: [],
    rawOutput: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// taskToReviewItem
// ---------------------------------------------------------------------------

describe("taskToReviewItem", () => {
  test("maps basic task fields correctly", () => {
    const task = makeTask({
      id: "my-task",
      title: "My Task",
      priority: "high",
      difficulty: "hard",
    });

    const item = taskToReviewItem(task);

    expect(item.id).toBe("my-task");
    expect(item.title).toBe("My Task");
    expect(item.priority).toBe("high");
    expect(item.difficulty).toBe("hard");
    expect(item.accepted).toBe(true);
  });

  test("maps depends_on to dependsOn", () => {
    const task = makeTask({ depends_on: ["dep-1", "dep-2"] });
    const item = taskToReviewItem(task);

    expect(item.dependsOn).toEqual(["dep-1", "dep-2"]);
  });

  test("includes effort in detail fields", () => {
    const task = makeTask({ effort: "4h" });
    const item = taskToReviewItem(task);

    const effortField = item.detailFields.find((f: { label: string }) => f.label.includes("Effort"));
    expect(effortField).toBeDefined();
    expect(effortField!.value).toBe("4h");
  });

  test("includes description in detail sections", () => {
    const task = makeTask({ description: "Build the auth module" });
    const item = taskToReviewItem(task);

    const section = item.detailSections.find((s: { label: string }) => s.label === "Description");
    expect(section).toBeDefined();
    expect(section!.items).toEqual(["Build the auth module"]);
  });

  test("includes constraints in detail sections with + prefix", () => {
    const task = makeTask({ constraints: ["Use TypeScript", "No eval"] });
    const item = taskToReviewItem(task);

    const section = item.detailSections.find((s: { label: string }) => s.label === "Constraints");
    expect(section).toBeDefined();
    expect(section!.items).toEqual(["Use TypeScript", "No eval"]);
    expect(section!.prefix).toBe("+");
  });

  test("includes forbidden in detail sections with - prefix", () => {
    const task = makeTask({ forbidden: ["eval", "any"] });
    const item = taskToReviewItem(task);

    const section = item.detailSections.find((s: { label: string }) => s.label === "Forbidden");
    expect(section).toBeDefined();
    expect(section!.items).toEqual(["eval", "any"]);
    expect(section!.prefix).toBe("-");
  });

  test("includes references in detail sections", () => {
    const task = makeTask({ references: ["src/auth.ts", "docs/auth.md"] });
    const item = taskToReviewItem(task);

    const section = item.detailSections.find((s: { label: string }) => s.label === "References");
    expect(section).toBeDefined();
    expect(section!.items).toEqual(["src/auth.ts", "docs/auth.md"]);
  });

  test("includes notes in detail sections", () => {
    const task = makeTask({ notes: ["Note 1", "Note 2"] });
    const item = taskToReviewItem(task);

    const section = item.detailSections.find((s: { label: string }) => s.label === "Notes");
    expect(section).toBeDefined();
    expect(section!.items).toEqual(["Note 1", "Note 2"]);
  });

  test("includes agent in detail sections when present", () => {
    const task = makeTask({ agent: "claude-opus" });
    const item = taskToReviewItem(task);

    const section = item.detailSections.find((s: { label: string }) => s.label === "Agent");
    expect(section).toBeDefined();
    expect(section!.items).toEqual(["claude-opus"]);
  });

  test("omits agent section when not present", () => {
    const task = makeTask({ agent: undefined });
    const item = taskToReviewItem(task);

    const section = item.detailSections.find((s: { label: string }) => s.label === "Agent");
    expect(section).toBeDefined();
    expect(section!.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reviewItemToTask
// ---------------------------------------------------------------------------

describe("reviewItemToTask", () => {
  test("maps basic item fields back to task", () => {
    const task = makeTask();
    const item = taskToReviewItem(task);
    const result = reviewItemToTask(item, task);

    expect(result.id).toBe(task.id);
    expect(result.title).toBe(task.title);
    expect(result.priority).toBe(task.priority);
    expect(result.difficulty).toBe(task.difficulty);
    expect(result.depends_on).toEqual(task.depends_on);
  });

  test("preserves edited title", () => {
    const task = makeTask({ title: "Original" });
    const item = taskToReviewItem(task);
    item.title = "Edited Title";
    const result = reviewItemToTask(item, task);

    expect(result.title).toBe("Edited Title");
  });

  test("preserves fields from original task that aren't on ReviewItem", () => {
    const task = makeTask({
      description: "Important description",
      effort: "8h",
      constraints: ["TypeScript only"],
    });
    const item = taskToReviewItem(task);
    const result = reviewItemToTask(item, task);

    expect(result.description).toBe("Important description");
    expect(result.effort).toBe("8h");
    expect(result.constraints).toEqual(["TypeScript only"]);
  });
});

// ---------------------------------------------------------------------------
// PLAN_EDIT_FIELDS
// ---------------------------------------------------------------------------

describe("PLAN_EDIT_FIELDS", () => {
  test("has 5 edit fields", () => {
    expect(PLAN_EDIT_FIELDS).toHaveLength(5);
  });

  test("includes title, priority, difficulty, depends_on, description", () => {
    const keys = PLAN_EDIT_FIELDS.map((f: { key: string }) => f.key);
    expect(keys).toContain("title");
    expect(keys).toContain("priority");
    expect(keys).toContain("difficulty");
    expect(keys).toContain("depends_on");
    expect(keys).toContain("description");
  });

  test("priority field has select type with 5 options", () => {
    const field = PLAN_EDIT_FIELDS.find((f: { key: string }) => f.key === "priority");
    expect(field!.type).toBe("select");
    expect(field!.options).toHaveLength(5);
  });

  test("difficulty field has select type with 5 options", () => {
    const field = PLAN_EDIT_FIELDS.find((f: { key: string }) => f.key === "difficulty");
    expect(field!.type).toBe("select");
    expect(field!.options).toHaveLength(5);
  });

  test("description field has textarea type", () => {
    const field = PLAN_EDIT_FIELDS.find((f: { key: string }) => f.key === "description");
    expect(field!.type).toBe("textarea");
  });
});

// ---------------------------------------------------------------------------
// buildPlanConfig
// ---------------------------------------------------------------------------

describe("buildPlanConfig", () => {
  test("creates config with correct labels", () => {
    const result = makePlanResult();
    const config = buildPlanConfig(
      "auth-quest",
      "Auth Overhaul",
      result,
      () => {},
      () => {}
    );

    expect(config.title).toBe("Plan Review");
    expect(config.itemLabel).toBe("task");
    expect(config.itemLabelPlural).toBe("tasks");
    expect(config.listLabel).toBe("Proposed Tasks");
  });

  test("includes quest info in subtitle", () => {
    const result = makePlanResult();
    const config = buildPlanConfig(
      "auth-quest",
      "Auth Overhaul",
      result,
      () => {},
      () => {}
    );

    expect(config.subtitle).toContain("auth-quest");
  });

  test("maps plan validation issues to config issues", () => {
    const result = makePlanResult({
      issues: [
        { level: "error", taskId: "t1", message: "Bad task" },
        { level: "warning", message: "Minor issue" },
      ],
    });
    const config = buildPlanConfig("q", "Q", result, () => {}, () => {});

    expect(config.issues).toHaveLength(2);
    expect(config.issues[0].itemId).toBe("t1");
    expect(config.issues[0].message).toBe("Bad task");
    expect(config.issues[1].itemId).toBeUndefined();
  });

  test("passes knowledge to config", () => {
    const result = makePlanResult({ knowledge: "Scout data" });
    const config = buildPlanConfig("q", "Q", result, () => {}, () => {});

    expect(config.knowledge).toBe("Scout data");
  });

  test("getEditFieldValue returns correct values", () => {
    const task = makeTask({
      title: "Auth",
      priority: "high",
      difficulty: "hard",
      depends_on: ["dep-a"],
      description: "Build auth",
    });
    const result = makePlanResult({ tasks: [task] });
    const config = buildPlanConfig("q", "Q", result, () => {}, () => {});

    const item = taskToReviewItem(task);

    expect(config.getEditFieldValue(item, "title")).toBe("Auth");
    expect(config.getEditFieldValue(item, "priority")).toBe("high");
    expect(config.getEditFieldValue(item, "difficulty")).toBe("hard");
    expect(config.getEditFieldValue(item, "depends_on")).toBe("dep-a");
    expect(config.getEditFieldValue(item, "description")).toBe("Build auth");
  });

  test("setEditFieldValue updates title", () => {
    const task = makeTask({ title: "Old" });
    const result = makePlanResult({ tasks: [task] });
    const config = buildPlanConfig("q", "Q", result, () => {}, () => {});

    const item = taskToReviewItem(task);
    const updated = config.setEditFieldValue(item, "title", "New Title");

    expect(updated.title).toBe("New Title");
  });

  test("setEditFieldValue updates priority", () => {
    const task = makeTask({ priority: "medium" });
    const result = makePlanResult({ tasks: [task] });
    const config = buildPlanConfig("q", "Q", result, () => {}, () => {});

    const item = taskToReviewItem(task);
    const updated = config.setEditFieldValue(item, "priority", "critical");

    expect(updated.priority).toBe("critical");
  });

  test("setEditFieldValue updates depends_on from comma-separated string", () => {
    const task = makeTask({ depends_on: [] });
    const result = makePlanResult({ tasks: [task] });
    const config = buildPlanConfig("q", "Q", result, () => {}, () => {});

    const item = taskToReviewItem(task);
    const updated = config.setEditFieldValue(item, "depends_on", "dep-a, dep-b");

    expect(updated.dependsOn).toEqual(["dep-a", "dep-b"]);
  });

  test("onApprove callback receives ProposedTask array", () => {
    const task = makeTask({ id: "test-t" });
    const result = makePlanResult({ tasks: [task] });
    const onApprove = mock((_tasks: ProposedTask[], _knowledge: string | null) => {});
    const config = buildPlanConfig("q", "Q", result, onApprove, () => {});

    const items = [taskToReviewItem(task)];
    config.onApprove(items);

    expect(onApprove).toHaveBeenCalledTimes(1);
    const [tasks, knowledge] = onApprove.mock.calls[0];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("test-t");
  });

  test("onCancel callback fires correctly", () => {
    const result = makePlanResult();
    const onCancel = mock(() => {});
    const config = buildPlanConfig("q", "Q", result, () => {}, onCancel);

    config.onCancel();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PlanReviewApp (static rendering)
// ---------------------------------------------------------------------------

describe("PlanReviewApp", () => {
  test("renders without crashing", () => {
    const result = makePlanResult();

    const output = renderToString(
      <PlanReviewApp
        questId="auth-quest"
        questTitle="Auth Overhaul"
        planResult={result}
        onApprove={() => {}}
        onCancel={() => {}}
      />
    );

    expect(output).toContain("Plan Review");
  });

  test("renders task IDs in the list", () => {
    const result = makePlanResult({
      tasks: [
        makeTask({ id: "setup-auth" }),
        makeTask({ id: "user-model" }),
      ],
    });

    const output = renderToString(
      <PlanReviewApp
        questId="auth-quest"
        questTitle="Auth Overhaul"
        planResult={result}
        onApprove={() => {}}
        onCancel={() => {}}
      />
    );

    expect(output).toContain("setup-auth");
    expect(output).toContain("user-model");
  });

  test("shows Proposed Tasks label", () => {
    const result = makePlanResult();

    const output = renderToString(
      <PlanReviewApp
        questId="auth-quest"
        questTitle="Auth Overhaul"
        planResult={result}
        onApprove={() => {}}
        onCancel={() => {}}
      />
    );

    expect(output).toContain("Proposed Tasks");
  });
});
