/**
 * tui.ts -- Unified TUI command entry point for wombo-combo.
 *
 * Orchestrates multiple views in a persistent loop:
 *   1. Quest Picker (tui-quest-picker.ts) -- select a quest or "All Tasks"
 *   2. Task Browser (tui-browser.ts) -- select tasks, change priorities, launch
 *   3. Wave Monitor (tui.ts) -- watch running wave, view logs, retry agents
 *   4. Plan Review (tui-plan-review.ts) -- review/edit/approve planner output
 *   5. Genesis Review (tui-genesis-review.ts) -- review/edit/approve genesis plan
 *
 * Flow:
 *   `woco` -> Quest Picker (if quests exist) -> Task Browser -> L -> launches
 *   wave -> wave completes -> Q in monitor -> back to Quest Picker -> ...
 *
 *   Quest Picker -> P (plan) -> spinner -> Plan Review -> approve/cancel ->
 *   back to Quest Picker
 *
 *   Quest Picker -> G (genesis) -> vision prompt -> spinner -> Genesis Review
 *   -> approve/cancel -> back to Quest Picker
 *
 *   Quest Picker/Browser -> E (errand) -> description prompt -> spinner ->
 *   Plan Review -> approve/cancel -> creates quest-less tasks -> back
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
import { loadAllQuests, loadQuest, saveQuest, listQuestIds, saveQuestKnowledge } from "../lib/quest-store.js";
import { GenesisReview } from "../lib/tui-genesis-review.js";
import type { GenesisReviewAction } from "../lib/tui-genesis-review.js";
import { runGenesisPlanner } from "../lib/genesis-planner.js";
import type { GenesisResult, ProposedQuest } from "../lib/genesis-planner.js";
import { createBlankQuest } from "../lib/quest.js";
import { runErrandPlanner, applyErrandPlan } from "../lib/errand-planner.js";
import type { ErrandSpec } from "../lib/errand-planner.js";
import { ProgressScreen, showConfirm } from "../lib/tui-progress.js";
import { WishlistPicker } from "../lib/tui-wishlist.js";
import type { WishlistAction } from "../lib/tui-wishlist.js";
import { deleteItem as deleteWishlistItem } from "../lib/wishlist-store.js";
import type { WishlistItem } from "../lib/wishlist-store.js";
import { runQuestWizardAsync } from "../lib/tui-quest-wizard.js";
import { projectExists } from "../lib/project-store.js";
import { runOnboardingAsync } from "../lib/tui-onboarding.js";
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
  | { type: "errand"; spec: ErrandSpec }
  | { type: "back" }
  | { type: "monitor" }
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

  // First-run detection: if no project.yml exists, run onboarding wizard.
  // If the user cancels/skips, we continue into the TUI anyway — next time
  // they launch, onboarding will appear again (snoozable).
  if (!projectExists(projectRoot)) {
    const profile = await runOnboardingAsync({ projectRoot, config });
    // Clear screen whether completed or skipped
    process.stdout.write('\x1B[2J\x1B[H');
  }

  // Main TUI loop:
  //   Quest Picker -> Task Browser -> Launch -> Monitor -> back to Quest Picker
  // Only exits when the user presses Q from the Quest Picker (or browser if no quests).
  //
  // Wave detach support: When the user presses Q in the monitor while agents
  // are still running, the monitor returns without killing agents. The loop
  // goes to the browser, which shows a "running wave" indicator and allows
  // the user to press Tab to switch back to the monitor.
  //
  // `skipAutoResume` prevents the loop from immediately re-entering the
  // monitor after the user explicitly detached from it.
  let skipAutoResume = false;
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

    if (hasRunningWave && !skipAutoResume) {
      // A wave is already running -- resume it (wave monitor TUI).
      // When the wave completes, cmdResume returns and we loop back.
      // When the user detaches (Q while agents running), cmdResume also
      // returns and we fall through to the browser with running wave indicator.
      {
        const ps = new ProgressScreen("Resuming Wave", existingState!.wave_id);
        ps.start();
        ps.setStatus("Reconnecting to active wave...");
        try {
          // Brief flash before cmdResume takes over the screen
          await sleep(500);
          ps.destroy();
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
            detachOnQuit: true,
          });
        } catch (err: any) {
          // Don't crash -- show error and loop back
          const errPs = new ProgressScreen("Resume Error");
          errPs.start();
          errPs.showError(`Resume error: ${err.message}`);
          await errPs.waitForDismiss(3000);
          errPs.destroy();
        }
      }
      // After resume returns, don't auto-resume again — let the user
      // browse tasks and use Tab to switch back to the monitor if needed.
      skipAutoResume = true;
      // Clear terminal before showing picker/browser again
      process.stdout.write("\x1B[2J\x1B[H");
      continue;
    }

    // Reset the skip flag — if we reach the browser and the user launches
    // a new wave, we should auto-resume when we loop back.
    skipAutoResume = false;

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

      if (questAction.type === "genesis") {
        // User provided vision via blessed modal — run genesis planner + review
        await handleGenesisFlow(projectRoot, config, opts, questAction.vision);
        // After genesis (approve or cancel), loop back to quest picker
        process.stdout.write("\x1B[2J\x1B[H");
        continue;
      }

      if (questAction.type === "errand") {
        // User provided spec via blessed modal — run errand planner
        await handleErrandFlow(projectRoot, config, opts, questAction.spec);
        // After errand (approve or cancel), loop back to quest picker
        process.stdout.write("\x1B[2J\x1B[H");
        continue;
      }

      if (questAction.type === "wishlist") {
        // User pressed W to browse wishlist
        await handleWishlistFlow(projectRoot, config, opts);
        // After wishlist (promote, back, or quit), loop back to quest picker
        process.stdout.write("\x1B[2J\x1B[H");
        continue;
      }

      if (questAction.type === "onboarding") {
        // User pressed O to open onboarding wizard (edit mode)
        await runOnboardingAsync({ projectRoot, config });
        // After onboarding, loop back to quest picker
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
      hasQuests,
      hasRunningWave
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

    if (action.type === "errand") {
      // User provided errand spec via blessed wizard in browser
      await handleErrandFlow(projectRoot, config, opts, action.spec);
      process.stdout.write("\x1B[2J\x1B[H");
      continue;
    }

    if (action.type === "monitor") {
      // User pressed Tab to switch to the running wave monitor.
      // Resume connects to the existing wave and opens the monitor TUI.
      // When the user presses Q in the monitor, cmdResume returns (detached)
      // and we loop back to the browser with the running wave indicator.
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
          detachOnQuit: true,
        });
      } catch (err: any) {
        const ps = new ProgressScreen("Resume Error");
        ps.start();
        ps.showError(`Resume error: ${err.message}`);
        await ps.waitForDismiss(3000);
        ps.destroy();
      }
      process.stdout.write("\x1B[2J\x1B[H");
      // Don't auto-resume — let user browse tasks and Tab to monitor
      skipAutoResume = true;
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
        detachOnQuit: true,
      };

      try {
        await cmdLaunch(launchOpts);
      } catch (err: any) {
        // Don't crash -- show error and loop back
        const ps = new ProgressScreen("Launch Error");
        ps.start();
        ps.showError(`Launch error: ${err.message}`);
        await ps.waitForDismiss(3000);
        ps.destroy();
      }

      // Clear terminal before showing picker/browser again
      process.stdout.write("\x1B[2J\x1B[H");
      // Don't auto-resume — let user browse tasks and Tab to monitor
      skipAutoResume = true;
      continue;
    }
  }

  // Centralized stdin cleanup — only runs when the TUI main loop exits.
  // Individual view destroy() methods do NOT touch stdin because that would
  // break blessed's internal program singleton during screen-to-screen
  // transitions (e.g. QuestPicker → TaskBrowser).
  cleanupStdin();
}

/**
 * Clean up stdin state left behind by blessed screens.
 * Called once when the TUI exits, NOT during screen transitions.
 */
