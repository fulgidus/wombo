/**
 * shell.tsx — Full Ink shell with input handling and clean exit.
 *
 * Wraps child components in a layout with header and keybind hints.
 * Handles 'q' key and Escape to exit the app cleanly via useApp().exit().
 *
 * This component proves:
 *   - Ink's useInput hook works in Bun
 *   - useApp().exit() triggers clean unmount
 *   - Child component mounting/unmounting works correctly
 */

import React, { type ReactNode } from "react";
import { Box, Text, useApp, useInput } from "ink";

export interface ShellProps {
  /** Child components to render in the main content area. */
  children?: ReactNode;
}

/**
 * InputHandler — internal component that uses useInput to handle keyboard events.
 * Separated from Shell so hooks are called in a proper component context.
 */
function InputHandler(): null {
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
    }
  });

  return null;
}

/**
 * Shell — top-level app shell with header, content area, and keybind bar.
 */
export function Shell({ children }: ShellProps): React.ReactElement {
  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          wombo-combo
        </Text>
        <Text dimColor> — Ink Shell</Text>
      </Box>

      {/* Content area */}
      <Box flexDirection="column" marginBottom={1}>
        {children}
      </Box>

      {/* Keybind hints */}
      <Box>
        <Text dimColor>Press </Text>
        <Text bold>q</Text>
        <Text dimColor> to quit</Text>
      </Box>

      {/* Input handler (invisible — just hooks) */}
      <InputHandler />
    </Box>
  );
}
