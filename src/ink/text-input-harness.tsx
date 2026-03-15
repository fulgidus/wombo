#!/usr/bin/env bun
/**
 * text-input-harness.tsx — Standalone test harness for the TextInput component.
 *
 * Run with: bun src/ink/text-input-harness.tsx
 *
 * Provides an interactive terminal UI to exercise all TextInput features:
 *   - Single-line and multi-line modes
 *   - Arrow key cursor navigation
 *   - Home/End keys
 *   - Insert/delete at cursor position
 *   - Ctrl+S to submit
 *   - Ctrl+E to open $EDITOR
 *   - Tab to switch between modes
 *   - q in header to quit
 */

import React, { useState, useCallback } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { TextInput } from "./text-input";
import { useTextInput } from "./use-text-input";
import { openEditor } from "./open-editor";

type Mode = "single" | "multi";

function Harness(): React.ReactElement {
  const { exit } = useApp();
  const [mode, setMode] = useState<Mode>("single");
  const [submitted, setSubmitted] = useState<string | null>(null);

  const singleLine = useTextInput({ initialValue: "" });
  const multiLine = useTextInput({ initialValue: "" });

  const current = mode === "single" ? singleLine : multiLine;

  const handleSubmit = useCallback(
    (value: string) => {
      setSubmitted(value);
    },
    [],
  );

  const handleEditorRequest = useCallback(
    async (currentValue: string) => {
      try {
        const edited = await openEditor(currentValue);
        current.setValue(edited);
      } catch {
        // Editor failed — keep current value
      }
    },
    [current],
  );

  // Global keybinds (Tab to switch mode, Ctrl+C to quit)
  useInput((input, key) => {
    if (key.tab) {
      setMode((m) => (m === "single" ? "multi" : "single"));
      setSubmitted(null);
    }
    if (key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          TextInput Harness
        </Text>
        <Text dimColor> — test all input features</Text>
      </Box>

      {/* Mode indicator */}
      <Box marginBottom={1}>
        <Text dimColor>Mode: </Text>
        <Text bold color={mode === "single" ? "green" : "blue"}>
          {mode === "single" ? "Single-line" : "Multi-line"}
        </Text>
        <Text dimColor> (Tab to switch)</Text>
      </Box>

      {/* Input area */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={mode === "single" ? "green" : "blue"}
        paddingX={1}
      >
        <Text dimColor>
          {mode === "single" ? "Type here (single-line):" : "Type here (multi-line, Enter = newline):"}
        </Text>
        <TextInput
          value={current.value}
          onChange={current.onChange}
          onSubmit={handleSubmit}
          onEditorRequest={handleEditorRequest}
          multiline={mode === "multi"}
          placeholder={
            mode === "single"
              ? "Type something..."
              : "Type multiple lines..."
          }
          focus={true}
        />
      </Box>

      {/* Debug info */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Value length: {current.value.length}</Text>
        <Text dimColor>
          Lines: {current.value.split("\n").length}
        </Text>
        {current.value.length > 0 && (
          <Box>
            <Text dimColor>Content: </Text>
            <Text>{JSON.stringify(current.value)}</Text>
          </Box>
        )}
      </Box>

      {/* Submitted value */}
      {submitted !== null && (
        <Box marginTop={1} borderStyle="single" borderColor="yellow" paddingX={1}>
          <Text color="yellow">Submitted: </Text>
          <Text>{JSON.stringify(submitted)}</Text>
        </Box>
      )}

      {/* Keybind hints */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Keybinds:</Text>
        <Text dimColor>  Ctrl+S  Submit value</Text>
        <Text dimColor>  Ctrl+E  Open $EDITOR</Text>
        <Text dimColor>  Tab     Switch mode</Text>
        <Text dimColor>  Esc     Quit</Text>
        <Text dimColor>  ←→↑↓   Move cursor</Text>
        <Text dimColor>  Home/End  Jump within line</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const instance = render(<Harness />);
await instance.waitUntilExit();
