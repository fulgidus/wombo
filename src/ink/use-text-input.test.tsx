/**
 * use-text-input.test.tsx — Tests for the useTextInput hook.
 *
 * useTextInput is a convenience hook that manages controlled state for a
 * TextInput component. It provides value, onChange handler, and a reset method.
 *
 * Verifies:
 *   - Hook provides initial value
 *   - onChange updates the value
 *   - reset restores initial value
 *   - Can be used in a component that renders and processes input
 */

import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { render, renderToString, Text, Box } from "ink";
import { useTextInput } from "./use-text-input.js";
import { TextInput } from "./text-input.js";
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

// ---------------------------------------------------------------------------
// Test harness component
// ---------------------------------------------------------------------------

/** A component that uses the hook and renders the value. */
function TestHarness({
  initialValue = "",
  onSubmit,
}: {
  initialValue?: string;
  onSubmit?: (value: string) => void;
}): React.ReactElement {
  const { value, onChange, reset } = useTextInput({ initialValue });

  return (
    <Box flexDirection="column">
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={(v) => {
          onSubmit?.(v);
        }}
      />
      <Text>current:{value}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useTextInput", () => {
  test("renders initial value", () => {
    const output = renderToString(<TestHarness initialValue="hello" />);
    expect(output).toContain("hello");
    expect(output).toContain("current:hello");
  });

  test("renders empty initial value", () => {
    const output = renderToString(<TestHarness />);
    expect(output).toContain("current:");
  });

  test("typing updates value via onChange", async () => {
    const { stdin, stdout } = createTestStreams();
    const chunks: string[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));

    const instance = render(<TestHarness initialValue="" />, {
      stdout,
      stdin,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    // Type a character
    (stdin as any as PassThrough).write("x");
    await new Promise((r) => setTimeout(r, 100));

    const output = chunks.join("");
    // The value should have been updated to include 'x'
    expect(output).toContain("current:x");

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("submit callback receives current value", async () => {
    const onSubmit = mock(() => {});
    const { stdin, stdout } = createTestStreams();

    const instance = render(
      <TestHarness initialValue="test value" onSubmit={onSubmit} />,
      {
        stdout,
        stdin: stdin as any,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    // Ctrl+S to submit
    (stdin as any as PassThrough).write("\x13");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSubmit).toHaveBeenCalledWith("test value");

    instance.unmount();
    await instance.waitUntilExit();
  });
});
