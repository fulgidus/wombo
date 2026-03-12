/**
 * launch.ts — Launch a wave of agents.
 *
 * Usage: wombo launch [selection options] [launch options]
 *
 * This is the primary entry point for starting a new wave. It selects features
 * from the features file, creates a wave state, sets up worktrees, and launches
 * agent processes (either headless or interactive via dmux/tmux).
 *
 * IMPORTANT: This file also exports shared helper functions that are reused
 * by resume.ts and other commands:
 *   - launchSingleHeadless
 *   - handleBuildVerification
 *   - handleRetry
 *   - launchNextQueued
 */

import { execSync } from "node:child_process";
import type { WomboConfig } from "../config.js";
import type { Feature, SelectionOptions, Priority, Difficulty } from "../lib/features.js";
import { loadFeatures, selectFeatures, parseDurationMinutes, saveFeatures } from "../lib/features.js";
import {
  loadState,
  saveState,
  createWaveState,
  createAgentState,
  updateAgent,
  activeAgents,
  queuedAgents,
  isWaveComplete,
  type WaveState,
  type AgentState,
} from "../lib/state.js";
import {
  createWorktree,
  installDeps,
  featureBranchName,
  worktreePath,
  worktreeReady,
  branchHasChanges,
  branchExists,
  removeWorktree,
  log as wtLog,
} from "../lib/worktree.js";
import { generatePrompt, generateConflictResolutionPrompt } from "../lib/prompt.js";
import {
  launchHeadless,
  retryHeadless,
  launchInteractive,
  retryInteractive,
  launchConflictResolver,
  isProcessRunning,
  getMultiplexerName,
} from "../lib/launcher.js";
import { ProcessMonitor } from "../lib/monitor.js";
import { runBuild } from "../lib/verifier.js";
import { mergeBranch, mergeBaseIntoFeature, pushBaseBranch } from "../lib/merger.js";
import {
  printDashboard,
  printFeatureSelection,
  printAgentUpdate,
} from "../lib/ui.js";
import { WomboTUI } from "../lib/tui.js";
import { ensureAgentDefinition } from "../lib/templates.js";
import { outputError, type OutputFormat } from "../lib/output.js";
import {
  detectMultiplexer,
  muxAttachCommand,
  muxListCommand,
} from "../lib/multiplexer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LaunchCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  // Selection
  topPriority?: number;
  quickestWins?: number;
  priority?: Priority;
  difficulty?: Difficulty;
  features?: string[];
  allReady?: boolean;
  // Launch
  maxConcurrent: number;
  model?: string;
  interactive: boolean;
  dryRun: boolean;
  baseBranch: string;
  maxRetries: number;
  noTui: boolean;
  autoPush: boolean;
  // Output
  outputFmt?: OutputFormat;
}

// ---------------------------------------------------------------------------
// Shared Helpers (exported for resume.ts and others)
// ---------------------------------------------------------------------------

/**
 * Mark a feature as done in the features file after a successful merge.
 * Updates status to "done", completion to 100, and sets ended_at.
 *
 * GUARD: Verifies that the feature branch has actually been merged into
 * baseBranch before allowing the status change. This prevents callers
 * from accidentally marking verified-but-unmerged features as done.
 */
