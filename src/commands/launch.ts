/**
 * launch.ts — Launch a wave of agents.
 *
 * Usage: woco launch [selection options] [launch options]
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
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WomboConfig } from "../config.js";
import type { Feature, SelectionOptions, Priority, Difficulty } from "../lib/tasks.js";
import { loadFeatures, selectFeatures, parseDurationMinutes, saveFeatures } from "../lib/tasks.js";
import {
  loadState,
  saveState,
  createWaveState,
  createAgentState,
  updateAgent,
  activeAgents,
  queuedAgents,
  readyToLaunchAgents,
  areAgentDepsReady,
  cancelDownstream,
  isWaveComplete,
  type WaveState,
  type AgentState,
  type SerializedSchedulePlan,
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
import { runBuild, runFullVerification } from "../lib/verifier.js";
import { mergeBranch, mergeBaseIntoFeature, pushBaseBranch, canMerge, enqueueMerge } from "../lib/merger.js";
import {
  printDashboard,
  printFeatureSelection,
  printAgentUpdate,
} from "../lib/ui.js";
import { WomboTUI } from "../lib/tui.js";
import { ensureAgentDefinition } from "../lib/templates.js";
import {
  buildDepGraph,
  validateDepGraph,
  buildSchedulePlan,
  formatSchedulePlan,
  getStreamForFeature,
  type DepGraph,
  type SchedulePlan,
} from "../lib/dependency-graph.js";
import { ensureProxyRunning, isPortlessAvailable, portlessUrl } from "../lib/portless.js";
import { outputError, type OutputFormat } from "../lib/output.js";
import {
  detectMultiplexer,
  muxAttachCommand,
  muxListCommand,
} from "../lib/multiplexer.js";
import { exportWaveHistory } from "../lib/history.js";
import {
  prepareAgentDefinitions,
  isSpecializedAgent,
  writeAgentToWorktree,
  type AgentResolution,
} from "../lib/agent-registry.js";
import { patchImportedAgent } from "../lib/templates.js";
import {
  tuiPreflightConfirm,
  consolePreflightConfirm,
} from "../lib/preflight.js";

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
    const feature = data.tasks.find((f: Feature) => f.id === featureId);
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
 * If agentResolutions is provided and contains a specialized agent for this
 * feature, the patched agent definition is written into the worktree.
 */
