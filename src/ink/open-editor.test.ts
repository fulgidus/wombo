/**
 * open-editor.test.ts — Tests for the external editor utility.
 *
 * openEditor() spawns $EDITOR (or fallback) with a temp file containing the
 * provided text. When the editor closes, it reads back the file and returns
 * the updated text.
 *
 * Verifies:
 *   - getEditorCommand returns $EDITOR when set
 *   - getEditorCommand falls back to "vi" when $EDITOR is not set
 *   - openEditor writes initial value to temp file
 *   - openEditor returns updated value from temp file
 *   - openEditor cleans up temp file after completion
 */

import { describe, test, expect, afterEach } from "bun:test";
import { getEditorCommand, openEditor } from "./open-editor";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// getEditorCommand
// ---------------------------------------------------------------------------

describe("getEditorCommand", () => {
  const originalEditor = process.env.EDITOR;
  const originalVisual = process.env.VISUAL;

  afterEach(() => {
    // Restore originals
    if (originalEditor !== undefined) {
      process.env.EDITOR = originalEditor;
    } else {
      delete process.env.EDITOR;
    }
    if (originalVisual !== undefined) {
      process.env.VISUAL = originalVisual;
    } else {
      delete process.env.VISUAL;
    }
  });

  test("returns $EDITOR when set", () => {
    process.env.EDITOR = "nano";
    expect(getEditorCommand()).toBe("nano");
  });

  test("returns $VISUAL when EDITOR is not set", () => {
    delete process.env.EDITOR;
    process.env.VISUAL = "code --wait";
    expect(getEditorCommand()).toBe("code --wait");
  });

  test("falls back to vi when neither EDITOR nor VISUAL is set", () => {
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    expect(getEditorCommand()).toBe("vi");
  });

  test("prefers $EDITOR over $VISUAL", () => {
    process.env.EDITOR = "nano";
    process.env.VISUAL = "code --wait";
    expect(getEditorCommand()).toBe("nano");
  });
});

// ---------------------------------------------------------------------------
// openEditor
// ---------------------------------------------------------------------------

describe("openEditor", () => {
  test("returns the edited text from the temp file", async () => {
    // Use bash with -c and a script that writes known content
    const result = await openEditor("original text", {
      spawnArgs: ["bash", "-c", 'echo "edited text" > "$1"', "--"],
    });

    expect(result).toBe("edited text\n");
  });

  test("receives initial value in the temp file", async () => {
    // Script that reads the file, verifies content, then writes new content
    const result = await openEditor("initial content", {
      spawnArgs: ["bash", "-c", 'grep -q "initial content" "$1" && echo "verified" > "$1"', "--"],
    });

    expect(result).toBe("verified\n");
  });

  test("returns original value when editor exits with error", async () => {
    const result = await openEditor("keep this", {
      spawnArgs: ["false"], // exits with code 1
    });

    // On editor error, should return original value
    expect(result).toBe("keep this");
  });

  test("cleans up temp file after completion", async () => {
    let tempPath = "";

    await openEditor("temp content", {
      spawnArgs: ["bash", "-c", 'echo "modified" > "$1"', "--"],
      onTempFile: (path: string) => {
        tempPath = path;
      },
    });

    // The temp file should have been cleaned up
    expect(tempPath).not.toBe("");
    expect(existsSync(tempPath)).toBe(false);
  });

  test("handles empty initial value", async () => {
    const result = await openEditor("", {
      spawnArgs: ["bash", "-c", 'echo "new content" > "$1"', "--"],
    });

    expect(result).toBe("new content\n");
  });
});
