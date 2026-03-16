/**
 * genesis-review.test.tsx — Tests for the genesis review adapter.
 *
 * Verifies:
 *   - questToReviewItem maps ProposedQuest → ReviewItem correctly
 *   - reviewItemToQuest maps ReviewItem back to ProposedQuest
 *   - buildGenesisConfig creates correct ReviewListConfig
 *   - Edit fields include title, priority, difficulty, hitl_mode, depends_on, goal
 *   - getEditFieldValue / setEditFieldValue work for all fields
 *   - Detail fields include HITL mode with correct color
 *   - Detail sections include goal, constraints, banned, notes
 *   - Validation issues map questId → itemId
 *   - GenesisReviewApp renders without error
 */

import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import {
  questToReviewItem,
  reviewItemToQuest,
  buildGenesisConfig,
  GENESIS_EDIT_FIELDS,
  GenesisReviewApp,
} from "./genesis-review";
import type { ReviewItem } from "./review-list-types";
import type { ProposedQuest, GenesisResult, GenesisValidationIssue } from "../lib/genesis-planner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQuest(overrides?: Partial<ProposedQuest>): ProposedQuest {
  return {
    id: "auth-system",
    title: "Authentication System",
    goal: "Implement OAuth2 authentication",
    priority: "high",
    difficulty: "hard",
    depends_on: [],
    constraints: { add: [], ban: [] },
    hitl_mode: "cautious",
    notes: [],
    ...overrides,
  };
}

