/**
 * use-wishlist-store.ts — React hook for wishlist state management.
 *
 * Provides a hook that wraps the wishlist-store CRUD operations with
 * React state, selection tracking, and reorder support.
 *
 * Used by both WishlistPicker and WishlistOverlay Ink components.
 */

import { useState, useCallback, useMemo } from "react";
import type { WishlistItem } from "../lib/wishlist-store";
import {
  loadWishlist,
  addItem,
  deleteItem,
  moveItem,
} from "../lib/wishlist-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseWishlistStoreOptions {
  /** Project root directory for locating .wombo-combo/wishlist.yml. */
  projectRoot: string;
}

export interface UseWishlistStoreResult {
  /** Current list of wishlist items. */
  items: WishlistItem[];
  /** Currently selected index. */
  selectedIndex: number;
  /** Currently selected item, or null if the list is empty. */
  selectedItem: WishlistItem | null;
  /** Move selection to the next item. */
  selectNext: () => void;
  /** Move selection to the previous item. */
  selectPrev: () => void;
  /** Set selection to a specific index. */
  selectIndex: (index: number) => void;
  /** Delete the currently selected item. */
  deleteSelected: () => void;
  /** Move the selected item up one position. */
  moveSelectedUp: () => void;
  /** Move the selected item down one position. */
  moveSelectedDown: () => void;
  /** Add a new item. Returns true if added, false if text was empty. */
  addNewItem: (text: string, tags?: string[]) => boolean;
  /** Reload items from disk. */
  reload: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * useWishlistStore — manages wishlist items with selection and CRUD.
 *
 * Loads items from the YAML store on mount, and provides operations
 * that persist changes back to disk.
 */
export function useWishlistStore(
  options: UseWishlistStoreOptions
): UseWishlistStoreResult {
  const { projectRoot } = options;

  const [items, setItems] = useState<WishlistItem[]>(() =>
    loadWishlist(projectRoot)
  );
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectedItem = useMemo(() => {
    if (items.length === 0) return null;
    const idx = Math.min(selectedIndex, items.length - 1);
    return items[idx] ?? null;
  }, [items, selectedIndex]);

  const reload = useCallback(() => {
    const loaded = loadWishlist(projectRoot);
    setItems(loaded);
  }, [projectRoot]);

  const selectNext = useCallback(() => {
    setSelectedIndex((prev) => {
      // Use items.length from the closure — need current items
      // We read items directly since setItems doesn't help here
      return Math.min(prev + 1, Math.max(0, items.length - 1));
    });
  }, [items.length]);

  const selectPrev = useCallback(() => {
    setSelectedIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const selectIndex = useCallback(
    (index: number) => {
      setSelectedIndex(Math.max(0, Math.min(index, items.length - 1)));
    },
    [items.length]
  );

  const deleteSelected = useCallback(() => {
    if (items.length === 0) return;
    const idx = Math.min(selectedIndex, items.length - 1);
    const item = items[idx];
    if (!item) return;

    deleteItem(projectRoot, item.id);
    const newItems = loadWishlist(projectRoot);
    setItems(newItems);

    // Adjust selection
    if (idx >= newItems.length && newItems.length > 0) {
      setSelectedIndex(newItems.length - 1);
    }
  }, [projectRoot, items, selectedIndex]);

  const moveSelectedUp = useCallback(() => {
    if (items.length === 0 || selectedIndex <= 0) return;

    const item = items[selectedIndex];
    if (!item) return;

    // moveItem uses 1-indexed positions
    const newPos = selectedIndex; // move from (selectedIndex+1) to selectedIndex
    moveItem(projectRoot, item.id, newPos);
    const newItems = loadWishlist(projectRoot);
    setItems(newItems);
    setSelectedIndex(newPos - 1);
  }, [projectRoot, items, selectedIndex]);

  const moveSelectedDown = useCallback(() => {
    if (items.length === 0 || selectedIndex >= items.length - 1) return;

    const item = items[selectedIndex];
    if (!item) return;

    // moveItem uses 1-indexed positions
    const newPos = selectedIndex + 2; // move from (selectedIndex+1) to (selectedIndex+2)
    moveItem(projectRoot, item.id, newPos);
    const newItems = loadWishlist(projectRoot);
    setItems(newItems);
    setSelectedIndex(newPos - 1);
  }, [projectRoot, items, selectedIndex]);

  const addNewItem = useCallback(
    (text: string, tags?: string[]): boolean => {
      const trimmed = text.trim();
      if (!trimmed) return false;

      try {
        addItem(projectRoot, trimmed, tags);
        const newItems = loadWishlist(projectRoot);
        setItems(newItems);
        // Select the newly added item (it's at the end)
        setSelectedIndex(newItems.length - 1);
        return true;
      } catch {
        return false;
      }
    },
    [projectRoot]
  );

  return {
    items,
    selectedIndex,
    selectedItem,
    selectNext,
    selectPrev,
    selectIndex,
    deleteSelected,
    moveSelectedUp,
    moveSelectedDown,
    addNewItem,
    reload,
  };
}
