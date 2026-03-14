/**
 * tui-quest-picker.ts -- Quest picker view for the wombo-combo TUI.
 *
 * Shows all quests as a selectable list with an "All Tasks" option at the top.
 * Selecting a quest navigates to the Task Browser filtered to that quest's tasks.
 *
 * Layout:
 *   +-----------------------------------------------------------+
 *   | WOMBO-COMBO Quest Picker  | 4 quests                      |
 *   +---------------------------+-------------------------------+
 *   | > All Tasks (42)          | Quest: auth-overhaul           |
 *   |   auth-overhaul   ACTV    | Status: active                 |
 *   |   search-api      DRFT    | Priority: high                 |
 *   |   perf-optim      PAUS    | Tasks: 8 (3 done, 62%)         |
 *   |   ui-redesign     PLAN    | Goal: Replace basic auth...    |
 *   |                           |                                |
 *   +---------------------------+-------------------------------+
 *   | Enter:select  C:create  Q:quit                            |
 *   +-----------------------------------------------------------+
 *
 * Keybinds:
 *   Enter/Space  -- select quest (or "All Tasks") and proceed to browser
 *   C            -- create new quest (Phase 2 p2-quest-create-tui)
 *   A            -- activate/pause selected quest
 *   Q / C-c      -- quit the TUI
 */

import blessed from "neo-blessed";
import type { Widgets } from "neo-blessed";
import type { Quest } from "./quest.js";
import { QUEST_STATUS_ORDER } from "./quest.js";
import { loadAllQuests, saveQuest } from "./quest-store.js";
import { loadTasks, getDoneTaskIds, loadArchive } from "./tasks.js";
import type { WomboConfig } from "../config.js";
import type { ErrandSpec } from "./errand-planner.js";
import { loadUsageRecords, totalUsage, groupBy as groupUsageBy } from "./token-usage.js";
import type { UsageTotals } from "./token-usage.js";
import { showQuestWizard } from "./tui-quest-wizard.js";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuestPickerAction =
  | { type: "select"; questId: string | null }
  | { type: "plan"; questId: string }
  | { type: "genesis"; vision: string }
  | { type: "errand"; spec: ErrandSpec }
  | { type: "wishlist" }
  | { type: "onboarding" }
  | { type: "quit" };

export interface QuestPickerOptions {
  projectRoot: string;
  config: WomboConfig;
  onSelect: (questId: string | null) => void;
  onPlan?: (questId: string) => void;
  onGenesis?: (vision: string) => void;
  onErrand?: (spec: ErrandSpec) => void;
  onWishlist?: () => void;
  onOnboarding?: () => void;
  onQuit: () => void;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const STATUS_ABBREV: Record<string, string> = {
  draft: "DRFT",
  planning: "PLAN",
  active: "ACTV",
  paused: "PAUS",
  completed: "DONE",
  abandoned: "ABAN",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "gray",
  planning: "blue",
  active: "green",
  paused: "yellow",
  completed: "cyan",
  abandoned: "red",
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "red",
  high: "yellow",
  medium: "white",
  low: "gray",
  wishlist: "gray",
};

function escapeBlessedTags(text: string): string {
  return text.replace(/\{/g, "\uFF5B").replace(/\}/g, "\uFF5D");
}

// ---------------------------------------------------------------------------
// Token Usage Formatting Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Quest summary for display
// ---------------------------------------------------------------------------

interface QuestSummary {
  quest: Quest;
  totalTasks: number;
  doneTasks: number;
  completionPct: number;
}

// ---------------------------------------------------------------------------
// QuestPicker Class
// ---------------------------------------------------------------------------

export class QuestPicker {
  private screen: Widgets.Screen;
  private headerBox: Widgets.BoxElement;
  private questList: Widgets.ListElement;
  private detailBox: Widgets.BoxElement;
  private statusBar: Widgets.BoxElement;

  private projectRoot: string;
  private config: WomboConfig;
  private onSelect: (questId: string | null) => void;
  private onPlan?: (questId: string) => void;
  private onGenesis?: (vision: string) => void;
  private onErrand?: (spec: ErrandSpec) => void;
  private onWishlist?: () => void;
  private onOnboarding?: () => void;
  private onQuit: () => void;

