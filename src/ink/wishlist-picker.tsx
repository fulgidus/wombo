/**
 * wishlist-picker.tsx — Full-screen Ink component for browsing and promoting
 * wishlist items.
 *
 * Replaces the neo-blessed WishlistPicker class from tui-wishlist.ts.
 *
 * Layout:
 *   ┌───────────────────────────────────────────────────────┐
 *   │ wombo-combo Wishlist  │ 5 items                       │
 *   ├──────────────────────────┬────────────────────────────┤
 *   │ • Fix login timeout...   │ Description: Fix login...  │
 *   │ • Add dark mode support  │                            │
 *   │ • Refactor DB layer      │ Tags: auth, ux             │
 *   │                          │ Created: 2025-01-15        │
 *   ├──────────────────────────┴────────────────────────────┤
 *   │ E:errand  P:quest  G:genesis  D:delete  Esc:back Q:quit│
 *   └───────────────────────────────────────────────────────┘
 *
 * Keybinds:
 *   E         — promote selected item to errand
 *   P         — promote selected item to quest
 *   G         — promote selected item to genesis
 *   D / Del   — delete selected item
 *   +/-       — move selected item down/up in order
 *   Up/Down   — navigate items
 *   Esc       — go back
 *   Q         — quit
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import type { WishlistItem } from "../lib/wishlist-store";
import { useWishlistStore } from "./use-wishlist-store";
import { formatDate, truncateText } from "./wishlist-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WishlistPickerProps {
  /** Project root directory. */
  projectRoot: string;
  /** Called when the user promotes an item to errand (E key). */
  onPromoteErrand: (item: WishlistItem) => void;
  /** Called when the user promotes an item to genesis (G key). */
  onPromoteGenesis: (item: WishlistItem) => void;
  /** Called when the user promotes an item to quest (P key). */
  onPromoteQuest: (item: WishlistItem) => void;
  /** Called when the user presses Esc to go back. */
  onBack: () => void;
  /** Called when the user presses Q to quit. */
  onQuit: () => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Header — displays app name, "Wishlist" label, and item count.
 */
function Header({ itemCount }: { itemCount: number }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text bold color="white">
          wombo-combo
        </Text>
        <Text> </Text>
        <Text bold color="yellow">
          Wishlist
        </Text>
        <Text dimColor> | </Text>
        <Text>{itemCount}</Text>
        <Text> item{itemCount !== 1 ? "s" : ""}</Text>
      </Box>
      <Text dimColor>
        Promote items to errands, quests, or genesis
      </Text>
    </Box>
  );
}

/**
 * ItemList — left pane showing all wishlist items.
 */