export async function launchSingleHeadless(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  feature: Feature,
  monitor: ProcessMonitor,
  config: WomboConfig,
  model?: string,
  agentResolutions?: Map<string, AgentResolution>
): Promise<void> {
  updateAgent(state, agent.feature_id, {
    status: "installing",
    started_at: new Date().toISOString(),
    activity: "setting up worktree...",
  });
  saveState(projectRoot, state);

  try {
    // Check if this agent is reusing a chain predecessor's worktree
    const isChainReuse = agent.depends_on.some((depId) => {
      const depAgent = state.agents.find((a) => a.feature_id === depId);
      return depAgent && depAgent.worktree === agent.worktree;
    });

    if (isChainReuse && worktreeReady(agent.worktree)) {
      // Chain worktree reuse: the worktree already exists from a predecessor.
      // Create a new branch for this feature and switch the worktree to it.
      wtLog(agent.feature_id, "reusing chain worktree — switching branch...");
      updateAgent(state, agent.feature_id, { activity: "switching branch (chain reuse)..." });

      try {
        // Create the new feature branch from base (in the worktree)
        execSync(`git checkout -B "${agent.branch}" "${state.base_branch}"`, {
          cwd: agent.worktree,
          stdio: "pipe",
        });
        wtLog(agent.feature_id, `switched to branch ${agent.branch}`);
      } catch (branchErr: any) {
        wtLog(agent.feature_id, `branch switch failed: ${branchErr.message}`);
        // Fall through to normal worktree creation
        await createWorktree(projectRoot, feature.id, state.base_branch, config);
      }
    } else if (worktreeReady(agent.worktree)) {
      // Skip worktree setup if already ready (resume case)
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

    // Write specialized agent to worktree if applicable
    const resolution = agentResolutions?.get(feature.id);
    const agentName = agent.agent_name ?? undefined;
    if (resolution && isSpecializedAgent(resolution)) {
      try {
        const patchedContent = patchImportedAgent(resolution.rawContent, config, projectRoot);
        writeAgentToWorktree(agent.worktree, resolution.name, patchedContent);
        wtLog(agent.feature_id, `wrote specialized agent: ${resolution.name}`);
      } catch (err: any) {
        wtLog(agent.feature_id, `WARN: failed to write specialized agent, using generalist: ${err.message}`);
      }
    }

    // Launch agent
    wtLog(agent.feature_id, "launching agent...");
    const result = launchHeadless({
      worktreePath: agent.worktree,
      featureId: feature.id,
      prompt,
      model,
      config,
      agentName,
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

    // Use full verification pipeline (build + optional browser tests)
    const fullResult = await runFullVerification(agent.worktree, agent.feature_id, config);
    const buildResult = fullResult.build;

    // Report browser test status if they ran
    if (fullResult.browser.ran && fullResult.browser.browserResult) {
      const br = fullResult.browser.browserResult;
      printAgentUpdate(
        agent,
        `BROWSER: ${br.summary} (${Math.round(br.totalDurationMs / 1000)}s)`
      );
    } else if (fullResult.browser.skipReason && config.browser.enabled) {
      printAgentUpdate(agent, `BROWSER: skipped — ${fullResult.browser.skipReason}`);
    }

    if (fullResult.overallPassed) {
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
      const errorSummary = fullResult.combinedErrorSummary;

      if (agent.retries < agent.max_retries) {
        updateAgent(state, agent.feature_id, {
          status: "retry",
          retries: agent.retries + 1,
          build_passed: false,
          build_output: errorSummary,
        });
        saveState(projectRoot, state);
        printAgentUpdate(
          agent,
          `VERIFICATION FAILED — retrying (${agent.retries}/${agent.max_retries})`
        );

        // Retry with error details
        if (agent.session_id) {
          const retryResult = retryHeadless({
            worktreePath: agent.worktree,
            featureId: agent.feature_id,
            sessionId: agent.session_id,
            buildErrors: errorSummary,
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
          build_output: errorSummary,
          error: `Verification failed after ${agent.max_retries} retries`,
          completed_at: new Date().toISOString(),
        });
        saveState(projectRoot, state);
        printAgentUpdate(agent, "VERIFICATION FAILED — max retries reached");

        // Cascade failure to downstream agents
        const cancelled = cancelDownstream(state, agent.feature_id);
        if (cancelled.length > 0) {
          printAgentUpdate(agent, `downstream cancelled: ${cancelled.join(", ")}`);
          saveState(projectRoot, state);
        }
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
 *
 * All merge operations are serialized via enqueueMerge() to prevent
 * concurrent checkout races on the project root.
 */
export async function attemptMerge(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  feature: Feature,
  config: WomboConfig,
  model?: string,
): Promise<void> {
  return enqueueMerge(async () => {
    printAgentUpdate(agent, "auto-merging...");
    try {
      // Pre-flight check: detect conflicts before attempting the real merge.
      // This avoids the expensive merge-then-abort dance for known conflicts.
      const preCheck = await canMerge(projectRoot, agent.branch, state.base_branch);
      if (!preCheck.canMerge) {
        printAgentUpdate(agent, `conflict detected (pre-flight) — attempting resolution...`);
        await handleMergeConflict(
          projectRoot, state, agent, feature, config, model,
          preCheck.reason
        );
        return;
      }

      const mergeResult = await mergeBranch(projectRoot, agent.branch, state.base_branch, config);

      if (mergeResult.success) {
        handleMergeSuccess(projectRoot, state, agent, config, mergeResult.commitHash);
        return;
      }

      // Merge failed despite clean pre-flight — race with another merge or
      // a git state issue. Fall through to conflict resolution.
      printAgentUpdate(agent, `MERGE CONFLICT — attempting resolution...`);
      await handleMergeConflict(
        projectRoot, state, agent, feature, config, model,
        mergeResult.error ?? "Unknown merge error"
      );
    } catch (mergeErr: any) {
      // Unexpected exception — stay in "verified" (retryable) but record the
      // error so the user can see what went wrong instead of silent stalling.
      printAgentUpdate(agent, `AUTO-MERGE ERROR: ${mergeErr.message?.slice(0, 100)}`);
      updateAgent(state, agent.feature_id, {
        error: `Auto-merge error: ${mergeErr.message}`,
      });
      saveState(projectRoot, state);
    }
  });
}

/**
 * Handle a successful merge: update state, mark feature done, clean up.
 */
function handleMergeSuccess(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  config: WomboConfig,
  commitHash: string | null,
  label = "MERGED",
): void {
  updateAgent(state, agent.feature_id, {
    status: "merged",
    completed_at: new Date().toISOString(),
  });
  saveState(projectRoot, state);
  printAgentUpdate(agent, `${label} (${commitHash?.slice(0, 7)})`);

  markFeatureDone(projectRoot, agent.feature_id, config, state.base_branch);

  // Clean up worktree — but preserve it if downstream agents in the same
  // chain share this worktree.
  const hasChainSuccessor = agent.depended_on_by.some((depId) => {
    const depAgent = state.agents.find((a) => a.feature_id === depId);
    return depAgent && depAgent.worktree === agent.worktree;
  });

  if (hasChainSuccessor) {
    printAgentUpdate(agent, "worktree preserved for chain successor");
  } else {
    try {
      removeWorktree(projectRoot, agent.worktree, true);
      printAgentUpdate(agent, "worktree and branch removed");
    } catch {
      // Not critical — worktree cleanup is best-effort
    }
  }
}

/**
 * Handle a merge conflict: merge base into feature, then either retry the
 * direct merge (if base merged cleanly) or launch a resolver agent.
 *
 * All failure paths record the error on the agent (which stays "verified")
 * so the merge can be retried without silently stalling.
 */
async function handleMergeConflict(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  feature: Feature,
  config: WomboConfig,
  model: string | undefined,
  mergeError: string,
): Promise<void> {
  try {
    // Merge base INTO the feature worktree to create conflict markers
    const conflictResult = await mergeBaseIntoFeature(
      agent.worktree,
      state.base_branch,
      config
    );

    if (conflictResult.error && !conflictResult.conflicting) {
      // Setup itself failed — stay as "verified" (retryable) with error
      printAgentUpdate(agent, `CONFLICT SETUP FAILED: ${conflictResult.error.slice(0, 100)}`);
      updateAgent(state, agent.feature_id, {
        error: `Conflict setup failed: ${conflictResult.error}`,
      });
      saveState(projectRoot, state);
      return;
    }

    if (!conflictResult.conflicting) {
      // Base merged cleanly into feature — retry merge into base.
      printAgentUpdate(agent, "base merged cleanly into feature — retrying merge...");
      const retryMerge = await mergeBranch(projectRoot, agent.branch, state.base_branch, config);
      if (retryMerge.success) {
        handleMergeSuccess(projectRoot, state, agent, config, retryMerge.commitHash, "MERGED after rebase");
        return;
      }

      // Retry still failed — need conflict resolution.
      // Merge base into feature again to get conflict files for the resolver.
      printAgentUpdate(agent, `retry merge still failed — launching resolver agent...`);
      const secondConflict = await mergeBaseIntoFeature(
        agent.worktree,
        state.base_branch,
        config
      );

      const conflictFiles = secondConflict.conflicting
        ? secondConflict.files
        : ["(unknown — merge direction mismatch)"];

      await launchResolverAndRetryMerge(
        projectRoot, state, agent, feature, config, model,
        retryMerge.error ?? mergeError, conflictFiles
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
    // Unexpected error during conflict handling — stay "verified" with error
    printAgentUpdate(agent, `CONFLICT RESOLUTION ERROR: ${conflictErr.message?.slice(0, 100)}`);
    updateAgent(state, agent.feature_id, {
      error: `Conflict resolution error: ${conflictErr.message}`,
    });
    saveState(projectRoot, state);
  }
}

/**
 * Launch a conflict resolver agent, wait for it to finish, re-verify build,
 * and retry the merge. Supports configurable retry attempts (defaults to 1,
 * up to config.defaults.maxRetries + 1).
 *
 * The resolver is re-launched with updated conflict state on each attempt,
 * so it sees the current conflict markers, not stale ones.
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
  const maxResolverAttempts = Math.max(1, (config.defaults.maxRetries ?? 0) + 1);

  for (let attempt = 1; attempt <= maxResolverAttempts; attempt++) {
    const conflictPrompt = generateConflictResolutionPrompt(
      feature,
      state.base_branch,
      mergeError,
      config
    );

    const attemptLabel = maxResolverAttempts > 1
      ? ` (attempt ${attempt}/${maxResolverAttempts})`
      : "";

    updateAgent(state, agent.feature_id, {
      status: "resolving_conflict",
      activity: `resolving ${conflictFiles.length} conflict(s)${attemptLabel}...`,
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

    printAgentUpdate(
      agent,
      `conflict resolver exited (code ${resolverExitCode})${attemptLabel} — re-verifying build...`
    );

    // Re-verify build after conflict resolution
    const rebuildResult = await runBuild(agent.worktree, config);

    if (!rebuildResult.passed) {
      if (attempt < maxResolverAttempts) {
        printAgentUpdate(agent, `POST-CONFLICT BUILD FAILED${attemptLabel} — retrying resolver...`);
        continue; // Try again with a fresh resolver
      }
      printAgentUpdate(agent, `POST-CONFLICT BUILD FAILED (all ${maxResolverAttempts} attempts exhausted)`);
      updateAgent(state, agent.feature_id, {
        status: "failed",
        build_passed: false,
        build_output: rebuildResult.errorSummary,
        error: "Build failed after conflict resolution",
        completed_at: new Date().toISOString(),
      });
      saveState(projectRoot, state);
      cancelDownstream(state, agent.feature_id);
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
      handleMergeSuccess(
        projectRoot, state, agent, config,
        retryMerge.commitHash, "MERGED after conflict resolution"
      );
      return;
    }

    // Merge still failed after resolver. If we have attempts left, re-merge
    // base into feature to refresh conflict markers and try again.
    if (attempt < maxResolverAttempts) {
      printAgentUpdate(agent, `POST-CONFLICT MERGE FAILED${attemptLabel} — retrying resolver...`);
      const refreshConflict = await mergeBaseIntoFeature(
        agent.worktree,
        state.base_branch,
        config
      );
      conflictFiles = refreshConflict.conflicting
        ? refreshConflict.files
        : conflictFiles;
      mergeError = retryMerge.error ?? mergeError;
      continue;
    }

    // All attempts exhausted
    printAgentUpdate(agent, `POST-CONFLICT MERGE FAILED (all ${maxResolverAttempts} attempts exhausted): ${retryMerge.error}`);
    updateAgent(state, agent.feature_id, {
      status: "failed",
      error: `Merge still failed after ${maxResolverAttempts} conflict resolution attempt(s): ${retryMerge.error}`,
      completed_at: new Date().toISOString(),
    });
    saveState(projectRoot, state);
    cancelDownstream(state, agent.feature_id);
    saveState(projectRoot, state);
    return;
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
 * Dependency-aware: only launches agents whose dependencies are satisfied.
 */
export function launchNextQueued(
  projectRoot: string,
  state: WaveState,
  featureMap: Map<string, Feature>,
  monitor: ProcessMonitor,
  config: WomboConfig,
  model?: string,
  agentResolutions?: Map<string, AgentResolution>
): void {
  const active = activeAgents(state);
  const ready = readyToLaunchAgents(state);

  if (active.length < state.max_concurrent && ready.length > 0) {
    const next = ready[0];
    const feature = featureMap.get(next.feature_id);
    if (feature) {
      launchSingleHeadless(projectRoot, state, next, feature, monitor, config, model, agentResolutions);
    }
  }
}

/**
 * Launch ALL ready agents up to capacity.
 * After a dependency completes, multiple downstream agents may become unblocked.
 * This launches as many as capacity allows, not just one.
 *
 * Also logs merge gate events when diamond-dependency features become unblocked.
 */
export function launchAllReady(
  projectRoot: string,
  state: WaveState,
  featureMap: Map<string, Feature>,
  monitor: ProcessMonitor,
  config: WomboConfig,
  model?: string,
  agentResolutions?: Map<string, AgentResolution>
): void {
  const active = activeAgents(state);
  const ready = readyToLaunchAgents(state);
  const available = state.max_concurrent - active.length;

  if (available <= 0 || ready.length === 0) return;

  const toLaunch = ready.slice(0, available);
  for (const next of toLaunch) {
    const feature = featureMap.get(next.feature_id);
    if (!feature) continue;

    // Log merge gate opening for diamond dependencies
    if (next.depends_on.length > 1 && state.schedule_plan) {
      const isMergeGate = state.schedule_plan.merge_gates.some(
        (g) => g.feature_id === next.feature_id
      );
      if (isMergeGate) {
        wtLog(
          next.feature_id,
          `merge gate opened — all ${next.depends_on.length} dependencies satisfied`
        );
      }
    }

    launchSingleHeadless(projectRoot, state, next, feature, monitor, config, model, agentResolutions);
  }
}

// ---------------------------------------------------------------------------
// Post-mortem: dump failed agent logs
// ---------------------------------------------------------------------------

/**
 * Print full log contents for every failed agent so the user can diagnose
 * issues after the wave finishes. Handles missing log files gracefully.
 */
export function dumpFailedAgentLogs(projectRoot: string, state: WaveState): void {
  const failed = state.agents.filter((a) => a.status === "failed");
  if (failed.length === 0) return;

  const logDir = resolve(projectRoot, ".wombo-combo/logs");

  console.log(
    `\n${"=".repeat(72)}\n` +
    `  FAILED AGENT LOGS (${failed.length} agent${failed.length > 1 ? "s" : ""})\n` +
    `${"=".repeat(72)}`
  );

  for (const agent of failed) {
    const logFile = resolve(logDir, `${agent.feature_id}.log`);

    console.log(
      `\n${"─".repeat(72)}\n` +
      `  Feature: ${agent.feature_id}\n` +
      (agent.error ? `  Error:   ${agent.error}\n` : "") +
      `${"─".repeat(72)}`
    );

    if (!existsSync(logFile)) {
      console.log("  (no log file found)");
      continue;
    }

    try {
      const contents = readFileSync(logFile, "utf-8");
      if (contents.trim().length === 0) {
        console.log("  (log file is empty)");
      } else {
        console.log(contents);
      }
    } catch (err: any) {
      console.log(`  (error reading log: ${err.message})`);
    }
  }

  console.log(`\n${"=".repeat(72)}\n`);
}

// ---------------------------------------------------------------------------
// Headless Wave Launch
// ---------------------------------------------------------------------------

async function launchWaveHeadless(
  projectRoot: string,
  state: WaveState,
  features: Feature[],
  opts: LaunchCommandOptions,
  agentResolutions?: Map<string, AgentResolution>
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
        .then(() => {
          // After verification/merge, try to launch dependency-ready agents
          // Multiple queued agents may now be unblocked
          launchAllReady(projectRoot, state, featureMap, monitor, config, model, agentResolutions);
        })
        .catch((err) => {
          wtLog(featureId, `BUILD VERIFICATION UNHANDLED ERROR: ${err.message}`);
          launchAllReady(projectRoot, state, featureMap, monitor, config, model, agentResolutions);
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

        // Cascade failure to downstream agents
        const cancelled = cancelDownstream(state, featureId);
        if (cancelled.length > 0) {
          wtLog(featureId, `downstream cancelled: ${cancelled.join(", ")}`);
          saveState(projectRoot, state);
        }
      }

      // Try to launch dependency-ready agents
      launchAllReady(projectRoot, state, featureMap, monitor, config, model, agentResolutions);
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
        console.log("State saved. Use 'woco resume' to continue.");
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
    console.log("\nState saved. Use 'woco resume' to continue.");
    process.exit(0);
  });

  // Launch initial batch — only agents whose dependencies are already satisfied
  const ready = readyToLaunchAgents(state);
  const tolaunch = ready.slice(0, opts.maxConcurrent);
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
        model,
        agentResolutions
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

          // Cascade failure to downstream agents
          const cancelled = cancelDownstream(state, agent.feature_id);
          if (cancelled.length > 0) {
            wtLog(agent.feature_id, `downstream cancelled: ${cancelled.join(", ")}`);
            saveState(projectRoot, state);
          }
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
        launchAllReady(projectRoot, state, featureMap, monitor, config, model, agentResolutions);
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

  // Wave complete — keep TUI open for post-mortem browsing
  if (tuiRef.current) {
    tuiRef.current.updateState(state);
    tuiRef.current.markWaveComplete();
    // Wait for the user to press q to exit the TUI
    await tuiRef.current.waitForQuit();
  }

  // Print final dashboard after TUI is closed
  printDashboard(state);

  // Dump full logs for failed agents (post-mortem)
  dumpFailedAgentLogs(projectRoot, state);

  // Auto-export wave history
  try {
    const historyPath = exportWaveHistory(projectRoot, state);
    console.log(`Wave history exported to ${historyPath}`);
  } catch (err: any) {
    console.error(`Warning: failed to export wave history: ${err.message}`);
  }

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
  opts: LaunchCommandOptions,
  agentResolutions?: Map<string, AgentResolution>
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

        // Write specialized agent to worktree if applicable
        const resolution = agentResolutions?.get(agent.feature_id);
        const agentName = agent.agent_name ?? undefined;
        if (resolution && isSpecializedAgent(resolution)) {
          try {
            const patchedContent = patchImportedAgent(resolution.rawContent, config, projectRoot);
            writeAgentToWorktree(agent.worktree, resolution.name, patchedContent);
            wtLog(agent.feature_id, `wrote specialized agent: ${resolution.name}`);
          } catch (err: any) {
            wtLog(agent.feature_id, `WARN: failed to write specialized agent, using generalist: ${err.message}`);
          }
        }

        wtLog(agent.feature_id, "launching interactive session...");
        const result = launchInteractive({
          worktreePath: agent.worktree,
          featureId: agent.feature_id,
          prompt,
          model,
          interactive: true,
          config,
          agentName,
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
  console.log("  woco status                                             # check status");
  console.log("  woco verify                                             # verify builds");
  console.log("  woco merge                                              # merge verified");
  console.log("  woco cleanup                                            # remove worktrees");

  printDashboard(state);
}

// ---------------------------------------------------------------------------
// Main Command
// ---------------------------------------------------------------------------

export async function cmdLaunch(opts: LaunchCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;

  console.log("\n--- wombo-combo: Launch ---\n");

  // Ensure agent definition exists — reinstall from template if missing
  ensureAgentDefinition(projectRoot, config);

  // Ensure portless proxy is running (if enabled) to prevent port collisions
  if (config.portless.enabled) {
    if (isPortlessAvailable(config)) {
      const proxyOk = ensureProxyRunning(config);
      if (!proxyOk) {
        console.warn(
          "\x1b[33m[portless]\x1b[0m proxy could not be started — agents may encounter port collisions"
        );
      }
    } else {
      console.warn(
        "\x1b[33m[portless]\x1b[0m enabled but not installed. Install with: npm install -g portless"
      );
      console.warn(
        "  Agents will run without portless — concurrent dev servers may have port collisions.\n"
      );
    }
  }

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
        console.log("\nFinalizing merged tasks in tasks file...");
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
      // Leave them for 'woco resume' to attempt the merge.
      if (verified.length > 0) {
        for (const agent of verified) {
          console.log(`  ${agent.feature_id}: verified (not yet merged) — use 'woco resume' to merge`);
        }
      }

      const activeCount = running.length + completed.length + queued.length;
      if (activeCount > 0) {
        console.error(`\nWave ${existingState.wave_id} has ${activeCount} unfinished agent(s).`);
      console.error("Use 'woco resume' to continue the existing wave,");
      console.error("or 'woco cleanup' to clear it before starting a new one.");
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
  if (opts.features) selOpts.taskIds = opts.features;
  if (opts.allReady) selOpts.allReady = true;

  // Select features
  const selected = selectFeatures(data, selOpts);

  if (selected.length === 0) {
    // Build a context-aware message based on which flags were passed
    const activeFilters: string[] = [];
    if (opts.allReady) activeFilters.push("--all-ready");
    if (opts.topPriority) activeFilters.push(`--top-priority ${opts.topPriority}`);
    if (opts.quickestWins) activeFilters.push(`--quickest-wins ${opts.quickestWins}`);
    if (opts.priority) activeFilters.push(`--priority ${opts.priority}`);
    if (opts.difficulty) activeFilters.push(`--difficulty ${opts.difficulty}`);
    if (opts.features?.length) activeFilters.push(`--tasks ${opts.features.join(",")}`);

    if (opts.allReady && activeFilters.length === 1) {
      // Only --all-ready was passed, no additional filters
      console.error(
        "No launchable tasks found (all tasks are done, cancelled, or have unmet dependencies).\n" +
        "Run 'woco tasks list' to review task statuses."
      );
    } else if (activeFilters.length > 0) {
      // Specific filter flags were passed (with or without --all-ready)
      console.error(
        `No tasks matched the current filters: ${activeFilters.join(", ")}.\n` +
        "Try broadening your criteria or run 'woco tasks list --ready' to see available tasks."
      );
    } else {
      // No selection flags at all — default selection found nothing
      console.error(
        "No launchable tasks found.\n" +
        "Use --all-ready to select all tasks whose dependencies are met,\n" +
        "or run 'woco tasks list --ready' to see available tasks."
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

  // ---------------------------------------------------------------------------
  // Dependency graph analysis
  // ---------------------------------------------------------------------------
  const depGraph = buildDepGraph(selected, data.tasks);
  let schedulePlan: SchedulePlan | null = null;

  // Check if any features actually have dependencies within the selected set
  const hasDeps = selected.some(
    (f) => f.depends_on.some((d) => selected.find((s) => s.id === d))
  );

  if (hasDeps) {
    // Validate graph — throws on cycles or dangling deps
    try {
      validateDepGraph(depGraph);
    } catch (err: any) {
      console.error(`\n${err.message}`);
      console.error("\nFix dependency issues before launching.");
      process.exit(1);
    }

    // Build scheduling plan
    schedulePlan = buildSchedulePlan(depGraph);
    console.log(`\n${formatSchedulePlan(schedulePlan)}\n`);
  }

  if (opts.dryRun) {
    console.log("Dry run — not launching agents.");
    return;
  }

  // ---------------------------------------------------------------------------
  // Agent registry: resolve specialized agents for tasks with agent_type
  // ---------------------------------------------------------------------------
  let agentResolutions: Map<string, AgentResolution> | undefined;

  if (config.agentRegistry.mode !== "disabled") {
    const tasksWithAgentType = selected.filter((t) => t.agent_type);
    if (tasksWithAgentType.length > 0) {
      console.log(`\nResolving ${tasksWithAgentType.length} specialized agent(s) from registry...`);
      agentResolutions = await prepareAgentDefinitions(selected, config, projectRoot);

      const specialized = [...agentResolutions.values()].filter(isSpecializedAgent);
      const cached = specialized.filter((r) => r.fromCache);
      console.log(
        `  ${specialized.length} specialized (${cached.length} cached, ${specialized.length - cached.length} fetched), ` +
        `${selected.length - specialized.length} generalist`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Preflight confirmation
  // ---------------------------------------------------------------------------
  if (agentResolutions && agentResolutions.size > 0) {
    const isTTY = process.stdout.isTTY && process.stdin.isTTY;
    const preflight = isTTY && !opts.noTui
      ? await tuiPreflightConfirm(selected, agentResolutions, config)
      : await consolePreflightConfirm(selected, agentResolutions, config);

    if (!preflight.proceed) {
      console.log("Launch cancelled.\n");
      return;
    }

    // Apply user's changes (rejected agents, mode changes)
    agentResolutions = preflight.agents;
  }

  // Create wave state
  const state = createWaveState({
    baseBranch: opts.baseBranch,
    maxConcurrent: opts.maxConcurrent,
    model: opts.model ?? null,
    interactive: opts.interactive,
  });

  // Store serialized schedule plan in wave state
  if (schedulePlan) {
    state.schedule_plan = {
      streams: schedulePlan.streams.map((s) => s.featureIds),
      merge_gates: schedulePlan.mergeGates.map((g) => ({
        feature_id: g.featureId,
        wait_for: g.waitFor,
      })),
      topological_order: schedulePlan.topologicalOrder,
    };
  }

  // Create agent entries for all selected features
  const selectedIds = new Set(selected.map((f) => f.id));

  // Build a map from feature ID → shared worktree path for chain reuse.
  // All features in the same chain share the worktree of the chain's first feature.
  const chainWorktreeMap = new Map<string, string>();
  if (schedulePlan) {
    for (const stream of schedulePlan.streams) {
      if (stream.featureIds.length > 1) {
        // All features in this chain share the first feature's worktree
        const sharedWtPath = worktreePath(projectRoot, stream.featureIds[0], config);
        for (const featureId of stream.featureIds) {
          chainWorktreeMap.set(featureId, sharedWtPath);
        }
      }
    }
  }

  for (const feature of selected) {
    const branch = featureBranchName(feature.id, config);
    // Use shared worktree path for chain members, or individual path otherwise
    const wtPath = chainWorktreeMap.get(feature.id) ?? worktreePath(projectRoot, feature.id, config);
    const agent = createAgentState(feature.id, branch, wtPath, opts.maxRetries);

    // Set effort estimate from feature spec
    const effortMinutes = parseDurationMinutes(feature.effort);
    agent.effort_estimate_ms = effortMinutes === Infinity ? null : effortMinutes * 60 * 1000;

    // Populate dependency fields from the graph
    const graphNode = depGraph.nodes.get(feature.id);
    if (graphNode) {
      // Only track internal deps (within the selected set)
      agent.depends_on = graphNode.dependsOn.filter((d) => selectedIds.has(d));
      agent.depended_on_by = graphNode.dependedOnBy.filter((d) => selectedIds.has(d));
    }

    // Set stream index
    if (schedulePlan) {
      agent.stream_index = getStreamForFeature(schedulePlan, feature.id);
    }

    // Set specialized agent info from resolution
    const resolution = agentResolutions?.get(feature.id);
    if (resolution && isSpecializedAgent(resolution)) {
      agent.agent_name = resolution.name;
      agent.agent_type = resolution.agentType;
    }

    state.agents.push(agent);
  }

  saveState(projectRoot, state);
  console.log(`Wave ${state.wave_id} created with ${selected.length} agents.`);

  // Launch agents up to max_concurrent
  if (opts.interactive) {
    await launchWaveInteractive(projectRoot, state, selected, opts, agentResolutions);
  } else {
    await launchWaveHeadless(projectRoot, state, selected, opts, agentResolutions);
  }
}
