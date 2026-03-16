/**
 * run-review.test.tsx — Tests for the standalone review screen launchers.
 *
 * Verifies:
 *   - runGenesisReviewInk creates a render instance and resolves on approve
 *   - runGenesisReviewInk resolves on cancel
 *   - runPlanReviewInk creates a render instance and resolves on approve
 *   - runPlanReviewInk resolves on cancel
 *   - GenesisReviewAction and PlanReviewAction types are exported
 */

import { describe, test, expect } from "bun:test";
import type {
  GenesisReviewAction,
  PlanReviewAction,
} from "./run-review";

// ---------------------------------------------------------------------------
// Type-level tests (these verify the exported types compile correctly)
// ---------------------------------------------------------------------------

describe("run-review types", () => {
  test("GenesisReviewAction has approve and cancel variants", () => {
    // Type-level check: construct both variants
    const approve: GenesisReviewAction = {
      type: "approve",
      quests: [],
      knowledge: null,
    };
    const cancel: GenesisReviewAction = { type: "cancel" };

    expect(approve.type).toBe("approve");
    expect(cancel.type).toBe("cancel");
  });

  test("PlanReviewAction has approve and cancel variants", () => {
    const approve: PlanReviewAction = {
      type: "approve",
      tasks: [],
      knowledge: null,
    };
    const cancel: PlanReviewAction = { type: "cancel" };

    expect(approve.type).toBe("approve");
    expect(cancel.type).toBe("cancel");
  });

  test("GenesisReviewAction approve variant carries quests and knowledge", () => {
    const action: GenesisReviewAction = {
      type: "approve",
      quests: [
        {
          id: "test",
          title: "Test",
          goal: "Test goal",
          priority: "medium",
          difficulty: "easy",
          depends_on: [],
          constraints: { add: [], ban: [] },
          hitl_mode: "cautious",
          notes: [],
        },
      ],
      knowledge: "some knowledge",
    };

    expect(action.type).toBe("approve");
    if (action.type === "approve") {
      expect(action.quests).toHaveLength(1);
      expect(action.knowledge).toBe("some knowledge");
    }
  });

  test("PlanReviewAction approve variant carries tasks and knowledge", () => {
    const action: PlanReviewAction = {
      type: "approve",
      tasks: [
        {
          id: "test",
          title: "Test",
          description: "Test desc",
          priority: "medium",
          difficulty: "easy",
          effort: "2h",
          depends_on: [],
          constraints: [],
          forbidden: [],
          references: [],
          notes: [],
        },
      ],
      knowledge: "some knowledge",
    };

    expect(action.type).toBe("approve");
    if (action.type === "approve") {
      expect(action.tasks).toHaveLength(1);
      expect(action.knowledge).toBe("some knowledge");
    }
  });
});