export function markFeatureDone(
  projectRoot: string,
  featureId: string,
  config: WomboConfig,
  baseBranch: string
): void {
  try {
    // Verify the feature branch was actually merged into base
    const branch = featureBranchName(featureId, config);
    try {
      execSync(`git merge-base --is-ancestor "${branch}" "${baseBranch}"`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {
      // git merge-base --is-ancestor exits non-zero if NOT an ancestor
      console.error(
        `Warning: ${featureId} branch "${branch}" is not merged into "${baseBranch}" — refusing to mark as done`
      );
      return;
    }

    const data = loadFeatures(projectRoot, config);
    const feature = data.features.find((f) => f.id === featureId);
    if (feature && feature.status !== "done") {
      feature.status = "done";
      feature.completion = 100;
      feature.ended_at = new Date().toISOString();
      saveFeatures(projectRoot, config, data);
    }
  } catch (err: any) {
    // Non-fatal — log but don't crash the wave
    console.error(`Warning: failed to update feature status for ${featureId}: ${err.message}`);
  }
}

/**
 * Launch a single agent in headless mode.
 * Sets up worktree, installs deps, generates prompt, launches agent process.
 */
export async function launchSingleHeadless(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  feature: Feature,
  monitor: ProcessMonitor,
  config: WomboConfig,
  model?: string
): Promise<void> {
  updateAgent(state, agent.feature_id, {
    status: "installing",
    started_at: new Date().toISOString(),
    activity: "setting up worktree...",
  });
  saveState(projectRoot, state);

  try {
    // Skip worktree setup if already ready (resume case)
    if (worktreeReady(agent.worktree)) {
      wtLog(agent.feature_id, "worktree already exists, skipping setup");
    } else {
      // Create worktree (async — doesn't block other agents)
      await createWorktree(projectRoot, feature.id, state.base_branch, config);

      // Install dependencies (async)
      updateAgent(state, agent.feature_id, { activity: "installing deps..." });
      await installDeps(agent.worktree, feature.id, config);
    }

    // Generate prompt
    const prompt = generatePrompt(feature, state.base_branch, config);

    // Launch agent
    wtLog(agent.feature_id, "launching agent...");
    const result = launchHeadless({
      worktreePath: agent.worktree,
      featureId: feature.id,
      prompt,
      model,
      config,
    });

    updateAgent(state, agent.feature_id, {
      status: "running",
      pid: result.pid,
      activity: "starting...",
    });
    saveState(projectRoot, state);

    monitor.addProcess(feature.id, result.process);
    wtLog(agent.feature_id, `running (PID: ${result.pid})`);
  } catch (err: any) {
    updateAgent(state, agent.feature_id, {
      status: "failed",
      error: err.message,
      activity: null,
      completed_at: new Date().toISOString(),
    });
    saveState(projectRoot, state);
    wtLog(agent.feature_id, `SETUP FAILED: ${err.message.split("\n")[0]}`);
  }
}

/**
 * Handle build verification after agent completion.
 * Runs build, auto-merges on pass, retries on failure if retries remain.
 *
 * ASYNC — runs build and merge without blocking the event loop.
 */
export async function handleBuildVerification(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  feature: Feature,
  config: WomboConfig,
  model?: string,
  monitor?: ProcessMonitor
): Promise<void> {
  try {
    printAgentUpdate(agent, "verifying build...");

    const buildResult = await runBuild(agent.worktree, config);

    if (buildResult.passed) {
      updateAgent(state, agent.feature_id, {
        status: "verified",
        build_passed: true,
        build_output: null,
      });
      saveState(projectRoot, state);
      printAgentUpdate(agent, `BUILD PASSED (${Math.round(buildResult.durationMs / 1000)}s)`);

      // Auto-merge: attempt merge + conflict resolution
      await attemptMerge(projectRoot, state, agent, feature, config, model);
    } else {
      if (agent.retries < agent.max_retries) {
        updateAgent(state, agent.feature_id, {
          status: "retry",
          retries: agent.retries + 1,
          build_passed: false,
          build_output: buildResult.errorSummary,
        });
        saveState(projectRoot, state);
        printAgentUpdate(
          agent,
          `BUILD FAILED — retrying (${agent.retries}/${agent.max_retries})`
        );

        // Retry with build errors
        if (agent.session_id) {
          const retryResult = retryHeadless({
            worktreePath: agent.worktree,
            featureId: agent.feature_id,
            sessionId: agent.session_id,
            buildErrors: buildResult.errorSummary,
            model,
            config,
          });

          updateAgent(state, agent.feature_id, {
            status: "running",
            pid: retryResult.pid,
          });
          saveState(projectRoot, state);

          // Add retry process to monitor so events are tracked
          if (monitor) {
            monitor.addProcess(agent.feature_id, retryResult.process);
          }
        }
      } else {
        updateAgent(state, agent.feature_id, {
          status: "failed",
          build_passed: false,
          build_output: buildResult.errorSummary,
          error: `Build failed after ${agent.max_retries} retries`,
          completed_at: new Date().toISOString(),
        });
        saveState(projectRoot, state);
        printAgentUpdate(agent, "BUILD FAILED — max retries reached");
      }
    }
  } catch (err: any) {
    // Catch-all — never let build verification crash the process
    printAgentUpdate(agent, `VERIFY ERROR: ${err.message?.slice(0, 100)}`);
    updateAgent(state, agent.feature_id, {
      status: "failed",
      error: `Build verification error: ${err.message}`,
      completed_at: new Date().toISOString(),
    });
    saveState(projectRoot, state);
  }
}

/**
 * Attempt to merge a verified agent's branch into the base branch.
 *
 * Handles conflict detection, base-into-feature merge, and resolver agent
 * launch. Extracted from handleBuildVerification so it can be called
 * independently (e.g., from resume's sequential merge phase).
 */
export async function attemptMerge(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  feature: Feature,
  config: WomboConfig,
  model?: string,
): Promise<void> {
  printAgentUpdate(agent, "auto-merging...");
  try {
    const mergeResult = await mergeBranch(projectRoot, agent.branch, state.base_branch, config);

    if (mergeResult.success) {
      updateAgent(state, agent.feature_id, {
        status: "merged",
        completed_at: new Date().toISOString(),
      });
      saveState(projectRoot, state);
      printAgentUpdate(agent, `MERGED (${mergeResult.commitHash?.slice(0, 7)})`);

      // Mark feature as done in .features.yml so it won't be re-selected
      markFeatureDone(projectRoot, agent.feature_id, config, state.base_branch);

      // Clean up worktree after successful merge
      try {
        removeWorktree(projectRoot, agent.worktree, true);
        printAgentUpdate(agent, "worktree and branch removed");
      } catch {
        // Not critical — worktree cleanup is best-effort
      }
    } else {
      // Merge failed — attempt automatic conflict resolution
      const mergeError = mergeResult.error ?? "Unknown merge error";
      printAgentUpdate(agent, `MERGE CONFLICT — attempting resolution...`);

      try {
        // Merge base INTO the feature worktree to create conflict markers
        const conflictResult = await mergeBaseIntoFeature(
          agent.worktree,
          state.base_branch,
          config
        );

        if (conflictResult.error && !conflictResult.conflicting) {
          printAgentUpdate(agent, `CONFLICT SETUP FAILED: ${conflictResult.error.slice(0, 100)}`);
          return; // Leave as "verified" for manual resolution
        }

        if (!conflictResult.conflicting) {
          // Base merged cleanly into feature — retry merge into base.
          printAgentUpdate(agent, "base merged cleanly into feature — retrying merge...");
          const retryMerge = await mergeBranch(projectRoot, agent.branch, state.base_branch, config);
          if (retryMerge.success) {
            updateAgent(state, agent.feature_id, {
              status: "merged",
              completed_at: new Date().toISOString(),
            });
            saveState(projectRoot, state);
            printAgentUpdate(agent, `MERGED after rebase (${retryMerge.commitHash?.slice(0, 7)})`);
            markFeatureDone(projectRoot, agent.feature_id, config, state.base_branch);
            try {
              removeWorktree(projectRoot, agent.worktree, true);
            } catch {}
            return;
          }

          // Retry still failed — launch resolver agent
          printAgentUpdate(agent, `retry merge still failed — launching resolver agent...`);

          const secondConflict = await mergeBaseIntoFeature(
            agent.worktree,
            state.base_branch,
            config
          );

          const conflictFiles = secondConflict.conflicting
            ? secondConflict.files
            : ["(unknown — merge direction mismatch)"];
          const resolverMergeError = retryMerge.error ?? mergeError;

          await launchResolverAndRetryMerge(
            projectRoot, state, agent, feature, config, model,
            resolverMergeError, conflictFiles
          );
          return;
        }

        // There are real conflicts — launch a resolver agent
        printAgentUpdate(
          agent,
          `${conflictResult.files.length} conflicting file(s): ${conflictResult.files.join(", ")}`
        );

        await launchResolverAndRetryMerge(
          projectRoot, state, agent, feature, config, model,
          mergeError, conflictResult.files
        );
      } catch (conflictErr: any) {
        printAgentUpdate(agent, `CONFLICT RESOLUTION ERROR: ${conflictErr.message?.slice(0, 100)}`);
        // Leave as "verified" for manual resolution
      }
    }
  } catch (mergeErr: any) {
    printAgentUpdate(agent, `AUTO-MERGE ERROR: ${mergeErr.message?.slice(0, 100)}`);
  }
}

/**
 * Launch a conflict resolver agent, wait for it to finish, re-verify build,
 * and retry the merge. Extracted to avoid duplicating the resolver flow.
 */
async function launchResolverAndRetryMerge(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  feature: Feature,
  config: WomboConfig,
  model: string | undefined,
  mergeError: string,
  conflictFiles: string[]
): Promise<void> {
  const conflictPrompt = generateConflictResolutionPrompt(
    feature,
    state.base_branch,
    mergeError,
    config
  );

  updateAgent(state, agent.feature_id, {
    status: "resolving_conflict",
    activity: `resolving ${conflictFiles.length} conflict(s)...`,
  });
  saveState(projectRoot, state);

  const resolverResult = launchConflictResolver({
    worktreePath: agent.worktree,
    featureId: agent.feature_id,
    prompt: conflictPrompt,
    model,
    config,
  });

  updateAgent(state, agent.feature_id, {
    pid: resolverResult.pid,
  });
  saveState(projectRoot, state);

  // Wait for the resolver process to complete, then re-verify and retry merge.
  // We intentionally do NOT add the resolver to the ProcessMonitor because
  // the monitor's onComplete callback would trigger handleBuildVerification
  // again, causing infinite recursion. Instead we await the process directly.
  const resolverExitCode = await new Promise<number | null>((resolve) => {
    resolverResult.process.on("exit", (code) => resolve(code));
    resolverResult.process.on("error", () => resolve(null));
  });

  printAgentUpdate(agent, `conflict resolver exited (code ${resolverExitCode}) — re-verifying build...`);

  // Re-verify build after conflict resolution
  const rebuildResult = await runBuild(agent.worktree, config);

  if (!rebuildResult.passed) {
    printAgentUpdate(agent, `POST-CONFLICT BUILD FAILED`);
    updateAgent(state, agent.feature_id, {
      status: "failed",
      build_passed: false,
      build_output: rebuildResult.errorSummary,
      error: "Build failed after conflict resolution",
      completed_at: new Date().toISOString(),
    });
    saveState(projectRoot, state);
    return;
  }

  printAgentUpdate(agent, "post-conflict build passed — retrying merge...");

  const retryMerge = await mergeBranch(
    projectRoot,
    agent.branch,
    state.base_branch,
    config
  );

  if (retryMerge.success) {
    updateAgent(state, agent.feature_id, {
      status: "merged",
      build_passed: true,
      completed_at: new Date().toISOString(),
    });
    saveState(projectRoot, state);
    printAgentUpdate(agent, `MERGED after conflict resolution (${retryMerge.commitHash?.slice(0, 7)})`);
    markFeatureDone(projectRoot, agent.feature_id, config, state.base_branch);
    try {
      removeWorktree(projectRoot, agent.worktree, true);
    } catch {}
  } else {
    printAgentUpdate(agent, `POST-CONFLICT MERGE FAILED: ${retryMerge.error}`);
    updateAgent(state, agent.feature_id, {
      status: "failed",
      error: `Merge still failed after conflict resolution: ${retryMerge.error}`,
      completed_at: new Date().toISOString(),
    });
    saveState(projectRoot, state);
  }
}

/**
 * Handle retry of a failed agent (error-based, not build-based).
 */
export function handleRetry(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  monitor: ProcessMonitor,
  config: WomboConfig,
  model?: string
): void {
  if (!agent.session_id || !agent.error) return;

  const retryResult = retryHeadless({
    worktreePath: agent.worktree,
    featureId: agent.feature_id,
    sessionId: agent.session_id,
    buildErrors: agent.error,
    model,
    config,
  });

  updateAgent(state, agent.feature_id, {
    status: "running",
    pid: retryResult.pid,
  });
  saveState(projectRoot, state);

  monitor.addProcess(agent.feature_id, retryResult.process);
}

/**
 * Launch the next queued agent if capacity allows.
 */
export function launchNextQueued(
  projectRoot: string,
  state: WaveState,
  featureMap: Map<string, Feature>,
  monitor: ProcessMonitor,
  config: WomboConfig,
  model?: string
): void {
  const active = activeAgents(state);
  const queued = queuedAgents(state);

  if (active.length < state.max_concurrent && queued.length > 0) {
    const next = queued[0];
    const feature = featureMap.get(next.feature_id);
    if (feature) {
      launchSingleHeadless(projectRoot, state, next, feature, monitor, config, model);
    }
  }
}

// ---------------------------------------------------------------------------
// Headless Wave Launch
// ---------------------------------------------------------------------------

async function launchWaveHeadless(
  projectRoot: string,
  state: WaveState,
  features: Feature[],
  opts: LaunchCommandOptions
): Promise<void> {
  const { config, model } = opts;
  const featureMap = new Map(features.map((f) => [f.id, f]));

  const monitor = new ProcessMonitor(projectRoot, {
    onSessionId: (featureId, sessionId) => {
      updateAgent(state, featureId, { session_id: sessionId });
      saveState(projectRoot, state);
    },
    onComplete: (featureId) => {
      updateAgent(state, featureId, {
        status: "completed",
        completed_at: new Date().toISOString(),
      });
      saveState(projectRoot, state);

      // Run build verification — fire-and-forget
      const agent = state.agents.find((a) => a.feature_id === featureId)!;
      handleBuildVerification(projectRoot, state, agent, featureMap.get(featureId)!, config, model, monitor)
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
        });
        saveState(projectRoot, state);

        // Retry
        handleRetry(projectRoot, state, agent, monitor, config, model);
      } else {
        updateAgent(state, featureId, {
          status: "failed",
          error,
          completed_at: new Date().toISOString(),
        });
        saveState(projectRoot, state);
      }

      // Try to launch next queued agent
      launchNextQueued(projectRoot, state, featureMap, monitor, config, model);
    },
    onOutput: (_featureId, _data) => {
      // Raw output — logged to file by ProcessMonitor
    },
    onActivity: (featureId, activity) => {
      updateAgent(state, featureId, {
        activity,
        activity_updated_at: new Date().toISOString(),
      });
      // Don't save to disk on every activity — too frequent.
    },
  });

  // Create the TUI — it will auto-refresh and show activity from the monitor
  const tuiRef = { current: null as WomboTUI | null };
  const startTUI = () => {
    tuiRef.current = new WomboTUI({
      state,
      monitor,
      projectRoot,
      interactive: false,
      config,
      onQuit: () => {
        // Same as SIGINT — save state and exit
        for (const agent of state.agents) {
          if (agent.status === "running" || agent.status === "resolving_conflict") {
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
  };

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    if (tuiRef.current) tuiRef.current.stop();
    for (const agent of state.agents) {
      if (agent.status === "running" || agent.status === "resolving_conflict") {
        updateAgent(state, agent.feature_id, { activity: "interrupted" });
      }
    }
    monitor.killAll();
    saveState(projectRoot, state);
    console.log("\nState saved. Use 'wombo resume' to continue.");
    process.exit(0);
  });

  // Launch initial batch — set up worktrees in parallel
  const tolaunch = queuedAgents(state).slice(0, opts.maxConcurrent);
  console.log(`Setting up ${tolaunch.length} agent(s) in parallel...\n`);

  await Promise.all(
    tolaunch.map((agent) =>
      launchSingleHeadless(
        projectRoot,
        state,
        agent,
        featureMap.get(agent.feature_id)!,
        monitor,
        config,
        model
      )
    )
  );

  const launched = state.agents.filter((a) => a.status === "running").length;

  // Start the TUI dashboard (or skip if --no-tui)
  if (opts.noTui) {
    console.log(`${launched} agent(s) running. (--no-tui mode, dashboard prints every 15s)\n`);
    printDashboard(state);
  } else {
    console.log(`${launched} agent(s) running. Launching TUI...\n`);
    startTUI();
  }

  // Background monitoring loop — checks for dead processes and launches queued
  const POLL_INTERVAL = 5000;
  let dashboardCounter = 0;
  while (!isWaveComplete(state)) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    // Check for completed processes that weren't caught by event handlers
    for (const agent of state.agents) {
      if (
        (agent.status === "running" || agent.status === "resolving_conflict") &&
        agent.pid &&
        !isProcessRunning(agent.pid) &&
        !monitor.isRunning(agent.feature_id)
      ) {
        if (agent.status === "resolving_conflict") {
          // Conflict resolver died — the await in handleBuildVerification
          // will resolve via the 'exit' event, so nothing to do here
          continue;
        }
        // Process exited but we didn't get a callback
        // Check if the agent actually made any commits
        if (!branchHasChanges(projectRoot, agent.branch, state.base_branch)) {
          // Agent died without producing any code — mark as failed, not completed
          updateAgent(state, agent.feature_id, {
            status: "failed",
            error: "Agent process exited without making any commits",
            activity: null,
            completed_at: new Date().toISOString(),
          });
          saveState(projectRoot, state);
          wtLog(agent.feature_id, "process died with no code changes — marked failed");
        } else {
          updateAgent(state, agent.feature_id, {
            status: "completed",
            completed_at: new Date().toISOString(),
            activity: "done",
          });
          saveState(projectRoot, state);
          try {
            await handleBuildVerification(projectRoot, state, agent, featureMap.get(agent.feature_id)!, config, model, monitor);
          } catch (err: any) {
            wtLog(agent.feature_id, `POLL VERIFY ERROR: ${err.message}`);
          }
        }
        launchNextQueued(projectRoot, state, featureMap, monitor, config, model);
      }
    }

    // Persist state periodically
    saveState(projectRoot, state);

    // Update TUI state reference (or print dashboard in --no-tui mode)
    if (tuiRef.current) {
      tuiRef.current.updateState(state);
    } else if (opts.noTui) {
      dashboardCounter++;
      if (dashboardCounter % 3 === 0) {
        printDashboard(state);

        // Auto-push base branch if requested
        if (opts.autoPush) {
          const anyMerged = state.agents.some((a) => a.status === "merged");
          if (anyMerged) {
            await pushBaseBranch(projectRoot, state.base_branch, config);
          } else {
            console.log("No branches were merged — skipping push.");
          }
        }
      }
    }
  }

  // Wave complete — tear down TUI and show final summary
  if (tuiRef.current) tuiRef.current.stop();
  printDashboard(state);

  // Auto-push base branch if requested
  if (opts.autoPush) {
    await pushBaseBranch(projectRoot, state.base_branch, config);
  }

  console.log("Wave complete.");
}

// ---------------------------------------------------------------------------
// Interactive Wave Launch
// ---------------------------------------------------------------------------

async function launchWaveInteractive(
  projectRoot: string,
  state: WaveState,
  features: Feature[],
  opts: LaunchCommandOptions
): Promise<void> {
  const { config, model } = opts;
  const featureMap = new Map(features.map((f) => [f.id, f]));

  // Show dashboard immediately
  printDashboard(state);

  // Launch initial batch — parallelize setup
  const tolaunch = queuedAgents(state).slice(0, opts.maxConcurrent);
  console.log(`Setting up ${tolaunch.length} agent(s) in parallel...\n`);

  await Promise.all(
    tolaunch.map(async (agent) => {
      updateAgent(state, agent.feature_id, {
        status: "installing",
        started_at: new Date().toISOString(),
        activity: "setting up worktree...",
      });
      saveState(projectRoot, state);

      try {
        if (worktreeReady(agent.worktree)) {
          wtLog(agent.feature_id, "worktree already exists, skipping setup");
        } else {
          await createWorktree(projectRoot, agent.feature_id, state.base_branch, config);
          updateAgent(state, agent.feature_id, { activity: "installing deps..." });
          await installDeps(agent.worktree, agent.feature_id, config);
        }

        const prompt = generatePrompt(
          featureMap.get(agent.feature_id)!,
          state.base_branch,
          config
        );

        wtLog(agent.feature_id, "launching interactive session...");
        const result = launchInteractive({
          worktreePath: agent.worktree,
          featureId: agent.feature_id,
          prompt,
          model,
          interactive: true,
          config,
        });

        const muxName = getMultiplexerName(config);
        updateAgent(state, agent.feature_id, {
          status: "running",
          pid: result.pid,
          activity: `${muxName} session active`,
        });
        saveState(projectRoot, state);
        wtLog(agent.feature_id, `${muxName} session: ${config.agent.tmuxPrefix}-${agent.feature_id}`);
      } catch (err: any) {
        updateAgent(state, agent.feature_id, {
          status: "failed",
          error: err.message,
          activity: null,
          completed_at: new Date().toISOString(),
        });
        saveState(projectRoot, state);
        wtLog(agent.feature_id, `SETUP FAILED: ${err.message.split("\n")[0]}`);
      }
    })
  );

  const mux = detectMultiplexer(config.agent.multiplexer);
  const muxName = getMultiplexerName(config);
  console.log("\nInteractive sessions launched. Use these commands:");
  console.log(`  ${muxAttachCommand(mux, `${config.agent.tmuxPrefix}-<feature-id>`)}   # attach to a session`);
  console.log(`  ${muxListCommand(mux)}${" ".repeat(Math.max(1, 54 - muxListCommand(mux).length))}# list sessions`);
  console.log("  wombo status                                             # check status");
  console.log("  wombo verify                                             # verify builds");
  console.log("  wombo merge                                              # merge verified");
  console.log("  wombo cleanup                                            # remove worktrees");

  printDashboard(state);
}

// ---------------------------------------------------------------------------
// Main Command
// ---------------------------------------------------------------------------

export async function cmdLaunch(opts: LaunchCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;

  console.log("\n--- Wombo: Launch ---\n");

  // Ensure agent definition exists — reinstall from template if missing
  ensureAgentDefinition(projectRoot, config);

  // -------------------------------------------------------------------------
  // Validate that the configured baseBranch exists as a local branch
  // -------------------------------------------------------------------------
  if (!branchExists(projectRoot, opts.baseBranch)) {
    const fmt = opts.outputFmt ?? "text";
    const msg = `Base branch "${opts.baseBranch}" does not exist as a local branch. ` +
      `Create it first (e.g. "git checkout -b ${opts.baseBranch}") or specify ` +
      `a different branch with --base-branch.`;
    outputError(fmt, msg);
  }

  // -------------------------------------------------------------------------
  // Check for existing wave state — don't overwrite work in progress
  // -------------------------------------------------------------------------
  const existingState = loadState(projectRoot);
  if (existingState) {
    const merged = existingState.agents.filter((a) => a.status === "merged");
    const verified = existingState.agents.filter((a) => a.status === "verified");
    const completed = existingState.agents.filter((a) => a.status === "completed");
    const running = existingState.agents.filter((a) => a.status === "running");
    const queued = existingState.agents.filter((a) => a.status === "queued");
    const failed = existingState.agents.filter((a) => a.status === "failed");

    const hasWork = merged.length > 0 || verified.length > 0 || completed.length > 0 || running.length > 0;

    if (hasWork) {
      console.log(`Existing wave found: ${existingState.wave_id}`);
      console.log(`  ${merged.length} merged, ${verified.length} verified, ${completed.length} completed, ${running.length} running, ${queued.length} queued, ${failed.length} failed`);

      // Finalize any merged agents by marking their features as done
      if (merged.length > 0) {
        console.log("\nFinalizing merged features in .features.yml...");
        for (const agent of merged) {
          markFeatureDone(projectRoot, agent.feature_id, config, existingState.base_branch);
          // Clean up worktree and branch (already merged, safe to delete)
          try {
            removeWorktree(projectRoot, agent.worktree, true);
            console.log(`  ${agent.feature_id}: marked done, worktree removed`);
          } catch {
            console.log(`  ${agent.feature_id}: marked done (worktree already cleaned)`);
          }
        }
      }

      // Verified agents: build passed but NOT merged — do NOT mark done.
      // Leave them for 'wombo resume' to attempt the merge.
      if (verified.length > 0) {
        for (const agent of verified) {
          console.log(`  ${agent.feature_id}: verified (not yet merged) — use 'wombo resume' to merge`);
        }
      }

      const activeCount = running.length + completed.length + queued.length;
      if (activeCount > 0) {
        console.error(`\nWave ${existingState.wave_id} has ${activeCount} unfinished agent(s).`);
        console.error("Use 'wombo resume' to continue the existing wave,");
        console.error("or 'wombo cleanup' to clear it before starting a new one.");
        process.exit(1);
      }

      // All agents are in terminal states (merged/verified/failed) — safe to start fresh
      console.log("\nAll agents in previous wave are finished. Starting fresh wave.\n");
    }
  }

  // Load features
  const data = loadFeatures(projectRoot, config);

  // Build selection options
  const selOpts: SelectionOptions = {};
  if (opts.topPriority) selOpts.topPriority = opts.topPriority;
  if (opts.quickestWins) selOpts.quickestWins = opts.quickestWins;
  if (opts.priority) selOpts.priority = opts.priority;
  if (opts.difficulty) selOpts.difficulty = opts.difficulty;
  if (opts.features) selOpts.featureIds = opts.features;
  if (opts.allReady) selOpts.allReady = true;

  // Select features
  const selected = selectFeatures(data, selOpts);

  if (selected.length === 0) {
    if (opts.allReady) {
      console.error(
        "No launchable features found (all features are done, cancelled, or have unmet dependencies).\n" +
        "Run 'wombo features list' to review feature statuses."
      );
    } else {
      console.error(
        "No features matched the selection criteria.\n" +
        "Use --all-ready to select all features whose dependencies are met,\n" +
        "or run 'wombo features list --ready' to see available features."
      );
    }
    process.exit(1);
  }

  // Show selection
  printFeatureSelection(
    selected.map((f) => ({
      id: f.id,
      title: f.title,
      priority: f.priority,
      difficulty: f.difficulty,
      effort: f.effort,
    }))
  );

  if (opts.dryRun) {
    console.log("Dry run — not launching agents.");
    return;
  }

  // Create wave state
  const state = createWaveState({
    baseBranch: opts.baseBranch,
    maxConcurrent: opts.maxConcurrent,
    model: opts.model ?? null,
    interactive: opts.interactive,
  });

  // Create agent entries for all selected features
  for (const feature of selected) {
    const branch = featureBranchName(feature.id, config);
    const wtPath = worktreePath(projectRoot, feature.id, config);
    const agent = createAgentState(feature.id, branch, wtPath, opts.maxRetries);
    // Set effort estimate from feature spec
    const effortMinutes = parseDurationMinutes(feature.effort);
    agent.effort_estimate_ms = effortMinutes === Infinity ? null : effortMinutes * 60 * 1000;
    state.agents.push(agent);
  }

  saveState(projectRoot, state);
  console.log(`Wave ${state.wave_id} created with ${selected.length} agents.`);

  // Launch agents up to max_concurrent
  if (opts.interactive) {
    await launchWaveInteractive(projectRoot, state, selected, opts);
  } else {
    await launchWaveHeadless(projectRoot, state, selected, opts);
  }
}