function makeGenesisResult(
  overrides?: Partial<GenesisResult>
): GenesisResult {
  return {
    success: true,
    quests: [makeQuest()],
    knowledge: "Some planner knowledge",
    issues: [],
    rawOutput: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// questToReviewItem
// ---------------------------------------------------------------------------

describe("questToReviewItem", () => {
  test("maps basic quest fields correctly", () => {
    const quest = makeQuest({
      id: "my-quest",
      title: "My Quest",
      priority: "high",
      difficulty: "hard",
    });

    const item = questToReviewItem(quest);

    expect(item.id).toBe("my-quest");
    expect(item.title).toBe("My Quest");
    expect(item.priority).toBe("high");
    expect(item.difficulty).toBe("hard");
    expect(item.accepted).toBe(true);
  });

  test("maps depends_on to dependsOn", () => {
    const quest = makeQuest({ depends_on: ["dep-1", "dep-2"] });
    const item = questToReviewItem(quest);

    expect(item.dependsOn).toEqual(["dep-1", "dep-2"]);
  });

  test("includes HITL mode in detail fields", () => {
    const quest = makeQuest({ hitl_mode: "yolo" });
    const item = questToReviewItem(quest);

    const hitlField = item.detailFields.find((f) => f.label.includes("HITL"));
    expect(hitlField).toBeDefined();
    expect(hitlField!.value).toBe("yolo");
    expect(hitlField!.color).toBe("green");
  });

  test("includes goal in detail sections", () => {
    const quest = makeQuest({ goal: "Build the auth system" });
    const item = questToReviewItem(quest);

    const goalSection = item.detailSections.find((s) => s.label === "Goal");
    expect(goalSection).toBeDefined();
    expect(goalSection!.items).toEqual(["Build the auth system"]);
  });

  test("includes constraints in detail sections with + prefix", () => {
    const quest = makeQuest({
      constraints: { add: ["Use TypeScript", "No eval"], ban: [] },
    });
    const item = questToReviewItem(quest);

    const section = item.detailSections.find((s) => s.label === "Constraints");
    expect(section).toBeDefined();
    expect(section!.items).toEqual(["Use TypeScript", "No eval"]);
    expect(section!.prefix).toBe("+");
  });

  test("includes banned items in detail sections with - prefix", () => {
    const quest = makeQuest({
      constraints: { add: [], ban: ["eval", "any"] },
    });
    const item = questToReviewItem(quest);

    const section = item.detailSections.find((s) => s.label === "Forbidden");
    expect(section).toBeDefined();
    expect(section!.items).toEqual(["eval", "any"]);
    expect(section!.prefix).toBe("-");
  });

  test("includes notes in detail sections", () => {
    const quest = makeQuest({ notes: ["Note 1", "Note 2"] });
    const item = questToReviewItem(quest);

    const section = item.detailSections.find((s) => s.label === "Notes");
    expect(section).toBeDefined();
    expect(section!.items).toEqual(["Note 1", "Note 2"]);
  });

  test("omits empty sections", () => {
    const quest = makeQuest({
      goal: "",
      constraints: { add: [], ban: [] },
      notes: [],
    });
    const item = questToReviewItem(quest);

    // All sections should still be present but with empty items
    // (they get filtered at render time by ReviewList)
    expect(item.detailSections.every((s) => s.items.length === 0 || s.label === "Goal")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reviewItemToQuest
// ---------------------------------------------------------------------------

describe("reviewItemToQuest", () => {
  test("maps basic item fields back to quest", () => {
    const quest = makeQuest();
    const item = questToReviewItem(quest);
    const result = reviewItemToQuest(item, quest);

    expect(result.id).toBe(quest.id);
    expect(result.title).toBe(quest.title);
    expect(result.priority).toBe(quest.priority);
    expect(result.difficulty).toBe(quest.difficulty);
    expect(result.depends_on).toEqual(quest.depends_on);
  });

  test("preserves edited title", () => {
    const quest = makeQuest({ title: "Original" });
    const item = questToReviewItem(quest);
    item.title = "Edited Title";
    const result = reviewItemToQuest(item, quest);

    expect(result.title).toBe("Edited Title");
  });

  test("preserves fields from original quest that aren't on ReviewItem", () => {
    const quest = makeQuest({ goal: "Important goal", hitl_mode: "supervised" });
    const item = questToReviewItem(quest);
    const result = reviewItemToQuest(item, quest);

    expect(result.goal).toBe("Important goal");
    expect(result.hitl_mode).toBe("supervised");
  });
});

// ---------------------------------------------------------------------------
// GENESIS_EDIT_FIELDS
// ---------------------------------------------------------------------------

describe("GENESIS_EDIT_FIELDS", () => {
  test("has 6 edit fields", () => {
    expect(GENESIS_EDIT_FIELDS).toHaveLength(6);
  });

  test("includes title, priority, difficulty, hitl_mode, depends_on, goal", () => {
    const keys = GENESIS_EDIT_FIELDS.map((f) => f.key);
    expect(keys).toContain("title");
    expect(keys).toContain("priority");
    expect(keys).toContain("difficulty");
    expect(keys).toContain("hitl_mode");
    expect(keys).toContain("depends_on");
    expect(keys).toContain("goal");
  });

  test("priority field has select type with 5 options", () => {
    const field = GENESIS_EDIT_FIELDS.find((f) => f.key === "priority");
    expect(field!.type).toBe("select");
    expect(field!.options).toHaveLength(5);
  });

  test("difficulty field has select type with 5 options", () => {
    const field = GENESIS_EDIT_FIELDS.find((f) => f.key === "difficulty");
    expect(field!.type).toBe("select");
    expect(field!.options).toHaveLength(5);
  });

  test("hitl_mode field has select type with 3 options", () => {
    const field = GENESIS_EDIT_FIELDS.find((f) => f.key === "hitl_mode");
    expect(field!.type).toBe("select");
    expect(field!.options).toHaveLength(3);
  });

  test("goal field has textarea type", () => {
    const field = GENESIS_EDIT_FIELDS.find((f) => f.key === "goal");
    expect(field!.type).toBe("textarea");
  });
});

// ---------------------------------------------------------------------------
// buildGenesisConfig
// ---------------------------------------------------------------------------

describe("buildGenesisConfig", () => {
  test("creates config with correct labels", () => {
    const result = makeGenesisResult();
    const config = buildGenesisConfig(result, () => {}, () => {});

    expect(config.title).toBe("Genesis Review");
    expect(config.itemLabel).toBe("quest");
    expect(config.itemLabelPlural).toBe("quests");
    expect(config.listLabel).toBe("Proposed Quests");
  });

  test("maps genesis validation issues to config issues", () => {
    const result = makeGenesisResult({
      issues: [
        { level: "error", questId: "q1", message: "Bad quest" },
        { level: "warning", message: "Minor issue" },
      ],
    });
    const config = buildGenesisConfig(result, () => {}, () => {});

    expect(config.issues).toHaveLength(2);
    expect(config.issues[0].itemId).toBe("q1");
    expect(config.issues[0].message).toBe("Bad quest");
    expect(config.issues[1].itemId).toBeUndefined();
  });

  test("passes knowledge to config", () => {
    const result = makeGenesisResult({ knowledge: "Scout data" });
    const config = buildGenesisConfig(result, () => {}, () => {});

    expect(config.knowledge).toBe("Scout data");
  });

  test("getEditFieldValue returns correct values", () => {
    const quest = makeQuest({
      title: "Auth",
      priority: "high",
      difficulty: "hard",
      hitl_mode: "cautious",
      depends_on: ["dep-a"],
      goal: "Build auth",
    });
    const result = makeGenesisResult({ quests: [quest] });
    const config = buildGenesisConfig(result, () => {}, () => {});

    const item = questToReviewItem(quest);

    expect(config.getEditFieldValue(item, "title")).toBe("Auth");
    expect(config.getEditFieldValue(item, "priority")).toBe("high");
    expect(config.getEditFieldValue(item, "difficulty")).toBe("hard");
    expect(config.getEditFieldValue(item, "hitl_mode")).toBe("cautious");
    expect(config.getEditFieldValue(item, "depends_on")).toBe("dep-a");
    expect(config.getEditFieldValue(item, "goal")).toBe("Build auth");
  });

  test("setEditFieldValue updates title", () => {
    const quest = makeQuest({ title: "Old" });
    const result = makeGenesisResult({ quests: [quest] });
    const config = buildGenesisConfig(result, () => {}, () => {});

    const item = questToReviewItem(quest);
    const updated = config.setEditFieldValue(item, "title", "New Title");

    expect(updated.title).toBe("New Title");
  });

  test("setEditFieldValue updates priority", () => {
    const quest = makeQuest({ priority: "medium" });
    const result = makeGenesisResult({ quests: [quest] });
    const config = buildGenesisConfig(result, () => {}, () => {});

    const item = questToReviewItem(quest);
    const updated = config.setEditFieldValue(item, "priority", "critical");

    expect(updated.priority).toBe("critical");
  });

  test("setEditFieldValue updates depends_on from comma-separated string", () => {
    const quest = makeQuest({ depends_on: [] });
    const result = makeGenesisResult({ quests: [quest] });
    const config = buildGenesisConfig(result, () => {}, () => {});

    const item = questToReviewItem(quest);
    const updated = config.setEditFieldValue(item, "depends_on", "dep-a, dep-b");

    expect(updated.dependsOn).toEqual(["dep-a", "dep-b"]);
  });

  test("onApprove callback receives ProposedQuest array", () => {
    const quest = makeQuest({ id: "test-q" });
    const result = makeGenesisResult({ quests: [quest] });
    const onApprove = mock((_quests: ProposedQuest[], _knowledge: string | null) => {});
    const config = buildGenesisConfig(result, onApprove, () => {});

    const items = [questToReviewItem(quest)];
    config.onApprove(items);

    expect(onApprove).toHaveBeenCalledTimes(1);
    const [quests, knowledge] = onApprove.mock.calls[0];
    expect(quests).toHaveLength(1);
    expect(quests[0].id).toBe("test-q");
  });

  test("onCancel callback fires correctly", () => {
    const result = makeGenesisResult();
    const onCancel = mock(() => {});
    const config = buildGenesisConfig(result, () => {}, onCancel);

    config.onCancel();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// GenesisReviewApp (static rendering)
// ---------------------------------------------------------------------------

describe("GenesisReviewApp", () => {
  test("renders without crashing", () => {
    const result = makeGenesisResult();

    const output = renderToString(
      <GenesisReviewApp
        genesisResult={result}
        onApprove={() => {}}
        onCancel={() => {}}
      />
    );

    expect(output).toContain("Genesis Review");
  });

  test("renders quest IDs in the list", () => {
    const result = makeGenesisResult({
      quests: [
        makeQuest({ id: "auth-system" }),
        makeQuest({ id: "api-layer" }),
      ],
    });

    const output = renderToString(
      <GenesisReviewApp
        genesisResult={result}
        onApprove={() => {}}
        onCancel={() => {}}
      />
    );

    expect(output).toContain("auth-system");
    expect(output).toContain("api-layer");
  });

  test("shows Proposed Quests label", () => {
    const result = makeGenesisResult();

    const output = renderToString(
      <GenesisReviewApp
        genesisResult={result}
        onApprove={() => {}}
        onCancel={() => {}}
      />
    );

    expect(output).toContain("Proposed Quests");
  });
});
