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
import type { Quest, QuestHitlMode } from "./quest.js";
import { QUEST_STATUS_ORDER, createBlankQuest, VALID_HITL_MODES } from "./quest.js";
import { loadAllQuests, saveQuest, loadQuest } from "./quest-store.js";
import { VALID_PRIORITIES, VALID_DIFFICULTIES } from "./task-schema.js";
import type { Priority, Difficulty } from "./tasks.js";
import { loadTasks, getDoneTaskIds, loadArchive } from "./tasks.js";
import type { WomboConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuestPickerAction =
  | { type: "select"; questId: string | null }
  | { type: "quit" };

export interface QuestPickerOptions {
  projectRoot: string;
  config: WomboConfig;
  onSelect: (questId: string | null) => void;
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
  private onQuit: () => void;

  /** "All Tasks" + quest summaries */
  private items: Array<{ type: "all" } | { type: "quest"; summary: QuestSummary }> = [];
  private selectedIndex: number = 0;
  private totalTaskCount: number = 0;

  constructor(opts: QuestPickerOptions) {
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.onSelect = opts.onSelect;
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

  // -----------------------------------------------------------------------
  // Create Quest Modal
  // -----------------------------------------------------------------------

  /** Whether the create modal is currently showing (blocks other key handlers) */
  private creatingQuest = false;

  /**
   * Show a multi-step modal form to create a new quest.
   * Steps: ID -> Title -> Goal -> Priority -> Difficulty -> HITL -> Confirm
   */
  private showCreateQuestModal(): void {
    if (this.creatingQuest) return;
    this.creatingQuest = true;

    // Overlay box that covers the detail pane
    const modal = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "70%",
      height: "80%",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "magenta" },
        fg: "white",
        bg: "black",
      },
      label: " {magenta-fg}New Quest{/magenta-fg} ",
      shadow: true,
    });

    // Content area (instructions)
    const content = blessed.box({
      parent: modal,
      top: 0,
      left: 1,
      right: 1,
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Textbox for text input steps
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

    // Textarea for goal (multi-line)
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

    // Selection list for enum steps (priority, difficulty, hitl)
    const selectList = blessed.list({
      parent: modal,
      top: 3,
      left: 1,
      right: 1,
      height: "100%-8",
      tags: true,
      keys: true,
      vi: true,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" },
        bg: "black",
      },
      hidden: true,
    });

    // Status line at bottom of modal
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
    let questId = "";
    let questTitle = "";
    let questGoal = "";
    let questPriority: Priority = "medium";
    let questDifficulty: Difficulty = "medium";
    let questHitl: QuestHitlMode = "yolo";

    type Step = "id" | "title" | "goal" | "priority" | "difficulty" | "hitl";
    const steps: Step[] = ["id", "title", "goal", "priority", "difficulty", "hitl"];
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
      selectList.hide();

      const stepLabel = `Step ${currentStepIdx + 1}/${steps.length}`;

      switch (step) {
        case "id":
          content.setContent(
            `{bold}${stepLabel} — Quest ID{/bold}\n` +
            `{gray-fg}Kebab-case identifier (e.g. auth-overhaul, search-api){/gray-fg}\n` +
            `{gray-fg}Esc to cancel{/gray-fg}`
          );
          statusLine.setContent("{gray-fg}Enter a unique ID for the quest{/gray-fg}");
          textbox.setValue("");
          textbox.show();
          textbox.focus();
          break;

        case "title":
          content.setContent(
            `{bold}${stepLabel} — Title{/bold}\n` +
            `{gray-fg}Human-readable name for the quest{/gray-fg}\n` +
            `{gray-fg}Esc to go back{/gray-fg}`
          );
          statusLine.setContent(`{gray-fg}ID: ${questId}{/gray-fg}`);
          textbox.setValue("");
          textbox.show();
          textbox.focus();
          break;

        case "goal":
          content.setContent(
            `{bold}${stepLabel} — Goal{/bold}\n` +
            `{gray-fg}What should this quest achieve? (Enter to submit, Esc to go back){/gray-fg}\n` +
            `{gray-fg}Shift+Enter or \\n for newlines{/gray-fg}`
          );
          statusLine.setContent(`{gray-fg}ID: ${questId} | Title: ${questTitle}{/gray-fg}`);
          textarea.setValue("");
          textarea.show();
          textarea.focus();
          break;

        case "priority":
          content.setContent(
            `{bold}${stepLabel} — Priority{/bold}\n` +
            `{gray-fg}Select with Enter, Esc to go back{/gray-fg}`
          );
          statusLine.setContent(`{gray-fg}ID: ${questId} | Title: ${questTitle}{/gray-fg}`);
          selectList.setItems(
            (VALID_PRIORITIES as readonly string[]).map((p) => {
              const dot = PRIORITY_COLORS[p] ?? "white";
              const marker = p === "medium" ? " {gray-fg}(default){/gray-fg}" : "";
              return `  {${dot}-fg}\u25CF{/${dot}-fg}  ${p}${marker}`;
            }) as any
          );
          // Pre-select "medium" (index 2)
          selectList.select(2);
          selectList.show();
          selectList.focus();
          break;

        case "difficulty":
          content.setContent(
            `{bold}${stepLabel} — Difficulty{/bold}\n` +
            `{gray-fg}Select with Enter, Esc to go back{/gray-fg}`
          );
          statusLine.setContent(`{gray-fg}ID: ${questId} | Priority: ${questPriority}{/gray-fg}`);
          selectList.setItems(
            (VALID_DIFFICULTIES as readonly string[]).map((d) => {
              const marker = d === "medium" ? " {gray-fg}(default){/gray-fg}" : "";
              return `  ${d}${marker}`;
            }) as any
          );
          selectList.select(2);
          selectList.show();
          selectList.focus();
          break;

        case "hitl":
          content.setContent(
            `{bold}${stepLabel} — HITL Mode{/bold}\n` +
            `{gray-fg}Human-in-the-loop mode for agents. Select with Enter, Esc to go back{/gray-fg}`
          );
          statusLine.setContent(`{gray-fg}ID: ${questId} | Difficulty: ${questDifficulty}{/gray-fg}`);
          const hitlDescs: Record<string, string> = {
            yolo: "Full autonomy, no interruptions",
            cautious: "Agent blocks on uncertainty, user answers in TUI",
            supervised: "Like cautious, but prompt encourages asking often",
          };
          selectList.setItems(
            (VALID_HITL_MODES as readonly string[]).map((m) => {
              const desc = hitlDescs[m] ?? "";
              const marker = m === "yolo" ? " {gray-fg}(default){/gray-fg}" : "";
              return `  ${m}${marker}  {gray-fg}— ${desc}{/gray-fg}`;
            }) as any
          );
          selectList.select(0);
          selectList.show();
          selectList.focus();
          break;
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

    const advanceOrFinish = () => {
      currentStepIdx++;
      if (currentStepIdx >= steps.length) {
        // All done — create the quest
        this.finishCreateQuest(
          questId,
          questTitle,
          questGoal,
          questPriority,
          questDifficulty,
          questHitl,
          modal,
          content,
          statusLine
        );
        return;
      }
      showStep(steps[currentStepIdx]);
    };

    // --- Textbox submit/cancel for ID and Title steps ---
    textbox.on("submit", (value: string) => {
      const trimmed = (value ?? "").trim();
      const currentStep = steps[currentStepIdx];

      if (currentStep === "id") {
        // Validate ID
        if (!trimmed) {
          statusLine.setContent("{red-fg}ID cannot be empty{/red-fg}");
          this.screen.render();
          textbox.focus();
          return;
        }
        if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(trimmed)) {
          statusLine.setContent("{red-fg}ID must be kebab-case (lowercase letters, numbers, hyphens){/red-fg}");
          this.screen.render();
          textbox.focus();
          return;
        }
        // Check duplicate
        const existing = loadQuest(this.projectRoot, trimmed);
        if (existing) {
          statusLine.setContent(`{red-fg}Quest "${trimmed}" already exists (${existing.status}){/red-fg}`);
          this.screen.render();
          textbox.focus();
          return;
        }
        questId = trimmed;
        advanceOrFinish();
      } else if (currentStep === "title") {
        if (!trimmed) {
          statusLine.setContent("{red-fg}Title cannot be empty{/red-fg}");
          this.screen.render();
          textbox.focus();
          return;
        }
        questTitle = trimmed;
        advanceOrFinish();
      }
    });

    textbox.on("cancel", () => {
      goBack();
    });

    // --- Textarea submit/cancel for Goal step ---
    textarea.key(["enter"], () => {
      const val = (textarea.getValue() ?? "").trim();
      if (!val) {
        statusLine.setContent("{red-fg}Goal cannot be empty{/red-fg}");
        this.screen.render();
        return;
      }
      questGoal = val;
      advanceOrFinish();
    });

    textarea.key(["escape"], () => {
      goBack();
    });

    // --- Select list for Priority, Difficulty, HITL ---
    selectList.on("select item", (_item: any, index: number) => {
      // This fires on mouse click or manual select event
    });

    selectList.key(["enter", "space"], () => {
      const currentStep = steps[currentStepIdx];
      const idx = (selectList as any).selected ?? 0;

      if (currentStep === "priority") {
        questPriority = (VALID_PRIORITIES as readonly string[])[idx] as Priority;
        advanceOrFinish();
      } else if (currentStep === "difficulty") {
        questDifficulty = (VALID_DIFFICULTIES as readonly string[])[idx] as Difficulty;
        advanceOrFinish();
      } else if (currentStep === "hitl") {
        questHitl = (VALID_HITL_MODES as readonly string[])[idx] as QuestHitlMode;
        advanceOrFinish();
      }
    });

    selectList.key(["escape"], () => {
      goBack();
    });

    // Start at step 0
    showStep(steps[0]);
  }

  /**
   * Finalize quest creation: save to store, show confirmation, reload list.
   */
  private finishCreateQuest(
    id: string,
    title: string,
    goal: string,
    priority: Priority,
    difficulty: Difficulty,
    hitlMode: QuestHitlMode,
    modal: Widgets.BoxElement,
    content: Widgets.BoxElement,
    statusLine: Widgets.BoxElement
  ): void {
    try {
      const baseBranch = this.config.baseBranch;
      const quest = createBlankQuest(id, title, goal, baseBranch, {
        priority,
        difficulty,
        hitlMode,
      });

      saveQuest(this.projectRoot, quest);

      // Show confirmation briefly
      content.setContent(
        `{bold}{green-fg}\u2714 Quest created!{/green-fg}{/bold}\n\n` +
        `  {white-fg}${id}{/white-fg} — ${escapeBlessedTags(title)}\n` +
        `  Priority: ${priority}  |  Difficulty: ${difficulty}  |  HITL: ${hitlMode}\n` +
        `  Branch: quest/${id}  |  Base: ${baseBranch}`
      );
      statusLine.setContent("{gray-fg}Returning to quest list...{/gray-fg}");
      this.screen.render();

      // After a brief delay, reload and return to picker
      setTimeout(() => {
        modal.destroy();
        this.creatingQuest = false;
        this.loadQuests();
        // Select the newly created quest
        const newIdx = this.items.findIndex(
          (item) => item.type === "quest" && item.summary.quest.id === id
        );
        if (newIdx >= 0) this.selectedIndex = newIdx;
        this.refreshAll();
        this.questList.focus();
        this.screen.render();
      }, 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      content.setContent(
        `{bold}{red-fg}\u2718 Failed to create quest{/red-fg}{/bold}\n\n` +
        `  ${escapeBlessedTags(msg)}`
      );
      statusLine.setContent("{gray-fg}Press Esc to return{/gray-fg}");
      this.screen.render();

      const escHandler = () => {
        modal.destroy();
        this.creatingQuest = false;
        this.questList.focus();
        this.screen.render();
      };
      modal.key(["escape"], escHandler);
    }
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
        "  Press {bold}Enter{/bold} to open the full task browser.",
      ];
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

    this.detailBox.setContent(lines.join("\n"));
    this.detailBox.setLabel(` ${quest.id} `);
  }

  private refreshStatusBar(): void {
    let line1 = ` {bold}Keys:{/bold}`;
    line1 += `  {gray-fg}Enter{/gray-fg} select`;
    line1 += `  {gray-fg}C{/gray-fg} create`;
    line1 += `  {gray-fg}A{/gray-fg} activate/pause`;
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
    }

    this.statusBar.setContent(`${line1}\n${line2}`);
  }
}
