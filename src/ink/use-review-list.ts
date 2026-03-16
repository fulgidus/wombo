/**
 * use-review-list.ts — Pure state management functions for the ReviewList component.
 *
 * Provides immutable state operations for the review list:
 *   - createReviewState: initialize from items
 *   - toggleAccept: flip a single item's accepted state
 *   - toggleAll: flip all items (all accepted → all rejected, or vice versa)
 *   - moveItem: reorder items up/down
 *   - selectItem: change the selected index
 *   - getAcceptedItems: get only accepted items
 *   - getCounts: get accepted/rejected/total counts
 *   - updateItem: replace an item at a given index
 *
 * These are pure functions (no React hooks) so they can be tested without
 * rendering. The ReviewList component wraps them in useState.
 */

import type { ReviewItem } from "./review-list-types";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The state managed by the review list. */
export interface ReviewState {
  items: ReviewItem[];
  selectedIndex: number;
}

// ---------------------------------------------------------------------------
// State Constructors
// ---------------------------------------------------------------------------

/** Create initial review state from a list of items. */
export function createReviewState(items: ReviewItem[]): ReviewState {
  return {
    items: items.map((item) => ({ ...item })),
    selectedIndex: 0,
  };
}

// ---------------------------------------------------------------------------
// State Mutations (immutable — return new state)
// ---------------------------------------------------------------------------

/** Toggle the accepted state of the currently selected item. */
export function toggleAccept(state: ReviewState): ReviewState {
  const { items, selectedIndex } = state;
  if (selectedIndex < 0 || selectedIndex >= items.length) return state;

  const newItems = items.map((item, i) =>
    i === selectedIndex ? { ...item, accepted: !item.accepted } : item
  );
  return { ...state, items: newItems };
}

/** Toggle all items: if all accepted → reject all, otherwise accept all. */
export function toggleAll(state: ReviewState): ReviewState {
  const allAccepted = state.items.every((i) => i.accepted);
  const newItems = state.items.map((item) => ({
    ...item,
    accepted: !allAccepted,
  }));
  return { ...state, items: newItems };
}

/** Move the selected item up (-1) or down (+1) in the list. */
export function moveItem(state: ReviewState, direction: -1 | 1): ReviewState {
  const { items, selectedIndex } = state;
  const newIdx = selectedIndex + direction;
  if (newIdx < 0 || newIdx >= items.length) return state;

  const newItems = [...items];
  const temp = newItems[selectedIndex];
  newItems[selectedIndex] = newItems[newIdx];
  newItems[newIdx] = temp;

  return { items: newItems, selectedIndex: newIdx };
}

/** Change the selected index, clamped to valid range. */
export function selectItem(state: ReviewState, index: number): ReviewState {
  const clamped = Math.max(0, Math.min(index, state.items.length - 1));
  return { ...state, selectedIndex: clamped };
}

/** Replace the item at the given index with a new item. */
export function updateItem(
  state: ReviewState,
  index: number,
  item: ReviewItem,
): ReviewState {
  if (index < 0 || index >= state.items.length) return state;
  const newItems = state.items.map((existing, i) => (i === index ? item : existing));
  return { ...state, items: newItems };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Get only the accepted items. */
export function getAcceptedItems(state: ReviewState): ReviewItem[] {
  return state.items.filter((i) => i.accepted);
}

/** Get counts of accepted, rejected, and total items. */
export function getCounts(state: ReviewState): {
  total: number;
  accepted: number;
  rejected: number;
} {
  const accepted = state.items.filter((i) => i.accepted).length;
  return {
    total: state.items.length,
    accepted,
    rejected: state.items.length - accepted,
  };
}
