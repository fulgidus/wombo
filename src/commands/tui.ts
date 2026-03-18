/**
 * tui.ts -- Unified TUI command entry point for wombo-combo.
 *
 * Orchestrates multiple Ink views in a persistent loop:
 *   1. Quest Picker (ink/run-quest-picker.tsx) -- select a quest or "All Tasks"
 *   2. Task Browser (ink/run-task-browser.tsx) -- select tasks, change priorities, launch
 *   3. Wave Monitor -- watch running wave (via cmdResume with TUI)
 *   4. Plan Review (ink/run-review.tsx) -- review/edit/approve planner output
 *   5. Genesis Review (ink/run-review.tsx) -- review/edit/approve genesis plan
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

import type { WomboConfig } from "../config";
import { ensureTasksFile } from "../lib/tasks";
import { loadTasksFromStore } from "../lib/task-store";
import { loadState } from "../lib/state";
import { loadTUISession, saveTUISession } from "../lib/tui-session";
import type { TUISession } from "../lib/tui-session";
import type { ProposedTask } from "../lib/quest-planner";
import { runQuestPlanner, applyPlanToQuest } from "../lib/quest-planner";
import type { PlanResult } from "../lib/quest-planner";
import { loadAllQuests, loadQuest, saveQuest, listQuestIds, saveQuestKnowledge } from "../lib/quest-store";
import { runGenesisPlanner } from "../lib/genesis-planner";
import type { GenesisResult, ProposedQuest } from "../lib/genesis-planner";
import { createBlankQuest, getQuestTaskIds } from "../lib/quest";
import { runErrandPlanner, applyErrandPlan } from "../lib/errand-planner";
import type { ErrandSpec } from "../lib/errand-planner";
import { deleteItem as deleteWishlistItem } from "../lib/wishlist-store";
import type { WishlistItem } from "../lib/wishlist-store";
import { projectExists, formatProjectContext } from "../lib/project-store";
import { runOnboardingInk } from "../ink/onboarding/run-onboarding";
import { runQuestPickerInk, type QuestPickerAction } from "../ink/run-quest-picker";
import { runTaskBrowserInk, type TaskBrowserAction } from "../ink/run-task-browser";
import { runGenesisReviewInk, runPlanReviewInk, type GenesisReviewAction, type PlanReviewAction } from "../ink/run-review";
import { runWishlistPickerInk } from "../ink/run-wishlist-picker";
import { runErrandWizardInk } from "../ink/run-errand-wizard";
import { runQuestWizardInk } from "../ink/run-quest-wizard";
import { runProgressInk, runConfirmInk, type ProgressController } from "../ink/run-progress";
import { cmdLaunch } from "./launch";
import type { LaunchCommandOptions } from "./launch";
import { cmdResume } from "./resume";
import { enterAltScreen, exitAltScreen, installAltScreenGuard, clearScreen } from "../ink/alt-screen";
// Daemon types only — actual modules are loaded via dynamic import() to
// avoid pulling in Bun.serve / AgentRunner / ink's top-level await into
// the synchronous require() chain (schema.ts → citty-registry → tui.ts).
import type { DaemonClient } from "../daemon/client";
import type { InkDaemonTUI } from "../ink/run-daemon-monitor";

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

// ---------------------------------------------------------------------------
// Daemon Monitor Helper (dynamic import)
// ---------------------------------------------------------------------------

/** Dynamically import InkDaemonTUI and run it. Returns when user quits. */
async function runDaemonMonitor(opts: {
  client: DaemonClient;
  projectRoot: string;
  config: WomboConfig;
}): Promise<void> {
  const { InkDaemonTUI: InkDaemonTUIImpl } = await import("../ink/run-daemon-monitor");
  const daemonTui: InkDaemonTUI = new InkDaemonTUIImpl({
    client: opts.client,
    projectRoot: opts.projectRoot,
    config: opts.config,
    onQuit: () => {
      // Detach from monitor — daemon keeps agents running
    },
  });
  daemonTui.start();
  await daemonTui.waitForQuit();
  daemonTui.stop();
}

