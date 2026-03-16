/**
 * review-list-types.test.ts — Tests for the ReviewList shared types.
 *
 * Verifies:
 *   - Type constants are defined correctly
 *   - Priority/difficulty/HITL color maps have expected entries
 *   - ReviewItem interface works with realistic data
 *   - ReviewListConfig can be constructed for both genesis and plan
 */

import { describe, test, expect } from "bun:test";
import {
  PRIORITY_ABBREV,
  PRIORITY_COLORS,
  DIFFICULTY_COLORS,
  HITL_COLORS,
  type ReviewItem,
  type ReviewValidationIssue,
  type EditFieldDef,
  type ReviewListConfig,
  type DetailField,
  type DetailSection,
} from "./review-list-types";

// ---------------------------------------------------------------------------
// Constants tests
// ---------------------------------------------------------------------------

describe("PRIORITY_ABBREV", () => {
  test("has all standard priority levels", () => {
    expect(PRIORITY_ABBREV.critical).toBe("CRIT");
    expect(PRIORITY_ABBREV.high).toBe("HIGH");
    expect(PRIORITY_ABBREV.medium).toBe("MED ");
    expect(PRIORITY_ABBREV.low).toBe("LOW ");
    expect(PRIORITY_ABBREV.wishlist).toBe("WISH");
  });
});

describe("PRIORITY_COLORS", () => {
  test("has all standard priority levels", () => {
    expect(PRIORITY_COLORS.critical).toBe("red");
    expect(PRIORITY_COLORS.high).toBe("yellow");
    expect(PRIORITY_COLORS.medium).toBe("white");
    expect(PRIORITY_COLORS.low).toBe("gray");
    expect(PRIORITY_COLORS.wishlist).toBe("gray");
  });
});

describe("DIFFICULTY_COLORS", () => {
  test("has all difficulty levels", () => {
    expect(DIFFICULTY_COLORS.trivial).toBe("gray");
    expect(DIFFICULTY_COLORS.easy).toBe("green");
    expect(DIFFICULTY_COLORS.medium).toBe("white");
    expect(DIFFICULTY_COLORS.hard).toBe("yellow");
    expect(DIFFICULTY_COLORS.very_hard).toBe("red");
  });
});

describe("HITL_COLORS", () => {
  test("has all HITL modes", () => {
    expect(HITL_COLORS.yolo).toBe("green");
    expect(HITL_COLORS.cautious).toBe("yellow");
    expect(HITL_COLORS.supervised).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// ReviewItem shape tests
// ---------------------------------------------------------------------------

describe("ReviewItem", () => {
  test("can be constructed with minimal fields", () => {
    const item: ReviewItem = {
      id: "auth-system",
      title: "Authentication System",
      priority: "high",
      difficulty: "hard",
      dependsOn: [],
      accepted: true,
      detailFields: [],
      detailSections: [],
    };

    expect(item.id).toBe("auth-system");
    expect(item.accepted).toBe(true);
    expect(item.dependsOn).toEqual([]);
  });

  test("can hold detail fields and sections", () => {
    const fields: DetailField[] = [
      { label: "HITL Mode", value: "cautious", color: "yellow" },
      { label: "Effort", value: "4h" },
    ];

    const sections: DetailSection[] = [
      { label: "Constraints", items: ["Use TypeScript", "No new deps"], prefix: "+" },
      { label: "Forbidden", items: ["No jQuery"], prefix: "-" },
    ];

    const item: ReviewItem = {
      id: "test",
      title: "Test",
      priority: "medium",
      difficulty: "easy",
      dependsOn: ["dep-1"],
      accepted: false,
      detailFields: fields,
      detailSections: sections,
    };

    expect(item.detailFields).toHaveLength(2);
    expect(item.detailSections).toHaveLength(2);
    expect(item.detailSections[0].prefix).toBe("+");
    expect(item.dependsOn).toEqual(["dep-1"]);
  });
});

// ---------------------------------------------------------------------------
// ReviewValidationIssue tests
// ---------------------------------------------------------------------------

describe("ReviewValidationIssue", () => {
  test("can represent plan-level issues", () => {
    const issue: ReviewValidationIssue = {
      level: "error",
      message: "Dependency cycle detected",
    };

    expect(issue.level).toBe("error");
    expect(issue.itemId).toBeUndefined();
  });

  test("can represent item-level issues", () => {
    const issue: ReviewValidationIssue = {
      level: "warning",
      itemId: "auth-system",
      message: "This quest has no dependencies",
    };

    expect(issue.itemId).toBe("auth-system");
    expect(issue.level).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// EditFieldDef tests
// ---------------------------------------------------------------------------

describe("EditFieldDef", () => {
  test("text field definition", () => {
    const field: EditFieldDef = {
      key: "title",
      label: "Title",
      type: "text",
    };

    expect(field.type).toBe("text");
  });

  test("select field definition with options", () => {
    const field: EditFieldDef = {
      key: "priority",
      label: "Priority",
      type: "select",
      options: [
        { label: "Critical", value: "critical" },
        { label: "High", value: "high" },
        { label: "Medium", value: "medium" },
      ],
    };

    expect(field.type).toBe("select");
    expect(field.options).toHaveLength(3);
    expect(field.options![0].value).toBe("critical");
  });

  test("textarea field definition", () => {
    const field: EditFieldDef = {
      key: "goal",
      label: "Goal",
      type: "textarea",
      hint: "Edit quest goal (Ctrl+S to submit)",
    };

    expect(field.type).toBe("textarea");
    expect(field.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// ReviewListConfig shape test
// ---------------------------------------------------------------------------

describe("ReviewListConfig", () => {
  test("can be constructed for genesis review", () => {
    const config: ReviewListConfig = {
      title: "Genesis Review",
      subtitle: "Project Decomposition",
      itemLabel: "quest",
      itemLabelPlural: "quests",
      listLabel: "Proposed Quests",
      issues: [{ level: "warning", message: "test warning" }],
      editFields: [{ key: "title", label: "Title", type: "text" }],
      getEditFieldValue: (item, key) => item.title,
      setEditFieldValue: (item, key, value) => ({ ...item, title: value }),
      approveTitle: "Approve Genesis Plan",
      approveBody: (n) => `Create ${n} quests?`,
      onApprove: () => {},
      onCancel: () => {},
      knowledge: "some knowledge",
    };

    expect(config.title).toBe("Genesis Review");
    expect(config.itemLabel).toBe("quest");
    expect(config.approveBody(3)).toBe("Create 3 quests?");
  });

  test("can be constructed for plan review", () => {
    const config: ReviewListConfig = {
      title: "Plan Review",
      subtitle: "Quest: auth-overhaul",
      itemLabel: "task",
      itemLabelPlural: "tasks",
      listLabel: "Proposed Tasks",
      issues: [],
      editFields: [],
      getEditFieldValue: (item, key) => "",
      setEditFieldValue: (item, key, value) => item,
      approveTitle: "Approve Plan",
      approveBody: (n) => `Apply ${n} tasks?`,
      onApprove: () => {},
      onCancel: () => {},
    };

    expect(config.title).toBe("Plan Review");
    expect(config.itemLabel).toBe("task");
  });
});