  /** "All Tasks" + quest summaries */
  private items: Array<{ type: "all" } | { type: "quest"; summary: QuestSummary }> = [];
  private selectedIndex: number = 0;
  private totalTaskCount: number = 0;
  /** Per-quest token usage totals (loaded from usage.jsonl) */
  private questUsage: Map<string, UsageTotals> = new Map();
  /** Overall usage totals across all records */
  private overallUsage: UsageTotals | null = null;

  constructor(opts: QuestPickerOptions) {
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.onSelect = opts.onSelect;
    this.onPlan = opts.onPlan;
    this.onGenesis = opts.onGenesis;
    this.onErrand = opts.onErrand;
    this.onWishlist = opts.onWishlist;
    this.onOnboarding = opts.onOnboarding;
    this.onQuit = opts.onQuit;

    this.loadQuests();

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: "wombo-combo -- Quest Picker",
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

    // Quest list (left pane)
    this.questList = blessed.list({
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
      label: " Quests ",
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
    this.screen.append(this.questList);
    this.screen.append(this.detailBox);
    this.screen.append(this.statusBar);
    this.questList.focus();

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
    // Clean up stdin state left behind by blessed — prevents double-character
    // input when readline takes over stdin after the blessed screen is gone.
    process.stdin.removeAllListeners("keypress");
    process.stdin.removeAllListeners("data");
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write("\x1B[2J\x1B[H");
  }

  // -----------------------------------------------------------------------
  // Data Loading
  // -----------------------------------------------------------------------

  private loadQuests(): void {
    const quests = loadAllQuests(this.projectRoot);
    const tasksData = loadTasks(this.projectRoot, this.config);
    const archiveData = loadArchive(this.projectRoot, this.config);
    const doneIds = getDoneTaskIds(tasksData, archiveData.tasks);
    this.totalTaskCount = tasksData.tasks.length;

    // Build task lookup for quest summaries
    const taskMap = new Map(tasksData.tasks.map((t) => [t.id, t]));

    // Sort quests: active first, then by status order, then by priority
    const sorted = [...quests].sort((a, b) => {
      const statusDiff = (QUEST_STATUS_ORDER[a.status] ?? 99) - (QUEST_STATUS_ORDER[b.status] ?? 99);
      if (statusDiff !== 0) return statusDiff;
      return 0;
    });

    // Build items list
    this.items = [{ type: "all" as const }];
    for (const quest of sorted) {
      const totalTasks = quest.taskIds.length;
      const doneTasks = quest.taskIds.filter((id) => doneIds.has(id)).length;
      const completionPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

      this.items.push({
        type: "quest" as const,
        summary: { quest, totalTasks, doneTasks, completionPct },
      });
    }

    // Load token usage data
    this.reloadUsage();
  }

  /**
   * Reload token usage data from the JSONL file and build per-quest aggregates.
   */
  private reloadUsage(): void {
    try {
      const records = loadUsageRecords(this.projectRoot);
      if (records.length > 0) {
        this.questUsage = groupUsageBy(records, "quest_id");
        this.overallUsage = totalUsage(records);
      } else {
        this.questUsage = new Map();
        this.overallUsage = null;
      }
    } catch {
      // Non-critical — usage display is optional
      this.questUsage = new Map();
      this.overallUsage = null;
    }
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

    // Navigate
    this.questList.on("select item", (_item: any, index: number) => {
      this.selectedIndex = index;
      this.refreshDetail();
      this.screen.render();
    });

    // Enter/Space -- select
    this.screen.key(["enter", "space"], () => {
      this.selectCurrent();
    });

    // A -- activate/pause quest
    this.screen.key(["a"], () => {
      this.toggleQuestActive();
    });

    // C -- create new quest
    this.screen.key(["c"], () => {
      this.showCreateQuestModal();
    });

    // P -- plan quest (run planner agent)
    this.screen.key(["p"], () => {
      this.planQuest();
    });

    // G -- genesis (project-level decomposition)
    this.screen.key(["g"], () => {
      this.triggerGenesis();
    });

    // E -- errand (quick task generation without a quest)
    this.screen.key(["e"], () => {
      this.triggerErrand();
    });

    // W -- wishlist browser
    this.screen.key(["w"], () => {
      this.triggerWishlist();
    });

    // O -- onboarding wizard
    this.screen.key(["o"], () => {
      this.triggerOnboarding();
    });
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  private selectCurrent(): void {
    const item = this.items[this.selectedIndex];
    if (!item) return;

    if (item.type === "all") {
      this.destroy();
      this.onSelect(null);
    } else {
      this.destroy();
      this.onSelect(item.summary.quest.id);
    }
  }

  private toggleQuestActive(): void {
    const item = this.items[this.selectedIndex];
    if (!item || item.type === "all") return;

    const quest = item.summary.quest;
    if (quest.status === "active") {
      quest.status = "paused";
    } else if (quest.status === "draft" || quest.status === "paused" || quest.status === "planning") {
      quest.status = "active";
      if (!quest.started_at) {
        quest.started_at = new Date().toISOString();
      }
    } else {
      // completed/abandoned -- can't toggle
      return;
    }

    saveQuest(this.projectRoot, quest);
    this.loadQuests();
    this.refreshAll();
    this.screen.render();
  }

  private planQuest(): void {
    if (this.creatingQuest) return;
    const item = this.items[this.selectedIndex];
    if (!item || item.type === "all") return;

    const quest = item.summary.quest;
    // Only allow planning for draft or planning quests
    if (quest.status !== "draft" && quest.status !== "planning") {
      return;
    }

    if (!this.onPlan) return;

    this.destroy();
    this.onPlan(quest.id);
  }

  private triggerGenesis(): void {
    if (this.creatingQuest) return;
    if (!this.onGenesis) return;

    this.showInputModal(
      "Genesis Planner",
      "Describe your project vision. The genesis planner will\ndecompose it into a set of quests.",
      "Vision",
      (vision) => {
        this.destroy();
        this.onGenesis!(vision);
      }
    );
  }

  private triggerErrand(): void {
    if (this.creatingQuest) return;
    if (!this.onErrand) return;

    this.showErrandWizard((spec) => {
      this.destroy();
      this.onErrand!(spec);
    });
  }

  private triggerWishlist(): void {
    if (this.creatingQuest) return;
    if (!this.onWishlist) return;

    this.destroy();
    this.onWishlist();
  }

  private triggerOnboarding(): void {
    if (this.creatingQuest) return;
    if (!this.onOnboarding) return;

    this.destroy();
    this.onOnboarding();
  }

  // -----------------------------------------------------------------------
  // Errand Wizard (multi-step: description → scope → objectives → confirm)
  // -----------------------------------------------------------------------

  /**
   * Show a multi-step errand wizard modal.
   * Steps:
   *   1. Description (textbox, required) — "What needs to be done?"
   *   2. Scope (textarea, optional)      — "What areas/files to focus on?"
   *   3. Objectives (textarea, optional) — "Key objectives / acceptance criteria"
   *   4. Review (summary, Enter to confirm, Esc to go back)
   *
   * Modelled after showCreateQuestModal — same overlay pattern, step navigation.
   */
  private showErrandWizard(onSubmit: (spec: ErrandSpec) => void): void {
    if (this.creatingQuest) return;
    this.creatingQuest = true;

    const modal = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "70%",
      height: "70%",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "magenta" },
        fg: "white",
        bg: "black",
      },
      label: " {magenta-fg}New Errand{/magenta-fg} ",
      shadow: true,
    });

