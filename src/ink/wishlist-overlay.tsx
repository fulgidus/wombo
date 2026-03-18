/**
 * wishlist-overlay.tsx — Modal popup Ink component for quick wishlist browsing
 * and adding items.
 *
 * Replaces the neo-blessed WishlistOverlay class from tui-wishlist.ts.
 *
 * Layout:
 *   +----------------------------------------------+
 *   | Wishlist (3 items)                            |
 *   +----------------------------------------------+
 *   | > Buy new keyboard           2025-12-01      |
 *   |   Research TUI frameworks    2025-12-05      |
 *   |   Add dark mode support      2025-12-10      |
 *   +----------------------------------------------+
 *   | [____________________________________]       |
 *   +----------------------------------------------+
 *   | A:add  D/X:delete  Esc/W:close               |
 *   +----------------------------------------------+
 *
 * Keybinds:
 *   Up/Down   — navigate items
 *   A         — add new item (inline text input)
 *   D / X     — delete selected item
 *   Escape/W  — close the overlay
 *   +/-       — move item down/up in order
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { WishlistItem } from "../lib/wishlist-store";
import { useWishlistStore } from "./use-wishlist-store";
import { formatDate, truncateText } from "./wishlist-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WishlistOverlayProps {
  /** Project root directory. */
  projectRoot: string;
  /** Called when the overlay is closed (Esc or W). */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * OverlayItemList — scrollable list of wishlist items.
 */
function OverlayItemList({
  items,
  selectedIndex,
}: {
  items: WishlistItem[];
  selectedIndex: number;
}): React.ReactElement {
  if (items.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No wishlist items. Press A to add one.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {items.map((item, i) => {
        const isSelected = i === selectedIndex;
        const pos = String(i + 1).padStart(2, " ");
        const text = truncateText(item.text, 48);
        const date = formatDate(item.created_at);
        const tagsBadge =
          item.tags.length > 0 ? ` [${item.tags.join(", ")}]` : "";

        return (
          <Box key={item.id}>
            {isSelected ? (
              <Text backgroundColor="blue" color="white" bold>
                {` ${pos}. ${text}${tagsBadge}  ${date} `}
              </Text>
            ) : (
              <Text>
                <Text dimColor>{` ${pos}. `}</Text>
                <Text>{text}</Text>
                <Text dimColor>{tagsBadge}</Text>
                <Text dimColor>{`  ${date}`}</Text>
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * AddInput — inline text input shown when user presses A to add a new item.
 */
function AddInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <Box paddingX={1} borderStyle="single" borderColor="gray">
      <Text color="magenta">{"> "}</Text>
      <Text>{value}</Text>
      <Text inverse>{" "}</Text>
    </Box>
  );
}

/**
 * OverlayFooter — keybind hints at the bottom.
 */
function OverlayFooter({
  addingItem,
}: {
  addingItem: boolean;
}): React.ReactElement {
  if (addingItem) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Enter</Text>
        <Text> save  </Text>
        <Text dimColor>Esc</Text>
        <Text> cancel</Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text dimColor>A</Text>
      <Text> add  </Text>
      <Text dimColor>D/X</Text>
      <Text> delete  </Text>
      <Text dimColor>+/-</Text>
      <Text> reorder  </Text>
      <Text dimColor>Esc/W</Text>
      <Text> close</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * WishlistOverlay — modal popup component for quick wishlist browsing/adding.
 */
export function WishlistOverlay({
  projectRoot,
  onClose,
}: WishlistOverlayProps): React.ReactElement {
  const store = useWishlistStore({ projectRoot });
  const [addingItem, setAddingItem] = useState(false);
  const [inputValue, setInputValue] = useState("");

  const showAddInput = useCallback(() => {
    setAddingItem(true);
    setInputValue("");
  }, []);

  const hideAddInput = useCallback(() => {
    setAddingItem(false);
    setInputValue("");
  }, []);

  const submitNewItem = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    store.addNewItem(trimmed);
    hideAddInput();
  }, [inputValue, store, hideAddInput]);

  useInput((input, key) => {
    if (addingItem) {
      // In add mode, handle text input
      if (key.return) {
        submitNewItem();
        return;
      }
      if (key.escape) {
        hideAddInput();
        return;
      }
      if (key.backspace) {
        setInputValue((prev) => prev.slice(0, -1));
        return;
      }
      // Filter control chars
      if (key.ctrl || key.meta || key.tab) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;

      // Regular character input
      if (input && input.length > 0) {
        setInputValue((prev) => prev + input);
      }
      return;
    }

    // Browse mode
    // Navigation
    if (key.downArrow) {
      store.selectNext();
      return;
    }
    if (key.upArrow) {
      store.selectPrev();
      return;
    }

    // + — move selected item down in order
    if (input === "+") {
      store.moveSelectedDown();
      return;
    }
    // - — move selected item up in order
    if (input === "-") {
      store.moveSelectedUp();
      return;
    }

    // A — add new item
    if (input === "a") {
      showAddInput();
      return;
    }

    // D / X — delete selected item
    if (input === "d" || input === "x") {
      store.deleteSelected();
      return;
    }

    // Escape / W — close overlay
    if (key.escape || input === "w") {
      onClose();
      return;
    }
  });

  const count = store.items.length;
  const label = `Wishlist (${count} item${count !== 1 ? "s" : ""})`;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="magenta"
      paddingY={0}
    >
      {/* Label / Header */}
      <Box paddingX={1}>
        <Text color="magenta" bold>
          {label}
        </Text>
      </Box>

      {/* Item list */}
      <OverlayItemList items={store.items} selectedIndex={store.selectedIndex} />

      {/* Add input (shown when A is pressed) */}
      {addingItem && (
        <Box paddingX={1}>
          <AddInput value={inputValue} onChange={setInputValue} />
        </Box>
      )}

      {/* Footer */}
      <OverlayFooter addingItem={addingItem} />
    </Box>
  );
}
