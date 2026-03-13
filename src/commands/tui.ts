/**
 * tui.ts — Unified TUI command entry point for wombo-combo.
 *
 * Orchestrates two views in a persistent loop:
 *   1. Task Browser (tui-browser.ts) — select tasks, change priorities, launch
 *   2. Wave Monitor (tui.ts) — watch running wave, view logs, retry agents
 *
 * Flow:
 *   `woco` (or `bun dev tui`) → Task Browser → L → launches wave → wave
 *   completes → user presses Q in monitor → back to Task Browser → ...
 *
 * Only pressing Q from the Task Browser exits the process. Everything else
 * loops back. Errors during launch/resume are caught and displayed briefly
 * before returning to the browser.
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
  | { type: "quit" };

// ---------------------------------------------------------------------------
// Command — Main Loop
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

  // Main TUI loop — browser → launch → monitor → back to browser
  // Only exits when the user presses Q from the browser.
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
      // A wave is already running — resume it (wave monitor TUI).
      // When the wave completes and the user presses Q, cmdResume returns
      // and we loop back to the browser.
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
        // Don't crash — show error and loop back to browser
        console.error(`\nResume error: ${err.message}\n`);
        await sleep(2000);
      }
      // Clear terminal before showing browser again
      process.stdout.write("\x1B[2J\x1B[H");
      continue;
    }

    // No running wave — show the Task Browser and wait for user action
    const action = await showBrowser(projectRoot, config, session, opts);

    if (action.type === "quit") {
      // User pressed Q in browser — exit cleanly
      session.lastView = "browser";
      saveTUISession(projectRoot, session);
      break;
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
      };

      try {
        await cmdLaunch(launchOpts);
      } catch (err: any) {
        // Don't crash — show error and loop back to browser
        console.error(`\nLaunch error: ${err.message}\n`);
        await sleep(2000);
      }

      // Clear terminal before showing browser again
      process.stdout.write("\x1B[2J\x1B[H");
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Browser View — Promise-based
// ---------------------------------------------------------------------------

/**
 * Show the Task Browser and return a Promise that resolves when the user
 * takes an action (launch or quit).
 */
function showBrowser(
  projectRoot: string,
  config: WomboConfig,
  session: TUISession,
  opts: TUICommandOptions
): Promise<BrowserAction> {
  // Reload session from disk in case state changed after a wave
  const freshSession = loadTUISession(projectRoot);
  // Merge any runtime overrides
  if (opts.maxConcurrent !== undefined) {
    freshSession.maxConcurrent = opts.maxConcurrent;
  }
  // Copy fresh values back into the shared session object
  Object.assign(session, freshSession);

  return new Promise<BrowserAction>((resolve) => {
    const browser = new TaskBrowser({
      projectRoot,
      config,
      session,

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
