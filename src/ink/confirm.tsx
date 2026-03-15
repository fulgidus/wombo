/**
 * confirm.tsx — Ink ConfirmDialog component for yes/no confirmations.
 *
 * Replaces the neo-blessed showConfirm() function with a declarative
 * React component. Listens for Y/N/Escape keys and calls onConfirm.
 *
 * Features:
 *   - Modal with title and message
 *   - Y key confirms (true)
 *   - N or Escape key cancels (false)
 *   - Keybind hints in footer
 *
 * Usage:
 *   <ConfirmDialog
 *     title="Delete Task"
 *     message="Are you sure you want to delete this task?"
 *     onConfirm={(confirmed) => { ... }}
 *   />
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./modal";

export interface ConfirmDialogProps {
  /** Title displayed in the modal header. */
  title: string;
  /** The confirmation message/question. */
  message: string;
  /** Called with true (Y) or false (N/Escape). */
  onConfirm: (confirmed: boolean) => void;
}

/**
 * ConfirmDialog — a yes/no confirmation modal.
 */
export function ConfirmDialog({
  title,
  message,
  onConfirm,
}: ConfirmDialogProps): React.ReactElement {
  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      onConfirm(true);
    } else if (input === "n" || input === "N" || key.escape) {
      onConfirm(false);
    }
  });

  return (
    <Modal
      title={title}
      borderColor="yellow"
      footer={
        <Box>
          <Text color="green" bold>Y</Text>
          <Text dimColor> Yes    </Text>
          <Text color="red" bold>N</Text>
          <Text dimColor> No    </Text>
          <Text dimColor>Esc</Text>
          <Text dimColor> Cancel</Text>
        </Box>
      }
    >
      <Box paddingY={1}>
        <Text>{message}</Text>
      </Box>
    </Modal>
  );
}
