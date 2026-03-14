/**
 * tui.ts -- Unified TUI command entry point for wombo-combo.
 *
 * Orchestrates multiple views in a persistent loop:
 *   1. Quest Picker (tui-quest-picker.ts) -- select a quest or "All Tasks"
 *   2. Task Browser (tui-browser.ts) -- select tasks, change priorities, launch
 *   3. Wave Monitor (tui.ts) -- watch running wave, view logs, retry agents
 *   4. Plan Review (tui-plan-review.ts) -- review/edit/approve planner output
 *
 * Flow:
 *   `woco` -> Quest Picker (if quests exist) -> Task Browser -> L -> launches
 *   wave -> wave completes -> Q in monitor -> back to Quest Picker -> ...
 *
 *   Quest Picker -> P (plan) -> spinner -> Plan Review -> approve/cancel ->
 *   back to Quest Picker
 *
 * If no quests exist, the Quest Picker is skipped entirely and the flow goes
 * straight to the Task Browser (backward compatible).
 *
 * Exit behavior:
 *   - Q from Quest Picker: exits the process
 *   - Q/Esc from Task Browser: back to Quest Picker (or exits if no quests)
 *   - Q from Wave Monitor: back to Quest Picker
 *   - Q/Esc from Plan Review: discard plan, back to Quest Picker
 *
 * Session state is persisted to .wombo-combo/tui-session.json so the user can
 * close and reopen the TUI without losing their task selections.
 */

import type { WomboConfig } from "../config.js";
import { ensureTasksFile } from "../lib/tasks.js";
import { loadState } from "../lib/state.js";
import { loadTUISession, saveTUISession } from "../lib/tui-session.js";
import type { TUISession } from "../lib/tui-session.js";
import { TaskBrowser } from "../lib/tui-browser.js";
import { QuestPicker } from "../lib/tui-quest-picker.js";
import type { QuestPickerAction } from "../lib/tui-quest-picker.js";
import { PlanReview } from "../lib/tui-plan-review.js";
import type { ProposedTask } from "../lib/quest-planner.js";
import { runQuestPlanner, applyPlanToQuest } from "../lib/quest-planner.js";
import type { PlanResult } from "../lib/quest-planner.js";
import { loadAllQuests, loadQuest, saveQuest } from "../lib/quest-store.js";
import { cmdLaunch } from "./launch.js";
import type { LaunchCommandOptions } from "./launch.js";
import { cmdResume } from "./resume.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TUICommandOptions {
  projectRoot: string;
  config: WomboConfig;
  /** Max concurrent agents (override, or null to use session/config default) */
  maxConcurrent?: number;
  /** Model override */
  model?: string;
  /** Base branch override */
  baseBranch?: string;
  /** Max retries override */
  maxRetries?: number;
  /** Auto-push after merge */
  autoPush?: boolean;
  /** Skip TDD tests */
  skipTests?: boolean;
  /** Strict TDD mode */
  strictTdd?: boolean;
  /** Agent definition override */
  agent?: string;
}

type BrowserAction =
  | { type: "launch"; ids: string[] }
  | { type: "back" }
  | { type: "quit" };

type PlanReviewResult =
  | { type: "approve"; tasks: ProposedTask[]; knowledge: string | null }
  | { type: "cancel" };

// ---------------------------------------------------------------------------
// Command -- Main Loop
// ---------------------------------------------------------------------------

