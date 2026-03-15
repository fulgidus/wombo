/**
 * confirm-dialog.tsx — Yes/No confirm dialog Ink component.
 *
 * Shows a title, message, and two options (Yes/No) with arrow key
 * navigation and Enter to select.
 *
 * Used for:
 *   - "Enhance profile with AI?" (before LLM synthesis)
 *   - "Run genesis planner to create initial quests?" (after onboarding)
 *
 * Navigation:
 *   - Arrow keys (up/down or left/right) to toggle between Yes/No
 *   - Enter/Space to confirm selection
 *   - Esc to cancel (selects No)
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  /** Dialog title displayed as a header. */
  title: string;
  /** Message/question to display. */
  message: string;
  /** Called when the user confirms (selects Yes). */
  onConfirm: () => void;
  /** Called when the user cancels (selects No or presses Esc). */
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// ConfirmDialog
// ---------------------------------------------------------------------------

/**
 * ConfirmDialog — a simple yes/no prompt component.
 *
 * Renders a title, message, and two highlighted options. The user
 * toggles between Yes and No using arrow keys and confirms with Enter.
 * Esc cancels (equivalent to selecting No).
 */
export function ConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.ReactElement {
  const [selected, setSelected] = useState<"yes" | "no">("yes");

  useInput((input, key) => {
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      setSelected((prev) => (prev === "yes" ? "no" : "yes"));
      return;
    }
    if (key.return || input === " ") {
      if (selected === "yes") {
        onConfirm();
      } else {
        onCancel();
      }
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="magenta">
          {title}
        </Text>
      </Box>

      {/* Message */}
      <Box marginBottom={1}>
        <Text>{message}</Text>
      </Box>

      {/* Options */}
      <Box gap={2}>
        <Text
          bold={selected === "yes"}
          color={selected === "yes" ? "green" : undefined}
        >
          {selected === "yes" ? "❯ " : "  "}
          Yes
        </Text>
        <Text
          bold={selected === "no"}
          color={selected === "no" ? "red" : undefined}
        >
          {selected === "no" ? "❯ " : "  "}
          No
        </Text>
      </Box>

      {/* Navigation hint */}
      <Box marginTop={1}>
        <Text dimColor>
          Arrow keys: toggle  |  Enter: select  |  Esc: cancel
        </Text>
      </Box>
    </Box>
  );
}
