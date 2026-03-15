/**
 * wishlist-store.test.ts — Tests for wishlist-store CRUD + ordering.
 *
 * Uses a temp directory so we don't touch the real .wombo-combo/wishlist.yml.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WOMBO_DIR } from "../src/config.js";

import {
  loadWishlist,
  addItem,
  deleteItem,
  listItems,
  moveItem,
} from "../src/lib/wishlist-store.js";

let tempRoot: string;

beforeEach(() => {
  // Create a fresh temp dir for each test so ordering doesn't leak
  tempRoot = mkdtempSync(join(tmpdir(), "woco-wl-test-"));
});

afterAll(() => {
  // Clean up all temp dirs (best-effort)
  try {
    // The last tempRoot; individual tests clean up via mkdtemp prefix
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Basic CRUD
// ---------------------------------------------------------------------------

describe("wishlist-store CRUD", () => {
  test("loadWishlist returns [] for non-existent file", () => {
    const items = loadWishlist(tempRoot);
    expect(items).toEqual([]);
  });

  test("addItem creates an item with auto-assigned order", () => {
    const item = addItem(tempRoot, "First idea");
    expect(item.text).toBe("First idea");
    expect(item.order).toBe(1);
    expect(item.tags).toEqual([]);
    expect(item.id).toBeTruthy();
    expect(item.created_at).toBeTruthy();
  });

  test("addItem assigns sequential orders", () => {
    const a = addItem(tempRoot, "Item A");
    const b = addItem(tempRoot, "Item B");
    const c = addItem(tempRoot, "Item C");

    expect(a.order).toBe(1);
    expect(b.order).toBe(2);
    expect(c.order).toBe(3);

    const items = listItems(tempRoot);
    expect(items.length).toBe(3);
    expect(items[0].text).toBe("Item A");
    expect(items[1].text).toBe("Item B");
    expect(items[2].text).toBe("Item C");
  });

  test("addItem with tags", () => {
    const item = addItem(tempRoot, "Tagged idea", ["ui", "  perf  ", ""]);
    expect(item.tags).toEqual(["ui", "perf"]); // trimmed, empty filtered
  });

  test("addItem throws on empty text", () => {
    expect(() => addItem(tempRoot, "   ")).toThrow("empty");
  });

  test("deleteItem removes by ID", () => {
    const a = addItem(tempRoot, "Keep me");
    const b = addItem(tempRoot, "Delete me");

    const deleted = deleteItem(tempRoot, b.id);
    expect(deleted).toBe(true);

    const remaining = listItems(tempRoot);
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(a.id);
  });

  test("deleteItem returns false for unknown ID", () => {
    addItem(tempRoot, "Exists");
    const deleted = deleteItem(tempRoot, "nonexistent-uuid");
    expect(deleted).toBe(false);
  });

  test("listItems returns items sorted by order", () => {
    addItem(tempRoot, "First");
    addItem(tempRoot, "Second");
    addItem(tempRoot, "Third");

    const items = listItems(tempRoot);
    expect(items.map((i) => i.text)).toEqual(["First", "Second", "Third"]);
    expect(items.map((i) => i.order)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// moveItem
// ---------------------------------------------------------------------------

describe("wishlist-store moveItem", () => {
  test("move item to a different position", () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");
    addItem(tempRoot, "C");
    addItem(tempRoot, "D");

    // Move D (position 4) to position 2
    const items = listItems(tempRoot);
    const d = items.find((i) => i.text === "D")!;
    const moved = moveItem(tempRoot, d.id, 2);

    expect(moved).not.toBeNull();
    expect(moved!.order).toBe(2);

    const after = listItems(tempRoot);
    expect(after.map((i) => i.text)).toEqual(["A", "D", "B", "C"]);
    expect(after.map((i) => i.order)).toEqual([1, 2, 3, 4]);
  });

  test("move item to position 1 (top)", () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");
    addItem(tempRoot, "C");

    const items = listItems(tempRoot);
    const c = items.find((i) => i.text === "C")!;
    moveItem(tempRoot, c.id, 1);

    const after = listItems(tempRoot);
    expect(after.map((i) => i.text)).toEqual(["C", "A", "B"]);
    expect(after.map((i) => i.order)).toEqual([1, 2, 3]);
  });

  test("move item to last position", () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");
    addItem(tempRoot, "C");

    const items = listItems(tempRoot);
    const a = items.find((i) => i.text === "A")!;
    moveItem(tempRoot, a.id, 3);

    const after = listItems(tempRoot);
    expect(after.map((i) => i.text)).toEqual(["B", "C", "A"]);
    expect(after.map((i) => i.order)).toEqual([1, 2, 3]);
  });

  test("move item to same position is a no-op", () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");
    addItem(tempRoot, "C");

    const items = listItems(tempRoot);
    const b = items.find((i) => i.text === "B")!;
    moveItem(tempRoot, b.id, 2);

    const after = listItems(tempRoot);
    expect(after.map((i) => i.text)).toEqual(["A", "B", "C"]);
    expect(after.map((i) => i.order)).toEqual([1, 2, 3]);
  });

  test("move clamps position to valid range (too large)", () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");

    const items = listItems(tempRoot);
    const a = items.find((i) => i.text === "A")!;
    moveItem(tempRoot, a.id, 999);

    const after = listItems(tempRoot);
    expect(after.map((i) => i.text)).toEqual(["B", "A"]);
    expect(after.map((i) => i.order)).toEqual([1, 2]);
  });

  test("move clamps position to valid range (zero/negative)", () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");

    const items = listItems(tempRoot);
    const b = items.find((i) => i.text === "B")!;
    moveItem(tempRoot, b.id, 0);

    const after = listItems(tempRoot);
    expect(after.map((i) => i.text)).toEqual(["B", "A"]);
    expect(after.map((i) => i.order)).toEqual([1, 2]);
  });

  test("move returns null for unknown ID", () => {
    addItem(tempRoot, "A");
    const result = moveItem(tempRoot, "nonexistent-uuid", 1);
    expect(result).toBeNull();
  });

  test("sequential moves maintain consistent ordering", () => {
    addItem(tempRoot, "A");
    addItem(tempRoot, "B");
    addItem(tempRoot, "C");
    addItem(tempRoot, "D");
    addItem(tempRoot, "E");

    // Move A to position 3, then E to position 1
    let items = listItems(tempRoot);
    const a = items.find((i) => i.text === "A")!;
    moveItem(tempRoot, a.id, 3);

    items = listItems(tempRoot);
    expect(items.map((i) => i.text)).toEqual(["B", "C", "A", "D", "E"]);

    const e = items.find((i) => i.text === "E")!;
    moveItem(tempRoot, e.id, 1);

    const final = listItems(tempRoot);
    expect(final.map((i) => i.text)).toEqual(["E", "B", "C", "A", "D"]);
    expect(final.map((i) => i.order)).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// Order normalization for legacy files
// ---------------------------------------------------------------------------

describe("wishlist-store order normalization", () => {
  test("items without order field get fallback order from array index", () => {
    // Simulate loading a legacy file by writing YAML directly
    const { writeFileSync, mkdirSync } = require("node:fs");
    const { resolve } = require("node:path");
    const { stringify } = require("yaml");

    const dir = resolve(tempRoot, WOMBO_DIR);
    mkdirSync(dir, { recursive: true });

    // Write items without order field
    const legacyItems = [
      { id: "aaa", text: "Legacy A", created_at: "2025-01-01T00:00:00Z", tags: [] },
      { id: "bbb", text: "Legacy B", created_at: "2025-01-02T00:00:00Z", tags: ["ui"] },
      { id: "ccc", text: "Legacy C", created_at: "2025-01-03T00:00:00Z", tags: [] },
    ];
    writeFileSync(resolve(dir, "wishlist.yml"), stringify(legacyItems), "utf-8");

    const items = loadWishlist(tempRoot);
    expect(items.length).toBe(3);
    // Should get fallback order from array index (1-based)
    expect(items[0].order).toBe(1);
    expect(items[1].order).toBe(2);
    expect(items[2].order).toBe(3);
    expect(items[0].text).toBe("Legacy A");
  });
});
