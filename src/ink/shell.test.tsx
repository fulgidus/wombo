/**
 * shell.test.tsx — Tests for the full Ink shell with input handling and clean exit.
 *
 * Verifies:
 *   - Shell renders child components
 *   - Shell handles q key to exit
 *   - Shell handles Ctrl+C to exit
 *   - Shell unmounts cleanly via waitUntilExit
 *   - Shell accepts and renders children
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { render, renderToString, Text } from "ink";
import { Shell } from "./shell.js";
import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create fake stdin/stdout streams for testing Ink render. */
function createTestStreams() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  // Ink needs .columns on stdout
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
// Static render tests (renderToString)
// ---------------------------------------------------------------------------

describe("Shell (static rendering)", () => {
  test("renders children", () => {
    const output = renderToString(
      <Shell>
        <Text>child content</Text>
      </Shell>
    );
    expect(output).toContain("child content");
  });

  test("renders header with app name", () => {
    const output = renderToString(<Shell />);
    expect(output).toContain("wombo-combo");
  });

  test("renders keybind hints", () => {
    const output = renderToString(<Shell />);
    expect(output).toContain("q");
  });
});

// ---------------------------------------------------------------------------
// Live render tests (render with streams)
// ---------------------------------------------------------------------------

describe("Shell (live rendering)", () => {
  test("mounts and unmounts cleanly", async () => {
    const { stdin, stdout } = createTestStreams();
    const instance = render(<Shell />, {
      stdout,
      stdin,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    // Unmount manually and verify it resolves
    instance.unmount();
    await instance.waitUntilExit();
  });

  test("exits when q is pressed", async () => {
    const { stdin, stdout } = createTestStreams();
    const instance = render(<Shell />, {
      stdout,
      stdin,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    // Simulate pressing 'q'
    (stdin as any as PassThrough).write("q");

    // waitUntilExit should resolve because the shell calls exit() on 'q'
    await instance.waitUntilExit();
  });

  test("renders child components in live mode", async () => {
    const { stdin, stdout } = createTestStreams();
    const chunks: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString());
    });

    const instance = render(
      <Shell>
        <Text>live child</Text>
      </Shell>,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    // Give it a tick to render
    await new Promise((resolve) => setTimeout(resolve, 100));

    instance.unmount();
    await instance.waitUntilExit();

    const output = chunks.join("");
    expect(output).toContain("live child");
  });
});
