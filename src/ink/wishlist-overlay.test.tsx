/**
 * wishlist-overlay.test.tsx — Tests for the WishlistOverlay Ink component.
 *
 * Verifies:
 *   - Renders as a modal with item count in label
 *   - Renders item list
 *   - Shows empty state when no items
 *   - Renders keybind hints in footer
 *   - A key shows input for adding new items
 *   - D/X key deletes the selected item
 *   - Escape triggers onClose callback
 *   - W key triggers onClose callback
 *   - Shift+Up/Down reorders items
 *   - +/- keys reorder items
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import React from "react";
import { render, renderToString } from "ink";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addItem, loadWishlist } from "../lib/wishlist-store";
import { WishlistOverlay } from "./wishlist-overlay";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestStreams() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 120;
  (stdout as any).rows = 40;
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

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "woco-overlay-test-"));
});

afterEach(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Static render tests
// ---------------------------------------------------------------------------

describe("WishlistOverlay (static rendering)", () => {
  test("renders Wishlist label with item count", () => {
    const output = renderToString(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );
    expect(output).toContain("Wishlist");
    expect(output).toContain("0 items");
  });

  test("renders item count when items exist", () => {
    addItem(tempRoot, "Item A");
    addItem(tempRoot, "Item B");
    addItem(tempRoot, "Item C");

    const output = renderToString(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );
    expect(output).toContain("3 items");
  });

  test("renders empty state message", () => {
    const output = renderToString(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );
    expect(output).toContain("No wishlist items");
  });

  test("renders item text", () => {
    addItem(tempRoot, "Buy new keyboard");

    const output = renderToString(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );
    expect(output).toContain("Buy new keyboard");
  });

  test("renders keybind footer", () => {
    const output = renderToString(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );
    expect(output).toContain("add");
    expect(output).toContain("delete");
    expect(output).toContain("close");
  });
});

// ---------------------------------------------------------------------------
// Keybind tests (live render)
// ---------------------------------------------------------------------------

describe("WishlistOverlay keybinds", () => {
  test("Escape triggers onClose", async () => {
    const onClose = mock(() => {});

    const { stdin, cleanup } = renderLive(
      <WishlistOverlay projectRoot={tempRoot} onClose={onClose} />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 50));

    expect(onClose).toHaveBeenCalled();

    await cleanup();
  });

  test("W key triggers onClose", async () => {
    const onClose = mock(() => {});

    const { stdin, cleanup } = renderLive(
      <WishlistOverlay projectRoot={tempRoot} onClose={onClose} />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("w");
    await new Promise((r) => setTimeout(r, 50));

    expect(onClose).toHaveBeenCalled();

    await cleanup();
  });

  test("D key deletes the selected item", async () => {
    addItem(tempRoot, "Keep");
    addItem(tempRoot, "Delete me");

    const { stdin, getOutput, cleanup } = renderLive(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );

    await new Promise((r) => setTimeout(r, 50));

    // Move down to second item
    stdin.write("\x1b[B");
    await new Promise((r) => setTimeout(r, 50));

    // Delete
    stdin.write("d");
    await new Promise((r) => setTimeout(r, 100));

    // Check that item was deleted from disk
    const items = loadWishlist(tempRoot);
    expect(items.length).toBe(1);
    expect(items[0].text).toBe("Keep");

    await cleanup();
  });

  test("X key also deletes the selected item", async () => {
    addItem(tempRoot, "Item to delete");

    const { stdin, cleanup } = renderLive(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("x");
    await new Promise((r) => setTimeout(r, 100));

    const items = loadWishlist(tempRoot);
    expect(items.length).toBe(0);

    await cleanup();
  });

  test("A key enters add mode and shows input prompt", async () => {
    const { stdin, getOutput, cleanup } = renderLive(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("a");
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    // In add mode, the footer should show Enter/Esc hints
    expect(output).toContain("save");

    await cleanup();
  });

  test("submitting new item in add mode adds it", async () => {
    const { stdin, cleanup } = renderLive(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );

    await new Promise((r) => setTimeout(r, 50));

    // Enter add mode
    stdin.write("a");
    await new Promise((r) => setTimeout(r, 50));

    // Type item text
    stdin.write("New wishlist idea");
    await new Promise((r) => setTimeout(r, 50));

    // Submit with Enter
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 100));

    const items = loadWishlist(tempRoot);
    expect(items.length).toBe(1);
    expect(items[0].text).toBe("New wishlist idea");

    await cleanup();
  });

  test("Escape in add mode cancels without adding", async () => {
    const onClose = mock(() => {});

    const { stdin, cleanup } = renderLive(
      <WishlistOverlay projectRoot={tempRoot} onClose={onClose} />
    );

    await new Promise((r) => setTimeout(r, 50));

    // Enter add mode
    stdin.write("a");
    await new Promise((r) => setTimeout(r, 50));

    // Type something
    stdin.write("draft");
    await new Promise((r) => setTimeout(r, 50));

    // Cancel with Escape
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 100));

    // Should not have added the item
    const items = loadWishlist(tempRoot);
    expect(items.length).toBe(0);

    // Should NOT have closed the overlay (Esc in add mode cancels add, not overlay)
    expect(onClose).not.toHaveBeenCalled();

    await cleanup();
  });

  test("+ key moves the selected item down", async () => {
    addItem(tempRoot, "First item");
    addItem(tempRoot, "Second item");

    const { stdin, cleanup } = renderLive(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );

    await new Promise((r) => setTimeout(r, 50));

    // Press + to move first item down
    stdin.write("+");
    await new Promise((r) => setTimeout(r, 100));

    // Verify reorder happened on disk
    const items = loadWishlist(tempRoot);
    expect(items[0].text).toBe("Second item");
    expect(items[1].text).toBe("First item");

    await cleanup();
  });

  test("- key moves the selected item up", async () => {
    addItem(tempRoot, "First item");
    addItem(tempRoot, "Second item");

    const { stdin, cleanup } = renderLive(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );

    await new Promise((r) => setTimeout(r, 50));

    // Move to second item
    stdin.write("\x1b[B"); // down arrow
    await new Promise((r) => setTimeout(r, 50));

    // Press - to move second item up
    stdin.write("-");
    await new Promise((r) => setTimeout(r, 100));

    // Verify reorder happened on disk
    const items = loadWishlist(tempRoot);
    expect(items[0].text).toBe("Second item");
    expect(items[1].text).toBe("First item");

    await cleanup();
  });

  test("footer shows +/- for reorder hint (not S-↑/↓)", () => {
    const output = renderToString(
      <WishlistOverlay projectRoot={tempRoot} onClose={() => {}} />
    );
    // Should show +/- hint, NOT S-↑/↓
    expect(output).toContain("+");
    expect(output).toContain("-");
    expect(output).toContain("reorder");
    expect(output).not.toContain("S-");
  });

  test("delete does nothing on empty list", async () => {
    const onClose = mock(() => {});

    const { stdin, cleanup } = renderLive(
      <WishlistOverlay projectRoot={tempRoot} onClose={onClose} />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("d");
    await new Promise((r) => setTimeout(r, 50));

    // Should not crash, onClose should not be called
    expect(onClose).not.toHaveBeenCalled();

    await cleanup();
  });
});
