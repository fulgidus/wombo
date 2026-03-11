/**
 * resume.ts — Resume a previously stopped wave.
 *
 * Usage: wombo resume [options]
 *
 * Restores from .wombo-state.json:
 *   - Agents in "running"/"installing" whose PID is dead → re-check or re-launch
 *   - Agents in "queued" → launch them
 *   - Agents in terminal states (verified/failed/merged) → leave alone
 */

import type { WomboConfig } from "../config.js";
import type { Feature } from "../lib/features.js";
import { loadFeatures } from "../lib/features.js";
import {
  loadState,
  saveState,
  updateAgent,
  queuedAgents,
  isWaveComplete,
  type WaveState,
  type AgentState,
} from "../lib/state.js";
import {
  createWorktree,
  installDeps,
  worktreeReady,
  log as wtLog,
} from "../lib/worktree.js";
import { generatePrompt } from "../lib/prompt.js";
import {
  launchInteractive,
  isProcessRunning,
} from "../lib/launcher.js";
import { ProcessMonitor } from "../lib/monitor.js";
import { pushBaseBranch } from "../lib/merger.js";
import { printDashboard } from "../lib/ui.js";
import { WomboTUI } from "../lib/tui.js";
import {
  launchSingleHeadless,
  handleBuildVerification,
  handleRetry,
  launchNextQueued,
} from "./launch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResumeCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  maxConcurrent?: number;
  model?: string;
  interactive: boolean;
  noTui: boolean;
  autoPush: boolean;
  baseBranch?: string;
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdResume(opts: ResumeCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;

  const state = loadState(projectRoot);
  if (!state) {
    console.error("No wave state found. Use 'wombo launch' to start a new wave.");
    process.exit(1);
    return; // unreachable — helps TypeScript narrow
  }

  console.log(`\n--- Wombo: Resume ${state.wave_id} ---\n`);

  // Load feature data for prompt generation
  const data = loadFeatures(projectRoot, config);
  const featureMap = new Map(data.features.map((f) => [f.id, f]));

  // Triage agents by current state
  let toRelaunch: AgentState[] = [];
  let toVerify: AgentState[] = [];

  for (const agent of state.agents) {
    switch (agent.status) {
      case "running":
      case "installing":
      case "retry":
        // Was in-flight when we stopped — check if PID is still alive
        if (agent.pid && isProcessRunning(agent.pid)) {
          console.log(`  ${agent.feature_id}: still running (PID ${agent.pid}), leaving alone`);
        } else {
          // Process is dead — check if worktree has meaningful changes
          if (worktreeReady(agent.worktree)) {
            // Worktree exists, try build verification first
            console.log(`  ${agent.feature_id}: process dead, worktree exists — will verify build`);
            toVerify.push(agent);
          } else {
            // Worktree gone or incomplete — re-launch from scratch
            console.log(`  ${agent.feature_id}: process dead, no worktree — will re-launch`);
            updateAgent(state, agent.feature_id, {
              status: "queued",
              pid: null,
              activity: null,
              session_id: null,
            });
            toRelaunch.push(agent);
          }
        }
        break;

      case "queued":
        console.log(`  ${agent.feature_id}: queued — will launch`);
        toRelaunch.push(agent);
        break;

      case "completed":
        // Completed but not verified — verify
        console.log(`  ${agent.feature_id}: completed — will verify build`);
        toVerify.push(agent);
        break;

      case "verified":
      case "merged":
        console.log(`  ${agent.feature_id}: ${agent.status} — nothing to do`);
        break;

      case "failed":
        console.log(`  ${agent.feature_id}: failed — skipping (use 'wombo retry' to re-run)`);
        break;
    }
  }

  saveState(projectRoot, state);

  // Run build verification on agents that were mid-flight
  for (const agent of toVerify) {
    const feature = featureMap.get(agent.feature_id);
    if (!feature) continue;
    console.log(`\n  Verifying ${agent.feature_id}...`);
    try {
      await handleBuildVerification(projectRoot, state, agent, feature, config, opts.model);
    } catch (err: any) {
      console.log(`  Verify error for ${agent.feature_id}: ${err.message}`);
    }

    // If build failed and retries remain, queue for re-launch
    if (agent.status === "retry" || agent.status === "running") {
      toRelaunch.push(agent);
    }
  }

  // Re-launch agents
  const maxConcurrent = opts.maxConcurrent ?? state.max_concurrent;
  const toLaunchNow = toRelaunch.slice(0, maxConcurrent);
  if (toLaunchNow.length === 0) {
    console.log("\nNo agents need (re)launching.");
    printDashboard(state);
    return;
  }

  console.log(`\nRe-launching ${toLaunchNow.length} agent(s)...\n`);
  printDashboard(state);

  const model = opts.model ?? state.model ?? undefined;

  if (opts.interactive) {
    // Interactive resume
    await Promise.all(
      toLaunchNow.map(async (agent) => {
        const feature = featureMap.get(agent.feature_id);
        if (!feature) return;

        updateAgent(state, agent.feature_id, {
          status: "installing",
          started_at: new Date().toISOString(),
          activity: "resuming...",
        });
        saveState(projectRoot, state);

        try {
          if (!worktreeReady(agent.worktree)) {
            await createWorktree(projectRoot, agent.feature_id, state.base_branch, config);
            await installDeps(agent.worktree, agent.feature_id, config);
          }

          const prompt = generatePrompt(feature, state.base_branch, config);
          const result = launchInteractive({
            worktreePath: agent.worktree,
            featureId: feature.id,
            prompt,
            model,
            interactive: true,
            config,
          });

          updateAgent(state, agent.feature_id, {
            status: "running",
            pid: result.pid,
            activity: "tmux session active",
          });
          saveState(projectRoot, state);
        } catch (err: any) {
          updateAgent(state, agent.feature_id, {
            status: "failed",
            error: err.message,
            activity: null,
            completed_at: new Date().toISOString(),
          });
          saveState(projectRoot, state);
        }
      })
    );

    printDashboard(state);
    console.log(`\nResume complete. Use 'tmux attach -t ${config.agent.tmuxPrefix}-<id>' to check sessions.`);
  } else {
    // Headless resume — re-enter monitoring loop
    const monitor = new ProcessMonitor(projectRoot, {
      onSessionId: (featureId, sessionId) => {
        updateAgent(state, featureId, { session_id: sessionId });
        saveState(projectRoot, state);
      },
      onComplete: (featureId) => {
        updateAgent(state, featureId, {
          status: "completed",
          completed_at: new Date().toISOString(),
          activity: "done",
        });
        saveState(projectRoot, state);
        wtLog(featureId, "agent completed — verifying build...");

        const agent = state.agents.find((a) => a.feature_id === featureId)!;
        const feature = featureMap.get(featureId)!;
        handleBuildVerification(projectRoot, state, agent, feature, config, model, monitor)
          .then(() => launchNextQueued(projectRoot, state, featureMap, monitor, config, model))
          .catch((err) => {
            wtLog(featureId, `BUILD VERIFICATION UNHANDLED ERROR: ${err.message}`);
            launchNextQueued(projectRoot, state, featureMap, monitor, config, model);
          });
      },
      onError: (featureId, error) => {
        const agent = state.agents.find((a) => a.feature_id === featureId)!;
        if (agent.retries < agent.max_retries) {
          updateAgent(state, featureId, {
            status: "retry",
            retries: agent.retries + 1,
            error,
            activity: "retrying...",
          });
          saveState(projectRoot, state);
          handleRetry(projectRoot, state, agent, monitor, config, model);
        } else {
          updateAgent(state, featureId, {
            status: "failed",
            error,
            activity: null,
            completed_at: new Date().toISOString(),
          });
          saveState(projectRoot, state);
        }
        launchNextQueued(projectRoot, state, featureMap, monitor, config, model);
      },
      onActivity: (featureId, activity) => {
        updateAgent(state, featureId, {
          activity,
          activity_updated_at: new Date().toISOString(),
        });
      },
    });

    // Handle graceful shutdown
    const tuiRef = { current: null as WomboTUI | null };
    process.on("SIGINT", () => {
      if (tuiRef.current) tuiRef.current.stop();
      for (const agent of state.agents) {
        if (agent.status === "running") {
          updateAgent(state, agent.feature_id, {
            activity: "interrupted",
          });
        }
      }
      monitor.killAll();
      saveState(projectRoot, state);
      console.log("\nState saved. Use 'wombo resume' to continue.");
      process.exit(0);
    });

    await Promise.all(
      toLaunchNow.map((agent) => {
        const feature = featureMap.get(agent.feature_id);
        if (!feature) return Promise.resolve();
        return launchSingleHeadless(projectRoot, state, agent, feature, monitor, config, model);
      })
    );

    // Start TUI dashboard (or skip if --no-tui)
    if (!opts.noTui) {
      tuiRef.current = new WomboTUI({
        state,
        monitor,
        projectRoot,
        interactive: false,
        config,
        onQuit: () => {
          for (const agent of state.agents) {
            if (agent.status === "running") {
              updateAgent(state, agent.feature_id, { activity: "interrupted" });
            }
          }
          monitor.killAll();
          saveState(projectRoot, state);
          console.log("State saved. Use 'wombo resume' to continue.");
          process.exit(0);
        },
      });
      tuiRef.current.start();
    } else {
      console.log("(--no-tui mode, dashboard prints every 15s)\n");
      printDashboard(state);
    }

    // Monitoring loop
    const POLL_INTERVAL = 5000;
    let dashboardCounter = 0;
    while (!isWaveComplete(state)) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));

      for (const agent of state.agents) {
        if (
          agent.status === "running" &&
          agent.pid &&
          !isProcessRunning(agent.pid) &&
          !monitor.isRunning(agent.feature_id)
        ) {
          updateAgent(state, agent.feature_id, {
            status: "completed",
            completed_at: new Date().toISOString(),
            activity: "done",
          });
          saveState(projectRoot, state);
          const feature = featureMap.get(agent.feature_id)!;
          try {
            await handleBuildVerification(projectRoot, state, agent, feature, config, model, monitor);
          } catch (err: any) {
            wtLog(agent.feature_id, `POLL VERIFY ERROR: ${err.message}`);
          }
          launchNextQueued(projectRoot, state, featureMap, monitor, config, model);
        }
      }

      saveState(projectRoot, state);
      if (tuiRef.current) {
        tuiRef.current.updateState(state);
      } else if (opts.noTui) {
        dashboardCounter++;
        if (dashboardCounter % 3 === 0) {
          printDashboard(state);
        }
      }
    }

    if (tuiRef.current) tuiRef.current.stop();
    printDashboard(state);

    // Auto-push base branch if requested
    if (opts.autoPush) {
      await pushBaseBranch(projectRoot, state.base_branch, config);
    }

    console.log("Wave complete.");
  }
}
