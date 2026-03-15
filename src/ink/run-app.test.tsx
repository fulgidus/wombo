/**
 * run-app.test.tsx — Tests for the Ink app launcher function.
 *
 * Verifies:
 *   - runApp mounts the Shell and returns an Instance
 *   - runApp accepts custom children
 *   - The instance can be unmounted and waited on
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { Text } from "ink";
import { runApp, type RunAppOptions } from "./run-app.js";
import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestOptions(): RunAppOptions {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 80;
  (stdout as any).rows = 24;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = () => stdin;
  (stdin as any).ref = () => stdin;
  (stdin as any).unref = () => stdin;
  return {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runApp", () => {
  test("returns an instance with unmount and waitUntilExit", async () => {
    const opts = createTestOptions();
    const instance = runApp(opts);

    expect(instance).toBeDefined();
    expect(typeof instance.unmount).toBe("function");
    expect(typeof instance.waitUntilExit).toBe("function");

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("accepts custom children", async () => {
    const opts = createTestOptions();
    const chunks: string[] = [];
    opts.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString());
    });

    const instance = runApp({
      ...opts,
      children: <Text>custom child</Text>,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    instance.unmount();
    await instance.waitUntilExit();

    const output = chunks.join("");
    expect(output).toContain("custom child");
  });

  test("exits cleanly when q is pressed via stdin", async () => {
    const opts = createTestOptions();
    const instance = runApp(opts);

    // Simulate pressing 'q'
    (opts.stdin as any as PassThrough).write("q");

    // Should resolve without hanging
    await instance.waitUntilExit();
  });
});
