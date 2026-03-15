/**
 * text-input.tsx — Ink TextInput component with full cursor navigation.
 *
 * A reusable text input component for Ink that replaces blessed-textarea-patch.ts.
 *
 * Features:
 *   - Arrow key cursor navigation (left/right/up/down)
 *   - Home/End to jump within lines
 *   - Insert/delete at cursor position
 *   - Ctrl+S to submit (not Enter)
 *   - Ctrl+E to open $EDITOR
 *   - Single-line and multi-line modes
 *   - Placeholder text when empty
 *   - Focus/blur support
 *
 * Usage:
 *   <TextInput
 *     value={text}
 *     onChange={setText}
 *     onSubmit={handleSubmit}
 *     multiline={true}
 *     placeholder="Type here..."
 *   />
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { TextBuffer } from "./text-buffer.js";

export interface TextInputProps {
  /** Current value of the text input. */
  value?: string;
  /** Called when the value changes (controlled component). */
  onChange?: (value: string) => void;
  /** Called when the user presses Ctrl+S to submit. */
  onSubmit?: (value: string) => void;
  /** Placeholder text shown when the input is empty. */
  placeholder?: string;
  /** Whether the input accepts multiple lines. Default: false. */
  multiline?: boolean;
  /** Whether the input is focused and accepting keyboard input. Default: true. */
  focus?: boolean;
}

/**
 * Render the text value with a cursor indicator.
 *
 * In Ink, we simulate a cursor by inverting colors at the cursor position.
 * The cursor is shown as an inverse-colored character (or space at the end).
 */
function renderWithCursor(
  value: string,
  cursorPos: number,
  focused: boolean,
): React.ReactElement {
  if (!focused || value.length === 0) {
    if (value.length === 0 && focused) {
      // Show cursor in empty field
      return (
        <Text>
          <Text inverse> </Text>
        </Text>
      );
    }
    return <Text>{value}</Text>;
  }

  // Cursor at end of value
  if (cursorPos >= value.length) {
    return (
      <Text>
        {value}
        <Text inverse> </Text>
      </Text>
    );
  }

  const before = value.slice(0, cursorPos);
  const cursor = value[cursorPos];
  const after = value.slice(cursorPos + 1);

  return (
    <Text>
      {before}
      <Text inverse>{cursor}</Text>
      {after}
    </Text>
  );
}

/**
 * TextInput — a reusable Ink text input component.
 *
 * Manages a TextBuffer internally and dispatches onChange/onSubmit callbacks.
 * Supports single-line and multi-line modes.
 */
export function TextInput({
  value = "",
  onChange,
  onSubmit,
  placeholder,
  multiline = false,
  focus = true,
}: TextInputProps): React.ReactElement {
  // Internal buffer tracks cursor position independently of the controlled value
  const [buffer] = useState(() => new TextBuffer(value));
  const [cursorPos, setCursorPos] = useState(buffer.cursorPos);

  // Sync buffer with external value changes
  useEffect(() => {
    if (buffer.value !== value) {
      buffer.setValue(value);
      setCursorPos(buffer.cursorPos);
    }
  }, [value, buffer]);

  const handleInput = useCallback(
    (input: string, key: import("ink").Key) => {
      // Ctrl+S — submit
      if (key.ctrl && input === "s") {
        onSubmit?.(buffer.value);
        return;
      }

      // Ctrl+E — open external editor (placeholder for now)
      if (key.ctrl && input === "e") {
        // TODO: spawn $EDITOR with buffer.value, replace on return
        return;
      }

      // Arrow keys
      if (key.leftArrow) {
        buffer.moveLeft();
        setCursorPos(buffer.cursorPos);
        return;
      }

      if (key.rightArrow) {
        buffer.moveRight();
        setCursorPos(buffer.cursorPos);
        return;
      }

      if (key.upArrow) {
        buffer.moveUp();
        setCursorPos(buffer.cursorPos);
        return;
      }

      if (key.downArrow) {
        buffer.moveDown();
        setCursorPos(buffer.cursorPos);
        return;
      }

      // Home / End
      if (key.home) {
        buffer.moveHome();
        setCursorPos(buffer.cursorPos);
        return;
      }

      if (key.end) {
        buffer.moveEnd();
        setCursorPos(buffer.cursorPos);
        return;
      }

      // Backspace
      if (key.backspace) {
        buffer.deleteBack();
        setCursorPos(buffer.cursorPos);
        onChange?.(buffer.value);
        return;
      }

      // Delete
      if (key.delete) {
        buffer.deleteForward();
        setCursorPos(buffer.cursorPos);
        onChange?.(buffer.value);
        return;
      }

      // Return/Enter
      if (key.return) {
        if (multiline) {
          buffer.insert("\n");
          setCursorPos(buffer.cursorPos);
          onChange?.(buffer.value);
        }
        // Single-line mode: Enter is a no-op (Ctrl+S is the submit key)
        return;
      }

      // Tab — ignore (used for focus navigation in forms)
      if (key.tab) {
        return;
      }

      // Escape — ignore (could be used by parent for navigation)
      if (key.escape) {
        return;
      }

      // Filter out control characters (but allow normal text input)
      if (key.ctrl || key.meta) {
        return;
      }

      // Regular character input
      if (input && input.length > 0) {
        buffer.insert(input);
        setCursorPos(buffer.cursorPos);
        onChange?.(buffer.value);
      }
    },
    [buffer, onChange, onSubmit, multiline]
  );

  useInput(handleInput, { isActive: focus });

  // Render
  const isEmpty = buffer.value.length === 0;
  const showPlaceholder = isEmpty && placeholder && !focus;

  if (showPlaceholder) {
    return (
      <Box>
        <Text dimColor>{placeholder}</Text>
      </Box>
    );
  }

  // Show placeholder even when focused but empty (dimmed)
  if (isEmpty && placeholder && focus) {
    return (
      <Box>
        <Text dimColor>{placeholder}</Text>
        {focus && (
          <Text>
            <Text inverse> </Text>
          </Text>
        )}
      </Box>
    );
  }

  // Multiline rendering: render each line separately
  if (multiline && buffer.value.includes("\n")) {
    const lines = buffer.lines;
    let charOffset = 0;

    return (
      <Box flexDirection="column">
        {lines.map((line, lineIdx) => {
          const lineStart = charOffset;
          charOffset += line.length + 1; // +1 for newline

          // Check if cursor is on this line
          const cursorOnLine = cursorPos >= lineStart && cursorPos <= lineStart + line.length;

          if (cursorOnLine && focus) {
            const colInLine = cursorPos - lineStart;
            return (
              <Box key={lineIdx}>
                {renderWithCursor(line, colInLine, true)}
              </Box>
            );
          }

          return (
            <Box key={lineIdx}>
              <Text>{line || " "}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  // Single-line rendering
  return (
    <Box>
      {renderWithCursor(buffer.value, cursorPos, focus)}
    </Box>
  );
}