function ItemList({
  items,
  selectedIndex,
}: {
  items: WishlistItem[];
  selectedIndex: number;
}): React.ReactElement {
  if (items.length === 0) {
    return (
      <Box flexDirection="column" width="50%">
        <Text dimColor>No wishlist items</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="50%">
      {items.map((item, i) => {
        const isSelected = i === selectedIndex;
        const pos = String(i + 1).padStart(2, " ");
        const text = truncateText(item.text, 38);
        const date = formatDate(item.created_at);
        const tagsBadge =
          item.tags.length > 0 ? ` [${item.tags.join(", ")}]` : "";

        return (
          <Box key={item.id}>
            {isSelected ? (
              <Text backgroundColor="blue" color="white" bold>
                {` ${pos}. \u2022 ${text}${tagsBadge} ${date} `}
              </Text>
            ) : (
              <Text>
                <Text dimColor>{` ${pos}. `}</Text>
                <Text color="yellow">{"\u2022"}</Text>
                <Text>{` ${text}`}</Text>
                <Text dimColor>{tagsBadge}</Text>
                <Text dimColor>{` ${date}`}</Text>
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * DetailPane — right pane showing details of the selected item.
 */
function DetailPane({
  item,
  index,
  totalCount,
}: {
  item: WishlistItem | null;
  index: number;
  totalCount: number;
}): React.ReactElement {
  if (!item) {
    return (
      <Box flexDirection="column" width="50%" paddingLeft={2}>
        <Text bold color="yellow">
          No wishlist items
        </Text>
        <Text> </Text>
        <Text>Your wishlist is empty.</Text>
        <Text> </Text>
        <Text bold>Add ideas from the CLI:</Text>
        <Text color="cyan">{'woco wishlist add "your idea"'}</Text>
        <Text> </Text>
        <Text bold>Or from the Task Browser:</Text>
        <Text>
          Press <Text color="yellow">W</Text> to open the wishlist overlay,
        </Text>
        <Text>
          then press <Text color="yellow">A</Text> to add an item.
        </Text>
        <Text> </Text>
        <Text dimColor>Press Esc to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="50%" paddingLeft={2}>
      <Text dimColor>
        {`Item ${index + 1}/${totalCount}`}
      </Text>
      <Text> </Text>

      {/* Description */}
      <Text bold>Description:</Text>
      <Text> {item.text}</Text>
      <Text> </Text>

      {/* Tags */}
      {item.tags.length > 0 && (
        <>
          <Text bold>Tags:</Text>
          <Box>
            <Text>{"  "}</Text>
            {item.tags.map((tag, i) => (
              <React.Fragment key={tag}>
                {i > 0 && <Text>{"  "}</Text>}
                <Text color="cyan">{tag}</Text>
              </React.Fragment>
            ))}
          </Box>
          <Text> </Text>
        </>
      )}

      {/* Created */}
      <Text bold>Created:</Text>
      <Text>
        {"  "}
        {item.created_at.slice(0, 10)} {item.created_at.slice(11, 19)}
      </Text>
      <Text> </Text>

      {/* ID */}
      <Text bold>ID:</Text>
      <Text dimColor>{"  "}{item.id}</Text>
      <Text> </Text>

      {/* Promote hints */}
      <Text bold>Promote:</Text>
      <Text>
        {"  "}
        <Text color="green">E</Text>
        {" \u2192 Create errand from this item"}
      </Text>
      <Text>
        {"  "}
        <Text color="cyan">P</Text>
        {" \u2192 Create quest (goal pre-filled)"}
      </Text>
      <Text>
        {"  "}
        <Text color="magenta">G</Text>
        {" \u2192 Use as genesis vision"}
      </Text>
    </Box>
  );
}

/**
 * StatusBar — bottom bar with keybind hints and selected item preview.
 */
function StatusBar({
  selectedItem,
}: {
  selectedItem: WishlistItem | null;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={0}>
      <Box>
        <Text bold>Keys: </Text>
        <Text dimColor>E</Text>
        <Text> errand  </Text>
        <Text dimColor>P</Text>
        <Text> quest  </Text>
        <Text dimColor>G</Text>
        <Text> genesis  </Text>
        <Text dimColor>D</Text>
        <Text> delete  </Text>
        <Text dimColor>+/-</Text>
        <Text> reorder  </Text>
        <Text dimColor>Esc</Text>
        <Text> back  </Text>
        <Text dimColor>Q</Text>
        <Text> quit</Text>
      </Box>
      <Box>
        {selectedItem ? (
          <Text>{truncateText(selectedItem.text, 60)}</Text>
        ) : (
          <Text dimColor>
            {'Add items with: woco wishlist add "your idea"'}
          </Text>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * WishlistPicker — full-screen Ink component for browsing and promoting
 * wishlist items.
 */
export function WishlistPicker({
  projectRoot,
  onPromoteErrand,
  onPromoteGenesis,
  onPromoteQuest,
  onBack,
  onQuit,
}: WishlistPickerProps): React.ReactElement {
  const store = useWishlistStore({ projectRoot });

  useInput((input, key) => {
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

    // E — promote to errand
    if (input === "e") {
      if (store.selectedItem) {
        onPromoteErrand(store.selectedItem);
      }
      return;
    }

    // G — promote to genesis
    if (input === "g") {
      if (store.selectedItem) {
        onPromoteGenesis(store.selectedItem);
      }
      return;
    }

    // P — promote to quest
    if (input === "p") {
      if (store.selectedItem) {
        onPromoteQuest(store.selectedItem);
      }
      return;
    }

    // D / Delete — delete selected item
    if (input === "d" || key.delete) {
      store.deleteSelected();
      return;
    }

    // Q — quit
    if (input === "q") {
      onQuit();
      return;
    }

    // Escape — go back
    if (key.escape) {
      onBack();
      return;
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Header itemCount={store.items.length} />

      {/* Main content: list + detail */}
      <Box marginTop={1} marginBottom={1}>
        <ItemList items={store.items} selectedIndex={store.selectedIndex} />
        <DetailPane
          item={store.selectedItem}
          index={store.selectedIndex}
          totalCount={store.items.length}
        />
      </Box>

      {/* Status bar */}
      <StatusBar selectedItem={store.selectedItem} />
    </Box>
  );
}
