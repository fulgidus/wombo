/**
 * tui-wishlist.ts -- Wishlist views for the wombo-combo TUI.
 *
 * Contains two complementary views:
 *
 * 1. WishlistPicker — Full-screen standalone TUI for browsing and promoting
 *    wishlist items to errands (E key) or genesis input (G key). After
 *    promotion, the user is asked whether to delete the wishlist item.
 *
 *    Layout:
 *      ┌───────────────────────────────────────────────────────┐
 *      │ WOMBO-COMBO Wishlist  │ 5 items                      │
 *      ├──────────────────────────┬────────────────────────────┤
 *      │ • Fix login timeout...   │ Text: Fix login timeout    │
 *      │ • Add dark mode support  │   for SSO users on slow    │
 *      │ • Refactor DB layer      │   connections               │
 *      │ • Update docs for v2     │                             │
 *      │                          │ Tags: auth, ux              │
 *      │                          │ Created: 2025-01-15         │
 *      ├──────────────────────────┴────────────────────────────┤
 *      │ E:errand  G:genesis  D:delete  Esc:back  Q:quit      │
 *      └───────────────────────────────────────────────────────┘
 *
 *    Keybinds:
 *      E         — promote selected item to errand (pre-fill description)
 *      G         — promote selected item to genesis (pre-fill vision)
 *      D / Del   — delete selected item
 *      Esc / Q   — go back to quest picker
 *
 * 2. WishlistOverlay — Modal popup overlay for quick wishlist browsing and
 *    adding items. Accessible via W key from Quest Picker and Task Browser.
 *
 *    Layout:
 *      +----------------------------------------------+
 *      | Wishlist (3 items)                            |
 *      +----------------------------------------------+
 *      | > Buy new keyboard           2025-12-01      |
 *      |   Research TUI frameworks    2025-12-05      |
 *      |   Add dark mode support      2025-12-10      |
 *      +----------------------------------------------+
 *      | [____________________________________]       |
 *      +----------------------------------------------+
 *      | A:add  D/X:delete  Esc/W:close               |
 *      +----------------------------------------------+
 *
 *    Keybinds:
 *      Up/Down   -- navigate items
 *      A         -- add new item (textarea input)
 *      D / X     -- delete selected item
 *      Escape/W  -- close the overlay
 */

import blessed from "neo-blessed";
import type { Widgets } from "neo-blessed";
import type { WishlistItem } from "./wishlist-store.js";
import { loadWishlist, addItem, deleteItem } from "./wishlist-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WishlistAction =
  | { type: "promote-errand"; item: WishlistItem }
  | { type: "promote-genesis"; item: WishlistItem }
  | { type: "back" }
  | { type: "quit" };

export interface WishlistPickerOptions {
  projectRoot: string;
  onPromoteErrand: (item: WishlistItem) => void;
  onPromoteGenesis: (item: WishlistItem) => void;
  onBack: () => void;
  onQuit: () => void;
}

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
// WishlistPicker Class (full-screen, promotion flow)
// ---------------------------------------------------------------------------

export class WishlistPicker {
  private screen: Widgets.Screen;
  private headerBox: Widgets.BoxElement;
  private itemList: Widgets.ListElement;
  private detailBox: Widgets.BoxElement;
  private statusBar: Widgets.BoxElement;

  private projectRoot: string;
  private onPromoteErrand: (item: WishlistItem) => void;
  private onPromoteGenesis: (item: WishlistItem) => void;
  private onBack: () => void;
  private onQuit: () => void;

  private items: WishlistItem[] = [];
  private selectedIndex: number = 0;