export async function cmdTui(opts: TUICommandOptions): Promise<void> {
  const { projectRoot, config } = opts;

  // Ensure tasks file exists
  await ensureTasksFile(projectRoot, config);

  // Load session state (persisted selections, sort, concurrency)
  const session = loadTUISession(projectRoot);

  // Apply concurrency override from CLI if provided
  if (opts.maxConcurrent !== undefined) {
    session.maxConcurrent = opts.maxConcurrent;
  }

  // Main TUI loop:
  //   Quest Picker -> Task Browser -> Launch -> Monitor -> back to Quest Picker
  // Only exits when the user presses Q from the Quest Picker (or browser if no quests).
  while (true) {
    // Check for an active wave on each iteration
    const existingState = loadState(projectRoot);
    const hasRunningWave =
      existingState !== null &&
      existingState.agents.some(
        (a) =>
          a.status === "running" ||
          a.status === "queued" ||
          a.status === "installing" ||
          a.status === "resolving_conflict" ||
          a.status === "retry"
      );

    if (hasRunningWave) {
      // A wave is already running -- resume it (wave monitor TUI).
      // When the wave completes and the user presses Q, cmdResume returns
      // and we loop back to the quest picker / browser.
      console.log(
        `Active wave detected: ${existingState!.wave_id}. Resuming...`
      );
      try {
        await cmdResume({
          projectRoot,
          config,
          maxConcurrent: opts.maxConcurrent,
          model: opts.model,
          interactive: false,
          noTui: false,
          autoPush: opts.autoPush ?? false,
          baseBranch: opts.baseBranch,
          maxRetries: opts.maxRetries,
        });
      } catch (err: any) {
        // Don't crash -- show error and loop back
        console.error(`\nResume error: ${err.message}\n`);
        await sleep(2000);
      }
      // Clear terminal before showing picker/browser again
      process.stdout.write("\x1B[2J\x1B[H");
      continue;
    }

    // -----------------------------------------------------------------------
    // Quest Picker (skip if no quests exist)
    // -----------------------------------------------------------------------
    const quests = loadAllQuests(projectRoot);
    const hasQuests = quests.length > 0;

    let selectedQuestId: string | null = null;

    if (hasQuests) {
      const questAction = await showQuestPicker(projectRoot, config, opts);

      if (questAction.type === "quit") {
        // User pressed Q in quest picker -- exit cleanly
        session.lastView = "browser";
        saveTUISession(projectRoot, session);
        break;
      }

      if (questAction.type === "plan") {
        // User pressed P to plan a quest -- run planner + review
        await handlePlanFlow(projectRoot, config, opts, questAction.questId);
        // After planning (approve or cancel), loop back to quest picker
        process.stdout.write("\x1B[2J\x1B[H");
        continue;
      }

      selectedQuestId = questAction.questId;
    }

    // -----------------------------------------------------------------------
    // Task Browser (filtered by quest if one was selected)
    // -----------------------------------------------------------------------
    const action = await showBrowser(
      projectRoot,
      config,
      session,
      opts,
      selectedQuestId,
      hasQuests
    );

    if (action.type === "quit") {
      // User pressed Q in browser with no quest context -- exit cleanly
      session.lastView = "browser";
      saveTUISession(projectRoot, session);
      break;
    }

    if (action.type === "back") {
      // User pressed Q/Esc in quest-filtered browser -- back to quest picker
      process.stdout.write("\x1B[2J\x1B[H");
      continue;
    }

    if (action.type === "launch") {
      // Save session before launching
      session.selected = action.ids;
      session.lastView = "monitor";
      saveTUISession(projectRoot, session);

      // Build launch options
      const launchOpts: LaunchCommandOptions = {
        projectRoot,
        config,
        features: action.ids,
        maxConcurrent: session.maxConcurrent,
        model: opts.model,
        interactive: false,
        dryRun: false,
        baseBranch: opts.baseBranch ?? config.baseBranch,
        maxRetries: opts.maxRetries ?? config.defaults.maxRetries,
        noTui: false,
        autoPush: opts.autoPush ?? false,
        agent: opts.agent,
        outputFmt: "text",
        // Pass quest ID so launch uses quest branch and constraints
        questId: selectedQuestId ?? undefined,
      };

      try {
        await cmdLaunch(launchOpts);
      } catch (err: any) {
        // Don't crash -- show error and loop back
        console.error(`\nLaunch error: ${err.message}\n`);
        await sleep(2000);
      }

      // Clear terminal before showing picker/browser again
      process.stdout.write("\x1B[2J\x1B[H");
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Quest Picker View -- Promise-based
// ---------------------------------------------------------------------------

/**
 * Show the Quest Picker and return a Promise that resolves when the user
 * takes an action (select quest, plan quest, or quit).
 */
function showQuestPicker(
  projectRoot: string,
  config: WomboConfig,
  opts: TUICommandOptions
): Promise<QuestPickerAction> {
  return new Promise<QuestPickerAction>((resolve) => {
    const picker = new QuestPicker({
      projectRoot,
      config,

      onSelect: (questId: string | null) => {
        resolve({ type: "select", questId });
      },

      onPlan: (questId: string) => {
        resolve({ type: "plan", questId });
      },

      onQuit: () => {
        resolve({ type: "quit" });
      },
    });

    picker.start();
  });
}

// ---------------------------------------------------------------------------
// Plan Flow -- Planner + Review
// ---------------------------------------------------------------------------

/**
 * Run the quest planner agent, then show the plan review TUI.
 * Handles the full flow: spinner → planner → review → approve/cancel.
 */
async function handlePlanFlow(
  projectRoot: string,
  config: WomboConfig,
  opts: TUICommandOptions,
  questId: string
): Promise<void> {
  const quest = loadQuest(projectRoot, questId);
  if (!quest) {
    console.error(`\nQuest "${questId}" not found.\n`);
    await sleep(2000);
    return;
  }

  // Set quest to planning status
  const prevStatus = quest.status;
  quest.status = "planning";
  saveQuest(projectRoot, quest);

  // Show a planning spinner on the terminal (no blessed screen here)
  console.log(`\n  Planning quest: ${quest.title} (${quest.id})`);
  console.log(`  Running quest planner agent...\n`);

  const spinChars = ["\u2802", "\u2806", "\u2807", "\u2803", "\u2809", "\u280C", "\u280E", "\u280B"];
  let spinIdx = 0;
  let lastProgress = "";
  const spinTimer = setInterval(() => {
    const ch = spinChars[spinIdx % spinChars.length];
    spinIdx++;
    process.stdout.write(`\r  ${ch} ${lastProgress}`);
  }, 120);

  let planResult: PlanResult;

  try {
    planResult = await runQuestPlanner(quest, projectRoot, config, {
      model: opts.model,
      onProgress: (msg) => {
        lastProgress = msg;
      },
    });
  } catch (err: any) {
    clearInterval(spinTimer);
    process.stdout.write("\r" + " ".repeat(80) + "\r");
    console.error(`\n  Planner error: ${err.message}\n`);
    // Revert quest status
    quest.status = prevStatus;
    saveQuest(projectRoot, quest);
    await sleep(3000);
    return;
  }

  clearInterval(spinTimer);
  process.stdout.write("\r" + " ".repeat(80) + "\r");

  if (!planResult.success && planResult.tasks.length === 0) {
    // Total failure — no tasks produced
    console.error(`\n  Planner failed: ${planResult.error ?? "No tasks produced"}\n`);
    quest.status = prevStatus;
    saveQuest(projectRoot, quest);
    await sleep(3000);
    return;
  }

  console.log(`  Planner produced ${planResult.tasks.length} tasks.`);
  if (planResult.issues.length > 0) {
    const errors = planResult.issues.filter((i) => i.level === "error").length;
    const warnings = planResult.issues.filter((i) => i.level === "warning").length;
    if (errors > 0) console.log(`  ${errors} validation error(s).`);
    if (warnings > 0) console.log(`  ${warnings} validation warning(s).`);
  }
  console.log(`  Opening plan review...\n`);
  await sleep(1000);

  // Clear terminal before showing the plan review TUI
  process.stdout.write("\x1B[2J\x1B[H");

  // Show the plan review TUI
  const reviewAction = await showPlanReview(
    questId,
    quest.title,
    planResult
  );

  if (reviewAction.type === "cancel") {
    // User cancelled — revert quest status
    quest.status = prevStatus;
    saveQuest(projectRoot, quest);
    console.log(`\n  Plan discarded. Quest "${questId}" reverted to "${prevStatus}".\n`);
    await sleep(1500);
    return;
  }

  // User approved — apply the plan
  try {
    // Update planResult with only the accepted tasks
    const approvedResult: PlanResult = {
      ...planResult,
      tasks: reviewAction.tasks,
      knowledge: reviewAction.knowledge,
    };

    const tasks = applyPlanToQuest(approvedResult, quest, projectRoot, config);
    console.log(`\n  Plan approved! Created ${tasks.length} tasks.`);
    console.log(`  Quest "${questId}" is now active.`);
    if (reviewAction.knowledge) {
      console.log(`  Saved knowledge file (${reviewAction.knowledge.length} chars).`);
    }
    console.log();
    await sleep(2000);
  } catch (err: any) {
    console.error(`\n  Failed to apply plan: ${err.message}\n`);
    quest.status = prevStatus;
    saveQuest(projectRoot, quest);
    await sleep(3000);
  }
}

// ---------------------------------------------------------------------------
// Plan Review View -- Promise-based
// ---------------------------------------------------------------------------

/**
 * Show the Plan Review TUI and return a Promise that resolves when the user
 * approves or cancels.
 */
function showPlanReview(
  questId: string,
  questTitle: string,
  planResult: PlanResult
): Promise<PlanReviewResult> {
  return new Promise<PlanReviewResult>((resolve) => {
    const review = new PlanReview({
      questId,
      questTitle,
      planResult,

      onApprove: (tasks, knowledge) => {
        resolve({ type: "approve", tasks, knowledge });
      },

      onCancel: () => {
        resolve({ type: "cancel" });
      },
    });

    review.start();
  });
}

// ---------------------------------------------------------------------------
// Browser View -- Promise-based
// ---------------------------------------------------------------------------

/**
 * Show the Task Browser and return a Promise that resolves when the user
 * takes an action (launch, back, or quit).
 */
function showBrowser(
  projectRoot: string,
  config: WomboConfig,
  session: TUISession,
  opts: TUICommandOptions,
  questId: string | null,
  hasQuestPicker: boolean
): Promise<BrowserAction> {
  // Reload session from disk in case state changed after a wave
  const freshSession = loadTUISession(projectRoot);
  // Merge any runtime overrides
  if (opts.maxConcurrent !== undefined) {
    freshSession.maxConcurrent = opts.maxConcurrent;
  }
  // Copy fresh values back into the shared session object
  Object.assign(session, freshSession);

  // Load quest details for filtering if a quest was selected
  let questTitle: string | undefined;
  let questTaskIds: string[] | undefined;
  if (questId) {
    const quest = loadQuest(projectRoot, questId);
    if (quest) {
      questTitle = quest.title;
      questTaskIds = quest.taskIds;
    }
  }

  return new Promise<BrowserAction>((resolve) => {
    const browser = new TaskBrowser({
      projectRoot,
      config,
      session,
      questId,
      questTitle,
      questTaskIds,

      onLaunch: (selectedIds: string[]) => {
        if (selectedIds.length === 0) return;
        // The browser has already shown a transition message on-screen.
        // Destroy the blessed screen and clear the terminal.
        browser.destroy();
        resolve({ type: "launch", ids: selectedIds });
      },

      onQuit: () => {
        browser.stop();
        resolve({ type: "quit" });
      },

      onBack: hasQuestPicker
        ? () => {
            resolve({ type: "back" });
          }
        : undefined,

      onSwitchToMonitor: undefined,
    });

    browser.start();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
