/**
 * status-view.test.tsx — Tests for the StatusView component.
 *
 * Verifies:
 *   - StatusView renders a status message
 *   - StatusView accepts custom status text
 *   - StatusView displays a counter
 *   - StatusView can be mounted/unmounted as a child of Shell
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString, render, Text } from "ink";
import { StatusView } from "./status-view.js";
import { Shell } from "./shell.js";
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
// Tests
// ---------------------------------------------------------------------------

describe("StatusView", () => {
  test("renders default status message", () => {
    const output = renderToString(<StatusView />);
    expect(output).toContain("idle");
  });

  test("accepts custom status text", () => {
    const output = renderToString(<StatusView status="running" />);
    expect(output).toContain("running");
  });

  test("displays agent count", () => {
    const output = renderToString(<StatusView agentCount={5} />);
    expect(output).toContain("5");
  });

  test("mounts as child of Shell", () => {
    const output = renderToString(
      <Shell>
        <StatusView status="active" agentCount={3} />
      </Shell>
    );
    expect(output).toContain("active");
    expect(output).toContain("3");
  });

  test("can be dynamically swapped in live render", async () => {
    const { stdin, stdout } = createTestStreams();
    const chunks: string[] = [];
    stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString());
    });

    // Mount with StatusView
    const instance = render(
      <Shell>
        <StatusView status="first" />
      </Shell>,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Re-render with different child (proves child swap works)
    instance.rerender(
      <Shell>
        <StatusView status="second" />
      </Shell>
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    instance.unmount();
    await instance.waitUntilExit();

    const output = chunks.join("");
    expect(output).toContain("first");
    expect(output).toContain("second");
  });
});