  constructor(opts: WishlistPickerOptions) {
    this.projectRoot = opts.projectRoot;
    this.onPromoteErrand = opts.onPromoteErrand;
    this.onPromoteGenesis = opts.onPromoteGenesis;
    this.onBack = opts.onBack;
    this.onQuit = opts.onQuit;

    this.loadItems();

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: "wombo-combo -- Wishlist",
      fullUnicode: true,
    });

    // Header
    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Item list (left pane)
    this.itemList = blessed.list({
      top: 3,
      left: 0,
      width: "50%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      keys: true,
      vi: true,
      border: { type: "line" },
      style: {
        border: { fg: "gray" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" },
      },
      label: " Wishlist ",
    });

    // Detail pane (right pane)
    this.detailBox = blessed.box({
      top: 3,
      left: "50%",
      width: "50%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      border: { type: "line" },
      style: {
        border: { fg: "gray" },
        fg: "white",
      },
      label: " Details ",
    });

    // Status bar
    this.statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Assemble
    this.screen.append(this.headerBox);
    this.screen.append(this.itemList);
    this.screen.append(this.detailBox);
    this.screen.append(this.statusBar);
    this.itemList.focus();

    this.bindKeys();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  start(): void {
    this.refreshAll();
    this.screen.render();
  }

  stop(): void {
    this.screen.destroy();
  }

  destroy(): void {
    this.screen.destroy();
    process.stdout.write("\x1B[2J\x1B[H");
  }

  // -----------------------------------------------------------------------
  // Data Loading
  // -----------------------------------------------------------------------

  private loadItems(): void {
    this.items = loadWishlist(this.projectRoot);
  }

  // -----------------------------------------------------------------------
  // Key Bindings
  // -----------------------------------------------------------------------

  private bindKeys(): void {
    // Quit
    this.screen.key(["q", "C-c"], () => {
      this.stop();
      this.onQuit();
    });

    // Escape -- go back
    this.screen.key(["escape"], () => {
      this.destroy();
      this.onBack();
    });

    // Navigate
    this.itemList.on("select item", (_item: any, index: number) => {
      this.selectedIndex = index;
      this.refreshDetail();
      this.screen.render();
    });

    // E -- promote to errand
    this.screen.key(["e"], () => {
      this.promoteToErrand();
    });

    // G -- promote to genesis
    this.screen.key(["g"], () => {
      this.promoteToGenesis();
    });

    // D / Delete -- delete item
    this.screen.key(["d", "delete"], () => {
      this.deleteSelected();
    });
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  private promoteToErrand(): void {
    const item = this.items[this.selectedIndex];
    if (!item) return;

    this.destroy();
    this.onPromoteErrand(item);
  }

  private promoteToGenesis(): void {
    const item = this.items[this.selectedIndex];
    if (!item) return;

    this.destroy();
    this.onPromoteGenesis(item);
  }

  private deleteSelected(): void {
    const item = this.items[this.selectedIndex];
    if (!item) return;

    deleteItem(this.projectRoot, item.id);
    this.loadItems();
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.items.length - 1)
    );
    this.refreshAll();
    this.screen.render();
  }

  // -----------------------------------------------------------------------
  // Refresh Logic
  // -----------------------------------------------------------------------

  private refreshAll(): void {
    this.refreshHeader();
    this.refreshList();
    this.refreshDetail();
    this.refreshStatusBar();
  }

  private refreshHeader(): void {
    const count = this.items.length;
    let line1 = ` {bold}wombo-combo{/bold} {yellow-fg}Wishlist{/yellow-fg}`;
    line1 += `  {gray-fg}|{/gray-fg}  {white-fg}${count}{/white-fg} item${count !== 1 ? "s" : ""}`;

    let line2 = ` {gray-fg}Promote items to errands or genesis quests{/gray-fg}`;

    this.headerBox.setContent(`${line1}\n${line2}`);
  }

  private refreshList(): void {
    const listItems: string[] = [];

    for (const item of this.items) {
      // Truncate text for list display
      const maxLen = 40;
      const text = item.text.length > maxLen
        ? item.text.slice(0, maxLen - 1) + "\u2026"
        : item.text;

      // Tags badge
      const tagsBadge = item.tags.length > 0
        ? ` {gray-fg}[${item.tags.join(", ")}]{/gray-fg}`
        : "";

      // Date
      const created = item.created_at.slice(0, 10);

      listItems.push(
        ` {yellow-fg}\u2022{/yellow-fg} ${escapeBlessedTags(text)}${tagsBadge} {gray-fg}${created}{/gray-fg}`
      );
    }

    if (listItems.length === 0) {
      listItems.push(" {gray-fg}No wishlist items{/gray-fg}");
    }

    const prevSelected = this.selectedIndex;
    this.itemList.setItems(listItems as any);
    if (prevSelected < listItems.length) {
      this.itemList.select(prevSelected);
    }
  }

  private refreshDetail(): void {
    const item = this.items[this.selectedIndex];
    if (!item) {
      this.detailBox.setContent("{gray-fg}No item selected{/gray-fg}");
      this.detailBox.setLabel(" Details ");
      return;
    }

    const lines: string[] = [];

    // Full text
    lines.push("{bold}{white-fg}Description:{/white-fg}{/bold}");
    // Word-wrap the text to roughly 42 chars
    const text = escapeBlessedTags(item.text.trim());
    const words = text.split(/\s+/);
    let line = " ";
    for (const w of words) {
      if (line.length + w.length > 42) {
        lines.push(line);
        line = " " + w;
      } else {
        line += " " + w;
      }
    }
    if (line.trim()) lines.push(line);
    lines.push("");

    // Tags
    if (item.tags.length > 0) {
      lines.push("{bold}Tags:{/bold}");
      lines.push(`  ${item.tags.map((t) => `{cyan-fg}${escapeBlessedTags(t)}{/cyan-fg}`).join("  ")}`);
      lines.push("");
    }

    // Created date
    lines.push("{bold}Created:{/bold}");
    lines.push(`  ${item.created_at.slice(0, 10)} ${item.created_at.slice(11, 19)}`);
    lines.push("");

    // ID
    lines.push("{bold}ID:{/bold}");
    lines.push(`  {gray-fg}${item.id}{/gray-fg}`);
    lines.push("");

    // Promotion hints
    lines.push("{bold}Promote:{/bold}");
    lines.push("  {green-fg}E{/green-fg} \u2192 Create errand from this item");
    lines.push("  {magenta-fg}G{/magenta-fg} \u2192 Use as genesis vision");

    this.detailBox.setContent(lines.join("\n"));
    this.detailBox.setLabel(` Item ${this.selectedIndex + 1}/${this.items.length} `);
  }

  private refreshStatusBar(): void {
    let line1 = ` {bold}Keys:{/bold}`;
    line1 += `  {gray-fg}E{/gray-fg} promote to errand`;
    line1 += `  {gray-fg}G{/gray-fg} promote to genesis`;
    line1 += `  {gray-fg}D{/gray-fg} delete`;
    line1 += `  {gray-fg}Esc{/gray-fg} back`;
    line1 += `  {gray-fg}Q{/gray-fg} quit`;

    let line2 = ` `;
    const item = this.items[this.selectedIndex];
    if (item) {
      const truncText = item.text.length > 60
        ? item.text.slice(0, 57) + "..."
        : item.text;
      line2 += `{white-fg}${escapeBlessedTags(truncText)}{/white-fg}`;
    } else {
      line2 += `{gray-fg}Add items with: woco wishlist add "your idea"{/gray-fg}`;
    }

    this.statusBar.setContent(`${line1}\n${line2}`);
  }
}

// ---------------------------------------------------------------------------
// WishlistOverlay (modal popup, add/delete/browse)
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
