/**
 * use-spinner.test.tsx — Tests for the useSpinner hook.
 *
 * Verifies:
 *   - Hook increments frame counter when active
 *   - Hook stops incrementing when active is false
 *   - Hook returns frame 0 initially
 */

import { describe, test, expect, mock } from "bun:test";
import React, { useState, useEffect } from "react";
import { render, renderToString, Text } from "ink";
import { useSpinner } from "./use-spinner";
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

// Test component that uses the hook and calls back with the frame value
function SpinnerDisplay({ active, onFrame }: { active: boolean; onFrame: (f: number) => void }) {
  const frame = useSpinner(active);
  useEffect(() => {
    onFrame(frame);
  }, [frame, onFrame]);
  return <Text>frame:{frame}</Text>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSpinner", () => {
  test("returns initial frame 0", () => {
    const output = renderToString(
      <SpinnerDisplay active={false} onFrame={() => {}} />
    );
    expect(output).toContain("frame:0");
  });

  test("increments frame when active", async () => {
    const { stdin, stdout } = createTestStreams();
    const frames: number[] = [];

    const instance = render(
      <SpinnerDisplay active={true} onFrame={(f) => frames.push(f)} />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    // Wait for a few spinner ticks (120ms interval)
    await new Promise((r) => setTimeout(r, 500));

    instance.unmount();
    await instance.waitUntilExit();

    // Should have seen frame 0 and at least one increment
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[0]).toBe(0);
    // Later frames should be > 0
    const maxFrame = Math.max(...frames);
    expect(maxFrame).toBeGreaterThan(0);
  });

  test("stops incrementing when active is false", async () => {
    const { stdin, stdout } = createTestStreams();
    const frames: number[] = [];

    const instance = render(
      <SpinnerDisplay active={false} onFrame={(f) => frames.push(f)} />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 300));

    instance.unmount();
    await instance.waitUntilExit();

    // All frames should be 0 since active=false
    for (const f of frames) {
      expect(f).toBe(0);
    }
  });
});
