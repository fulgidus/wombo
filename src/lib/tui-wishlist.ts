/**
 * tui-wishlist.ts -- Wishlist overlay for the wombo-combo TUI.
 *
 * A blessed.box popup that shows the wishlist as a scrollable list.
 * Accessible via W key from Quest Picker and Task Browser.
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
 *   Up/Down   -- navigate items
 *   A         -- add new item (textarea input)
 *   D / X     -- delete selected item
 *   Escape/W  -- close the overlay
 */

import blessed from "neo-blessed";
import type { Widgets } from "neo-blessed";
import type { WishlistItem } from "./wishlist-store.js";
import { loadWishlist, addItem, deleteItem } from "./wishlist-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WishlistOverlayCallbacks {
  /** Called when the overlay is closed (Esc or W). */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeBlessedTags(text: string): string {
  return text.replace(/\{/g, "\uFF5B").replace(/\}/g, "\uFF5D");
}

function formatDate(isoTimestamp: string): string {
  try {
    return isoTimestamp.slice(0, 10);
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// WishlistOverlay
// ---------------------------------------------------------------------------

export class WishlistOverlay {
  private modal: Widgets.BoxElement;
  private itemList: Widgets.ListElement;
  private inputBox: Widgets.TextboxElement;
  private footerBox: Widgets.BoxElement;

  private screen: Widgets.Screen;
  private projectRoot: string;
  private callbacks: WishlistOverlayCallbacks;
  private destroyed: boolean = false;
  private items: WishlistItem[] = [];
  private selectedIndex: number = 0;
  private addingItem: boolean = false;

  constructor(
    screen: Widgets.Screen,
    projectRoot: string,
    callbacks: WishlistOverlayCallbacks
  ) {
    this.screen = screen;
    this.projectRoot = projectRoot;
    this.callbacks = callbacks;

    // Load initial items
    this.items = loadWishlist(projectRoot);

    // --- Modal container ---
    this.modal = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: "75%",
      height: "80%",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "magenta" },
        fg: "white",
        bg: "black",
      },
      label: this.buildLabel(),
      shadow: true,
    });

    // --- Scrollable item list ---
    this.itemList = blessed.list({
      parent: this.modal,
      top: 0,
      left: 1,
      right: 1,
      height: "100%-7",
      tags: true,
      scrollable: true,
      mouse: true,
      keys: true,
      vi: true,
      scrollbar: {
        ch: "\u2502",
        style: { fg: "magenta" },
      },
      style: {
        selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" },
        bg: "black",
      },
    });

    // --- Text input for adding new items ---
    this.inputBox = blessed.textbox({
      parent: this.modal,
      bottom: 2,
      left: 1,
      right: 1,
      height: 3,
      border: { type: "line" },
      style: {
        border: { fg: "gray" },
        fg: "white",
        bg: "black",
        focus: { border: { fg: "magenta" } },
      },
      inputOnFocus: true,
      hidden: true,
    });

    // --- Footer: keybind hints ---
    this.footerBox = blessed.box({
      parent: this.modal,
      bottom: 0,
      left: 1,
      right: 1,
      height: 1,
      tags: true,
      style: { fg: "gray", bg: "black" },
    });

    this.refreshList();
    this.refreshFooter();
    this.bindKeys();
    this.itemList.focus();
    this.screen.render();
  }

  // -------------------------------------------------------------------------
  // Key Bindings
  // -------------------------------------------------------------------------

  private bindKeys(): void {
    // Navigate — track selection changes
    this.itemList.on("select item", (_item: any, index: number) => {
      this.selectedIndex = index;
    });

    // Close overlay with Escape or W
    this.itemList.key(["escape", "w"], () => {
      if (this.addingItem) return;
      this.close();
    });

    // A — add new item
    this.itemList.key(["a"], () => {
      if (this.addingItem) return;
      this.showAddInput();
    });

    // D or X — delete selected item
    this.itemList.key(["d", "x"], () => {
      if (this.addingItem) return;
      this.deleteSelected();
    });

    // --- Input box bindings ---
    this.inputBox.on("submit", (value: string) => {
      this.submitNewItem(value);
    });

    this.inputBox.on("cancel", () => {
      this.hideAddInput();
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private buildLabel(): string {
    const count = this.items.length;
    return ` {magenta-fg}Wishlist{/magenta-fg} (${count} item${count !== 1 ? "s" : ""}) `;
  }

  private refreshList(): void {
    if (this.items.length === 0) {
      this.itemList.setItems([
        " {gray-fg}No wishlist items. Press A to add one.{/gray-fg}",
      ] as any);
      return;
    }

    const listItems: string[] = [];

    for (const item of this.items) {
      const date = formatDate(item.created_at);
      const text =
        item.text.length > 50
          ? item.text.slice(0, 49) + "\u2026"
          : item.text;
      const tags =
        item.tags.length > 0
          ? ` {gray-fg}[${item.tags.join(", ")}]{/gray-fg}`
          : "";

      listItems.push(
        ` ${escapeBlessedTags(text)}${tags}  {gray-fg}${date}{/gray-fg}`
      );
    }

    const prevSelected = this.selectedIndex;
    this.itemList.setItems(listItems as any);
    if (prevSelected < listItems.length) {
      this.itemList.select(prevSelected);
    } else if (listItems.length > 0) {
      this.itemList.select(listItems.length - 1);
      this.selectedIndex = listItems.length - 1;
    }
  }

  private refreshFooter(): void {
    if (this.addingItem) {
      this.footerBox.setContent(
        " {gray-fg}Enter{/gray-fg} save  {gray-fg}Esc{/gray-fg} cancel"
      );
    } else {
      this.footerBox.setContent(
        " {gray-fg}A{/gray-fg} add  {gray-fg}D/X{/gray-fg} delete  {gray-fg}Esc/W{/gray-fg} close"
      );
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private showAddInput(): void {
    this.addingItem = true;
    this.inputBox.setValue("");
    this.inputBox.show();
    this.inputBox.focus();
    this.refreshFooter();
    this.screen.render();
  }

  private hideAddInput(): void {
    this.addingItem = false;
    this.inputBox.hide();
    this.inputBox.clearValue();
    this.itemList.focus();
    this.refreshFooter();
    this.screen.render();
  }

  private submitNewItem(value: string): void {
    const text = (value ?? "").trim();
    if (!text) {
      // Flash border red briefly to indicate empty input
      this.inputBox.style.border = { fg: "red" } as any;
      this.screen.render();
      setTimeout(() => {
        if (!this.destroyed) {
          this.inputBox.style.border = { fg: "gray" } as any;
          this.screen.render();
        }
      }, 500);
      return;
    }

    // Add item to store
    addItem(this.projectRoot, text);

    // Reload items
    this.items = loadWishlist(this.projectRoot);

    // Select the newly added item (it's at the end)
    this.selectedIndex = this.items.length - 1;

    // Update display
    this.hideAddInput();
    this.refreshList();
    this.modal.setLabel(this.buildLabel());
    this.screen.render();
  }

  private deleteSelected(): void {
    if (this.items.length === 0) return;
    if (this.selectedIndex < 0 || this.selectedIndex >= this.items.length) return;

    const item = this.items[this.selectedIndex];
    deleteItem(this.projectRoot, item.id);

    // Reload items
    this.items = loadWishlist(this.projectRoot);

    // Adjust selection
    if (this.selectedIndex >= this.items.length && this.items.length > 0) {
      this.selectedIndex = this.items.length - 1;
    }

    // Update display
    this.refreshList();
    this.modal.setLabel(this.buildLabel());
    this.screen.render();
  }

  /**
   * Close and destroy the overlay.
   */
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.modal.destroy();
    this.callbacks.onClose();
    this.screen.render();
  }

  /**
   * Whether the overlay has been destroyed.
   */
  isDestroyed(): boolean {
    return this.destroyed;
  }
}
