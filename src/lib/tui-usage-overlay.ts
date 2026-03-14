/**
 * tui-usage-overlay.ts -- Token usage overlay for the wombo-combo TUI.
 *
 * Shows a modal overlay with overall token usage statistics and a per-task
 * breakdown. Accessible via the U keybind in the Task Browser.
 *
 * Layout:
 *   +--------------------------------------------------+
 *   | Token Usage                      Total: $12.34   |
 *   +--------------------------------------------------+
 *   | Overall:                                          |
 *   |   Input: 1.2M  Output: 450.3k  Cache: 800.0k    |
 *   |   Reasoning: 50.2k  Total: 2.5M  Steps: 42      |
 *   +--------------------------------------------------+
 *   | Per Task:                                         |
 *   | > auth-service     In: 200k Out: 100k  $2.50     |
 *   |   search-api       In: 150k Out:  80k  $1.80     |
 *   |   perf-optim       In:  50k Out:  30k  $0.60     |
 *   +--------------------------------------------------+
 *   | Tab:group by  Esc/U:close                        |
 *   +--------------------------------------------------+
 *
 * Keybinds:
 *   Up/Down   -- navigate per-task list
 *   Tab       -- cycle grouping (task_id → quest_id → model → provider)
 *   Escape/U  -- close the overlay
 */

import blessed from "neo-blessed";
import type { Widgets } from "neo-blessed";
import { loadUsageRecords, totalUsage, groupBy } from "./token-usage.js";
import type { UsageTotals, GroupableField } from "./token-usage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageOverlayCallbacks {
  /** Called when the overlay is closed (Esc or U). */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeBlessedTags(text: string): string {
  return text.replace(/\{/g, "\uFF5B").replace(/\}/g, "\uFF5D");
}

/**
 * Format a token count with k/M suffixes for compact display.
 */
