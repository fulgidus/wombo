/**
 * use-wishlist-store.test.ts — Tests for the useWishlistStore React hook.
 *
 * Verifies state management for wishlist items: load, add, delete, move,
 * and selection tracking. Uses a temp directory to avoid touching
 * the real .wombo-combo/wishlist.yml.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { addItem } from "../lib/wishlist-store";
import { useWishlistStore } from "./use-wishlist-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create fake stdin/stdout streams for testing Ink render. */
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

/** Result holder to capture hook state from a test component. */
interface HookResult {
  items: ReturnType<typeof useWishlistStore>["items"];
  selectedIndex: number;
  selectedItem: ReturnType<typeof useWishlistStore>["selectedItem"];
  store: ReturnType<typeof useWishlistStore>;
}

/**
 * Test component that exposes hook state to the test via a mutable ref.
 */
function TestComponent({
  projectRoot,
  resultRef,
}: {
  projectRoot: string;
  resultRef: { current: HookResult | null };
}) {
  const store = useWishlistStore({ projectRoot });
  resultRef.current = {
    items: store.items,
    selectedIndex: store.selectedIndex,
    selectedItem: store.selectedItem,
    store,
  };
  return null;
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "woco-wl-hook-test-"));
});

afterEach(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

describe("useWishlistStore loading", () => {
  test("loads empty wishlist", async () => {
    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current).not.toBeNull();
    expect(resultRef.current!.items).toEqual([]);
    expect(resultRef.current!.selectedIndex).toBe(0);
    expect(resultRef.current!.selectedItem).toBeNull();

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("loads existing wishlist items", async () => {
    // Pre-populate some items
    addItem(tempRoot, "Item A");
    addItem(tempRoot, "Item B");
    addItem(tempRoot, "Item C");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.items.length).toBe(3);
    expect(resultRef.current!.items[0].text).toBe("Item A");
    expect(resultRef.current!.items[1].text).toBe("Item B");
    expect(resultRef.current!.items[2].text).toBe("Item C");

    instance.unmount();
    await instance.waitUntilExit();
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe("useWishlistStore selection", () => {
  test("selectNext moves selection forward", async () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");
    addItem(tempRoot, "C");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.selectedIndex).toBe(0);

    resultRef.current!.store.selectNext();
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.selectedIndex).toBe(1);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("selectPrev moves selection backward", async () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Move to index 1
    resultRef.current!.store.selectNext();
    await new Promise((r) => setTimeout(r, 50));
    expect(resultRef.current!.selectedIndex).toBe(1);

    // Move back to index 0
    resultRef.current!.store.selectPrev();
    await new Promise((r) => setTimeout(r, 50));
    expect(resultRef.current!.selectedIndex).toBe(0);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("selectNext does not go past last item", async () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    resultRef.current!.store.selectNext();
    resultRef.current!.store.selectNext();
    resultRef.current!.store.selectNext(); // past end
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.selectedIndex).toBe(1); // clamped

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("selectPrev does not go below 0", async () => {
    addItem(tempRoot, "A");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    resultRef.current!.store.selectPrev();
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.selectedIndex).toBe(0);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("selectedItem returns the currently selected item", async () => {
    addItem(tempRoot, "Item X");
    addItem(tempRoot, "Item Y");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.selectedItem!.text).toBe("Item X");

    resultRef.current!.store.selectNext();
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.selectedItem!.text).toBe("Item Y");

    instance.unmount();
    await instance.waitUntilExit();
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("useWishlistStore deleteSelected", () => {
  test("removes the selected item", async () => {
    addItem(tempRoot, "Keep");
    addItem(tempRoot, "Delete Me");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Select second item
    resultRef.current!.store.selectNext();
    await new Promise((r) => setTimeout(r, 50));

    // Delete it
    resultRef.current!.store.deleteSelected();
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.items.length).toBe(1);
    expect(resultRef.current!.items[0].text).toBe("Keep");

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("adjusts selection when last item is deleted", async () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Select last item
    resultRef.current!.store.selectNext();
    await new Promise((r) => setTimeout(r, 50));
    expect(resultRef.current!.selectedIndex).toBe(1);

    // Delete it — selection should move to index 0
    resultRef.current!.store.deleteSelected();
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.items.length).toBe(1);
    expect(resultRef.current!.selectedIndex).toBe(0);

    instance.unmount();
    await instance.waitUntilExit();
  });
});

// ---------------------------------------------------------------------------
// Move (reorder)
// ---------------------------------------------------------------------------

describe("useWishlistStore moveSelectedUp/Down", () => {
  test("moveSelectedUp moves item up in order", async () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");
    addItem(tempRoot, "C");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Select B (index 1)
    resultRef.current!.store.selectNext();
    await new Promise((r) => setTimeout(r, 50));

    // Move B up → [B, A, C]
    resultRef.current!.store.moveSelectedUp();
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.items[0].text).toBe("B");
    expect(resultRef.current!.items[1].text).toBe("A");
    expect(resultRef.current!.selectedIndex).toBe(0);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("moveSelectedDown moves item down in order", async () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");
    addItem(tempRoot, "C");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Move A (index 0) down → [B, A, C]
    resultRef.current!.store.moveSelectedDown();
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.items[0].text).toBe("B");
    expect(resultRef.current!.items[1].text).toBe("A");
    expect(resultRef.current!.selectedIndex).toBe(1);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("moveSelectedUp at top does nothing", async () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Already at index 0
    resultRef.current!.store.moveSelectedUp();
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.items[0].text).toBe("A");
    expect(resultRef.current!.selectedIndex).toBe(0);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("moveSelectedDown at bottom does nothing", async () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Select last item
    resultRef.current!.store.selectNext();
    await new Promise((r) => setTimeout(r, 50));

    resultRef.current!.store.moveSelectedDown();
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.items[1].text).toBe("B");
    expect(resultRef.current!.selectedIndex).toBe(1);

    instance.unmount();
    await instance.waitUntilExit();
  });
});

// ---------------------------------------------------------------------------
// Add item
// ---------------------------------------------------------------------------

describe("useWishlistStore addNewItem", () => {
  test("adds a new item and selects it", async () => {
    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    resultRef.current!.store.addNewItem("New idea");
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.items.length).toBe(1);
    expect(resultRef.current!.items[0].text).toBe("New idea");
    expect(resultRef.current!.selectedIndex).toBe(0);

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("adding to non-empty list selects the new item at end", async () => {
    addItem(tempRoot, "Existing");

    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    resultRef.current!.store.addNewItem("Second item");
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.items.length).toBe(2);
    expect(resultRef.current!.selectedIndex).toBe(1); // selects new item
    expect(resultRef.current!.selectedItem!.text).toBe("Second item");

    instance.unmount();
    await instance.waitUntilExit();
  });

  test("returns false for empty text", async () => {
    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    const result = resultRef.current!.store.addNewItem("   ");
    expect(result).toBe(false);
    expect(resultRef.current!.items.length).toBe(0);

    instance.unmount();
    await instance.waitUntilExit();
  });
});

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

describe("useWishlistStore reload", () => {
  test("reload re-reads from disk", async () => {
    const { stdin, stdout } = createTestStreams();
    const resultRef: { current: HookResult | null } = { current: null };

    const instance = render(
      React.createElement(TestComponent, { projectRoot: tempRoot, resultRef }),
      { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(resultRef.current!.items.length).toBe(0);

    // Add item externally
    addItem(tempRoot, "External add");

    // Reload
    resultRef.current!.store.reload();
    await new Promise((r) => setTimeout(r, 50));

    expect(resultRef.current!.items.length).toBe(1);
    expect(resultRef.current!.items[0].text).toBe("External add");

    instance.unmount();
    await instance.waitUntilExit();
  });
});