// ---------------------------------------------------------------------------
// Command -- Main Loop
// ---------------------------------------------------------------------------

export async function cmdTui(opts: TUICommandOptions): Promise<void> {
  const { projectRoot, config } = opts;

  // The TUI requires a real TTY for keyboard input (Ink's useInput uses raw mode).
  // When stdin is not a TTY (piped, redirected, or bun script runner without TTY
  // forwarding), Ink throws an uncaught "Raw mode is not supported" error.
  // Fail early with a clear message instead.
  if (!process.stdin.isTTY) {
    console.error(
      "\nThe interactive TUI requires a terminal with TTY support.\n" +
        "If you're using `bun dev`, try running directly: bun src/index.ts\n" +
        "Or use a specific command: bun dev tasks list\n"
    );
    process.exit(1);
  }

  // Ensure tasks file exists
  await ensureTasksFile(projectRoot, config);

  // Load session state (persisted selections, sort, concurrency)
  const session = loadTUISession(projectRoot);

  // Apply concurrency override from CLI if provided
  if (opts.maxConcurrent !== undefined) {
    session.maxConcurrent = opts.maxConcurrent;
  }

  // Debug log to file (alt-screen swallows stderr — write to a file so we
  // can see exactly where execution stops).
  const _tuiLog = (() => {
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    const logPath = require("node:path").resolve(projectRoot, ".wombo-combo/tui-debug.log");
    return (msg: string) => {
      try { appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
    };
  })();

  _tuiLog("cmdTui started");

  // Enter the alternate screen buffer for a true fullscreen experience.
  // The guard ensures we exit alt-screen on crash, SIGINT, or SIGTERM.
  enterAltScreen();
  const removeGuard = installAltScreenGuard();
  _tuiLog("alt-screen entered");

  // Start the daemon (if not already running) and connect a client.
  // The daemon manages the agent lifecycle; the TUI is a pure viewer/controller.
  // Dynamic imports to avoid pulling daemon/ink server code into the
  // synchronous module graph (same pattern as launch.ts tryDaemonLaunch).
  let daemonClient: DaemonClient | null = null;
  let daemonConnected = false;

  try {
    _tuiLog("importing ensureDaemonRunning...");
    const { ensureDaemonRunning } = await import("../daemon/launcher");
    _tuiLog("calling ensureDaemonRunning...");
    await ensureDaemonRunning(projectRoot);
    _tuiLog("ensureDaemonRunning done, importing DaemonClient...");
    const { DaemonClient: DaemonClientImpl } = await import("../daemon/client");
    daemonClient = new DaemonClientImpl({ clientId: "tui", autoReconnect: true });
    _tuiLog("calling daemonClient.connect()...");
    await daemonClient.connect();
    daemonConnected = true;
    _tuiLog("daemon connected!");
  } catch (err: any) {
    // Daemon failed to start or connect — fall back to direct mode
    // (legacy cmdLaunch/cmdResume path).
    _tuiLog(`daemon connect failed (falling back): ${err?.message ?? err}`);
    daemonClient = null;
    daemonConnected = false;
  }

  _tuiLog(`daemonConnected=${daemonConnected}, entering main try block`);

  try {

  // First-run detection: if no project.yml exists, run onboarding wizard.
  // If the user cancels/skips, we continue into the TUI anyway — next time
  // they launch, onboarding will appear again (snoozable).
  _tuiLog(`projectExists=${projectExists(projectRoot)}`);
  if (!projectExists(projectRoot)) {
    _tuiLog("running onboarding...");
    const result = await runOnboardingInk({ projectRoot, config });
    // Clear screen whether completed or skipped
    clearScreen();

    // If onboarding completed and the user requested genesis, run it now.
    if (result.profile && result.genesisRequested) {
      const vision = formatProjectContext(result.profile);
      await handleGenesisFlow(projectRoot, config, opts, vision);
      clearScreen();
    }
  }

  // Main TUI loop:
  //   Quest Picker -> Task Browser -> Launch -> Monitor -> back to Quest Picker
  // Only exits when the user presses Q from the Quest Picker (or browser if no quests).
  //
  // Daemon mode: When connected to the daemon, the monitor shows a live
  // daemon-backed view (InkDaemonTUI) instead of cmdResume. The daemon
  // manages agent lifecycle; the TUI is a pure viewer/controller.
  //
  // Fallback: When the daemon is not available, falls back to the legacy
  // cmdLaunch/cmdResume path for backward compatibility.
  //
  // `skipAutoResume` prevents the loop from immediately re-entering the
  // monitor after the user explicitly detached from it.
  let skipAutoResume = false;
  let _loopCount = 0;
  while (true) {
    _loopCount++;
    _tuiLog(`main loop iteration ${_loopCount}`);
    // Check for active agents — via daemon (preferred) or legacy file state
    let hasRunningWave = false;

    if (daemonConnected && daemonClient) {
      // Ask the daemon for current state
      try {
        const snapshot = await daemonClient.requestState(3000);
        hasRunningWave = snapshot.agents.some(
          (a) =>
            a.status === "running" ||
            a.status === "queued" ||
            a.status === "installing" ||
            a.status === "resolving_conflict" ||
            a.status === "retry"
        );
      } catch {
        // Daemon not responding — fall back to file-based check
        const existingState = loadState(projectRoot);
        hasRunningWave =
          existingState !== null &&
          existingState.agents.some(
            (a) =>
              a.status === "running" ||
              a.status === "queued" ||
              a.status === "installing" ||
              a.status === "resolving_conflict" ||
              a.status === "retry"
          );
      }
    } else {
      const existingState = loadState(projectRoot);
      hasRunningWave =
        existingState !== null &&
        existingState.agents.some(
          (a) =>
            a.status === "running" ||
            a.status === "queued" ||
            a.status === "installing" ||
            a.status === "resolving_conflict" ||
            a.status === "retry"
        );
    }

    if (hasRunningWave && !skipAutoResume) {
      // Agents are running — show the monitor.
      if (daemonConnected && daemonClient) {
        // Daemon mode: use InkDaemonTUI
        try {
          await runDaemonMonitor({ client: daemonClient, projectRoot, config });
        } catch (err: any) {
          const errProgress = runProgressInk({ title: "Monitor Error" });
          await errProgress.finish({ type: "error", message: `Daemon monitor error: ${err.message}` });
        }
      } else {
        // Legacy mode: use cmdResume
        const existingState = loadState(projectRoot);
        const progress = runProgressInk({ title: "Resuming Wave", context: existingState?.wave_id });
        progress.update("Reconnecting to active wave...");
        try {
          await sleep(500);
          progress.unmount();
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
          progress.unmount();
          const errProgress = runProgressInk({ title: "Resume Error" });
          await errProgress.finish({ type: "error", message: `Resume error: ${err.message}` });
        }
      }
      // After resume/monitor returns, don't auto-resume again — let the user
      // browse tasks and use Tab to switch back to the monitor if needed.
      skipAutoResume = true;
      // Clear terminal before showing picker/browser again
      clearScreen();
      continue;
    }

    // Reset the skip flag — if we reach the browser and the user launches
    // a new wave, we should auto-resume when we loop back.
    skipAutoResume = false;

    // -----------------------------------------------------------------------
    // Quest Picker (skip if no quests exist, unless devMode for seed-fake)
    // -----------------------------------------------------------------------
    const quests = loadAllQuests(projectRoot);
    const hasQuests = quests.length > 0;
    _tuiLog(`hasQuests=${hasQuests}, devMode=${config.devMode}, hasRunningWave=${hasRunningWave}, skipAutoResume=${skipAutoResume}`);

    let selectedQuestId: string | null = null;

    if (hasQuests || config.devMode) {
      _tuiLog("launching runQuestPickerInk...");
      const questAction = await runQuestPickerInk({ projectRoot, config });
      _tuiLog(`runQuestPickerInk returned: ${questAction.type}`);

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
        clearScreen();
        continue;
      }

      if (questAction.type === "genesis") {
        // Genesis action -- need to prompt for vision text
        let vision = questAction.vision;
        if (!vision) {
          // The Ink quest picker signals genesis with empty vision;
          // prompt for vision text via readline
          vision = await promptVisionText();
        }
        if (vision) {
          await handleGenesisFlow(projectRoot, config, opts, vision);
        }
        // After genesis (approve or cancel), loop back to quest picker
        clearScreen();
        continue;
      }

      if (questAction.type === "errand") {
        // Errand action -- may need the errand wizard
        let spec = questAction.spec;
        if (!spec.description) {
          const wizardSpec = await runErrandWizardInk();
          if (wizardSpec) {
            spec = wizardSpec;
          } else {
            // User cancelled
            clearScreen();
            continue;
          }
        }
        await handleErrandFlow(projectRoot, config, opts, spec);
        // After errand (approve or cancel), loop back to quest picker
        clearScreen();
        continue;
      }

      if (questAction.type === "wishlist") {
        // User pressed W to browse wishlist
        await handleWishlistFlow(projectRoot, config, opts);
        // After wishlist (promote, back, or quit), loop back to quest picker
        clearScreen();
        continue;
      }

      if (questAction.type === "onboarding") {
        // User pressed O to open onboarding wizard (edit mode)
        await runOnboardingInk({ projectRoot, config });
        // After onboarding, loop back to quest picker
        clearScreen();
        continue;
      }

      if (questAction.type === "select") {
        if (questAction.questId === "__create__") {
          // User wants to create a new quest
          const quest = await runQuestWizardInk({
            projectRoot,
            baseBranch: opts.baseBranch ?? config.baseBranch,
          });
          // After wizard, loop back to quest picker
          clearScreen();
          continue;
        }
        selectedQuestId = questAction.questId;
      }
    }

    // -----------------------------------------------------------------------
    // Task Browser (filtered by quest if one was selected)
    // -----------------------------------------------------------------------

    // Reload session from disk in case state changed after a wave
    const freshSession = loadTUISession(projectRoot);
    if (opts.maxConcurrent !== undefined) {
      freshSession.maxConcurrent = opts.maxConcurrent;
    }
    Object.assign(session, freshSession);

    // Load quest details for filtering
    let questTitle: string | undefined;
    let questTaskIds: string[] | undefined;
    if (selectedQuestId) {
      const quest = loadQuest(projectRoot, selectedQuestId);
      if (quest) {
        questTitle = quest.title;
        questTaskIds = getQuestTaskIds(selectedQuestId, loadTasksFromStore(projectRoot, config).tasks);
      }
    }

    _tuiLog(`launching runTaskBrowserInk (selectedQuestId=${selectedQuestId})...`);
    const action = await runTaskBrowserInk({
      projectRoot,
      config,
      questId: selectedQuestId,
      questTitle,
      questTaskIds,
      hasRunningWave,
      showBack: hasQuests || config.devMode,
    });

    if (action.type === "quit") {
      // User pressed Q in browser with no quest context -- exit cleanly
      session.lastView = "browser";
      saveTUISession(projectRoot, session);
      break;
    }

    if (action.type === "back") {
      // User pressed Q/Esc in quest-filtered browser -- back to quest picker
      clearScreen();
      continue;
    }

    if (action.type === "errand") {
      // User wants an errand -- may need to run wizard
      let spec = action.spec;
      if (!spec.description) {
        const wizardSpec = await runErrandWizardInk();
        if (wizardSpec) {
          spec = wizardSpec;
        } else {
          clearScreen();
          continue;
        }
      }
      await handleErrandFlow(projectRoot, config, opts, spec);
      clearScreen();
      continue;
    }

    if (action.type === "switchToMonitor") {
      // User pressed Tab to switch to the running wave monitor.
      if (daemonConnected && daemonClient) {
        // Daemon mode: use InkDaemonTUI
        try {
          await runDaemonMonitor({ client: daemonClient, projectRoot, config });
        } catch (err: any) {
          const progress = runProgressInk({ title: "Monitor Error" });
          await progress.finish({ type: "error", message: `Daemon monitor error: ${err.message}` });
        }
      } else {
        // Legacy mode: use cmdResume
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
          const progress = runProgressInk({ title: "Resume Error" });
          await progress.finish({ type: "error", message: `Resume error: ${err.message}` });
        }
      }
      clearScreen();
      // Don't auto-resume — let user browse tasks and Tab to monitor
      skipAutoResume = true;
      continue;
    }

    if (action.type === "wishlist") {
      await handleWishlistFlow(projectRoot, config, opts);
      clearScreen();
      continue;
    }

    if (action.type === "launch") {
      // Save session before launching
      session.selected = action.selectedIds;
      session.lastView = "monitor";
      saveTUISession(projectRoot, session);

      if (daemonConnected && daemonClient) {
        // Daemon mode: send cmd:start to daemon, then show monitor
        const progress = runProgressInk({ title: "Starting Agents" });
        progress.update("Sending launch request to daemon...");
        try {
          daemonClient.start({
            questId: selectedQuestId ?? undefined,
            maxConcurrent: session.maxConcurrent,
            model: opts.model,
            taskIds: action.selectedIds,
          });
           // Brief flash to show request sent
          await sleep(500);
          progress.unmount();

          // Immediately enter daemon monitor
          await runDaemonMonitor({ client: daemonClient, projectRoot, config });
        } catch (err: any) {
          progress.unmount();
          const errProgress = runProgressInk({ title: "Launch Error" });
          await errProgress.finish({ type: "error", message: `Daemon launch error: ${err.message}` });
        }
      } else {
        // Legacy mode: use cmdLaunch directly
        const launchOpts: LaunchCommandOptions = {
          projectRoot,
          config,
          features: action.selectedIds,
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
          // Throw errors instead of calling process.exit(1) so the TUI can
          // catch them and display inline without killing the process.
          callerHandlesErrors: true,
        };

        try {
          await cmdLaunch(launchOpts);
        } catch (err: any) {
          // Don't crash -- show error and loop back
          const progress = runProgressInk({ title: "Launch Error" });
          await progress.finish({ type: "error", message: `Launch error: ${err.message}` });
        }
      }

      // Clear terminal before showing picker/browser again
      clearScreen();
      // Don't auto-resume — let user browse tasks and Tab to monitor
      skipAutoResume = true;
      continue;
    }
  }

  } finally {
    // Disconnect daemon client gracefully
    if (daemonClient) {
      try {
        daemonClient.disconnect();
      } catch {
        // Best-effort
      }
    }
    // Always exit the alternate screen buffer, even on error.
    removeGuard();
    exitAltScreen();
  }
}

