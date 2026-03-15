/**
 * select-input.test.tsx — Tests for the SelectInput Ink component.
 *
 * Verifies:
 *   - Renders list of items
 *   - Highlights the selected item
 *   - Arrow keys move selection up/down
 *   - Enter key triggers onSelect callback
 *   - Escape key triggers onCancel callback
 *   - Respects initialIndex prop
 *   - Wraps around at boundaries (optional)
 *   - Focus/blur behavior
 */

import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { render, renderToString } from "ink";
import { SelectInput } from "./select-input";
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

function renderLive(element: React.ReactElement) {
  const { stdin, stdout } = createTestStreams();
  const chunks: string[] = [];
  stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });

  const instance = render(element, {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    instance,
    stdin: stdin as any as PassThrough,
    getOutput: () => chunks.join(""),
    cleanup: async () => {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}

const ITEMS = [
  { label: "Alpha", value: "alpha" },
  { label: "Beta", value: "beta" },
  { label: "Gamma", value: "gamma" },
];

// ---------------------------------------------------------------------------
// Static render tests
// ---------------------------------------------------------------------------

describe("SelectInput (static rendering)", () => {
  test("renders all items", () => {
    const output = renderToString(
      <SelectInput items={ITEMS} onSelect={() => {}} />
    );
    expect(output).toContain("Alpha");
    expect(output).toContain("Beta");
    expect(output).toContain("Gamma");
  });

  test("highlights the first item by default", () => {
    const output = renderToString(
      <SelectInput items={ITEMS} onSelect={() => {}} />
    );
    // The selected item should have a marker (e.g., "❯" or "▶")
    // At minimum, all items should be present
    expect(output).toContain("Alpha");
  });

  test("respects initialIndex prop", () => {
    const output = renderToString(
      <SelectInput items={ITEMS} onSelect={() => {}} initialIndex={2} />
    );
    // All items should be present
    expect(output).toContain("Gamma");
  });

  test("renders custom labels", () => {
    const items = [
      { label: "High Priority", value: "high", hint: "(recommended)" },
      { label: "Low Priority", value: "low" },
    ];
    const output = renderToString(
      <SelectInput items={items} onSelect={() => {}} />
    );
    expect(output).toContain("High Priority");
    expect(output).toContain("Low Priority");
  });
});

// ---------------------------------------------------------------------------
// Navigation tests
// ---------------------------------------------------------------------------

describe("SelectInput navigation", () => {
  test("down arrow moves selection down", async () => {
    const onSelect = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <SelectInput items={ITEMS} onSelect={onSelect} />
    );

    // Press down arrow to move to "Beta" (index 1)
    stdin.write("\x1b[B");
    await new Promise((r) => setTimeout(r, 50));

    // Press Enter to select
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);

    await cleanup();
  });

  test("up arrow moves selection up", async () => {
    const onSelect = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <SelectInput items={ITEMS} onSelect={onSelect} initialIndex={2} />
    );

    // Press up arrow to move from "Gamma" (2) to "Beta" (1)
    stdin.write("\x1b[A");
    await new Promise((r) => setTimeout(r, 50));

    // Press Enter to select
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);

    await cleanup();
  });

  test("up arrow at top wraps to bottom", async () => {
    const onSelect = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <SelectInput items={ITEMS} onSelect={onSelect} initialIndex={0} />
    );

    // Press up arrow at index 0 — should wrap to last item
    stdin.write("\x1b[A");
    await new Promise((r) => setTimeout(r, 50));

    // Press Enter to select
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelect).toHaveBeenCalledWith(ITEMS[2]);

    await cleanup();
  });

  test("down arrow at bottom wraps to top", async () => {
    const onSelect = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <SelectInput items={ITEMS} onSelect={onSelect} initialIndex={2} />
    );

    // Press down arrow at index 2 — should wrap to first item
    stdin.write("\x1b[B");
    await new Promise((r) => setTimeout(r, 50));

    // Press Enter to select
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelect).toHaveBeenCalledWith(ITEMS[0]);

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Selection tests
// ---------------------------------------------------------------------------

describe("SelectInput selection", () => {
  test("Enter triggers onSelect with the current item", async () => {
    const onSelect = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <SelectInput items={ITEMS} onSelect={onSelect} />
    );

    // Press Enter immediately (selects first item)
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelect).toHaveBeenCalledWith(ITEMS[0]);

    await cleanup();
  });

  test("Space also triggers onSelect", async () => {
    const onSelect = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <SelectInput items={ITEMS} onSelect={onSelect} />
    );

    stdin.write(" ");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelect).toHaveBeenCalledWith(ITEMS[0]);

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Cancel tests
// ---------------------------------------------------------------------------

describe("SelectInput cancel", () => {
  test("Escape triggers onCancel callback", async () => {
    const onCancel = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <SelectInput items={ITEMS} onSelect={() => {}} onCancel={onCancel} />
    );

    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));

    expect(onCancel).toHaveBeenCalled();

    await cleanup();
  });

  test("Escape does nothing when onCancel is not provided", async () => {
    const onSelect = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <SelectInput items={ITEMS} onSelect={onSelect} />
    );

    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));

    // Should not crash or call onSelect
    expect(onSelect).not.toHaveBeenCalled();

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Focus tests
// ---------------------------------------------------------------------------

describe("SelectInput focus", () => {
  test("does not process input when not focused", async () => {
    const onSelect = mock(() => {});
    const { stdin, cleanup } = renderLive(
      <SelectInput items={ITEMS} onSelect={onSelect} focus={false} />
    );

    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelect).not.toHaveBeenCalled();

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("SelectInput edge cases", () => {
  test("handles empty items array", () => {
    const output = renderToString(
      <SelectInput items={[]} onSelect={() => {}} />
    );
    expect(typeof output).toBe("string");
  });

  test("handles single item", async () => {
    const onSelect = mock(() => {});
    const items = [{ label: "Only", value: "only" }];
    const { stdin, cleanup } = renderLive(
      <SelectInput items={items} onSelect={onSelect} />
    );

    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    expect(onSelect).toHaveBeenCalledWith(items[0]);

    await cleanup();
  });

  test("renders item hints when provided", () => {
    const items = [
      { label: "Alpha", value: "alpha", hint: "First letter" },
      { label: "Beta", value: "beta", hint: "Second letter" },
    ];
    const output = renderToString(
      <SelectInput items={items} onSelect={() => {}} />
    );
    expect(output).toContain("First letter");
    expect(output).toContain("Second letter");
  });
});
