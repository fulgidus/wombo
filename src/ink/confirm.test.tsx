/**
 * confirm.test.tsx — Tests for the ConfirmDialog Ink component.
 *
 * Verifies:
 *   - Renders title and message
 *   - Renders Y/N keybind hints
 *   - Calls onConfirm(true) when Y is pressed
 *   - Calls onConfirm(false) when N is pressed
 *   - Calls onConfirm(false) when Escape is pressed
 *   - Renders without crashing
 */

import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { render, renderToString, Text } from "ink";
import { ConfirmDialog } from "./confirm";
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
// Static render tests
// ---------------------------------------------------------------------------

describe("ConfirmDialog (static rendering)", () => {
  test("renders title", () => {
    const output = renderToString(
      <ConfirmDialog title="Confirm Action" message="Are you sure?" onConfirm={() => {}} />
    );
    expect(output).toContain("Confirm Action");
  });

  test("renders message", () => {
    const output = renderToString(
      <ConfirmDialog title="Test" message="Do you want to proceed?" onConfirm={() => {}} />
    );
    expect(output).toContain("Do you want to proceed?");
  });

  test("renders keybind hints", () => {
    const output = renderToString(
      <ConfirmDialog title="Test" message="Message" onConfirm={() => {}} />
    );
    expect(output).toContain("Y");
    expect(output).toContain("N");
  });

  test("renders without crashing", () => {
    expect(() =>
      renderToString(
        <ConfirmDialog title="Test" message="Message" onConfirm={() => {}} />
      )
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Interaction tests
// ---------------------------------------------------------------------------

describe("ConfirmDialog (interactions)", () => {
  test("calls onConfirm(true) when Y is pressed", async () => {
    const { stdin, stdout } = createTestStreams();
    const onConfirm = mock(() => {});

    const instance = render(
      <ConfirmDialog title="Test" message="Proceed?" onConfirm={onConfirm} />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    (stdin as any as PassThrough).write("y");
    await new Promise((r) => setTimeout(r, 50));

    expect(onConfirm).toHaveBeenCalledWith(true);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("calls onConfirm(false) when N is pressed", async () => {
    const { stdin, stdout } = createTestStreams();
    const onConfirm = mock(() => {});

    const instance = render(
      <ConfirmDialog title="Test" message="Proceed?" onConfirm={onConfirm} />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    (stdin as any as PassThrough).write("n");
    await new Promise((r) => setTimeout(r, 50));

    expect(onConfirm).toHaveBeenCalledWith(false);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("calls onConfirm(false) when Escape is pressed", async () => {
    const { stdin, stdout } = createTestStreams();
    const onConfirm = mock(() => {});

    const instance = render(
      <ConfirmDialog title="Test" message="Proceed?" onConfirm={onConfirm} />,
      {
        stdout,
        stdin,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await new Promise((r) => setTimeout(r, 50));
    (stdin as any as PassThrough).write("\x1b");
    await new Promise((r) => setTimeout(r, 50));

    expect(onConfirm).toHaveBeenCalledWith(false);

    instance.unmount();
    await instance.waitUntilExit();
  });
});
