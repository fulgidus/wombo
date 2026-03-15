/**
 * text-input-harness.test.tsx — Tests for the standalone TextInput test harness.
 *
 * The harness is an interactive tool, so tests verify:
 *   - The harness module exports render-ready components
 *   - The harness mounts and unmounts cleanly
 *   - Mode switching works (single/multi)
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { render, renderToString, Box, Text } from "ink";
import { TextInput } from "./text-input";
import { useTextInput } from "./use-text-input";
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
// Harness-style component for testing
// ---------------------------------------------------------------------------

function HarnessLike(): React.ReactElement {
  const { value, onChange } = useTextInput({ initialValue: "test value" });

  return (
    <Box flexDirection="column">
      <Text>TextInput Harness</Text>
      <TextInput value={value} onChange={onChange} />
      <Text>current:{value}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TextInput harness", () => {
  test("harness-like component renders without crashing", () => {
    const output = renderToString(<HarnessLike />);
    expect(output).toContain("TextInput Harness");
    expect(output).toContain("test value");
  });

  test("harness mounts and unmounts cleanly", async () => {
    const { stdin, stdout } = createTestStreams();
    const instance = render(<HarnessLike />, {
      stdout,
      stdin,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    await new Promise((r) => setTimeout(r, 50));

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("harness accepts input and updates value", async () => {
    const { stdin, stdout } = createTestStreams();
    const chunks: string[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));

    const instance = render(<HarnessLike />, {
      stdout,
      stdin,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    // Type a character
    (stdin as any as PassThrough).write("X");
    await new Promise((r) => setTimeout(r, 100));

    instance.unmount();
    await instance.waitUntilExit();

    const output = chunks.join("");
    expect(output).toContain("current:test valueX");
  });

  test("TextInput with useTextInput hook integration", () => {
    // Verify the hook + component integration renders correctly
    function IntegrationTest(): React.ReactElement {
      const single = useTextInput({ initialValue: "single" });
      const multi = useTextInput({ initialValue: "line1\nline2" });

      return (
        <Box flexDirection="column">
          <TextInput value={single.value} onChange={single.onChange} />
          <TextInput
            value={multi.value}
            onChange={multi.onChange}
            multiline={true}
          />
        </Box>
      );
    }

    const output = renderToString(<IntegrationTest />);
    expect(output).toContain("single");
    expect(output).toContain("line1");
    expect(output).toContain("line2");
  });
});
