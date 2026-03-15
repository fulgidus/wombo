/**
 * modal.tsx — Reusable Modal wrapper component for Ink overlays.
 *
 * Provides a bordered box with a title label and optional footer.
 * Used as the shared container for ProgressScreen, UsageOverlay,
 * and QuestionPopup components.
 *
 * Features:
 *   - Bordered box with customizable border color
 *   - Title rendered as a label in the border
 *   - Optional footer area for keybind hints
 *   - Flexbox column layout for children
 */

import React, { type ReactNode } from "react";
import { Box, Text } from "ink";

export interface ModalProps {
  /** Title displayed in the modal header. */
  title: string;
  /** Optional border color. Defaults to "yellow". */
  borderColor?: string;
  /** Optional footer element (e.g. keybind hints). */
  footer?: ReactNode;
  /** Child elements rendered in the modal body. */
  children?: ReactNode;
}

/**
 * Modal — a bordered overlay container with a title and optional footer.
 *
 * Renders a flexbox column layout:
 *   ┌─ Title ──────────────┐
 *   │ children              │
 *   │                       │
 *   ├───────────────────────┤
 *   │ footer                │
 *   └───────────────────────┘
 */
export function Modal({
  title,
  borderColor = "yellow",
  footer,
  children,
}: ModalProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
    >
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color={borderColor}>
          {title}
        </Text>
      </Box>

      {/* Body content */}
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>

      {/* Footer (if provided) */}
      {footer && (
        <Box marginTop={1} borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor="gray">
          {footer}
        </Box>
      )}
    </Box>
  );
}