function formatTokenCount(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Format a cost value as a dollar string.
 */
function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** The grouping fields available for cycling */
const GROUPING_FIELDS: GroupableField[] = [
  "task_id",
  "quest_id",
  "model",
  "provider",
];

/** Human-readable labels for grouping fields */
const GROUPING_LABELS: Record<GroupableField, string> = {
  task_id: "Task",
  quest_id: "Quest",
  model: "Model",
  provider: "Provider",
  harness: "Harness",
};

// ---------------------------------------------------------------------------
// UsageOverlay Class
// ---------------------------------------------------------------------------

export class UsageOverlay {
  private modal: Widgets.BoxElement;
  private summaryBox: Widgets.BoxElement;
  private groupList: Widgets.ListElement;
  private footerBox: Widgets.BoxElement;

  private screen: Widgets.Screen;
  private projectRoot: string;
  private callbacks: UsageOverlayCallbacks;
  private destroyed: boolean = false;

  /** Overall usage totals */
  private overall: UsageTotals | null = null;
  /** Grouped usage data (sorted by total_tokens descending) */
  private groups: Array<{ key: string; totals: UsageTotals }> = [];
  /** Current grouping field */
  private groupField: GroupableField = "task_id";
  /** Selected index in the group list */
  private selectedIndex: number = 0;

  constructor(
    screen: Widgets.Screen,
    projectRoot: string,
    callbacks: UsageOverlayCallbacks
  ) {
    this.screen = screen;
    this.projectRoot = projectRoot;
    this.callbacks = callbacks;

    // Load data
    this.loadData();

    // --- Modal container ---
    this.modal = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: "80%",
      height: "85%",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "yellow" },
        fg: "white",
        bg: "black",
      },
      label: this.buildLabel(),
      shadow: true,
    });

    // --- Summary box (overall totals) ---
    this.summaryBox = blessed.box({
      parent: this.modal,
      top: 0,
      left: 1,
      right: 1,
      height: 5,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // --- Scrollable group list ---
    this.groupList = blessed.list({
      parent: this.modal,
      top: 5,
      left: 1,
      right: 1,
      height: "100%-9",
      tags: true,
      scrollable: true,
      mouse: true,
      keys: true,
      vi: true,
      scrollbar: {
        ch: "\u2502",
        style: { fg: "yellow" },
      },
      border: { type: "line" },
      style: {
        border: { fg: "gray" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" },
        bg: "black",
      },
      label: ` By ${GROUPING_LABELS[this.groupField]} `,
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

    this.refreshSummary();
    this.refreshGroupList();
    this.refreshFooter();
    this.bindKeys();
    this.groupList.focus();
    this.screen.render();
  }

  // -------------------------------------------------------------------------
  // Data Loading
  // -------------------------------------------------------------------------

  private loadData(): void {
    try {
      const records = loadUsageRecords(this.projectRoot);
      if (records.length > 0) {
        this.overall = totalUsage(records);
        this.buildGroups(records);
      } else {
        this.overall = null;
        this.groups = [];
      }
    } catch {
      this.overall = null;
      this.groups = [];
    }
  }

  private buildGroups(records: ReturnType<typeof loadUsageRecords>): void {
    const grouped = groupBy(records, this.groupField);
    this.groups = [];
    for (const [key, totals] of grouped) {
      this.groups.push({ key, totals });
    }
    // Sort by total_tokens descending (most expensive first)
    this.groups.sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
  }

  // -------------------------------------------------------------------------
  // Key Bindings
  // -------------------------------------------------------------------------

  private bindKeys(): void {
    // Navigate — track selection changes
    this.groupList.on("select item", (_item: any, index: number) => {
      this.selectedIndex = index;
    });

    // Close overlay with Escape or U
    this.groupList.key(["escape", "u"], () => {
      this.close();
    });

    // Tab — cycle grouping
    this.groupList.key(["tab"], () => {
      this.cycleGrouping();
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private cycleGrouping(): void {
    const idx = GROUPING_FIELDS.indexOf(this.groupField);
    this.groupField =
      GROUPING_FIELDS[(idx + 1) % GROUPING_FIELDS.length];
    this.selectedIndex = 0;

    // Reload grouped data
    try {
      const records = loadUsageRecords(this.projectRoot);
      this.buildGroups(records);
    } catch {
      this.groups = [];
    }

    this.groupList.setLabel(` By ${GROUPING_LABELS[this.groupField]} `);
    this.refreshGroupList();
    this.refreshFooter();
    this.screen.render();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private buildLabel(): string {
    const costStr = this.overall
      ? `  Total: {yellow-fg}${formatCost(this.overall.total_cost)}{/yellow-fg}`
      : "";
    return ` {yellow-fg}Token Usage{/yellow-fg}${costStr} `;
  }

  private refreshSummary(): void {
    if (!this.overall) {
      this.summaryBox.setContent(
        "{gray-fg}No token usage data found.\n" +
        "Usage data is recorded when agents run and produce step_finish events.{/gray-fg}"
      );
      return;
    }

    const u = this.overall;
    const lines: string[] = [];

    lines.push("{bold}{yellow-fg}Overall Usage:{/yellow-fg}{/bold}");

    // Row 1: Input, Output, Cache
    let row1 = `  Input: {cyan-fg}${formatTokenCount(u.input_tokens)}{/cyan-fg}`;
    row1 += `    Output: {cyan-fg}${formatTokenCount(u.output_tokens)}{/cyan-fg}`;
    if (u.cache_read > 0) {
      row1 += `    Cache: {gray-fg}${formatTokenCount(u.cache_read)}{/gray-fg}`;
    }
    lines.push(row1);

    // Row 2: Reasoning, Total, Cost, Steps
    let row2 = "";
    if (u.reasoning_tokens > 0) {
      row2 += `  Reasoning: {magenta-fg}${formatTokenCount(u.reasoning_tokens)}{/magenta-fg}    `;
    } else {
      row2 += "  ";
    }
    row2 += `Total: {white-fg}${formatTokenCount(u.total_tokens)}{/white-fg}`;
    if (u.total_cost > 0) {
      row2 += `    Cost: {yellow-fg}${formatCost(u.total_cost)}{/yellow-fg}`;
    }
    row2 += `    Steps: ${u.record_count}`;
    lines.push(row2);

    this.summaryBox.setContent(lines.join("\n"));
  }

  private refreshGroupList(): void {
    if (this.groups.length === 0) {
      this.groupList.setItems([
        " {gray-fg}No usage data to group.{/gray-fg}",
      ] as any);
      return;
    }

    const listItems: string[] = [];

    for (const { key, totals } of this.groups) {
      // Truncate key for display
      const maxKeyLen = 24;
      const displayKey = key.length > maxKeyLen
        ? key.slice(0, maxKeyLen - 1) + "\u2026"
        : key.padEnd(maxKeyLen);

      // Format columns
      const input = `In: ${formatTokenCount(totals.input_tokens)}`.padEnd(12);
      const output = `Out: ${formatTokenCount(totals.output_tokens)}`.padEnd(13);
      const cost = totals.total_cost > 0 ? formatCost(totals.total_cost) : "";
      const steps = `${totals.record_count}st`;

      listItems.push(
        ` ${escapeBlessedTags(displayKey)}  {cyan-fg}${input}{/cyan-fg} {cyan-fg}${output}{/cyan-fg} {yellow-fg}${cost}{/yellow-fg}  {gray-fg}${steps}{/gray-fg}`
      );
    }

    const prevSelected = this.selectedIndex;
    this.groupList.setItems(listItems as any);
    if (prevSelected < listItems.length) {
      this.groupList.select(prevSelected);
    } else if (listItems.length > 0) {
      this.groupList.select(0);
      this.selectedIndex = 0;
    }
  }

  private refreshFooter(): void {
    const nextIdx = (GROUPING_FIELDS.indexOf(this.groupField) + 1) %
      GROUPING_FIELDS.length;
    const nextLabel = GROUPING_LABELS[GROUPING_FIELDS[nextIdx]];

    this.footerBox.setContent(
      ` {gray-fg}Tab{/gray-fg} group by ${nextLabel}  {gray-fg}Esc/U{/gray-fg} close` +
      `  {gray-fg}|{/gray-fg}  Grouped by: {yellow-fg}${GROUPING_LABELS[this.groupField]}{/yellow-fg}`
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

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
