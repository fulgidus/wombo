/**
 * use-review-list.test.ts — Tests for the useReviewList hook.
 *
 * Verifies:
 *   - Initial state (all items accepted, selectedIndex = 0)
 *   - toggleAccept flips a single item
 *   - toggleAll flips all items
 *   - moveItem reorders items up/down with bounds checking
 *   - selectItem changes the selected index
 *   - getAcceptedItems returns only accepted items
 *   - getCounts returns correct accepted/rejected counts
 *   - updateItem replaces an item in the list
 */

import { describe, test, expect } from "bun:test";
import {
  createReviewState,
  toggleAccept,
  toggleAll,
  moveItem,
  selectItem,
  getAcceptedItems,
  getCounts,
  updateItem,
  type ReviewState,
} from "./use-review-list";
import type { ReviewItem } from "./review-list-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(id: string, overrides?: Partial<ReviewItem>): ReviewItem {
  return {
    id,
    title: `Title for ${id}`,
    priority: "medium",
    difficulty: "easy",
    dependsOn: [],
    accepted: true,
    detailFields: [],
    detailSections: [],
    ...overrides,
  };
}

function makeItems(count: number): ReviewItem[] {
  return Array.from({ length: count }, (_, i) => makeItem(`item-${i + 1}`));
}

// ---------------------------------------------------------------------------
// createReviewState
// ---------------------------------------------------------------------------