function cleanupStdin(): void {
  try {
    process.stdin.removeAllListeners("keypress");
    process.stdin.removeAllListeners("data");
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  } catch {
    // Ignore — stdin may already be closed
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

      onGenesis: (vision: string) => {
        resolve({ type: "genesis", vision });
      },

      onErrand: (spec: ErrandSpec) => {
        resolve({ type: "errand", spec });
      },

      onWishlist: () => {
        resolve({ type: "wishlist" });
      },

      onOnboarding: () => {
        resolve({ type: "onboarding" });
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
 * Handles the full flow: progress screen → planner → review → approve/cancel.
 */
async function handlePlanFlow(
  projectRoot: string,
  config: WomboConfig,
  opts: TUICommandOptions,
  questId: string
): Promise<void> {
  const quest = loadQuest(projectRoot, questId);
  if (!quest) {
    const ps = new ProgressScreen("Error");
    ps.start();
    ps.showError(`Quest "${questId}" not found.`);
    await ps.waitForDismiss(3000);
    ps.destroy();
    return;
  }

  // Set quest to planning status
  const prevStatus = quest.status;
  quest.status = "planning";
  saveQuest(projectRoot, quest);

  // Show progress screen with spinner
  const ps = new ProgressScreen("Quest Planner", `${quest.title} (${quest.id})`);
  ps.start();
  ps.setStatus("Running quest planner agent...");

  let planResult: PlanResult;

  try {
    planResult = await runQuestPlanner(quest, projectRoot, config, {
      model: opts.model,
      onProgress: (msg) => {
        ps.setStatus(msg);
      },
    });
  } catch (err: any) {
    ps.showError(`Planner error: ${err.message}`);
    quest.status = prevStatus;
    saveQuest(projectRoot, quest);
    await ps.waitForDismiss(3000);
    ps.destroy();
    return;
  }

  if (!planResult.success && planResult.tasks.length === 0) {
    ps.showError(`Planner failed: ${planResult.error ?? "No tasks produced"}`);
    quest.status = prevStatus;
    saveQuest(projectRoot, quest);
    await ps.waitForDismiss(3000);
    ps.destroy();
    return;
  }

  // Show results briefly before switching to plan review
  ps.showSuccess(`Planner produced ${planResult.tasks.length} tasks.`);
  if (planResult.issues.length > 0) {
    const errors = planResult.issues.filter((i) => i.level === "error").length;
    const warnings = planResult.issues.filter((i) => i.level === "warning").length;
    if (errors > 0) ps.addLine(`  {red-fg}${errors} validation error(s){/red-fg}`);
    if (warnings > 0) ps.addLine(`  {yellow-fg}${warnings} validation warning(s){/yellow-fg}`);
  }
  ps.addLine("  Opening plan review...");
  await ps.waitForDismiss(1500);
  ps.destroy();

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
    const ps2 = new ProgressScreen("Plan Cancelled");
    ps2.start();
    ps2.showInfo(`Plan discarded. Quest "${questId}" reverted to "${prevStatus}".`);
    await ps2.waitForDismiss(2000);
    ps2.destroy();
    return;
  }

  // User approved — apply the plan
  try {
    const approvedResult: PlanResult = {
      ...planResult,
      tasks: reviewAction.tasks,
      knowledge: reviewAction.knowledge,
    };

    const tasks = applyPlanToQuest(approvedResult, quest, projectRoot, config);
    const ps2 = new ProgressScreen("Plan Approved");
    ps2.start();
    ps2.showSuccess(`Created ${tasks.length} tasks. Quest "${questId}" is now active.`);
    if (reviewAction.knowledge) {
      ps2.addLine(`  Saved knowledge file (${reviewAction.knowledge.length} chars).`);
    }
    await ps2.waitForDismiss(2500);
    ps2.destroy();
  } catch (err: any) {
    const ps2 = new ProgressScreen("Plan Error");
    ps2.start();
    ps2.showError(`Failed to apply plan: ${err.message}`);
    quest.status = prevStatus;
    saveQuest(projectRoot, quest);
    await ps2.waitForDismiss(3000);
    ps2.destroy();
  }
}

// ---------------------------------------------------------------------------
// Genesis Flow -- Vision Prompt + Planner + Review
// ---------------------------------------------------------------------------

/**
 * Run the genesis planner: take a vision string, run the genesis planner
 * agent, then show the genesis review TUI.
 * Handles the full flow: progress screen → planner → review → create quests.
 */
async function handleGenesisFlow(
  projectRoot: string,
  config: WomboConfig,
  opts: TUICommandOptions,
  vision: string
): Promise<void> {
  if (!vision) {
    const ps = new ProgressScreen("Genesis");
    ps.start();
    ps.showInfo("No vision provided. Returning to quest picker.");
    await ps.waitForDismiss(2000);
    ps.destroy();
    return;
  }

  // Gather existing quest IDs so the planner can avoid duplicates
  const existingQuestIds = listQuestIds(projectRoot);

  // Show progress screen with spinner
  const ps = new ProgressScreen("Genesis Planner");
  ps.start();
  ps.setStatus("Running genesis planner agent...");

  let genesisResult: GenesisResult;

  try {
    genesisResult = await runGenesisPlanner(vision, projectRoot, config, {
      existingQuestIds,
      model: opts.model,
      onProgress: (msg) => {
        ps.setStatus(msg);
      },
    });
  } catch (err: any) {
    ps.showError(`Genesis planner error: ${err.message}`);
    await ps.waitForDismiss(3000);
    ps.destroy();
    return;
  }

  if (!genesisResult.success && genesisResult.quests.length === 0) {
    ps.showError(`Genesis planner failed: ${genesisResult.error ?? "No quests produced"}`);
    await ps.waitForDismiss(3000);
    ps.destroy();
    return;
  }

  // Show results briefly before switching to genesis review
  ps.showSuccess(`Genesis planner produced ${genesisResult.quests.length} quests.`);
  if (genesisResult.issues.length > 0) {
    const errors = genesisResult.issues.filter((i) => i.level === "error").length;
    const warnings = genesisResult.issues.filter((i) => i.level === "warning").length;
    if (errors > 0) ps.addLine(`  {red-fg}${errors} validation error(s){/red-fg}`);
    if (warnings > 0) ps.addLine(`  {yellow-fg}${warnings} validation warning(s){/yellow-fg}`);
  }
  ps.addLine("  Opening genesis review...");
  await ps.waitForDismiss(1500);
  ps.destroy();

  // Show the genesis review TUI
  const reviewAction = await showGenesisReview(genesisResult);

  if (reviewAction.type === "cancel") {
    const ps2 = new ProgressScreen("Genesis Cancelled");
    ps2.start();
    ps2.showInfo("Genesis plan discarded.");
    await ps2.waitForDismiss(2000);
    ps2.destroy();
    return;
  }

  // User approved — create quests from accepted proposals
  const baseBranch = opts.baseBranch ?? config.baseBranch;
  const created: string[] = [];

  for (const proposed of reviewAction.quests) {
    const quest = createBlankQuest(proposed.id, proposed.title, proposed.goal, baseBranch, {
      priority: proposed.priority,
      difficulty: proposed.difficulty,
      hitlMode: proposed.hitl_mode,
    });

    // Apply constraints from the genesis planner
    quest.constraints.add = proposed.constraints.add ?? [];
    quest.constraints.ban = proposed.constraints.ban ?? [];
    quest.depends_on = proposed.depends_on ?? [];
    quest.notes = proposed.notes ?? [];

    saveQuest(projectRoot, quest);
    created.push(quest.id);
  }

  // Show approval result
  const ps2 = new ProgressScreen("Genesis Approved");
  ps2.start();
  const questList = created.map((id) => `    - ${id}`).join("\n");
  ps2.showSuccess(`Created ${created.length} quests.`);
  ps2.addLine(questList);

  // Save knowledge if the planner produced any (attach to the first quest)
  const knowledge = reviewAction.knowledge;
  if (knowledge && created.length > 0) {
    saveQuestKnowledge(projectRoot, created[0], knowledge);
    ps2.addLine(`  Saved knowledge file (${knowledge.length} chars) to quest "${created[0]}".`);
  }

  await ps2.waitForDismiss(2500);
  ps2.destroy();
}

// ---------------------------------------------------------------------------
// Errand Flow -- Quick Task Generation (quest-less)
// ---------------------------------------------------------------------------

/**
 * Run the errand planner: take an ErrandSpec (description + optional scope/objectives),
 * run the quest planner agent with an errand-specific prompt, then show plan review
 * to let the user accept/reject/edit the proposed tasks.
 *
 * Created tasks go directly into the task store without any quest association.
 */
async function handleErrandFlow(
  projectRoot: string,
  config: WomboConfig,
  opts: TUICommandOptions,
  spec: ErrandSpec
): Promise<void> {
  if (!spec.description) {
    const ps = new ProgressScreen("Errand");
    ps.start();
    ps.showInfo("No description provided. Returning.");
    await ps.waitForDismiss(2000);
    ps.destroy();
    return;
  }

  // Show progress screen with spinner
  const ps = new ProgressScreen("Errand Planner");
  ps.start();
  ps.setStatus("Running errand planner...");

  let planResult: PlanResult;

  try {
    planResult = await runErrandPlanner(spec, projectRoot, config, {
      model: opts.model,
      onProgress: (msg) => {
        ps.setStatus(msg);
      },
    });
  } catch (err: any) {
    ps.showError(`Errand planner error: ${err.message}`);
    await ps.waitForDismiss(3000);
    ps.destroy();
    return;
  }

  if (!planResult.success && planResult.tasks.length === 0) {
    ps.showError(`Errand planner failed: ${planResult.error ?? "No tasks produced"}`);
    await ps.waitForDismiss(3000);
    ps.destroy();
    return;
  }

  const desc = spec.description;

  // Show results briefly before switching to plan review
  ps.showSuccess(`Errand planner produced ${planResult.tasks.length} task(s).`);
  if (planResult.issues.length > 0) {
    const errors = planResult.issues.filter((i) => i.level === "error").length;
    const warnings = planResult.issues.filter((i) => i.level === "warning").length;
    if (errors > 0) ps.addLine(`  {red-fg}${errors} validation error(s){/red-fg}`);
    if (warnings > 0) ps.addLine(`  {yellow-fg}${warnings} validation warning(s){/yellow-fg}`);
  }
  ps.addLine("  Opening plan review...");
  await ps.waitForDismiss(1500);
  ps.destroy();

  // Reuse the plan review TUI (it works for any set of proposed tasks)
  const reviewAction = await showPlanReview(
    "(errand)",
    desc.length > 50 ? desc.slice(0, 47) + "..." : desc,
    planResult
  );

  if (reviewAction.type === "cancel") {
    const ps2 = new ProgressScreen("Errand Cancelled");
    ps2.start();
    ps2.showInfo("Errand plan discarded.");
    await ps2.waitForDismiss(2000);
    ps2.destroy();
    return;
  }

  // User approved -- create tasks directly (no quest)
  try {
    const approvedResult: PlanResult = {
      ...planResult,
      tasks: reviewAction.tasks,
      knowledge: reviewAction.knowledge,
    };

    const tasks = applyErrandPlan(approvedResult, projectRoot, config);
    const ps2 = new ProgressScreen("Errand Approved");
    ps2.start();
    const taskList = tasks.map((t) => `    - ${t.id}: ${t.title}`).join("\n");
    ps2.showSuccess(`Created ${tasks.length} task(s).`);
    ps2.addLine(taskList);
    await ps2.waitForDismiss(2500);
    ps2.destroy();
  } catch (err: any) {
    const ps2 = new ProgressScreen("Errand Error");
    ps2.start();
    ps2.showError(`Failed to create errand tasks: ${err.message}`);
    await ps2.waitForDismiss(3000);
    ps2.destroy();
  }
}

// ---------------------------------------------------------------------------
// Wishlist Flow -- Browse + Promote to Errand/Genesis
// ---------------------------------------------------------------------------

/**
 * Show the wishlist picker. When the user promotes an item, run the
 * appropriate flow (errand or genesis) with the item text pre-filled.
 * After promotion completes, offer to delete the wishlist item.
 */
async function handleWishlistFlow(
  projectRoot: string,
  config: WomboConfig,
  opts: TUICommandOptions
): Promise<void> {
  const action = await showWishlistPicker(projectRoot);

  if (action.type === "back" || action.type === "quit") {
    return;
  }

  if (action.type === "promote-errand") {
    const item = action.item;
    await handleErrandFlow(projectRoot, config, opts, { description: item.text });
    await maybeDeleteWishlistItem(projectRoot, item);
    return;
  }

  if (action.type === "promote-genesis") {
    const item = action.item;
    await handleGenesisFlow(projectRoot, config, opts, item.text);
    await maybeDeleteWishlistItem(projectRoot, item);
    return;
  }

  if (action.type === "promote-quest") {
    const item = action.item;

    // Run the quest creation wizard with the wishlist text as the goal
    const quest = await runQuestWizardAsync({
      projectRoot,
      baseBranch: config.baseBranch,
      prefill: { goal: item.text },
    });

    if (!quest) {
      // User cancelled the wizard
      return;
    }

    // Mandatory auto-plan: run the quest planner immediately
    await handlePlanFlow(projectRoot, config, opts, quest.id);

    // Offer to delete the wishlist item
    await maybeDeleteWishlistItem(projectRoot, item);
    return;
  }
}

/**
 * Show the Wishlist Picker TUI and return a Promise that resolves when the
 * user takes an action.
 */
function showWishlistPicker(projectRoot: string): Promise<WishlistAction> {
  return new Promise<WishlistAction>((resolve) => {
    const picker = new WishlistPicker({
      projectRoot,

      onPromoteErrand: (item) => {
        resolve({ type: "promote-errand", item });
      },

      onPromoteGenesis: (item) => {
        resolve({ type: "promote-genesis", item });
      },

      onPromoteQuest: (item) => {
        resolve({ type: "promote-quest", item });
      },

      onBack: () => {
        resolve({ type: "back" });
      },

      onQuit: () => {
        resolve({ type: "quit" });
      },
    });

    picker.start();
  });
}

/**
 * After a wishlist item has been promoted, ask the user whether to delete it.
 * Uses a blessed confirm popup (no readline needed).
 */
async function maybeDeleteWishlistItem(
  projectRoot: string,
  item: WishlistItem
): Promise<void> {
  const truncText =
    item.text.length > 50 ? item.text.slice(0, 47) + "..." : item.text;

  const confirmed = await showConfirm(
    "Delete Wishlist Item",
    `Delete "${truncText}" from wishlist?`
  );

  if (confirmed) {
    const deleted = deleteWishlistItem(projectRoot, item.id);
    const ps = new ProgressScreen("Wishlist");
    ps.start();
    if (deleted) {
      ps.showSuccess("Wishlist item deleted.");
    } else {
      ps.showInfo("Item not found (may have been already deleted).");
    }
    await ps.waitForDismiss(1500);
    ps.destroy();
  } else {
    const ps = new ProgressScreen("Wishlist");
    ps.start();
    ps.showInfo("Wishlist item kept.");
    await ps.waitForDismiss(1000);
    ps.destroy();
  }
}

// ---------------------------------------------------------------------------
// Genesis Review View -- Promise-based
// ---------------------------------------------------------------------------

/**
 * Show the Genesis Review TUI and return a Promise that resolves when the
 * user approves or cancels.
 */
function showGenesisReview(
  genesisResult: GenesisResult
): Promise<GenesisReviewAction> {
  return new Promise<GenesisReviewAction>((resolve) => {
    const review = new GenesisReview({
      genesisResult,

      onApprove: (quests, knowledge) => {
        resolve({ type: "approve", quests, knowledge });
      },

      onCancel: () => {
        resolve({ type: "cancel" });
      },
    });

    review.start();
  });
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
 * takes an action (launch, back, quit, or switch to monitor).
 */
function showBrowser(
  projectRoot: string,
  config: WomboConfig,
  session: TUISession,
  opts: TUICommandOptions,
  questId: string | null,
  hasQuestPicker: boolean,
  hasRunningWave: boolean = false
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

      // Errand is available when not in quest-filtered mode
      onErrand: !questId
        ? (spec: ErrandSpec) => {
            resolve({ type: "errand", spec });
          }
        : undefined,

      // Switch to monitor is available when a wave is running in the background
      onSwitchToMonitor: hasRunningWave
        ? () => {
            resolve({ type: "monitor" });
          }
        : undefined,
    });

    // Tell the browser about the running wave so it shows the Tab hint
    if (hasRunningWave) {
      browser.setHasRunningWave(true);
    }

    browser.start();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
