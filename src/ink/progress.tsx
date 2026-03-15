/**
 * progress.tsx — Ink ProgressView component for long-running operations.
 *
 * Replaces the neo-blessed ProgressScreen class with a declarative React
 * component. The parent manages state (spinning, status, result, logLines)
 * and passes them as props.
 *
 * Features:
 *   - Animated braille spinner (when spinning=true)
 *   - Title and optional context
 *   - Status text updated by the parent
 *   - Result display: success (✔), error (✘), info (ℹ)
 *   - Scrollable log area for result messages
 *   - Footer dismiss hint
 *
 * Usage:
 *   <ProgressView
 *     title="Running Planner"
 *     context="quest: auth-service"
 *     spinning={isRunning}
 *     status="Generating tasks..."
 *     logLines={logLines}
 *     result={result}
 *     showDismiss={showDismiss}
 *   />
 */

import React from "react";
import { Box, Text } from "ink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result state for the progress view. */
export interface ProgressResult {
  type: "success" | "error" | "info";
  message: string;
}

export interface ProgressViewProps {
  /** Title of the operation. */
  title: string;
  /** Optional context string shown next to the title. */
  context?: string;
  /** Whether the spinner is currently animating. Default: false. */
  spinning?: boolean;
  /** Current spinner frame index (for animated rendering). Default: 0. */
  spinFrame?: number;
  /** Status text shown next to the spinner. */
  status?: string;
  /** Result to display (replaces spinner when set). */
  result?: ProgressResult;
  /** Log lines to display in the scrollable area. */
  logLines?: string[];
  /** Whether to show the "Press any key to continue" footer. */
  showDismiss?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPIN_CHARS = ["⠂", "⠆", "⠇", "⠃", "⠉", "⠌", "⠎", "⠋"];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * ProgressView — a declarative progress display component.
 *
 * The parent component manages the spinner interval and result state,
 * passing updated props to trigger re-renders.
 */
export function ProgressView({
  title,
  context,
  spinning = false,
  spinFrame = 0,
  status,
  result,
  logLines,
  showDismiss = false,
}: ProgressViewProps): React.ReactElement {
  // Determine the icon and status text to display
  let icon: React.ReactElement | null = null;
  let statusText: React.ReactElement | null = null;

  if (result) {
    // Result overrides spinner
    switch (result.type) {
      case "success":
        icon = <Text color="green">✔</Text>;
        statusText = <Text color="green">{result.message}</Text>;
        break;
      case "error":
        icon = <Text color="red">✘</Text>;
        statusText = <Text color="red">{result.message}</Text>;
        break;
      case "info":
        icon = <Text color="cyan">ℹ</Text>;
        statusText = <Text color="cyan">{result.message}</Text>;
        break;
    }
  } else if (spinning) {
    const ch = SPIN_CHARS[spinFrame % SPIN_CHARS.length];
    icon = <Text color="magenta">{ch}</Text>;
    statusText = status ? <Text color="cyan">{status}</Text> : null;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="magenta">
          {title}
        </Text>
        {context && (
          <>
            <Text dimColor> — </Text>
            <Text dimColor>{context}</Text>
          </>
        )}
      </Box>

      {/* Spinner + status row */}
      {(icon || statusText) && (
        <Box>
          {icon && <Box marginRight={1}>{icon}</Box>}
          {statusText}
        </Box>
      )}

      {/* Log area */}
      {logLines && logLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {logLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}

      {/* Footer */}
      {showDismiss && (
        <Box marginTop={1}>
          <Text dimColor>Press any key to continue...</Text>
        </Box>
      )}
    </Box>
  );
}
