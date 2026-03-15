/**
 * open-editor.ts — Utility to open $EDITOR for text editing.
 *
 * Spawns the user's preferred editor with a temp file containing the
 * provided text. When the editor closes, reads the file back and returns
 * the (potentially modified) text.
 *
 * Used by the TextInput component's Ctrl+E feature.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";

export interface OpenEditorOptions {
  /** Override the editor command (defaults to $EDITOR / $VISUAL / vi). */
  editorCommand?: string;
  /**
   * Override the spawn arguments directly.
   * When provided, editorCommand is ignored and these args are used.
   * The temp file path will be appended as the last argument.
   */
  spawnArgs?: string[];
  /** Callback invoked with the temp file path (for testing/cleanup tracking). */
  onTempFile?: (path: string) => void;
}

/**
 * Get the editor command from environment variables.
 * Prefers $EDITOR, then $VISUAL, then falls back to "vi".
 */
export function getEditorCommand(): string {
  return process.env.EDITOR || process.env.VISUAL || "vi";
}

/**
 * Open the user's editor with the given text and return the edited result.
 *
 * Creates a temp file with the initial value, spawns the editor, waits for
 * it to exit, reads the file, cleans up, and returns the result.
 *
 * If the editor exits with a non-zero code, returns the original value
 * unchanged (treating editor failure as a cancellation).
 */
export async function openEditor(
  initialValue: string,
  options: OpenEditorOptions = {},
): Promise<string> {
  const editorCmd = options.editorCommand ?? getEditorCommand();

  // Create a temp file with the initial value
  const tempFile = join(
    tmpdir(),
    `wombo-edit-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );

  try {
    writeFileSync(tempFile, initialValue, "utf-8");

    // Notify caller of temp file path (for testing)
    options.onTempFile?.(tempFile);

    let spawnCmd: string[];

    if (options.spawnArgs) {
      // Use provided spawn args directly (for testing)
      spawnCmd = [...options.spawnArgs, tempFile];
    } else {
      // Parse the editor command — it may contain arguments (e.g., "code --wait")
      const parts = editorCmd.split(/\s+/);
      spawnCmd = [...parts, tempFile];
    }

    // Spawn the editor and wait for it to exit
    const proc = Bun.spawn(spawnCmd, {
      stdio: ["inherit", "inherit", "inherit"],
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      // Editor exited with error — return original value
      return initialValue;
    }

    // Read the (potentially modified) file
    const result = readFileSync(tempFile, "utf-8");
    return result;
  } finally {
    // Clean up the temp file
    try {
      if (existsSync(tempFile)) {
        unlinkSync(tempFile);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