    // Header / instructions area
    const header = blessed.box({
      parent: modal,
      top: 0,
      left: 1,
      right: 1,
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Single-line textbox (for description step)
    const textbox = blessed.textbox({
      parent: modal,
      top: 3,
      left: 1,
      right: 1,
      height: 3,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        fg: "white",
        bg: "black",
        focus: { border: { fg: "magenta" } },
      },
      inputOnFocus: true,
    });

    // Multi-line textarea (for scope & objectives steps)
    const textarea = blessed.textarea({
      parent: modal,
      top: 3,
      left: 1,
      right: 1,
      height: 10,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        fg: "white",
        bg: "black",
        focus: { border: { fg: "magenta" } },
      },
      inputOnFocus: true,
      hidden: true,
    });

    // Review / summary box (for confirm step)
    const reviewBox = blessed.box({
      parent: modal,
      top: 3,
      left: 1,
      right: 1,
      height: "100%-6",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "green" },
        fg: "white",
        bg: "black",
      },
      hidden: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
    });

    // Status line at bottom
    const statusLine = blessed.box({
      parent: modal,
      bottom: 0,
      left: 1,
      right: 1,
      height: 1,
      tags: true,
      style: { fg: "gray", bg: "black" },
    });

    // Collected values
    let description = "";
    let scope = "";
    let objectives = "";

    type Step = "description" | "scope" | "objectives" | "review";
    const steps: Step[] = ["description", "scope", "objectives", "review"];
    let currentStepIdx = 0;

    const cleanup = () => {
      modal.destroy();
      this.creatingQuest = false;
      this.questList.focus();
      this.screen.render();
    };

    const showStep = (step: Step) => {
      textbox.hide();
      textarea.hide();
      reviewBox.hide();

      const stepLabel = `Step ${currentStepIdx + 1}/${steps.length}`;

      switch (step) {
        case "description":
          header.setContent(
            `{bold}${stepLabel} — Description{/bold}\n` +
            `{cyan-fg}What needs to be done? (required){/cyan-fg}\n` +
            `{gray-fg}Esc to cancel{/gray-fg}`
          );
          statusLine.setContent(
            "{gray-fg}Enter: next  |  Esc: cancel{/gray-fg}"
          );
          textbox.setValue(description);
          textbox.show();
          textbox.focus();
          break;

        case "scope":
          header.setContent(
            `{bold}${stepLabel} — Scope{/bold}\n` +
            `{cyan-fg}What areas/files should this focus on? (optional — Enter to skip){/cyan-fg}\n` +
            `{gray-fg}Esc to go back{/gray-fg}`
          );
          statusLine.setContent(
            `{gray-fg}Description: ${description.slice(0, 50)}${description.length > 50 ? "…" : ""}{/gray-fg}`
          );
          textarea.setValue(scope);
          textarea.show();
          textarea.focus();
          break;

        case "objectives":
          header.setContent(
            `{bold}${stepLabel} — Objectives{/bold}\n` +
            `{cyan-fg}Key objectives or acceptance criteria (optional — Enter to skip){/cyan-fg}\n` +
            `{gray-fg}Esc to go back{/gray-fg}`
          );
          statusLine.setContent(
            `{gray-fg}Description: ${description.slice(0, 50)}${description.length > 50 ? "…" : ""}{/gray-fg}`
          );
          textarea.setValue(objectives);
          textarea.show();
          textarea.focus();
          break;

        case "review": {
          header.setContent(
            `{bold}${stepLabel} — Review{/bold}\n` +
            `{cyan-fg}Review your errand details below.{/cyan-fg}\n` +
            `{gray-fg}Enter to confirm  |  Esc to go back{/gray-fg}`
          );
          statusLine.setContent(
            "{gray-fg}Enter: launch errand planner  |  Esc: go back{/gray-fg}"
          );
          const lines: string[] = [];
          lines.push(`{bold}{magenta-fg}Description:{/magenta-fg}{/bold}`);
          lines.push(`  ${description}`);
          lines.push(``);
          if (scope) {
            lines.push(`{bold}{cyan-fg}Scope:{/cyan-fg}{/bold}`);
            for (const ln of scope.split("\n")) lines.push(`  ${ln}`);
            lines.push(``);
          } else {
            lines.push(`{gray-fg}Scope: (none){/gray-fg}`);
            lines.push(``);
          }
          if (objectives) {
            lines.push(`{bold}{cyan-fg}Objectives:{/cyan-fg}{/bold}`);
            for (const ln of objectives.split("\n")) lines.push(`  ${ln}`);
          } else {
            lines.push(`{gray-fg}Objectives: (none){/gray-fg}`);
          }
          reviewBox.setContent(lines.join("\n"));
          reviewBox.show();
          reviewBox.focus();
          break;
        }
      }

      this.screen.render();
    };

    const goBack = () => {
      if (currentStepIdx <= 0) {
        cleanup();
        return;
      }
      currentStepIdx--;
      showStep(steps[currentStepIdx]);
    };

    const advance = () => {
      currentStepIdx++;
      if (currentStepIdx >= steps.length) {
        // Should not happen — review step handles confirm
        return;
      }
      showStep(steps[currentStepIdx]);
    };

    // --- Textbox handlers (description step) ---
    textbox.on("submit", (value: string) => {
      const trimmed = (value ?? "").trim();
      if (!trimmed) {
        statusLine.setContent("{red-fg}Description cannot be empty{/red-fg}");
        this.screen.render();
        textbox.focus();
        return;
      }
      description = trimmed;
      advance();
    });

    textbox.on("cancel", () => {
      goBack();
    });

    // --- Textarea handlers (scope & objectives steps) ---
    textarea.key(["enter"], () => {
      const val = (textarea.getValue() ?? "").trim();
      const step = steps[currentStepIdx];
      if (step === "scope") {
        scope = val; // may be empty — that's OK
        advance();
      } else if (step === "objectives") {
        objectives = val; // may be empty — that's OK
        advance();
      }
    });

    textarea.key(["escape"], () => {
      goBack();
    });

    // --- Review step handlers ---
    reviewBox.key(["enter"], () => {
      // Confirm — build the spec and fire callback
      const spec: ErrandSpec = { description };
      if (scope) spec.scope = scope;
      if (objectives) spec.objectives = objectives;
      modal.destroy();
      this.creatingQuest = false;
      this.screen.render();
      onSubmit(spec);
    });

    reviewBox.key(["escape"], () => {
      goBack();
    });

    // Start at step 1
    showStep("description");
  }

  // -----------------------------------------------------------------------
  // Input Modal (reusable for genesis/errand text prompts)
  // -----------------------------------------------------------------------

  /**
   * Show a simple modal with a text input field. Calls `onSubmit` with the
   * trimmed value when the user presses Enter. Pressing Escape cancels.
   * This keeps all input inside the blessed screen — no readline needed.
   */
  private showInputModal(
    title: string,
    instructions: string,
    placeholder: string,
    onSubmit: (value: string) => void
  ): void {
    this.creatingQuest = true; // reuse flag to block other key handlers

    const modal = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "60%",
      height: 12,
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "magenta" },
        fg: "white",
        bg: "black",
      },
      label: ` {magenta-fg}${title}{/magenta-fg} `,
      shadow: true,
    });

    blessed.box({
      parent: modal,
      top: 0,
      left: 1,
      right: 1,
      height: 3,
      tags: true,
      content: `{cyan-fg}${instructions}{/cyan-fg}`,
      style: { fg: "white", bg: "black" },
    });

    const textbox = blessed.textbox({
      parent: modal,
      top: 4,
      left: 1,
      right: 1,
      height: 3,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        fg: "white",
        bg: "black",
        focus: { border: { fg: "magenta" } },
      },
      inputOnFocus: true,
    });

    blessed.box({
      parent: modal,
      bottom: 0,
      left: 1,
      right: 1,
      height: 1,
      tags: true,
      content: "{gray-fg}Enter: submit  |  Escape: cancel{/gray-fg}",
      style: { fg: "gray", bg: "black" },
    });

    textbox.on("submit", (value: string) => {
      const trimmed = (value ?? "").trim();
      if (!trimmed) {
        // Empty input — re-focus so the user can try again
        textbox.focus();
        this.screen.render();
        return;
      }
      modal.destroy();
      this.creatingQuest = false;
      this.screen.render();
      onSubmit(trimmed);
    });

    textbox.on("cancel", () => {
      modal.destroy();
      this.creatingQuest = false;
      this.screen.render();
    });

    textbox.focus();
    this.screen.render();
  }

  // -----------------------------------------------------------------------
  // Create Quest Modal
  // -----------------------------------------------------------------------

  /** Whether the create modal is currently showing (blocks other key handlers) */
  private creatingQuest = false;

  /**
   * Show a multi-step modal form to create a new quest.
   * Delegates to the extracted showQuestWizard() utility.
   */
  private showCreateQuestModal(): void {
    if (this.creatingQuest) return;
    this.creatingQuest = true;

    showQuestWizard({
      screen: this.screen,
      projectRoot: this.projectRoot,
      baseBranch: this.config.baseBranch,
      onCreated: (_quest) => {
        this.creatingQuest = false;
        this.loadQuests();
        // Select the newly created quest
        const newIdx = this.items.findIndex(
          (item) => item.type === "quest" && item.summary.quest.id === _quest.id
        );
        if (newIdx >= 0) this.selectedIndex = newIdx;
        this.refreshAll();
        this.questList.focus();
        this.screen.render();
      },
      onCancelled: () => {
        this.creatingQuest = false;
        this.questList.focus();
        this.screen.render();
      },
    });
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
    const questCount = this.items.length - 1; // exclude "All Tasks"
    const activeCount = this.items.filter(
      (i) => i.type === "quest" && i.summary.quest.status === "active"
    ).length;

    let line1 = ` {bold}wombo-combo{/bold} {magenta-fg}Quest Picker{/magenta-fg}`;
    line1 += `  {gray-fg}|{/gray-fg}  {white-fg}${questCount}{/white-fg} quest${questCount !== 1 ? "s" : ""}`;
    if (activeCount > 0) {
      line1 += `  {gray-fg}|{/gray-fg}  {green-fg}${activeCount}{/green-fg} active`;
    }
    line1 += `  {gray-fg}|{/gray-fg}  {white-fg}${this.totalTaskCount}{/white-fg} total tasks`;

    let line2 = ` {gray-fg}Select a quest to filter tasks, or choose "All Tasks" for the full list{/gray-fg}`;

    this.headerBox.setContent(`${line1}\n${line2}`);
  }

  private refreshList(): void {
    const listItems: string[] = [];

    for (const item of this.items) {
      if (item.type === "all") {
        listItems.push(
          ` {bold}{cyan-fg}\u25C6{/cyan-fg} All Tasks{/bold} {gray-fg}(${this.totalTaskCount}){/gray-fg}`
        );
      } else {
        const { quest, totalTasks, doneTasks, completionPct } = item.summary;

        // Status badge
        const sColor = STATUS_COLORS[quest.status] ?? "white";
        const sAbbr = STATUS_ABBREV[quest.status] ?? quest.status.slice(0, 4).toUpperCase();
        const statusBadge = `{${sColor}-fg}${sAbbr}{/${sColor}-fg}`;

        // Priority
        const pColor = PRIORITY_COLORS[quest.priority] ?? "white";
        const priorityDot = `{${pColor}-fg}\u25CF{/${pColor}-fg}`;

        // Title (truncated)
        const maxTitleLen = 28;
        const title = quest.title.length > maxTitleLen
          ? quest.title.slice(0, maxTitleLen - 1) + "\u2026"
          : quest.title;

        // Completion bar
        const barWidth = 8;
        const filled = Math.round((completionPct / 100) * barWidth);
        const empty = barWidth - filled;
        const bar = `{green-fg}${"#".repeat(filled)}{/green-fg}{gray-fg}${"-".repeat(empty)}{/gray-fg}`;

        // Task count
        const taskInfo = totalTasks > 0
          ? `{gray-fg}${doneTasks}/${totalTasks}{/gray-fg}`
          : `{gray-fg}0 tasks{/gray-fg}`;

        listItems.push(
          ` ${priorityDot} ${statusBadge} ${escapeBlessedTags(title)}  [${bar}] ${taskInfo}`
        );
      }
    }

    if (listItems.length === 0) {
      listItems.push(" {gray-fg}No quests found{/gray-fg}");
    }

    const prevSelected = this.selectedIndex;
    this.questList.setItems(listItems as any);
    if (prevSelected < listItems.length) {
      this.questList.select(prevSelected);
    }
  }

  private refreshDetail(): void {
    const item = this.items[this.selectedIndex];
    if (!item) {
      this.detailBox.setContent("{gray-fg}No item selected{/gray-fg}");
      this.detailBox.setLabel(" Details ");
      return;
    }

    if (item.type === "all") {
      const lines: string[] = [
        "{bold}{cyan-fg}All Tasks{/cyan-fg}{/bold}",
        "",
        "  Browse all tasks across all quests",
        "  and unassigned tasks.",
        "",
        `  Total: {white-fg}${this.totalTaskCount}{/white-fg} tasks`,
        "",
      ];

      // Overall token usage
      if (this.overallUsage) {
        const u = this.overallUsage;
        lines.push("{bold}{yellow-fg}Overall Token Usage:{/yellow-fg}{/bold}");
        lines.push(`  Input:      {cyan-fg}${formatTokenCount(u.input_tokens)}{/cyan-fg}`);
        lines.push(`  Output:     {cyan-fg}${formatTokenCount(u.output_tokens)}{/cyan-fg}`);
        if (u.cache_read > 0) {
          lines.push(`  Cache read: {gray-fg}${formatTokenCount(u.cache_read)}{/gray-fg}`);
        }
        if (u.reasoning_tokens > 0) {
          lines.push(`  Reasoning:  {magenta-fg}${formatTokenCount(u.reasoning_tokens)}{/magenta-fg}`);
        }
        lines.push(`  Total:      {white-fg}${formatTokenCount(u.total_tokens)}{/white-fg}`);
        if (u.total_cost > 0) {
          lines.push(`  Cost:       {yellow-fg}${formatCost(u.total_cost)}{/yellow-fg}`);
        }
        lines.push(`  Steps:      ${u.record_count}`);
        lines.push("");
      }

      lines.push("  Press {bold}Enter{/bold} to open the full task browser.");
      this.detailBox.setContent(lines.join("\n"));
      this.detailBox.setLabel(" All Tasks ");
      return;
    }

    const { quest, totalTasks, doneTasks, completionPct } = item.summary;
    const lines: string[] = [];

    // Title
    lines.push(`{bold}{white-fg}${escapeBlessedTags(quest.title)}{/white-fg}{/bold}`);
    lines.push("");

    // Status
    const sColor = STATUS_COLORS[quest.status] ?? "white";
    lines.push(`  Status:     {${sColor}-fg}${quest.status}{/${sColor}-fg}`);

    // Priority
    const pColor = PRIORITY_COLORS[quest.priority] ?? "white";
    lines.push(`  Priority:   {${pColor}-fg}${quest.priority}{/${pColor}-fg}`);

    // Difficulty
    lines.push(`  Difficulty: ${quest.difficulty}`);

    // HITL mode
    lines.push(`  HITL:       ${quest.hitlMode}`);
    lines.push("");

    // Task progress
    if (totalTasks > 0) {
      lines.push("{bold}Progress:{/bold}");
      lines.push(`  Tasks: ${doneTasks}/${totalTasks} done (${completionPct}%)`);

      // Progress bar (wider in detail view)
      const barWidth = 20;
      const filled = Math.round((completionPct / 100) * barWidth);
      const empty = barWidth - filled;
      const bar = `{green-fg}${"=".repeat(filled)}{/green-fg}{gray-fg}${"-".repeat(empty)}{/gray-fg}`;
      lines.push(`  [${bar}]`);
    } else {
      lines.push("{bold}Progress:{/bold}");
      lines.push("  {gray-fg}No tasks assigned{/gray-fg}");
    }
    lines.push("");

    // Goal
    if (quest.goal) {
      lines.push("{bold}Goal:{/bold}");
      const goalText = escapeBlessedTags(quest.goal.trim());
      const words = goalText.split(/\s+/);
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
    }

    // Branch
    lines.push("{bold}Branch:{/bold}");
    lines.push(`  ${quest.branch}`);
    lines.push(`  Base: ${quest.baseBranch}`);
    lines.push("");

    // Constraints
    if (quest.constraints.add.length > 0) {
      lines.push("{bold}Added Constraints:{/bold}");
      for (const c of quest.constraints.add) {
        lines.push(`  + ${escapeBlessedTags(c)}`);
      }
      lines.push("");
    }
    if (quest.constraints.ban.length > 0) {
      lines.push("{bold}Banned:{/bold}");
      for (const b of quest.constraints.ban) {
        lines.push(`  - ${escapeBlessedTags(b)}`);
      }
      lines.push("");
    }

    // Dependencies
    if (quest.depends_on.length > 0) {
      lines.push("{bold}Depends on:{/bold}");
      for (const d of quest.depends_on) {
        lines.push(`  \u2192 ${d}`);
      }
      lines.push("");
    }

    // Notes
    if (quest.notes.length > 0) {
      lines.push("{bold}Notes:{/bold}");
      for (const n of quest.notes) {
        lines.push(`  ${escapeBlessedTags(n)}`);
      }
      lines.push("");
    }

    // Timestamps
    lines.push("{bold}Timeline:{/bold}");
    lines.push(`  Created: ${quest.created_at.slice(0, 10)}`);
    if (quest.started_at) lines.push(`  Started: ${quest.started_at.slice(0, 10)}`);
    if (quest.ended_at) lines.push(`  Ended:   ${quest.ended_at.slice(0, 10)}`);
    lines.push("");

    // Token usage
    const usage = this.questUsage.get(quest.id);
    if (usage) {
      lines.push("{bold}{yellow-fg}Token Usage:{/yellow-fg}{/bold}");
      lines.push(`  Input:      {cyan-fg}${formatTokenCount(usage.input_tokens)}{/cyan-fg}`);
      lines.push(`  Output:     {cyan-fg}${formatTokenCount(usage.output_tokens)}{/cyan-fg}`);
      if (usage.cache_read > 0) {
        lines.push(`  Cache read: {gray-fg}${formatTokenCount(usage.cache_read)}{/gray-fg}`);
      }
      if (usage.reasoning_tokens > 0) {
        lines.push(`  Reasoning:  {magenta-fg}${formatTokenCount(usage.reasoning_tokens)}{/magenta-fg}`);
      }
      lines.push(`  Total:      {white-fg}${formatTokenCount(usage.total_tokens)}{/white-fg}`);
      if (usage.total_cost > 0) {
        lines.push(`  Cost:       {yellow-fg}${formatCost(usage.total_cost)}{/yellow-fg}`);
      }
      lines.push(`  Steps:      ${usage.record_count}`);
    }
    this.detailBox.setContent(lines.join("\n"));
    this.detailBox.setLabel(` ${quest.id} `);
  }

  private refreshStatusBar(): void {
    let line1 = ` {bold}Keys:{/bold}`;
    line1 += `  {gray-fg}Enter{/gray-fg} select`;
    line1 += `  {gray-fg}C{/gray-fg} create`;
    line1 += `  {gray-fg}E{/gray-fg} errand`;
    line1 += `  {gray-fg}P{/gray-fg} plan`;
    line1 += `  {gray-fg}G{/gray-fg} genesis`;
    line1 += `  {gray-fg}A{/gray-fg} activate/pause`;
    line1 += `  {gray-fg}W{/gray-fg} wishlist`;
    line1 += `  {gray-fg}O{/gray-fg} onboarding`;
    line1 += `  {gray-fg}Q{/gray-fg} quit`;

    const item = this.items[this.selectedIndex];
    let line2 = " ";
    if (item?.type === "all") {
      line2 += `{cyan-fg}View all tasks across all quests{/cyan-fg}`;
    } else if (item?.type === "quest") {
      const q = item.summary.quest;
      line2 += `{white-fg}${escapeBlessedTags(q.id)}{/white-fg}`;
      line2 += `  {gray-fg}|{/gray-fg}  ${item.summary.totalTasks} task${item.summary.totalTasks !== 1 ? "s" : ""}`;
      line2 += `  {gray-fg}|{/gray-fg}  ${item.summary.completionPct}% complete`;
      if (q.status === "draft" || q.status === "planning") {
        line2 += `  {gray-fg}|{/gray-fg}  {magenta-fg}P to plan{/magenta-fg}`;
      }
    }

    this.statusBar.setContent(`${line1}\n${line2}`);
  }
}
