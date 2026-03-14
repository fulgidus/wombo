/**
 * tui-quest-wizard.ts -- Standalone 6-step quest creation wizard for blessed.
 *
 * Extracted from QuestPicker.showCreateQuestModal() so it can be reused in
 * multiple contexts (Quest Picker, Wishlist → Quest promotion, etc.).
 *
 * Steps: ID → Title → Goal → Priority → Difficulty → HITL
 *
 * Two modes:
 *   1. Overlay: pass an existing blessed screen — wizard renders as a modal.
 *   2. Standalone: omit the screen — wizard creates its own and destroys it
 *      when finished.
 *
 * Usage:
 *   // Overlay (inside QuestPicker)
 *   showQuestWizard({ screen: this.screen, projectRoot, baseBranch, ... });
 *
 *   // Standalone (Promise-based, creates/destroys its own screen)
 *   const quest = await runQuestWizardAsync({ projectRoot, baseBranch, prefill: { goal } });
 */

import blessed from "neo-blessed";
import type { Widgets } from "neo-blessed";
import type { Quest, QuestHitlMode } from "./quest.js";
import { createBlankQuest, VALID_HITL_MODES } from "./quest.js";
import { saveQuest, loadQuest } from "./quest-store.js";
import { VALID_PRIORITIES, VALID_DIFFICULTIES } from "./task-schema.js";
import type { Priority, Difficulty } from "./tasks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Types
// ---------------------------------------------------------------------------

export interface QuestWizardPrefill {
  id?: string;
  title?: string;
  goal?: string;
  priority?: Priority;
  difficulty?: Difficulty;
  hitlMode?: QuestHitlMode;
}

export interface QuestWizardOptions {
  /** Blessed screen to render on. If omitted, a new one is created. */
  screen?: Widgets.Screen;
  /** Project root directory (for loadQuest duplicate checks, saveQuest). */
  projectRoot: string;
  /** Base branch for the new quest's branch. */
  baseBranch: string;
  /** Optional pre-filled values for wizard fields. */
  prefill?: QuestWizardPrefill;
  /** Called with the newly created Quest after the confirmation delay. */
  onCreated: (quest: Quest) => void;
  /** Called when user cancels (Escape from step 0). */
  onCancelled: () => void;
}

// ---------------------------------------------------------------------------
// showQuestWizard — renders a 6-step modal wizard on a blessed screen
// ---------------------------------------------------------------------------

/**
 * Show the 6-step quest creation wizard as a modal overlay on the given
 * (or newly created) screen.
 *
 * @returns A cleanup function that destroys the modal. Normally you don't
 *          need to call this — the wizard handles its own cleanup.
 */