// ---------------------------------------------------------------------------
// Plan Flow -- Planner + Review
// ---------------------------------------------------------------------------

/**
 * Run the quest planner agent, then show the plan review TUI.
 * Handles the full flow: progress screen -> planner -> review -> approve/cancel.
 */
async function handlePlanFlow(
  projectRoot: string,
  config: WomboConfig,
  opts: TUICommandOptions,
  questId: string
): Promise<void> {
  const quest = loadQuest(projectRoot, questId);
  if (!quest) {
    const progress = runProgressInk({ title: "Error" });
    await progress.finish({ type: "error", message: `Quest "${questId}" not found.` });
    return;
  }

  // Set quest to planning status
  const prevStatus = quest.status;
  quest.status = "planning";
  saveQuest(projectRoot, quest);

  // Show progress screen with spinner
  const progress = runProgressInk({
    title: "Quest Planner",
    context: `${quest.title} (${quest.id})`,
  });
  progress.update("Running quest planner agent...");

  let planResult: PlanResult;

  try {
    planResult = await runQuestPlanner(quest, projectRoot, config, {
      model: opts.model,
      onProgress: (msg) => {
        progress.update(msg);
      },
    });
  } catch (err: any) {
    quest.status = prevStatus;
    saveQuest(projectRoot, quest);
    await progress.finish({ type: "error", message: `Planner error: ${err.message}` });
    return;
  }

  if (!planResult.success && planResult.tasks.length === 0) {
    quest.status = prevStatus;
    saveQuest(projectRoot, quest);
    await progress.finish({
      type: "error",
      message: `Planner failed: ${planResult.error ?? "No tasks produced"}`,
    });
    return;
  }

  // Show results briefly before switching to plan review
  await progress.finish({
    type: "success",
    message: `Planner produced ${planResult.tasks.length} tasks. Opening plan review...`,
  });

  // Show the plan review TUI
  const reviewAction = await runPlanReviewInk({
    questId,
    questTitle: quest.title,
    planResult,
  });

  if (reviewAction.type === "cancel") {
    // User cancelled — revert quest status
    quest.status = prevStatus;
    saveQuest(projectRoot, quest);
    const p2 = runProgressInk({ title: "Plan Cancelled" });
    await p2.finish({
      type: "info",
      message: `Plan discarded. Quest "${questId}" reverted to "${prevStatus}".`,
    });
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
    const p2 = runProgressInk({ title: "Plan Approved" });
    let msg = `Created ${tasks.length} tasks. Quest "${questId}" is now active.`;
    if (reviewAction.knowledge) {
      msg += ` Saved knowledge file (${reviewAction.knowledge.length} chars).`;
    }
    await p2.finish({ type: "success", message: msg });
  } catch (err: any) {
    quest.status = prevStatus;
    saveQuest(projectRoot, quest);
    const p2 = runProgressInk({ title: "Plan Error" });
    await p2.finish({ type: "error", message: `Failed to apply plan: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// Genesis Flow -- Vision Prompt + Planner + Review
// ---------------------------------------------------------------------------

/**
 * Run the genesis planner: take a vision string, run the genesis planner
 * agent, then show the genesis review TUI.
 * Handles the full flow: progress screen -> planner -> review -> create quests.
 */
async function handleGenesisFlow(
  projectRoot: string,
  config: WomboConfig,
  opts: TUICommandOptions,
  vision: string
): Promise<void> {
  if (!vision) {
    const progress = runProgressInk({ title: "Genesis" });
    await progress.finish({ type: "info", message: "No vision provided. Returning to quest picker." });
    return;
  }

  // Gather existing quest IDs so the planner can avoid duplicates
  const existingQuestIds = listQuestIds(projectRoot);

  // Show progress screen with spinner
  const progress = runProgressInk({ title: "Genesis Planner" });
  progress.update("Running genesis planner agent...");

  let genesisResult: GenesisResult;

  try {
    genesisResult = await runGenesisPlanner(vision, projectRoot, config, {
      existingQuestIds,
      model: opts.model,
      onProgress: (msg) => {
        progress.update(msg);
      },
    });
  } catch (err: any) {
    await progress.finish({ type: "error", message: `Genesis planner error: ${err.message}` });
    return;
  }

  if (!genesisResult.success && genesisResult.quests.length === 0) {
    await progress.finish({
      type: "error",
      message: `Genesis planner failed: ${genesisResult.error ?? "No quests produced"}`,
    });
    return;
  }

  // Show results briefly before switching to genesis review
  await progress.finish({
    type: "success",
    message: `Genesis planner produced ${genesisResult.quests.length} quests. Opening genesis review...`,
  });

  // Show the genesis review TUI
  const reviewAction = await runGenesisReviewInk({ genesisResult });

  if (reviewAction.type === "cancel") {
    const p2 = runProgressInk({ title: "Genesis Cancelled" });
    await p2.finish({ type: "info", message: "Genesis plan discarded." });
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
  const p2 = runProgressInk({ title: "Genesis Approved" });
  let msg = `Created ${created.length} quests.`;

  // Save knowledge if the planner produced any (attach to the first quest)
  const knowledge = reviewAction.knowledge;
  if (knowledge && created.length > 0) {
    saveQuestKnowledge(projectRoot, created[0], knowledge);
    msg += ` Saved knowledge file (${knowledge.length} chars) to quest "${created[0]}".`;
  }

  await p2.finish({ type: "success", message: msg });
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
    const progress = runProgressInk({ title: "Errand" });
    await progress.finish({ type: "info", message: "No description provided. Returning." });
    return;
  }

  // Show progress screen with spinner
  const progress = runProgressInk({ title: "Errand Planner" });
  progress.update("Running errand planner...");

  let planResult: PlanResult;

  try {
    planResult = await runErrandPlanner(spec, projectRoot, config, {
      model: opts.model,
      onProgress: (msg) => {
        progress.update(msg);
      },
    });
  } catch (err: any) {
    await progress.finish({ type: "error", message: `Errand planner error: ${err.message}` });
    return;
  }

  if (!planResult.success && planResult.tasks.length === 0) {
    await progress.finish({
      type: "error",
      message: `Errand planner failed: ${planResult.error ?? "No tasks produced"}`,
    });
    return;
  }

  const desc = spec.description;

  // Show results briefly before switching to plan review
  await progress.finish({
    type: "success",
    message: `Errand planner produced ${planResult.tasks.length} task(s). Opening plan review...`,
  });

  // Reuse the plan review TUI (it works for any set of proposed tasks)
  const reviewAction = await runPlanReviewInk({
    questId: "(errand)",
    questTitle: desc.length > 50 ? desc.slice(0, 47) + "..." : desc,
    planResult,
  });

  if (reviewAction.type === "cancel") {
    const p2 = runProgressInk({ title: "Errand Cancelled" });
    await p2.finish({ type: "info", message: "Errand plan discarded." });
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
    const p2 = runProgressInk({ title: "Errand Approved" });
    const taskList = tasks.map((t) => `  - ${t.id}: ${t.title}`).join("\n");
    await p2.finish({
      type: "success",
      message: `Created ${tasks.length} task(s).\n${taskList}`,
    });
  } catch (err: any) {
    const p2 = runProgressInk({ title: "Errand Error" });
    await p2.finish({ type: "error", message: `Failed to create errand tasks: ${err.message}` });
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
  const action = await runWishlistPickerInk({ projectRoot });

  if (action.type === "back" || action.type === "quit") {
    return;
  }

  if (action.type === "promoteErrand") {
    const item = action.item;
    await handleErrandFlow(projectRoot, config, opts, { description: item.text });
    await maybeDeleteWishlistItem(projectRoot, item);
    return;
  }

  if (action.type === "promoteGenesis") {
    const item = action.item;
    await handleGenesisFlow(projectRoot, config, opts, item.text);
    await maybeDeleteWishlistItem(projectRoot, item);
    return;
  }

  if (action.type === "promoteQuest") {
    const item = action.item;

    // Run the quest creation wizard with the wishlist text as the goal
    const quest = await runQuestWizardInk({
      projectRoot,
      baseBranch: opts.baseBranch ?? config.baseBranch,
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
 * After a wishlist item has been promoted, ask the user whether to delete it.
 */
async function maybeDeleteWishlistItem(
  projectRoot: string,
  item: WishlistItem
): Promise<void> {
  const truncText =
    item.text.length > 50 ? item.text.slice(0, 47) + "..." : item.text;

  const confirmed = await runConfirmInk({
    title: "Delete Wishlist Item",
    message: `Delete "${truncText}" from wishlist?`,
  });

  if (confirmed) {
    const deleted = deleteWishlistItem(projectRoot, item.id);
    const p = runProgressInk({ title: "Wishlist" });
    if (deleted) {
      await p.finish({ type: "success", message: "Wishlist item deleted." });
    } else {
      await p.finish({ type: "info", message: "Item not found (may have been already deleted)." });
    }
  } else {
    const p = runProgressInk({ title: "Wishlist" });
    await p.finish({ type: "info", message: "Wishlist item kept." });
  }
}

// ---------------------------------------------------------------------------
// Vision Text Prompt
// ---------------------------------------------------------------------------

/**
 * Prompt the user for a vision text string via readline.
 * Returns the vision text, or empty string if cancelled.
 */
async function promptVisionText(): Promise<string> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    rl.question("Enter your project vision (or press Enter to cancel): ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