describe("createReviewState", () => {
  test("creates state from items with all accepted by default", () => {
    const items = makeItems(3);
    const state = createReviewState(items);

    expect(state.items).toHaveLength(3);
    expect(state.selectedIndex).toBe(0);
    expect(state.items.every((i) => i.accepted)).toBe(true);
  });

  test("creates empty state from empty array", () => {
    const state = createReviewState([]);
    expect(state.items).toHaveLength(0);
    expect(state.selectedIndex).toBe(0);
  });

  test("preserves item accepted state if already set", () => {
    const items = [
      makeItem("a", { accepted: false }),
      makeItem("b", { accepted: true }),
    ];
    const state = createReviewState(items);
    expect(state.items[0].accepted).toBe(false);
    expect(state.items[1].accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toggleAccept
// ---------------------------------------------------------------------------

describe("toggleAccept", () => {
  test("toggles item at selectedIndex from accepted to rejected", () => {
    const state = createReviewState(makeItems(3));
    const next = toggleAccept(state);

    expect(next.items[0].accepted).toBe(false);
    expect(next.items[1].accepted).toBe(true);
    expect(next.items[2].accepted).toBe(true);
  });

  test("toggles item at selectedIndex from rejected to accepted", () => {
    const items = [makeItem("a", { accepted: false }), makeItem("b")];
    const state = createReviewState(items);
    const next = toggleAccept(state);

    expect(next.items[0].accepted).toBe(true);
  });

  test("returns unchanged state for empty items", () => {
    const state = createReviewState([]);
    const next = toggleAccept(state);
    expect(next.items).toHaveLength(0);
  });

  test("returns unchanged state for out-of-bounds index", () => {
    const state: ReviewState = {
      items: makeItems(2),
      selectedIndex: 5,
    };
    const next = toggleAccept(state);
    // Should not crash, items unchanged
    expect(next.items[0].accepted).toBe(true);
    expect(next.items[1].accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toggleAll
// ---------------------------------------------------------------------------

describe("toggleAll", () => {
  test("rejects all when all are accepted", () => {
    const state = createReviewState(makeItems(3));
    const next = toggleAll(state);

    expect(next.items.every((i) => !i.accepted)).toBe(true);
  });

  test("accepts all when some are rejected", () => {
    const items = [
      makeItem("a", { accepted: false }),
      makeItem("b", { accepted: true }),
    ];
    const state = createReviewState(items);
    const next = toggleAll(state);

    expect(next.items.every((i) => i.accepted)).toBe(true);
  });

  test("accepts all when all are rejected", () => {
    const items = [
      makeItem("a", { accepted: false }),
      makeItem("b", { accepted: false }),
    ];
    const state = createReviewState(items);
    const next = toggleAll(state);

    expect(next.items.every((i) => i.accepted)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// moveItem
// ---------------------------------------------------------------------------

describe("moveItem", () => {
  test("moves selected item up", () => {
    const items = makeItems(3);
    const state: ReviewState = { items, selectedIndex: 1 };
    const next = moveItem(state, -1);

    expect(next.items[0].id).toBe("item-2");
    expect(next.items[1].id).toBe("item-1");
    expect(next.selectedIndex).toBe(0);
  });

  test("moves selected item down", () => {
    const items = makeItems(3);
    const state: ReviewState = { items, selectedIndex: 0 };
    const next = moveItem(state, 1);

    expect(next.items[0].id).toBe("item-2");
    expect(next.items[1].id).toBe("item-1");
    expect(next.selectedIndex).toBe(1);
  });

  test("does nothing when moving up at top", () => {
    const items = makeItems(3);
    const state: ReviewState = { items, selectedIndex: 0 };
    const next = moveItem(state, -1);

    expect(next.items[0].id).toBe("item-1");
    expect(next.selectedIndex).toBe(0);
  });

  test("does nothing when moving down at bottom", () => {
    const items = makeItems(3);
    const state: ReviewState = { items, selectedIndex: 2 };
    const next = moveItem(state, 1);

    expect(next.items[2].id).toBe("item-3");
    expect(next.selectedIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// selectItem
// ---------------------------------------------------------------------------

describe("selectItem", () => {
  test("changes selected index", () => {
    const state = createReviewState(makeItems(3));
    const next = selectItem(state, 2);
    expect(next.selectedIndex).toBe(2);
  });

  test("clamps to valid range", () => {
    const state = createReviewState(makeItems(3));
    const next = selectItem(state, 10);
    expect(next.selectedIndex).toBe(2);
  });

  test("clamps negative to 0", () => {
    const state = createReviewState(makeItems(3));
    const next = selectItem(state, -1);
    expect(next.selectedIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getAcceptedItems
// ---------------------------------------------------------------------------

describe("getAcceptedItems", () => {
  test("returns only accepted items", () => {
    const items = [
      makeItem("a", { accepted: true }),
      makeItem("b", { accepted: false }),
      makeItem("c", { accepted: true }),
    ];
    const state = createReviewState(items);
    const accepted = getAcceptedItems(state);

    expect(accepted).toHaveLength(2);
    expect(accepted[0].id).toBe("a");
    expect(accepted[1].id).toBe("c");
  });

  test("returns empty array when none accepted", () => {
    const items = [
      makeItem("a", { accepted: false }),
      makeItem("b", { accepted: false }),
    ];
    const state = createReviewState(items);
    expect(getAcceptedItems(state)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getCounts
// ---------------------------------------------------------------------------

describe("getCounts", () => {
  test("counts accepted and rejected items", () => {
    const items = [
      makeItem("a", { accepted: true }),
      makeItem("b", { accepted: false }),
      makeItem("c", { accepted: true }),
    ];
    const state = createReviewState(items);
    const counts = getCounts(state);

    expect(counts.total).toBe(3);
    expect(counts.accepted).toBe(2);
    expect(counts.rejected).toBe(1);
  });

  test("handles all accepted", () => {
    const state = createReviewState(makeItems(3));
    const counts = getCounts(state);

    expect(counts.total).toBe(3);
    expect(counts.accepted).toBe(3);
    expect(counts.rejected).toBe(0);
  });

  test("handles empty list", () => {
    const state = createReviewState([]);
    const counts = getCounts(state);

    expect(counts.total).toBe(0);
    expect(counts.accepted).toBe(0);
    expect(counts.rejected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// updateItem
// ---------------------------------------------------------------------------

describe("updateItem", () => {
  test("replaces item at the given index", () => {
    const state = createReviewState(makeItems(3));
    const updated = makeItem("updated-item", { title: "Updated" });
    const next = updateItem(state, 1, updated);

    expect(next.items[1].id).toBe("updated-item");
    expect(next.items[1].title).toBe("Updated");
    expect(next.items[0].id).toBe("item-1");
    expect(next.items[2].id).toBe("item-3");
  });

  test("returns unchanged state for out-of-bounds index", () => {
    const state = createReviewState(makeItems(2));
    const updated = makeItem("bad");
    const next = updateItem(state, 5, updated);

    expect(next.items).toHaveLength(2);
    expect(next.items[0].id).toBe("item-1");
  });
});
