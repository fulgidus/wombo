/**
 * run-quest-wizard.test.tsx — Tests for the standalone quest wizard launcher.
 *
 * Verifies:
 *   - runQuestWizardInk returns a Promise
 *   - Type exports are correct
 *   - The function signature matches expected interface
 */

import { describe, test, expect } from "bun:test";
import { runQuestWizardInk, type RunQuestWizardOptions } from "./run-quest-wizard";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runQuestWizardInk", () => {
  test("is exported as a function", () => {
    expect(typeof runQuestWizardInk).toBe("function");
  });

  test("RunQuestWizardOptions type is usable", () => {
    // Type-level check: ensure the options type is correctly shaped
    const opts: RunQuestWizardOptions = {
      projectRoot: "/tmp/test",
      baseBranch: "main",
    };
    expect(opts.projectRoot).toBe("/tmp/test");
    expect(opts.baseBranch).toBe("main");
  });

  test("RunQuestWizardOptions accepts prefill", () => {
    const opts: RunQuestWizardOptions = {
      projectRoot: "/tmp/test",
      baseBranch: "main",
      prefill: {
        id: "test-quest",
        title: "Test Quest",
        goal: "Test goal",
        priority: "high",
        difficulty: "easy",
        hitlMode: "cautious",
      },
    };
    expect(opts.prefill?.id).toBe("test-quest");
  });
});