export function showQuestWizard(opts: QuestWizardOptions): () => void {
  const {
    projectRoot,
    baseBranch,
    prefill,
    onCreated,
    onCancelled,
  } = opts;

  const ownsScreen = !opts.screen;
  const screen = opts.screen ?? blessed.screen({
    smartCSR: true,
    title: "wombo-combo -- New Quest",
    fullUnicode: true,
  });

  // Modal container
  const modal = blessed.box({
    parent: screen,
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

  // Content area (instructions / step header)
  const content = blessed.box({
    parent: modal,
    top: 0,
    left: 1,
    right: 1,
    height: 3,
    tags: true,
    style: { fg: "white", bg: "black" },
  });

  // Single-line textbox (for ID and Title steps)
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

  // Multi-line textarea (for Goal step)
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

  // Selection list (for Priority, Difficulty, HITL steps)
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

  // -----------------------------------------------------------------------
  // Collected values (pre-filled from prefill)
  // -----------------------------------------------------------------------

  let questId = prefill?.id ?? "";
  let questTitle = prefill?.title ?? "";
  let questGoal = prefill?.goal ?? "";
  let questPriority: Priority = prefill?.priority ?? "medium";
  let questDifficulty: Difficulty = prefill?.difficulty ?? "medium";
  let questHitl: QuestHitlMode = prefill?.hitlMode ?? "yolo";

  type Step = "id" | "title" | "goal" | "priority" | "difficulty" | "hitl";
  const steps: Step[] = ["id", "title", "goal", "priority", "difficulty", "hitl"];
  let currentStepIdx = 0;

  // -----------------------------------------------------------------------
  // Cleanup helpers
  // -----------------------------------------------------------------------

  let cleaned = false;

  const destroyScreen = () => {
    if (!ownsScreen) return;
    screen.destroy();
    // NOTE: Do NOT remove stdin listeners or reset raw mode here.
    // Stdin cleanup is done once at TUI exit in cmdTui() via cleanupStdin().
    process.stdout.write("\x1B[2J\x1B[H");
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    modal.destroy();
    screen.render();
  };

  // -----------------------------------------------------------------------
  // Step rendering
  // -----------------------------------------------------------------------

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
        textbox.setValue(questId);
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
        textbox.setValue(questTitle);
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
        textarea.setValue(questGoal);
        textarea.show();
        textarea.focus();
        break;

      case "priority": {
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
        // Pre-select current value
        const pIdx = (VALID_PRIORITIES as readonly string[]).indexOf(questPriority);
        selectList.select(pIdx >= 0 ? pIdx : 2);
        selectList.show();
        selectList.focus();
        break;
      }

      case "difficulty": {
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
        const dIdx = (VALID_DIFFICULTIES as readonly string[]).indexOf(questDifficulty);
        selectList.select(dIdx >= 0 ? dIdx : 2);
        selectList.show();
        selectList.focus();
        break;
      }

      case "hitl": {
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
        const hIdx = (VALID_HITL_MODES as readonly string[]).indexOf(questHitl);
        selectList.select(hIdx >= 0 ? hIdx : 0);
        selectList.show();
        selectList.focus();
        break;
      }
    }

    screen.render();
  };

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  const goBack = () => {
    if (currentStepIdx <= 0) {
      cleanup();
      destroyScreen();
      onCancelled();
      return;
    }
    currentStepIdx--;
    showStep(steps[currentStepIdx]);
  };

  const advanceOrFinish = () => {
    currentStepIdx++;
    if (currentStepIdx >= steps.length) {
      // All steps done — create the quest
      finishCreateQuest();
      return;
    }
    showStep(steps[currentStepIdx]);
  };

  // -----------------------------------------------------------------------
  // Quest creation
  // -----------------------------------------------------------------------

  const finishCreateQuest = () => {
    try {
      const quest = createBlankQuest(questId, questTitle, questGoal, baseBranch, {
        priority: questPriority,
        difficulty: questDifficulty,
        hitlMode: questHitl,
      });

      saveQuest(projectRoot, quest);

      // Show confirmation briefly
      content.setContent(
        `{bold}{green-fg}\u2714 Quest created!{/green-fg}{/bold}\n\n` +
        `  {white-fg}${questId}{/white-fg} — ${escapeBlessedTags(questTitle)}\n` +
        `  Priority: ${questPriority}  |  Difficulty: ${questDifficulty}  |  HITL: ${questHitl}\n` +
        `  Branch: quest/${questId}  |  Base: ${baseBranch}`
      );
      statusLine.setContent("{gray-fg}Continuing...{/gray-fg}");
      textbox.hide();
      textarea.hide();
      selectList.hide();
      screen.render();

      // After a brief delay, clean up and fire callback
      setTimeout(() => {
        cleanup();
        destroyScreen();
        onCreated(quest);
      }, 1200);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      content.setContent(
        `{bold}{red-fg}\u2718 Failed to create quest{/red-fg}{/bold}\n\n` +
        `  ${escapeBlessedTags(msg)}`
      );
      statusLine.setContent("{gray-fg}Press Esc to return{/gray-fg}");
      textbox.hide();
      textarea.hide();
      selectList.hide();
      screen.render();

      modal.key(["escape"], () => {
        cleanup();
        destroyScreen();
        onCancelled();
      });
    }
  };

  // -----------------------------------------------------------------------
  // Input handlers
  // -----------------------------------------------------------------------

  // Textbox submit/cancel (for ID and Title steps)
  textbox.on("submit", (value: string) => {
    const trimmed = (value ?? "").trim();
    const currentStep = steps[currentStepIdx];

    if (currentStep === "id") {
      if (!trimmed) {
        statusLine.setContent("{red-fg}ID cannot be empty{/red-fg}");
        screen.render();
        textbox.focus();
        return;
      }
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(trimmed)) {
        statusLine.setContent("{red-fg}ID must be kebab-case (lowercase letters, numbers, hyphens){/red-fg}");
        screen.render();
        textbox.focus();
        return;
      }
      // Check duplicate
      const existing = loadQuest(projectRoot, trimmed);
      if (existing) {
        statusLine.setContent(`{red-fg}Quest "${trimmed}" already exists (${existing.status}){/red-fg}`);
        screen.render();
        textbox.focus();
        return;
      }
      questId = trimmed;
      advanceOrFinish();
    } else if (currentStep === "title") {
      if (!trimmed) {
        statusLine.setContent("{red-fg}Title cannot be empty{/red-fg}");
        screen.render();
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

  // Textarea submit/cancel (for Goal step)
  textarea.key(["enter"], () => {
    const val = (textarea.getValue() ?? "").trim();
    if (!val) {
      statusLine.setContent("{red-fg}Goal cannot be empty{/red-fg}");
      screen.render();
      return;
    }
    questGoal = val;
    advanceOrFinish();
  });

  textarea.key(["escape"], () => {
    goBack();
  });

  // Select list (for Priority, Difficulty, HITL steps)
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

  // Return a cleanup function (rarely needed externally)
  return () => {
    cleanup();
    if (ownsScreen) destroyScreen();
  };
}

// ---------------------------------------------------------------------------
// runQuestWizardAsync — standalone Promise-based wrapper
// ---------------------------------------------------------------------------

/**
 * Run the quest creation wizard as a standalone screen, returning a Promise
 * that resolves with the created Quest or null if the user cancelled.
 *
 * Creates and destroys its own blessed screen automatically.
 */
export function runQuestWizardAsync(opts: {
  projectRoot: string;
  baseBranch: string;
  prefill?: QuestWizardPrefill;
}): Promise<Quest | null> {
  return new Promise<Quest | null>((resolve) => {
    showQuestWizard({
      projectRoot: opts.projectRoot,
      baseBranch: opts.baseBranch,
      prefill: opts.prefill,
      onCreated: (quest) => resolve(quest),
      onCancelled: () => resolve(null),
    });
  });
}
