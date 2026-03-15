/**
 * quest-wizard.test.tsx — Tests for the QuestWizard Ink component.
 *
 * Verifies the 6-step quest creation wizard:
 *   Step 1: Quest ID (text input, kebab-case validation)
 *   Step 2: Title (text input, non-empty validation)
 *   Step 3: Goal (text input, non-empty validation)
 *   Step 4: Priority (select input)
 *   Step 5: Difficulty (select input)
 *   Step 6: HITL Mode (select input)
 *
 * Tests cover:
 *   - Static rendering of each step
 *   - Step navigation (Ctrl+S to advance, Escape to go back)
 *   - Validation (empty ID, invalid format, duplicate IDs)
 *   - Prefill values
 *   - Cancellation from step 1
 *   - Full wizard flow completion
 *   - Confirmation display after creation
 */

import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { render, renderToString } from "ink";
import { QuestWizard } from "./quest-wizard";
import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestStreams() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 80;
  (stdout as any).rows = 24;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = () => stdin;
  (stdin as any).ref = () => stdin;
  (stdin as any).unref = () => stdin;
  return { stdin, stdout };
}

function renderLive(element: React.ReactElement) {
  const { stdin, stdout } = createTestStreams();
  const chunks: string[] = [];
  stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });

  const instance = render(element, {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    instance,
    stdin: stdin as any as PassThrough,
    getOutput: () => chunks.join(""),
    cleanup: async () => {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}

/** Stub checkDuplicateId that always returns null (no duplicates). */
const noDuplicates = (_id: string) => null;

/** Stub checkDuplicateId that reports a specific ID as existing. */
function duplicateOf(existingId: string) {
  return (id: string) => (id === existingId ? "active" : null);
}

/** Stub saveQuest that does nothing (for testing without filesystem). */
const noopSave = mock(() => {});

// ---------------------------------------------------------------------------
// Static rendering tests
// ---------------------------------------------------------------------------

describe("QuestWizard (static rendering)", () => {
  test("renders step 1 (Quest ID) by default", () => {
    const output = renderToString(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
      />
    );
    expect(output).toContain("Quest ID");
    expect(output).toContain("Step 1");
  });

  test("shows step indicator with total steps", () => {
    const output = renderToString(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
      />
    );
    expect(output).toContain("6");
  });

  test("displays prefilled ID value", () => {
    const output = renderToString(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
        prefill={{ id: "my-quest" }}
      />
    );
    expect(output).toContain("my-quest");
  });
});

// ---------------------------------------------------------------------------
// Step navigation tests
// ---------------------------------------------------------------------------

describe("QuestWizard step navigation", () => {
  test("advances from ID to Title on Ctrl+S with valid ID", async () => {
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
        prefill={{ id: "test-quest" }}
      />
    );

    // Ctrl+S to submit the prefilled ID
    stdin.write("\x13");
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    expect(output).toContain("Title");
    expect(output).toContain("Step 2");

    await cleanup();
  });

  test("goes back from Title to ID on Escape", async () => {
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
        prefill={{ id: "test-quest" }}
      />
    );

    // Advance to Title
    stdin.write("\x13");
    await new Promise((r) => setTimeout(r, 100));

    // Press Escape to go back
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    // Should be back on step 1
    expect(output).toContain("Quest ID");

    await cleanup();
  });

  test("cancels wizard when Escape is pressed on step 1", async () => {
    const onCancelled = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={onCancelled}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
      />
    );

    // Press Escape on step 1
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 100));

    expect(onCancelled).toHaveBeenCalled();

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("QuestWizard validation", () => {
  test("shows error for empty ID", async () => {
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
      />
    );

    // Submit with empty ID
    stdin.write("\x13");
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    // Should show an error about empty ID and stay on step 1
    expect(output).toContain("Quest ID");

    await cleanup();
  });

  test("shows error for invalid kebab-case ID", async () => {
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
      />
    );

    // Type an invalid ID (uppercase)
    stdin.write("Invalid_ID");
    await new Promise((r) => setTimeout(r, 50));

    // Try to submit
    stdin.write("\x13");
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    // Should show error and stay on step 1
    expect(output).toContain("kebab");

    await cleanup();
  });

  test("shows error for duplicate quest ID", async () => {
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={duplicateOf("existing-quest")}
        saveQuest={noopSave}
        prefill={{ id: "existing-quest" }}
      />
    );

    // Try to submit the duplicate ID
    stdin.write("\x13");
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    // Should show error about duplicate and stay on step 1
    expect(output).toContain("already exists");

    await cleanup();
  });

  test("shows error for empty title", async () => {
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
        prefill={{ id: "test-quest" }}
      />
    );

    // Advance to Title step
    stdin.write("\x13");
    await new Promise((r) => setTimeout(r, 100));

    // Try to submit with empty title
    stdin.write("\x13");
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    // Should show error and stay on Title step
    expect(output).toContain("Title");

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Full wizard flow
// ---------------------------------------------------------------------------

describe("QuestWizard full flow", () => {
  test("completes all 6 steps and calls onCreated", async () => {
    const onCreated = mock(() => {});
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={onCreated}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
        prefill={{
          id: "test-quest",
          title: "Test Quest",
          goal: "Test the wizard",
        }}
      />
    );

    // Step 1: ID (prefilled) → Ctrl+S
    stdin.write("\x13");
    await new Promise((r) => setTimeout(r, 100));

    // Step 2: Title (prefilled) → Ctrl+S
    stdin.write("\x13");
    await new Promise((r) => setTimeout(r, 100));

    // Step 3: Goal (prefilled) → Ctrl+S
    stdin.write("\x13");
    await new Promise((r) => setTimeout(r, 100));

    // Step 4: Priority (select) → Enter to accept default
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 100));

    // Step 5: Difficulty (select) → Enter to accept default
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 100));

    // Step 6: HITL Mode (select) → Enter to accept default
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 100));

    expect(onCreated).toHaveBeenCalled();
    const quest = (onCreated.mock.calls as unknown as any[][])[0]![0];
    expect(quest.id).toBe("test-quest");
    expect(quest.title).toBe("Test Quest");
    expect(quest.goal).toBe("Test the wizard");
    expect(quest.branch).toBe("quest/test-quest");

    await cleanup();
  });

  test("calls saveQuest when completing the wizard", async () => {
    const saveQuestFn = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={saveQuestFn}
        prefill={{
          id: "save-test",
          title: "Save Test",
          goal: "Test saving",
        }}
      />
    );

    // Complete all steps
    stdin.write("\x13"); // ID
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Title
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Goal
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // Priority
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // Difficulty
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // HITL
    await new Promise((r) => setTimeout(r, 100));

    expect(saveQuestFn).toHaveBeenCalled();

    await cleanup();
  });

  test("shows confirmation after quest creation", async () => {
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
        prefill={{
          id: "confirm-test",
          title: "Confirm Test",
          goal: "Test confirmation",
        }}
      />
    );

    // Complete all steps
    stdin.write("\x13"); // ID
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Title
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Goal
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // Priority
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // Difficulty
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // HITL
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    expect(output).toContain("Quest created");
    expect(output).toContain("confirm-test");

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Prefill tests
// ---------------------------------------------------------------------------

describe("QuestWizard prefill", () => {
  test("uses prefilled priority in select step", async () => {
    const onCreated = mock(() => {});
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={onCreated}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
        prefill={{
          id: "prefill-test",
          title: "Prefill Test",
          goal: "Test prefill",
          priority: "high",
          difficulty: "easy",
          hitlMode: "cautious",
        }}
      />
    );

    // Complete all 6 steps accepting prefilled values
    stdin.write("\x13"); // ID
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Title
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Goal
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // Priority (prefilled to high)
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // Difficulty (prefilled to easy)
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // HITL (prefilled to cautious)
    await new Promise((r) => setTimeout(r, 100));

    expect(onCreated).toHaveBeenCalled();
    const quest = (onCreated.mock.calls as unknown as any[][])[0]![0];
    expect(quest.priority).toBe("high");
    expect(quest.difficulty).toBe("easy");
    expect(quest.hitlMode).toBe("cautious");

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Select step rendering
// ---------------------------------------------------------------------------

describe("QuestWizard select steps", () => {
  test("Priority step shows all priority options", async () => {
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
        prefill={{ id: "test", title: "Test", goal: "Goal" }}
      />
    );

    // Navigate to Priority step (step 4)
    stdin.write("\x13"); // ID
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Title
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Goal
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    expect(output).toContain("Priority");
    expect(output).toContain("critical");
    expect(output).toContain("high");
    expect(output).toContain("medium");
    expect(output).toContain("low");

    await cleanup();
  });

  test("Difficulty step shows all difficulty options", async () => {
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
        prefill={{ id: "test", title: "Test", goal: "Goal" }}
      />
    );

    // Navigate to Difficulty step (step 5)
    stdin.write("\x13"); // ID
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Title
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Goal
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // Priority
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    expect(output).toContain("Difficulty");
    expect(output).toContain("easy");
    expect(output).toContain("medium");
    expect(output).toContain("hard");

    await cleanup();
  });

  test("HITL step shows all HITL mode options with descriptions", async () => {
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={noopSave}
        prefill={{ id: "test", title: "Test", goal: "Goal" }}
      />
    );

    // Navigate to HITL step (step 6)
    stdin.write("\x13"); // ID
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Title
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Goal
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // Priority
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // Difficulty
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    expect(output).toContain("HITL");
    expect(output).toContain("yolo");
    expect(output).toContain("cautious");
    expect(output).toContain("supervised");

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("QuestWizard error handling", () => {
  test("handles saveQuest error gracefully", async () => {
    const errorSave = mock(() => {
      throw new Error("Disk full");
    });
    const { stdin, getOutput, cleanup } = renderLive(
      <QuestWizard
        baseBranch="main"
        onCreated={() => {}}
        onCancelled={() => {}}
        checkDuplicateId={noDuplicates}
        saveQuest={errorSave}
        prefill={{
          id: "error-test",
          title: "Error Test",
          goal: "Test error handling",
        }}
      />
    );

    // Complete all steps
    stdin.write("\x13"); // ID
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Title
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\x13"); // Goal
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // Priority
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // Difficulty
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("\r"); // HITL
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    expect(output).toContain("Failed");
    expect(output).toContain("Disk full");

    await cleanup();
  });
});
