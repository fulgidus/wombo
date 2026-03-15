/**
 * launch.ts — Launch a wave of agents.
 *
 * Usage: woco launch [selection options] [launch options]
 *
 * This is the primary entry point for starting a new wave. It selects features
 * from the features file, creates a wave state, sets up worktrees, and launches
 * agent processes (either headless or interactive via tmux).
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
  flushState,
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
  isWorktreesDirEmpty,
  branchExists,
  removeWorktree,
  log as wtLog,
} from "../lib/worktree.js";
import { generatePrompt, generateConflictResolutionPrompt, generateTier4RerunPrompt, generateRebaseCommitPrompt, type QuestPromptContext, type ConflictResolutionContext } from "../lib/prompt.js";
import {
  launchHeadless,
  retryHeadless,
  launchInteractive,
  retryInteractive,
  launchConflictResolver,
  isProcessRunning,
} from "../lib/launcher.js";
import { ProcessMonitor } from "../lib/monitor.js";
import { runBuild, runFullVerification, type FullVerificationOptions } from "../lib/verifier.js";
import {
  mergeBranch,
  mergeBaseIntoFeature,
  pushBaseBranch,
  canMerge,
  enqueueMerge,
  tieredMergeBaseIntoFeature,
  syncQuestBranch,
  startRebaseStrategy,
  beginRebase,
  getRebaseConflicts,
  continueRebase,
  abortRebase,
  cleanupRebaseBranch,
  finalizeRebase,
} from "../lib/merger.js";
import type { Tier25Result } from "../lib/conflict-hunks.js";
import type { MaxEscalationTier } from "../config.js";
import {
  printDashboard,
  printFeatureSelection,
  printAgentUpdate,
} from "../lib/ui.js";
import { WomboTUI } from "../lib/tui.js";
import { ensureAgentDefinition, renderGeneralistAgent, patchImportedAgent } from "../lib/templates.js";
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
import { output, outputError, outputMessage, type OutputFormat } from "../lib/output.js";
import { renderLaunchDryRun } from "../lib/toon.js";
import { ensureTmux, tmuxAttach } from "../lib/tmux.js";
import { InteractiveMonitor, type InteractiveAgent } from "../lib/interactive-monitor.js";
import { exportWaveHistory } from "../lib/history.js";
import {
  prepareAgentDefinitions,
  isSpecializedAgent,
  writeAgentToWorktree,
  type AgentResolution,
} from "../lib/agent-registry.js";
import {
  tuiPreflightConfirm,
  consolePreflightConfirm,
} from "../lib/preflight.js";
import { loadQuest, loadQuestKnowledge } from "../lib/quest-store.js";
import { resolveQuestConfig, applyQuestConstraintsToTask, type QuestHitlMode } from "../lib/quest.js";
import { questBranchExists, createQuestBranch } from "../lib/worktree.js";
import { getPendingQuestions, cleanupAll as cleanupHitl, submitAnswer, type HitlQuestion } from "../lib/hitl-channel.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Build a QuestPromptContext from a wave's quest_id.
 * Returns undefined if the wave is not quest-scoped.
 * Used by internal functions that can't receive questContext from their caller.
 */
function buildQuestContext(
  projectRoot: string,
  questId: string | null
): QuestPromptContext | undefined {
  if (!questId) return undefined;

  const quest = loadQuest(projectRoot, questId);
  if (!quest) return undefined;

  const knowledge = loadQuestKnowledge(projectRoot, questId);
  return {
    questId: quest.id,
    goal: quest.goal,
    addedConstraints: quest.constraints.add ?? [],
    addedForbidden: quest.constraints.ban ?? [],
    knowledge,
  };
}

/**
 * Delay (ms) between sequential agent launches to avoid SQLite race conditions.
 * Each agent spawns its own process which runs DB migrations on startup.
 * Launching them simultaneously causes `CREATE TABLE` collisions.
 */
const LAUNCH_STAGGER_MS = 500;

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
  // Agent selection
  /** CLI override: use this local agent definition for all launched tasks */
  agent?: string;
  // Quest scoping
  /** Quest ID to scope this launch to (uses quest branch as base) */
  questId?: string;
  // Output
  outputFmt?: OutputFormat;
  /**
   * When true, pressing Q in the monitor detaches (returns to caller) instead
   * of killing agents and exiting. Used by cmdTui so the user can switch
   * between the monitor and task browser while agents keep running.
   */
  detachOnQuit?: boolean;
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
 *
 * @param fmt - Output format. When "json" or "toon", suppresses console warnings.
 */
export function markFeatureDone(
  projectRoot: string,
  featureId: string,
  config: WomboConfig,
  baseBranch: string,
  fmt: OutputFormat = "text"
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
      if (fmt === "text") {
        console.error(
          `Warning: ${featureId} branch "${branch}" is not merged into "${baseBranch}" — refusing to mark as done`
        );
      }
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
    if (fmt === "text") {
      console.error(`Warning: failed to update feature status for ${featureId}: ${err.message}`);
    }
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
  agentResolutions?: Map<string, AgentResolution>,
  questContext?: QuestPromptContext,
  hitlMode?: string
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
      // Branch from the current HEAD (predecessor's tip) so all accumulated
      // chain work carries forward — no merge-branch-merge cycle needed.
      wtLog(agent.feature_id, "reusing chain worktree — branching from predecessor tip...");
      updateAgent(state, agent.feature_id, { activity: "branching from predecessor (chain reuse)..." });

      try {
        // Create the new feature branch at the current HEAD (predecessor's tip).
        // This carries forward all work from prior chain members without
        // requiring an intermediate merge into base_branch.
        execSync(`git checkout -B "${agent.branch}"`, {
          cwd: agent.worktree,
          stdio: "pipe",
        });
        wtLog(agent.feature_id, `switched to branch ${agent.branch} (from predecessor tip)`);
      } catch (branchErr: any) {
        wtLog(agent.feature_id, `branch switch failed: ${branchErr.message}`);
        // Fall through to normal worktree creation
        await createWorktree(projectRoot, feature.id, agent.base_branch ?? state.base_branch, config);
      }
    } else if (worktreeReady(agent.worktree)) {
      // Skip worktree setup if already ready (resume case)
      wtLog(agent.feature_id, "worktree already exists, skipping setup");
    } else {
      // Create worktree (async — doesn't block other agents)
      await createWorktree(projectRoot, feature.id, agent.base_branch ?? state.base_branch, config);

      // Install dependencies (async)
      updateAgent(state, agent.feature_id, { activity: "installing deps..." });
      await installDeps(agent.worktree, feature.id, config);
    }

    // Generate prompt
    const prompt = generatePrompt(feature, agent.base_branch ?? state.base_branch, config, questContext, hitlMode as QuestHitlMode | undefined);

    // Write specialized agent to worktree if applicable
    const resolution = agentResolutions?.get(feature.id);
    const agentName = agent.agent_name ?? undefined;
    if (resolution && isSpecializedAgent(resolution)) {
      try {
        const patchedContent = patchImportedAgent(resolution.rawContent, config, projectRoot, hitlMode as QuestHitlMode | undefined);
        writeAgentToWorktree(agent.worktree, resolution.name, patchedContent);
        wtLog(agent.feature_id, `wrote specialized agent: ${resolution.name}`);
      } catch (err: any) {
        wtLog(agent.feature_id, `WARN: failed to write specialized agent, using generalist: ${err.message}`);
      }
    } else if (hitlMode && hitlMode !== "yolo") {
      // For generalist agents under HITL, re-render the template with HITL awareness
      // so the "never ask" rules don't contradict the HITL instructions in the task prompt
      try {
        const hitlAwareContent = renderGeneralistAgent(config, projectRoot, hitlMode as QuestHitlMode);
        writeAgentToWorktree(agent.worktree, config.agent.name, hitlAwareContent);
        wtLog(agent.feature_id, `wrote HITL-aware generalist agent (${hitlMode})`);
      } catch (err: any) {
        wtLog(agent.feature_id, `WARN: failed to write HITL-aware agent, using default: ${err.message}`);
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
      hitlMode,
      projectRoot,
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
  monitor?: ProcessMonitor,
  tddOpts?: FullVerificationOptions,
  hitlMode?: string
): Promise<void> {
  try {
    printAgentUpdate(agent, "verifying build...");

    // Use full verification pipeline (build + optional browser tests + optional TDD)
    const fullResult = await runFullVerification(agent.worktree, agent.feature_id, config, tddOpts);
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

    // Report TDD verification status if it ran
    if (fullResult.tdd.ran) {
      const tdd = fullResult.tdd;
      const tddIcon = tdd.passed ? "✓" : "✗";
      printAgentUpdate(agent, `TDD: ${tddIcon} ${tdd.summary}`);
      if (tdd.hasWarnings) {
        printAgentUpdate(agent, `TDD: ⚠ Missing tests detected (non-blocking)`);
      }
    } else if (fullResult.tdd.skipReason && config.tdd?.enabled) {
      printAgentUpdate(agent, `TDD: skipped — ${fullResult.tdd.skipReason}`);
    }

    if (fullResult.overallPassed) {
      updateAgent(state, agent.feature_id, {
        status: "verified",
        build_passed: true,
        build_output: null,
      });
      saveState(projectRoot, state);
      printAgentUpdate(agent, `BUILD PASSED (${Math.round(buildResult.durationMs / 1000)}s)`);

      // Chain-aware merge: non-terminal chain members defer their merge.
      // The successor will branch from this agent's tip and carry forward
      // all accumulated work.  Only the terminal chain member merges the
      // full chain into base_branch — one merge instead of N.
      const hasChainSuccessor = agent.depended_on_by.some((depId) => {
        const depAgent = state.agents.find((a) => a.feature_id === depId);
        return depAgent && depAgent.worktree === agent.worktree;
      });

      if (hasChainSuccessor) {
        printAgentUpdate(agent, "chain member — deferring merge to chain terminal");
      } else {
        // Terminal chain member (or standalone agent) — merge now.
        await attemptMerge(projectRoot, state, agent, feature, config, model);
      }
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
            hitlMode,
            projectRoot,
            agentName: agent.agent_name ?? undefined,
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
        } else {
          // Agent has no session — reset to queued for a fresh launch
          wtLog(agent.feature_id, `no session — resetting to queued for fresh launch (retry ${agent.retries}/${agent.max_retries})`);
          updateAgent(state, agent.feature_id, {
            status: "queued",
            error: null,
            activity: "waiting for relaunch...",
          });
          saveState(projectRoot, state);
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

        // Rescue verified chain predecessors whose merge was deferred
        await rescueChainPredecessors(projectRoot, state, agent, config, model);
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

    // Rescue verified chain predecessors whose merge was deferred
    await rescueChainPredecessors(projectRoot, state, agent, config, model);
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
      const preCheck = await canMerge(projectRoot, agent.branch, agent.base_branch ?? state.base_branch);
      if (!preCheck.canMerge) {
        printAgentUpdate(agent, `conflict detected (pre-flight) — attempting resolution...`);
        await handleMergeConflict(
          projectRoot, state, agent, feature, config, model,
          preCheck.reason
        );
        return;
      }

      const mergeResult = await mergeBranch(projectRoot, agent.branch, agent.base_branch ?? state.base_branch, config);

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

  markFeatureDone(projectRoot, agent.feature_id, config, agent.base_branch ?? state.base_branch);

  // Walk back the chain and mark all deferred predecessors as merged.
  // Their work was carried forward through branch continuity and is now
  // included in the terminal merge — no separate merge needed.
  const chainPredecessors = getChainPredecessors(state, agent);
  for (const predAgent of chainPredecessors) {
    if (predAgent.status === "verified") {
      updateAgent(state, predAgent.feature_id, {
        status: "merged",
        completed_at: new Date().toISOString(),
      });
      printAgentUpdate(predAgent, `MERGED (via chain terminal ${agent.feature_id})`);
      markFeatureDone(projectRoot, predAgent.feature_id, config, predAgent.base_branch ?? state.base_branch);

      // Clean up predecessor branch — its commits are now reachable via
      // the terminal branch's merge into base.
      try {
        execSync(`git branch -D "${predAgent.branch}"`, {
          cwd: projectRoot,
          stdio: "pipe",
        });
      } catch {
        // Branch may already be gone
      }
    }
  }
  if (chainPredecessors.length > 0) {
    saveState(projectRoot, state);
  }

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
    } catch (err: any) {
      // Log the failure so it's visible — stale worktrees waste disk space
      printAgentUpdate(agent, `WARN: worktree cleanup failed: ${err.message?.split("\n")[0]}`);
    }
  }
}

/**
 * Walk back through chain predecessors (agents sharing the same worktree
 * via depends_on links).  Returns predecessors in reverse order (immediate
 * predecessor first, chain root last).
 */
function getChainPredecessors(state: WaveState, agent: AgentState): AgentState[] {
  const predecessors: AgentState[] = [];
  let current = agent;
  while (true) {
    const pred = current.depends_on
      .map((depId) => state.agents.find((a) => a.feature_id === depId))
      .find((a) => a && a.worktree === current.worktree);
    if (!pred) break;
    predecessors.push(pred);
    current = pred;
  }
  return predecessors;
}

/**
 * Rescue verified chain predecessors when a chain member fails.
 *
 * If the failed agent has deferred-merge predecessors, merges the most
 * recent verified predecessor's branch so its work isn't stranded.
 * The predecessor's branch tip carries all earlier chain work, so one
 * merge rescues the entire verified portion of the chain.
 */
export async function rescueChainPredecessors(
  projectRoot: string,
  state: WaveState,
  failedAgent: AgentState,
  config: WomboConfig,
  model?: string,
): Promise<void> {
  const predecessors = getChainPredecessors(state, failedAgent);
  // Find the most recent verified predecessor (closest to the failed agent
  // in the chain — its branch tip carries all earlier chain work).
  const lastVerified = predecessors.find((a) => a.status === "verified");
  if (!lastVerified) return;

  const data = loadFeatures(projectRoot, config);
  const feature = data.tasks.find((f: Feature) => f.id === lastVerified.feature_id);
  if (!feature) return;

  printAgentUpdate(lastVerified, "rescuing verified chain work after downstream failure...");
  await attemptMerge(projectRoot, state, lastVerified, feature, config, model);
}

/**
 * Handle a merge conflict: use tiered merge strategy.
 *
 * Tier 1: Already failed (we got here because the direct merge failed).
 * Tier 2: Merge base into feature, then auto-resolve trivial conflicts.
 * Tier 3: Real conflicts remain — launch a resolver agent.
 *
 * If tier 3 also fails after max attempts, mark as needs_manual_merge.
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
    // Tiered merge: attempts tier 1 (clean merge), tier 2 (trivial auto-resolve),
    // and tier 2.5 (surgical per-hunk resolution)
    const tieredResult = await tieredMergeBaseIntoFeature(
      agent.worktree,
      agent.base_branch ?? state.base_branch,
      config
    );

    if (tieredResult.success && (tieredResult.tier === 1 || tieredResult.tier === 2 || tieredResult.tier === 2.5)) {
      // Tier 1, 2, or 2.5 resolved the conflicts — retry merge into base
      const tierLabel = tieredResult.tier === 1
        ? "base merged cleanly into feature"
        : tieredResult.tier === 2
        ? "trivial conflicts auto-resolved (whitespace only)"
        : `tier 2.5 surgical resolution (${tieredResult.tier25Result?.resolvedHunkCount ?? 0}/${tieredResult.tier25Result?.totalHunks ?? 0} hunks)`;

      printAgentUpdate(agent, `${tierLabel} — retrying merge...`);
      const retryMerge = await mergeBranch(projectRoot, agent.branch, agent.base_branch ?? state.base_branch, config);
      if (retryMerge.success) {
        const successLabel = tieredResult.tier === 1
          ? "MERGED after rebase"
          : tieredResult.tier === 2
          ? "MERGED after trivial auto-resolve"
          : "MERGED after tier 2.5 surgical resolution";
        handleMergeSuccess(projectRoot, state, agent, config, retryMerge.commitHash, successLabel);
        return;
      }

      // Retry still failed — escalate to tier 3+
      printAgentUpdate(agent, `retry merge still failed after tier ${tieredResult.tier} — escalating...`);
      mergeError = retryMerge.error ?? mergeError;
      // Re-merge base into feature to get fresh conflict state for escalation
      const freshConflict = await mergeBaseIntoFeature(
        agent.worktree,
        agent.base_branch ?? state.base_branch,
        config
      );
      const conflictFiles = freshConflict.conflicting ? freshConflict.files : [];

      await escalatingConflictResolution(
        projectRoot, state, agent, feature, config, model,
        mergeError, conflictFiles, tieredResult.tier25Result ?? null
      );
      return;
    }

    if (tieredResult.tier === null && tieredResult.error) {
      // Setup itself failed — stay as "verified" (retryable) with error
      printAgentUpdate(agent, `CONFLICT SETUP FAILED: ${tieredResult.error.slice(0, 100)}`);
      updateAgent(state, agent.feature_id, {
        error: `Conflict setup failed: ${tieredResult.error}`,
      });
      saveState(projectRoot, state);
      return;
    }

    // Tier 3+: Real conflicts remain after tiers 1, 2, 2.5
    // The tieredResult has structured hunk data from tier 2.5
    printAgentUpdate(
      agent,
      `${tieredResult.conflictFiles.length} non-trivial conflict(s): ${tieredResult.conflictFiles.join(", ")}`
    );

    await escalatingConflictResolution(
      projectRoot, state, agent, feature, config, model,
      mergeError, tieredResult.conflictFiles, tieredResult.tier25Result ?? null
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

// ---------------------------------------------------------------------------
// Escalating Conflict Resolution Pipeline (Tiers 3 → 3.5 → 4)
// ---------------------------------------------------------------------------

/**
 * Check if a given tier is allowed by the maxEscalation config.
 */
function isTierAllowed(tier: "tier3" | "tier3.5" | "tier4", maxEscalation: MaxEscalationTier): boolean {
  const tierOrder: MaxEscalationTier[] = ["tier3", "tier3.5", "tier4"];
  return tierOrder.indexOf(tier) <= tierOrder.indexOf(maxEscalation);
}

/**
 * Get git diffs for enriched conflict resolution context.
 */
async function getConflictDiffs(
  worktreePath: string,
  baseBranch: string,
  remote: string
): Promise<{ featureDiff: string; upstreamDiff: string }> {
  const mergeBaseResult = await runSafeCmd(`git merge-base HEAD "${remote}/${baseBranch}"`, worktreePath);
  const mergeBase = mergeBaseResult.ok ? mergeBaseResult.output.trim() : "";

  let featureDiff = "";
  let upstreamDiff = "";

  if (mergeBase) {
    const fdResult = await runSafeCmd(`git diff "${mergeBase}...HEAD" --stat -p`, worktreePath);
    featureDiff = fdResult.ok ? fdResult.output : "";

    const udResult = await runSafeCmd(`git diff "${mergeBase}...${remote}/${baseBranch}" --stat -p`, worktreePath);
    upstreamDiff = udResult.ok ? udResult.output : "";
  }

  return { featureDiff, upstreamDiff };
}

/**
 * Thin wrapper around exec for simple git commands in the escalation pipeline.
 */
function runSafeCmd(cmd: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const { exec: execFn } = require("node:child_process");
    execFn(cmd, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
      if (error) {
        resolve({ ok: false, output: stderr?.trim() || stdout?.trim() || error.message });
      } else {
        resolve({ ok: true, output: (stdout ?? "").trim() });
      }
    });
  });
}

/**
 * Escalating conflict resolution pipeline.
 *
 * Runs through tiers 3 → 3.5 → 4, stopping at the first success or when
 * the configured maxEscalation is reached.
 *
 * Tier 3:   Enriched single-shot LLM resolve (1 LLM call, structured hunks + diffs)
 * Tier 3.5: Rebase strategy with per-commit LLM resolution (1+ LLM calls)
 * Tier 4:   Nuclear re-run (new worktree, re-implement from scratch)
 */
async function escalatingConflictResolution(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  feature: Feature,
  config: WomboConfig,
  model: string | undefined,
  mergeError: string,
  conflictFiles: string[],
  tier25Result: Tier25Result | null
): Promise<void> {
  const maxEscalation = config.merge.maxEscalation;
  const baseBranch = agent.base_branch ?? state.base_branch;

  // ── Tier 3: Enriched single-shot LLM resolve ──────────────────────────

  if (isTierAllowed("tier3", maxEscalation)) {
    printAgentUpdate(agent, `tier 3: launching enriched LLM conflict resolver...`);

    const tier3Result = await runTier3(
      projectRoot, state, agent, feature, config, model,
      mergeError, conflictFiles, tier25Result
    );

    if (tier3Result === "merged") return;
    if (tier3Result === "build-failed" || tier3Result === "merge-failed") {
      printAgentUpdate(agent, `tier 3 failed (${tier3Result}) — checking escalation options...`);
    }
  }

  // ── Tier 3.5: Rebase strategy ─────────────────────────────────────────

  if (isTierAllowed("tier3.5", maxEscalation)) {
    printAgentUpdate(agent, `tier 3.5: attempting rebase strategy...`);

    // First, abort any in-progress merge to start fresh for rebase
    await runSafeCmd("git merge --abort", agent.worktree);

    const tier35Result = await runTier35(
      projectRoot, state, agent, feature, config, model
    );

    if (tier35Result === "merged") return;
    if (tier35Result === "failed") {
      printAgentUpdate(agent, `tier 3.5 rebase strategy failed — checking escalation options...`);
    }
  }

  // ── Tier 4: Nuclear re-run ────────────────────────────────────────────

  if (isTierAllowed("tier4", maxEscalation)) {
    printAgentUpdate(agent, `tier 4: nuclear re-run — re-implementing feature from scratch...`);

    const tier4Result = await runTier4(
      projectRoot, state, agent, feature, config, model
    );

    if (tier4Result === "merged") return;
    printAgentUpdate(agent, `tier 4 nuclear re-run failed`);
  }

  // ── All tiers exhausted ───────────────────────────────────────────────

  printAgentUpdate(agent, `ALL conflict resolution tiers exhausted (max: ${maxEscalation}) — marking failed`);
  updateAgent(state, agent.feature_id, {
    status: "failed",
    error: `All conflict resolution tiers exhausted (max escalation: ${maxEscalation})`,
    completed_at: new Date().toISOString(),
  });
  saveState(projectRoot, state);
  cancelDownstream(state, agent.feature_id);
  saveState(projectRoot, state);
}

/**
 * Tier 3: Enriched single-shot LLM resolve.
 *
 * ONE attempt with structured hunks, contextual diffs, and feature description.
 */
async function runTier3(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  feature: Feature,
  config: WomboConfig,
  model: string | undefined,
  mergeError: string,
  conflictFiles: string[],
  tier25Result: Tier25Result | null
): Promise<"merged" | "build-failed" | "merge-failed"> {
  const baseBranch = agent.base_branch ?? state.base_branch;

  // Gather contextual diffs
  const diffs = await getConflictDiffs(agent.worktree, baseBranch, config.git.remote);

  const conflictContext: ConflictResolutionContext = {
    tier25Result: tier25Result ?? undefined,
    featureDiff: diffs.featureDiff || undefined,
    upstreamDiff: diffs.upstreamDiff || undefined,
  };

  const conflictPrompt = generateConflictResolutionPrompt(
    feature, baseBranch, mergeError, config,
    buildQuestContext(projectRoot, state.quest_id),
    conflictContext
  );

  updateAgent(state, agent.feature_id, {
    status: "resolving_conflict",
    activity: `tier 3: resolving ${conflictFiles.length} conflict(s)...`,
  });
  saveState(projectRoot, state);

  const resolverResult = launchConflictResolver({
    worktreePath: agent.worktree,
    featureId: agent.feature_id,
    prompt: conflictPrompt,
    model,
    config,
  });

  updateAgent(state, agent.feature_id, { pid: resolverResult.pid });
  saveState(projectRoot, state);

  // Wait for resolver to complete
  const resolverExitCode = await new Promise<number | null>((resolve) => {
    resolverResult.process.on("exit", (code) => resolve(code));
    resolverResult.process.on("error", () => resolve(null));
  });

  printAgentUpdate(agent, `tier 3 resolver exited (code ${resolverExitCode}) — re-verifying build...`);

  // Re-verify build
  const rebuildResult = await runBuild(agent.worktree, config);
  if (!rebuildResult.passed) {
    printAgentUpdate(agent, `tier 3 POST-CONFLICT BUILD FAILED`);
    return "build-failed";
  }

  // Retry merge into base
  printAgentUpdate(agent, "tier 3 build passed — retrying merge...");
  const retryMerge = await mergeBranch(projectRoot, agent.branch, baseBranch, config);
  if (retryMerge.success) {
    handleMergeSuccess(projectRoot, state, agent, config, retryMerge.commitHash, "MERGED after tier 3 enriched resolution");
    return "merged";
  }

  printAgentUpdate(agent, `tier 3 POST-CONFLICT MERGE FAILED: ${retryMerge.error?.slice(0, 100)}`);
  return "merge-failed";
}

/**
 * Tier 3.5: Rebase strategy — replay commits one-at-a-time on a throwaway branch.
 */
async function runTier35(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  feature: Feature,
  config: WomboConfig,
  model: string | undefined
): Promise<"merged" | "failed"> {
  const baseBranch = agent.base_branch ?? state.base_branch;
  const featureBranch = agent.branch;

  // Start the rebase on a throwaway branch
  const rebaseSetup = await startRebaseStrategy(
    agent.worktree, featureBranch, baseBranch, agent.feature_id, config
  );

  if (rebaseSetup.error) {
    printAgentUpdate(agent, `tier 3.5 setup failed: ${rebaseSetup.error.slice(0, 100)}`);
    return "failed";
  }

  const { tempBranch, commitsToReplay } = rebaseSetup;
  printAgentUpdate(agent, `tier 3.5: rebasing ${commitsToReplay.length} commit(s) on ${tempBranch}...`);

  updateAgent(state, agent.feature_id, {
    activity: `tier 3.5: rebasing ${commitsToReplay.length} commit(s)...`,
  });
  saveState(projectRoot, state);

  // Start the rebase
  const rebaseResult = await beginRebase(agent.worktree, baseBranch, config);

  if (rebaseResult.clean) {
    // Rebase completed cleanly — finalize
    printAgentUpdate(agent, `tier 3.5: rebase completed cleanly!`);
    const finalizeResult = await finalizeRebase(agent.worktree, tempBranch, featureBranch);
    if (!finalizeResult.success) {
      printAgentUpdate(agent, `tier 3.5 finalize failed: ${finalizeResult.error?.slice(0, 100)}`);
      await cleanupRebaseBranch(agent.worktree, tempBranch, featureBranch);
      return "failed";
    }

    // Retry merge into base
    const retryMerge = await mergeBranch(projectRoot, featureBranch, baseBranch, config);
    if (retryMerge.success) {
      handleMergeSuccess(projectRoot, state, agent, config, retryMerge.commitHash, "MERGED after tier 3.5 rebase");
      return "merged";
    }
    printAgentUpdate(agent, `tier 3.5 merge after rebase failed: ${retryMerge.error?.slice(0, 100)}`);
    return "failed";
  }

  if (rebaseResult.error) {
    printAgentUpdate(agent, `tier 3.5 rebase error: ${rebaseResult.error.slice(0, 100)}`);
    await abortRebase(agent.worktree);
    await cleanupRebaseBranch(agent.worktree, tempBranch, featureBranch);
    return "failed";
  }

  // Rebase paused at a conflict — handle per-commit resolution
  let commitIndex = 0;
  let maxCommits = commitsToReplay.length;

  while (true) {
    const conflicts = await getRebaseConflicts(agent.worktree);
    if (conflicts.length === 0) break; // No more conflicts

    commitIndex++;
    const currentCommit = commitsToReplay[Math.min(commitIndex - 1, maxCommits - 1)];
    printAgentUpdate(agent, `tier 3.5: resolving conflict in commit ${commitIndex}/${maxCommits}: ${currentCommit?.message?.slice(0, 50) ?? "unknown"}...`);

    updateAgent(state, agent.feature_id, {
      activity: `tier 3.5: resolving commit ${commitIndex}/${maxCommits}...`,
    });
    saveState(projectRoot, state);

    // Launch a per-commit resolver
    const commitPrompt = generateRebaseCommitPrompt(
      feature,
      currentCommit?.message ?? "unknown",
      currentCommit?.hash ?? "unknown",
      conflicts,
      maxCommits,
      commitIndex,
      config
    );

    const resolverResult = launchConflictResolver({
      worktreePath: agent.worktree,
      featureId: agent.feature_id,
      prompt: commitPrompt,
      model,
      config,
    });

    updateAgent(state, agent.feature_id, { pid: resolverResult.pid });
    saveState(projectRoot, state);

    // Wait for resolver
    const exitCode = await new Promise<number | null>((resolve) => {
      resolverResult.process.on("exit", (code) => resolve(code));
      resolverResult.process.on("error", () => resolve(null));
    });

    printAgentUpdate(agent, `tier 3.5 commit resolver exited (code ${exitCode})`);

    // Check if conflicts are resolved (files should be staged by the resolver)
    const remainingConflicts = await getRebaseConflicts(agent.worktree);
    if (remainingConflicts.length > 0) {
      // Resolver didn't fully resolve — abort the whole rebase
      printAgentUpdate(agent, `tier 3.5: resolver failed to resolve commit ${commitIndex} — aborting rebase`);
      await abortRebase(agent.worktree);
      await cleanupRebaseBranch(agent.worktree, tempBranch, featureBranch);
      return "failed";
    }

    // Continue the rebase
    const continueResult = await continueRebase(agent.worktree);
    if (continueResult.done) {
      break; // Rebase complete
    }
    if (continueResult.error) {
      printAgentUpdate(agent, `tier 3.5 continue error: ${continueResult.error.slice(0, 100)}`);
      await abortRebase(agent.worktree);
      await cleanupRebaseBranch(agent.worktree, tempBranch, featureBranch);
      return "failed";
    }
    // If not clean, loop back to handle the next conflict
  }

  // Rebase completed — finalize
  printAgentUpdate(agent, `tier 3.5: rebase completed after resolving ${commitIndex} conflict(s)`);

  const finalizeResult = await finalizeRebase(agent.worktree, tempBranch, featureBranch);
  if (!finalizeResult.success) {
    printAgentUpdate(agent, `tier 3.5 finalize failed: ${finalizeResult.error?.slice(0, 100)}`);
    await cleanupRebaseBranch(agent.worktree, tempBranch, featureBranch);
    return "failed";
  }

  // Verify build after rebase
  const rebuildResult = await runBuild(agent.worktree, config);
  if (!rebuildResult.passed) {
    printAgentUpdate(agent, `tier 3.5 POST-REBASE BUILD FAILED`);
    return "failed";
  }

  // Retry merge into base
  const retryMerge = await mergeBranch(projectRoot, featureBranch, baseBranch, config);
  if (retryMerge.success) {
    handleMergeSuccess(projectRoot, state, agent, config, retryMerge.commitHash, "MERGED after tier 3.5 rebase");
    return "merged";
  }

  printAgentUpdate(agent, `tier 3.5 merge after rebase failed: ${retryMerge.error?.slice(0, 100)}`);
  return "failed";
}

/**
 * Tier 4: Nuclear re-run — re-implement the feature from scratch.
 *
 * Creates a new worktree from the current base branch, generates a prompt
 * with the original feature's diff as reference, and launches the agent.
 */
async function runTier4(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  feature: Feature,
  config: WomboConfig,
  model: string | undefined
): Promise<"merged" | "failed"> {
  const baseBranch = agent.base_branch ?? state.base_branch;

  // Get the feature's diff (what it changed vs the merge base)
  const diffResult = await runSafeCmd(
    `git log --format="" -p "${config.git.remote}/${baseBranch}..${agent.branch}"`,
    agent.worktree
  );
  const featureDiff = diffResult.ok ? diffResult.output : "(diff unavailable)";

  // Abort any in-progress merge/rebase
  await runSafeCmd("git merge --abort", agent.worktree);
  await runSafeCmd("git rebase --abort", agent.worktree);

  // Reset the worktree to a clean state on the base branch
  // We re-use the existing worktree by resetting it to the base
  await runSafeCmd(`git fetch ${config.git.remote} "${baseBranch}"`, agent.worktree);
  const resetResult = await runSafeCmd(`git reset --hard "${config.git.remote}/${baseBranch}"`, agent.worktree);
  if (!resetResult.ok) {
    printAgentUpdate(agent, `tier 4: failed to reset worktree to base: ${resetResult.output.slice(0, 100)}`);
    return "failed";
  }

  updateAgent(state, agent.feature_id, {
    activity: `tier 4: re-implementing feature from scratch...`,
  });
  saveState(projectRoot, state);

  // Generate the tier 4 prompt
  const rerunPrompt = generateTier4RerunPrompt(
    feature, baseBranch, featureDiff, config,
    buildQuestContext(projectRoot, state.quest_id)
  );

  // Launch the agent
  const resolverResult = launchConflictResolver({
    worktreePath: agent.worktree,
    featureId: agent.feature_id,
    prompt: rerunPrompt,
    model,
    config,
  });

  updateAgent(state, agent.feature_id, { pid: resolverResult.pid });
  saveState(projectRoot, state);

  // Wait for completion
  const exitCode = await new Promise<number | null>((resolve) => {
    resolverResult.process.on("exit", (code) => resolve(code));
    resolverResult.process.on("error", () => resolve(null));
  });

  printAgentUpdate(agent, `tier 4 agent exited (code ${exitCode}) — verifying build...`);

  // Verify build
  const rebuildResult = await runBuild(agent.worktree, config);
  if (!rebuildResult.passed) {
    printAgentUpdate(agent, `tier 4 BUILD FAILED`);
    return "failed";
  }

  // Commit if the agent didn't already
  await runSafeCmd("git add -A", agent.worktree);
  await runSafeCmd(
    `git diff --cached --quiet || git commit -m "feat(${agent.feature_id}): re-implement ${feature.title} (tier 4)"`,
    agent.worktree
  );

  // Merge into base
  printAgentUpdate(agent, "tier 4 build passed — merging into base...");
  const retryMerge = await mergeBranch(projectRoot, agent.branch, baseBranch, config);
  if (retryMerge.success) {
    handleMergeSuccess(projectRoot, state, agent, config, retryMerge.commitHash, "MERGED after tier 4 nuclear re-run");
    return "merged";
  }

  printAgentUpdate(agent, `tier 4 MERGE FAILED: ${retryMerge.error?.slice(0, 100)}`);
  return "failed";
}

/**
 * Handle retry of a failed agent (error-based, not build-based).
 *
 * If the agent has a session_id, resumes the existing session with error context.
 * If the agent crashed before establishing a session (session_id is null),
 * resets it to "queued" so it gets relaunched from scratch on the next
 * launchAllReady() cycle. This prevents the "stuck retry" state where an
 * agent sits in "retry" forever with no process running.
 */
export function handleRetry(
  projectRoot: string,
  state: WaveState,
  agent: AgentState,
  monitor: ProcessMonitor,
  config: WomboConfig,
  model?: string,
  hitlMode?: string
): void {
  if (!agent.session_id) {
    // Agent crashed before establishing a session (e.g. SQLite race condition).
    // Reset to queued so it gets a fresh launch on the next cycle.
    wtLog(agent.feature_id, `no session — resetting to queued for fresh launch (retry ${agent.retries}/${agent.max_retries})`);
    updateAgent(state, agent.feature_id, {
      status: "queued",
      error: null,
      activity: "waiting for relaunch...",
    });
    saveState(projectRoot, state);
    return;
  }

  if (!agent.error) return;

  const retryResult = retryHeadless({
    worktreePath: agent.worktree,
    featureId: agent.feature_id,
    sessionId: agent.session_id,
    buildErrors: agent.error,
    model,
    config,
    hitlMode,
    projectRoot,
    agentName: agent.agent_name ?? undefined,
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
export async function launchNextQueued(
  projectRoot: string,
  state: WaveState,
  featureMap: Map<string, Feature>,
  monitor: ProcessMonitor,
  config: WomboConfig,
  model?: string,
  agentResolutions?: Map<string, AgentResolution>,
  questContext?: QuestPromptContext,
  hitlMode?: string
): Promise<void> {
  const active = activeAgents(state);
  const ready = readyToLaunchAgents(state);

  if (active.length < state.max_concurrent && ready.length > 0) {
    const next = ready[0];
    const feature = featureMap.get(next.feature_id);
    if (feature) {
      await launchSingleHeadless(projectRoot, state, next, feature, monitor, config, model, agentResolutions, questContext, hitlMode);
    }
  }
}

/**
 * Launch ALL ready agents up to capacity.
 * After a dependency completes, multiple downstream agents may become unblocked.
 * This launches as many as capacity allows, not just one.
 *
 * Launches are staggered to avoid SQLite race conditions.
 *
 * Also logs merge gate events when diamond-dependency features become unblocked.
 */
export async function launchAllReady(
  projectRoot: string,
  state: WaveState,
  featureMap: Map<string, Feature>,
  monitor: ProcessMonitor,
  config: WomboConfig,
  model?: string,
  agentResolutions?: Map<string, AgentResolution>,
  questContext?: QuestPromptContext,
  hitlMode?: string
): Promise<void> {
  const active = activeAgents(state);
  const ready = readyToLaunchAgents(state);
  const available = state.max_concurrent - active.length;

  if (available <= 0 || ready.length === 0) return;

  const toLaunch = ready.slice(0, available);
  for (let i = 0; i < toLaunch.length; i++) {
    const next = toLaunch[i];
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

    await launchSingleHeadless(projectRoot, state, next, feature, monitor, config, model, agentResolutions, questContext, hitlMode);
    // Stagger between launches to avoid SQLite race conditions
    if (i < toLaunch.length - 1) {
      await new Promise((r) => setTimeout(r, LAUNCH_STAGGER_MS));
    }
  }
}

// ---------------------------------------------------------------------------
// Post-mortem: dump failed agent logs
// ---------------------------------------------------------------------------

/**
 * Print full log contents for every failed agent so the user can diagnose
 * issues after the wave finishes. Handles missing log files gracefully.
 *
 * In JSON/TOON mode, this function is a no-op — callers should emit
 * structured failure data through the output() helper instead.
 *
 * @param fmt - Output format. Only prints when "text".
 */
export function dumpFailedAgentLogs(projectRoot: string, state: WaveState, fmt: OutputFormat = "text"): void {
  if (fmt !== "text") return; // suppress in JSON/TOON mode

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
  agentResolutions?: Map<string, AgentResolution>,
  questContext?: QuestPromptContext,
  hitlMode?: string
): Promise<void> {
  const { config, model } = opts;
  const fmt = opts.outputFmt ?? "text";
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
      handleBuildVerification(projectRoot, state, agent, featureMap.get(featureId)!, config, model, monitor, undefined, hitlMode)
        .then(() => {
          // After verification/merge, try to launch dependency-ready agents
          // Multiple queued agents may now be unblocked
          launchAllReady(projectRoot, state, featureMap, monitor, config, model, agentResolutions, questContext, hitlMode)
            .catch((err) => wtLog(featureId, `LAUNCH ERROR: ${err.message}`));
        })
        .catch((err) => {
          wtLog(featureId, `BUILD VERIFICATION UNHANDLED ERROR: ${err.message}`);
          launchAllReady(projectRoot, state, featureMap, monitor, config, model, agentResolutions, questContext, hitlMode)
            .catch((err2) => wtLog(featureId, `LAUNCH ERROR: ${err2.message}`));
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
        handleRetry(projectRoot, state, agent, monitor, config, model, hitlMode);
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

        // Rescue verified chain predecessors whose merge was deferred
        rescueChainPredecessors(projectRoot, state, agent, config, model)
          .catch((err) => wtLog(featureId, `CHAIN RESCUE ERROR: ${err.message}`));
      }

      // Try to launch dependency-ready agents
      launchAllReady(projectRoot, state, featureMap, monitor, config, model, agentResolutions, questContext, hitlMode)
        .catch((err) => wtLog(featureId, `LAUNCH ERROR: ${err.message}`));
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
  //
  // Detach support: When the user presses Q in the monitor TUI, we no longer
  // kill agents and exit. Instead, we set a `detached` flag and let the
  // monitoring loop exit naturally. The caller (cmdTui) then loops back to
  // the task browser, which shows a "running wave" indicator.
  let detached = false;
  const tuiRef = { current: null as WomboTUI | null };
  const startTUI = () => {
    tuiRef.current = new WomboTUI({
      state,
      monitor,
      projectRoot,
      interactive: false,
      config,
      onQuit: () => {
          if (opts.detachOnQuit) {
            // Detach from the wave monitor — agents keep running in the background.
            // The monitoring loop checks `detached` and exits, returning control
            // to the caller (cmdTui main loop).
            flushState(projectRoot, state);
            // Null out the TUI ref so the monitoring loop stops trying to update
            // the destroyed screen during remaining poll iterations.
            tuiRef.current = null;
            detached = true;
          } else {
            // Standalone mode — kill agents and exit (traditional behavior).
            for (const agent of state.agents) {
              if (agent.status === "running" || agent.status === "resolving_conflict") {
                updateAgent(state, agent.feature_id, { activity: "interrupted" });
              }
            }
            monitor.killAll();
            flushState(projectRoot, state);
            if (fmt === "text") console.log("State saved. Use 'woco resume' to continue.");
            process.exit(0);
          }
      },
      onBeforeDestroy: () => {
        // Flush state to disk before the blessed screen is destroyed.
        // This is called from TUI.stop() which runs before screen.destroy(),
        // ensuring state.json is complete even if process.exit() follows.
        flushState(projectRoot, state);
      },
      onRetry: (featureId: string) => {
        const agent = state.agents.find((a) => a.feature_id === featureId);
        if (!agent) return;
        if (agent.status !== "failed" && agent.status !== "retry") return;

        // Reset retries if exhausted, give it one more shot
        if (agent.retries >= agent.max_retries) {
          updateAgent(state, featureId, { max_retries: agent.retries + 1 });
        }

        wtLog(featureId, `manual retry requested from TUI — resetting to queued`);
        updateAgent(state, featureId, {
          status: "queued",
          error: null,
          activity: "waiting for relaunch (manual retry)...",
        });
        saveState(projectRoot, state);
        // The polling loop will call launchAllReady() and pick this up
      },
      onAnswer: (agentId: string, questionId: string, answerText: string) => {
        try {
          submitAnswer(projectRoot, agentId, questionId, answerText);
          wtLog(agentId, `HITL answer submitted: "${answerText.slice(0, 80)}${answerText.length > 80 ? "..." : ""}"`);
        } catch (err: any) {
          wtLog(agentId, `HITL answer error: ${err.message}`);
        }
      },
    });
    tuiRef.current.start();
  };

  // Handle graceful shutdown
  //
  // Audit (wave-detach-audit): This is the critical shutdown path for headless
  // agents. Because agents are spawned with `detached: false` (see launcher.ts),
  // they would be killed by the OS when the parent exits anyway. However, calling
  // `monitor.killAll()` explicitly before `process.exit(0)` ensures:
  //   1. Each agent gets SIGTERM (not SIGKILL), allowing graceful shutdown
  //   2. Wave state is saved BEFORE agents die, preserving progress
  //   3. The TUI is cleanly destroyed before terminal restoration
  //
  // If the parent is killed with SIGKILL (uncatchable), agents die immediately
  // with no state save. `woco resume` recovers from this by detecting orphaned
  // worktrees with commits and re-verifying or re-launching as appropriate.
  const gracefulShutdown = (signal: string) => {
    if (tuiRef.current) tuiRef.current.stop();
    for (const agent of state.agents) {
      if (agent.status === "running" || agent.status === "resolving_conflict") {
        updateAgent(state, agent.feature_id, { activity: "interrupted" });
      }
    }
    monitor.killAll();
    flushState(projectRoot, state);
    if (fmt === "text") console.log(`\nState saved (${signal}). Use 'woco resume' to continue.`);
    process.exit(0);
  };
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

  // Launch initial batch — only agents whose dependencies are already satisfied
  // Stagger launches to avoid SQLite race conditions in agent processes:
  // each agent spawns its own DB, and simultaneous CREATE TABLE calls collide.
  const ready = readyToLaunchAgents(state);
  const tolaunch = ready.slice(0, opts.maxConcurrent || undefined);
  if (fmt === "text") console.log(`Setting up ${tolaunch.length} agent(s) (staggered)...\n`);

  for (let i = 0; i < tolaunch.length; i++) {
    await launchSingleHeadless(
      projectRoot,
      state,
      tolaunch[i],
      featureMap.get(tolaunch[i].feature_id)!,
      monitor,
      config,
      model,
      agentResolutions,
      questContext,
      hitlMode
    );
    // Brief delay between spawns so each agent's DB migration settles
    if (i < tolaunch.length - 1) {
      await new Promise((r) => setTimeout(r, LAUNCH_STAGGER_MS));
    }
  }

  const launched = state.agents.filter((a) => a.status === "running").length;

  // Start the TUI dashboard (or skip if --no-tui)
  if (opts.noTui) {
    if (fmt === "text") {
      console.log(`${launched} agent(s) running. (--no-tui mode, dashboard prints every 15s)\n`);
      printDashboard(state);
    }
  } else {
    if (fmt === "text") console.log(`${launched} agent(s) running. Launching TUI...\n`);
    startTUI();
  }

  // Background monitoring loop — checks for dead processes and launches queued
  const POLL_INTERVAL = 5000;
  let dashboardCounter = 0;
  while (!isWaveComplete(state) && !detached) {
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
        if (!branchHasChanges(projectRoot, agent.branch, agent.base_branch ?? state.base_branch)) {
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
            await handleBuildVerification(projectRoot, state, agent, featureMap.get(agent.feature_id)!, config, model, monitor, undefined, hitlMode);
          } catch (err: any) {
            wtLog(agent.feature_id, `POLL VERIFY ERROR: ${err.message}`);
          }
        }
        await launchAllReady(projectRoot, state, featureMap, monitor, config, model, agentResolutions, questContext, hitlMode);
      }
    }

    // Safety net: detect agents stuck in "retry" with no running process.
    // This catches edge cases where handleRetry() wasn't called or failed
    // to reset the agent (e.g. race between onError callback and poll loop).
    for (const agent of state.agents) {
      if (
        agent.status === "retry" &&
        (!agent.pid || !isProcessRunning(agent.pid)) &&
        !monitor.isRunning(agent.feature_id)
      ) {
        if (agent.retries >= agent.max_retries) {
          // Out of retries — mark as failed and cascade
          wtLog(agent.feature_id, `stuck in retry with no process and retries exhausted (${agent.retries}/${agent.max_retries}) — marking failed`);
          updateAgent(state, agent.feature_id, {
            status: "failed",
            error: agent.error ?? "Agent stuck in retry state with no running process",
            activity: null,
            completed_at: new Date().toISOString(),
          });
          saveState(projectRoot, state);
          const cancelled = cancelDownstream(state, agent.feature_id);
          if (cancelled.length > 0) {
            wtLog(agent.feature_id, `downstream cancelled: ${cancelled.join(", ")}`);
            saveState(projectRoot, state);
          }
        } else {
          // Has retries left — reset to queued for a fresh launch
          wtLog(agent.feature_id, `stuck in retry with no process — resetting to queued (retry ${agent.retries}/${agent.max_retries})`);
          updateAgent(state, agent.feature_id, {
            status: "queued",
            error: null,
            activity: "waiting for relaunch...",
          });
          saveState(projectRoot, state);
        }
      }
    }

    // After recovering stuck agents, try launching any that are now ready
    await launchAllReady(projectRoot, state, featureMap, monitor, config, model, agentResolutions, questContext, hitlMode);

    // Persist state periodically
    saveState(projectRoot, state);

    // Poll for HITL questions from agents and forward to TUI
    if (hitlMode && hitlMode !== "yolo") {
      try {
        const pendingQuestions = getPendingQuestions(projectRoot);
        if (tuiRef.current && pendingQuestions.length > 0) {
          tuiRef.current.setPendingQuestions(pendingQuestions);
        }
      } catch {
        // Non-fatal — HITL dir may not exist yet
      }
    }

    // Update TUI state reference (or print dashboard in --no-tui mode)
    if (tuiRef.current) {
      tuiRef.current.updateState(state);
    } else if (opts.noTui && fmt === "text") {
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

  // If user detached (pressed Q while agents are still running), save state
  // and return without doing post-wave cleanup. The caller (cmdTui) will
  // loop back to the task browser, showing the running wave indicator.
  if (detached) {
    flushState(projectRoot, state);
    return;
  }

  // Wave complete — keep TUI open for post-mortem browsing
  if (tuiRef.current) {
    tuiRef.current.updateState(state);
    tuiRef.current.markWaveComplete();

    if (opts.detachOnQuit) {
      // TUI loop mode — show "WAVE COMPLETE" banner briefly, then auto-return
      // to the task browser instead of blocking on a manual Q press.
      await new Promise<void>((r) => setTimeout(r, 2500));
    } else {
      // Standalone mode — wait for the user to press q to exit the TUI
      await tuiRef.current.waitForQuit();
    }
  }

  // Print final dashboard after TUI is closed
  if (fmt === "text") printDashboard(state);

  // Clean up HITL files
  try {
    cleanupHitl(projectRoot);
  } catch {
    // Non-fatal
  }

  // Dump full logs for failed agents (post-mortem)
  dumpFailedAgentLogs(projectRoot, state, fmt);

  // Auto-export wave history
  try {
    const historyPath = exportWaveHistory(projectRoot, state);
    if (fmt === "text") console.log(`Wave history exported to ${historyPath}`);
  } catch (err: any) {
    if (fmt === "text") console.error(`Warning: failed to export wave history: ${err.message}`);
  }

  // Auto-push base branch if requested
  if (opts.autoPush) {
    await pushBaseBranch(projectRoot, state.base_branch, config);
  }

  // Completion double-check: verify worktrees directory is empty
  if (fmt === "text") {
    if (isWorktreesDirEmpty(projectRoot)) {
      console.log("All worktrees cleaned up — worktrees directory is empty.");
    } else {
      console.log("\x1b[33mNote:\x1b[0m worktrees directory still has contents. Run 'woco cleanup' to clean up.");
    }

    console.log("Wave complete.");
  }
}

// ---------------------------------------------------------------------------
// Interactive Wave Launch
//
// Audit (wave-detach-audit): Interactive agents run inside tmux sessions.
// Unlike headless agents, they are NOT child processes of the wombo parent —
// they survive parent death, SIGINT, and crashes naturally. No explicit
// cleanup is needed when the parent exits. The `launchInteractive()` function
// in launcher.ts returns `process: null as any` (no ChildProcess handle).
// ---------------------------------------------------------------------------

async function launchWaveInteractive(
  projectRoot: string,
  state: WaveState,
  features: Feature[],
  opts: LaunchCommandOptions,
  agentResolutions?: Map<string, AgentResolution>,
  questContext?: QuestPromptContext,
  hitlMode?: string
): Promise<void> {
  const { config, model } = opts;
  const fmt = opts.outputFmt ?? "text";
  const featureMap = new Map(features.map((f) => [f.id, f]));

  // Show dashboard immediately
  if (fmt === "text") printDashboard(state);

  // Ensure tmux is available
  ensureTmux();

  // ── Interactive Monitor ──────────────────────────────────────────────
  // Detects when agents finish (PID exit or TUI idle) and cleans up
  // their tmux sessions automatically.

  const imon = new InteractiveMonitor({
    onComplete: (featureId) => {
      updateAgent(state, featureId, {
        status: "completed",
        completed_at: new Date().toISOString(),
        activity: "done (session cleaned up)",
      });
      saveState(projectRoot, state);
      if (fmt === "text") {
        console.log(`\n  [completed] ${featureId} — session cleaned up`);
      }

      // Run build verification (fire-and-forget, no ProcessMonitor needed)
      const agent = state.agents.find((a) => a.feature_id === featureId)!;
      const feature = featureMap.get(featureId);
      if (feature) {
        handleBuildVerification(projectRoot, state, agent, feature, config, model, undefined, undefined, hitlMode)
          .catch((err) => wtLog(featureId, `BUILD VERIFICATION ERROR: ${err.message}`));
      }
    },
    onError: (featureId, reason) => {
      updateAgent(state, featureId, {
        status: "failed",
        error: reason,
        completed_at: new Date().toISOString(),
        activity: null,
      });
      saveState(projectRoot, state);
      if (fmt === "text") {
        console.log(`\n  [failed] ${featureId} — ${reason}`);
      }

      // Cascade failure to downstream agents
      const cancelled = cancelDownstream(state, featureId);
      if (cancelled.length > 0) {
        wtLog(featureId, `downstream cancelled: ${cancelled.join(", ")}`);
        saveState(projectRoot, state);
      }
    },
    onActivity: (featureId, activity) => {
      updateAgent(state, featureId, {
        activity: `tmux: ${activity}`,
        activity_updated_at: new Date().toISOString(),
      });
    },
  });

  // ── Launch agents ────────────────────────────────────────────────────

  // Launch initial batch — parallelize setup
  const tolaunch = queuedAgents(state).slice(0, opts.maxConcurrent || undefined);
  if (fmt === "text") console.log(`Setting up ${tolaunch.length} agent(s) in parallel...\n`);

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
          await createWorktree(projectRoot, agent.feature_id, agent.base_branch ?? state.base_branch, config);
          updateAgent(state, agent.feature_id, { activity: "installing deps..." });
          await installDeps(agent.worktree, agent.feature_id, config);
        }

        const prompt = generatePrompt(
          featureMap.get(agent.feature_id)!,
          agent.base_branch ?? state.base_branch,
          config,
          questContext,
          hitlMode as QuestHitlMode | undefined
        );

        // Write specialized agent to worktree if applicable
        const resolution = agentResolutions?.get(agent.feature_id);
        const agentName = agent.agent_name ?? undefined;
        if (resolution && isSpecializedAgent(resolution)) {
          try {
            const patchedContent = patchImportedAgent(resolution.rawContent, config, projectRoot, hitlMode as QuestHitlMode | undefined);
            writeAgentToWorktree(agent.worktree, resolution.name, patchedContent);
            wtLog(agent.feature_id, `wrote specialized agent: ${resolution.name}`);
          } catch (err: any) {
            wtLog(agent.feature_id, `WARN: failed to write specialized agent, using generalist: ${err.message}`);
          }
        } else if (hitlMode && hitlMode !== "yolo") {
          try {
            const hitlAwareContent = renderGeneralistAgent(config, projectRoot, hitlMode as QuestHitlMode);
            writeAgentToWorktree(agent.worktree, config.agent.name, hitlAwareContent);
            wtLog(agent.feature_id, `wrote HITL-aware generalist agent (${hitlMode})`);
          } catch (err: any) {
            wtLog(agent.feature_id, `WARN: failed to write HITL-aware agent, using default: ${err.message}`);
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

        const baseBranch = agent.base_branch ?? state.base_branch;

        updateAgent(state, agent.feature_id, {
          status: "running",
          pid: result.pid,
          activity: `tmux session active`,
        });
        saveState(projectRoot, state);
        wtLog(agent.feature_id, `tmux session: ${config.agent.tmuxPrefix}-${agent.feature_id}`);

        // Register with the interactive monitor for completion detection
        const iAgent: InteractiveAgent = {
          featureId: agent.feature_id,
          pid: result.pid,
          sessionName: `${config.agent.tmuxPrefix}-${agent.feature_id}`,
          worktree: agent.worktree,
          branch: agent.branch,
          baseBranch,
        };
        imon.addAgent(iAgent);
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

  if (fmt === "text") {
    console.log("\nInteractive sessions launched. Use these commands:");
    console.log(`  tmux attach-session -t ${config.agent.tmuxPrefix}-<feature-id>   # attach to a session`);
    console.log(`  tmux list-sessions                                      # list sessions`);
    console.log("  woco status                                             # check status");
    console.log("  Ctrl+C                                                  # detach (agents keep running)");
    console.log("");
    console.log("Monitoring for completion (sessions auto-cleanup when agents finish)...\n");
    printDashboard(state);
  }

  // ── Monitoring loop ──────────────────────────────────────────────────
  // Block and wait for all agents to finish, similar to the headless flow.
  // The InteractiveMonitor handles PID polling + pane-stability detection
  // and fires callbacks on completion/error. This loop provides periodic
  // status updates and handles graceful shutdown on Ctrl+C.

  imon.start();

  const POLL_INTERVAL = 10_000;
  let dashboardCounter = 0;

  // Handle Ctrl+C gracefully — detach monitoring but leave sessions alive
  let detached = false;
  const sigHandler = () => {
    if (detached) {
      // Second Ctrl+C — hard exit
      process.exit(1);
    }
    detached = true;
    imon.stop();
    if (fmt === "text") {
      console.log("\n\nDetached from monitoring. Agent sessions continue running.");
      console.log("Run 'woco status' to check progress, 'woco cleanup' to kill sessions.\n");
    }
  };
  process.on("SIGINT", sigHandler);

  try {
    while (!isWaveComplete(state) && !detached) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      if (detached) break;

      // Periodic dashboard update
      dashboardCounter++;
      if (dashboardCounter % 3 === 0 && fmt === "text") {
        printDashboard(state);
      }

      // Persist state periodically
      saveState(projectRoot, state);
    }
  } finally {
    process.removeListener("SIGINT", sigHandler);
    imon.stop();
  }

  if (detached) {
    flushState(projectRoot, state);
    return;
  }

  // ── Post-wave ────────────────────────────────────────────────────────

  if (fmt === "text") {
    console.log("\nAll agents finished.\n");
    printDashboard(state);
  }

  // Dump logs for failed agents
  dumpFailedAgentLogs(projectRoot, state, fmt);

  // Export wave history
  try {
    const historyPath = exportWaveHistory(projectRoot, state);
    if (fmt === "text") console.log(`Wave history exported to ${historyPath}`);
  } catch (err: any) {
    if (fmt === "text") console.error(`Warning: failed to export wave history: ${err.message}`);
  }

  // Auto-push base branch if requested
  if (opts.autoPush) {
    await pushBaseBranch(projectRoot, state.base_branch, config);
  }
}

// ---------------------------------------------------------------------------
// Main Command
// ---------------------------------------------------------------------------

export async function cmdLaunch(opts: LaunchCommandOptions): Promise<void> {
  const { projectRoot } = opts;
  let { config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (fmt === "text") console.log("\n--- wombo-combo: Launch ---\n");

  // Ensure agent definition exists — reinstall from template if missing
  ensureAgentDefinition(projectRoot, config, opts.agent);

  // -------------------------------------------------------------------------
  // Quest resolution — if --quest was specified, scope the wave to that quest
  // -------------------------------------------------------------------------
  let questContext: QuestPromptContext | undefined;
  let questId: string | null = opts.questId ?? null;

  if (questId) {
    const quest = loadQuest(projectRoot, questId);
    if (!quest) {
      outputError(fmt, `Quest "${questId}" not found. Use 'woco quest list' to see available quests.`);
      return; // unreachable
    }

    if (quest.status !== "active") {
      outputError(fmt, `Quest "${questId}" is in status "${quest.status}" — only active quests can be launched. Use 'woco quest activate ${questId}' first.`);
      return; // unreachable
    }

    // Ensure the quest branch exists (create from baseBranch if needed)
    if (!questBranchExists(projectRoot, questId)) {
      if (fmt === "text") console.log(`Creating quest branch "${quest.branch}" from "${quest.baseBranch}"...`);
      await createQuestBranch(projectRoot, questId, quest.baseBranch);
    } else {
      // Sync quest branch with baseBranch (merge main → quest branch)
      // This ensures task statuses and code changes are up-to-date
      if (fmt === "text") console.log(`Syncing quest branch "${quest.branch}" with "${quest.baseBranch}"...`);
      const syncResult = await syncQuestBranch(projectRoot, quest.branch, quest.baseBranch);
      if (syncResult.conflicting) {
        outputError(fmt, syncResult.error ?? `Merge conflicts syncing ${quest.baseBranch} into ${quest.branch}.`);
        return;
      }
      if (syncResult.error) {
        outputError(fmt, `Failed to sync quest branch: ${syncResult.error}`);
        return;
      }
      if (syncResult.synced && fmt === "text") {
        console.log(`  Quest branch synced with ${quest.baseBranch}.`);
      }
    }

    // Override baseBranch — task branches will fork from the quest branch
    opts.baseBranch = quest.branch;
    if (fmt === "text") {
      console.log(`Quest: ${quest.title} (${questId})`);
      console.log(`  Base branch overridden to: ${quest.branch}`);
    }

    // Apply quest config overrides (layered on top of project config)
    config = resolveQuestConfig(config, quest);

    // Build quest prompt context for agent prompts
    const knowledge = loadQuestKnowledge(projectRoot, questId);
    questContext = {
      questId: quest.id,
      goal: quest.goal,
      addedConstraints: quest.constraints.add ?? [],
      addedForbidden: quest.constraints.ban ?? [],
      knowledge,
    };

    if (fmt === "text") {
      const constraintCount = questContext.addedConstraints.length + questContext.addedForbidden.length;
      if (constraintCount > 0) {
        console.log(`  Quest constraints: ${questContext.addedConstraints.length} added, ${questContext.addedForbidden.length} banned`);
      }
      if (knowledge) {
        console.log(`  Quest knowledge: loaded (${knowledge.length} bytes)`);
      }
      console.log("");
    }
  }

  // Extract HITL mode from quest (defaults to undefined / yolo for non-quest waves)
  let hitlMode = questId ? loadQuest(projectRoot, questId)?.hitlMode : undefined;

  // Ensure portless proxy is running (if enabled) to prevent port collisions
  if (config.portless.enabled) {
    if (isPortlessAvailable(config)) {
      const proxyOk = ensureProxyRunning(config);
      if (!proxyOk && fmt === "text") {
        console.warn(
          "\x1b[33m[portless]\x1b[0m proxy could not be started — agents may encounter port collisions"
        );
      }
    } else if (fmt === "text") {
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
      if (fmt === "text") {
        console.log(`Existing wave found: ${existingState.wave_id}`);
        console.log(`  ${merged.length} merged, ${verified.length} verified, ${completed.length} completed, ${running.length} running, ${queued.length} queued, ${failed.length} failed`);
      }

      // Finalize any merged agents by marking their features as done
      const finalizedIds: string[] = [];
      if (merged.length > 0) {
        if (fmt === "text") console.log("\nFinalizing merged tasks in tasks file...");
        for (const agent of merged) {
          markFeatureDone(projectRoot, agent.feature_id, config, existingState.base_branch, fmt);
          finalizedIds.push(agent.feature_id);
          // Clean up worktree and branch (already merged, safe to delete)
          try {
            removeWorktree(projectRoot, agent.worktree, true);
            if (fmt === "text") console.log(`  ${agent.feature_id}: marked done, worktree removed`);
          } catch {
            if (fmt === "text") console.log(`  ${agent.feature_id}: marked done (worktree already cleaned)`);
          }
        }
      }

      // Strip finalized task IDs from explicit selection so we don't
      // try to re-launch tasks that were just marked done
      if (finalizedIds.length > 0 && opts.features?.length) {
        const finalizedSet = new Set(finalizedIds);
        opts.features = opts.features.filter((id) => !finalizedSet.has(id));
      }

      // Verified agents: build passed but NOT merged — do NOT mark done.
      // Leave them for 'woco resume' to attempt the merge.
      if (verified.length > 0) {
        for (const agent of verified) {
          if (fmt === "text") console.log(`  ${agent.feature_id}: verified (not yet merged) — use 'woco resume' to merge`);
        }
      }

      const activeCount = running.length + completed.length + queued.length;
      if (activeCount > 0) {
        outputError(fmt, `Wave ${existingState.wave_id} has ${activeCount} unfinished agent(s). Use 'woco resume' to continue the existing wave, or 'woco cleanup' to clear it before starting a new one.`);
      }

      // All agents are in terminal states (merged/verified/failed) — safe to start fresh
      if (fmt === "text") console.log("\nAll agents in previous wave are finished. Starting fresh wave.\n");
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
  let selected = selectFeatures(data, selOpts);

  if (selected.length === 0) {
    // Build a context-aware message based on which flags were passed
    const activeFilters: string[] = [];
    if (opts.allReady) activeFilters.push("--all-ready");
    if (opts.topPriority) activeFilters.push(`--top-priority ${opts.topPriority}`);
    if (opts.quickestWins) activeFilters.push(`--quickest-wins ${opts.quickestWins}`);
    if (opts.priority) activeFilters.push(`--priority ${opts.priority}`);
    if (opts.difficulty) activeFilters.push(`--difficulty ${opts.difficulty}`);
    if (opts.features?.length) activeFilters.push(`--tasks ${opts.features.join(",")}`);

    let msg: string;
    if (opts.allReady && activeFilters.length === 1) {
      msg = "No launchable tasks found (all tasks are done, cancelled, or have unmet dependencies).";
    } else if (activeFilters.length > 0) {
      msg = `No tasks matched the current filters: ${activeFilters.join(", ")}.`;
    } else {
      msg = "No launchable tasks found.";
    }

    // Throw instead of outputError so TUI callers can catch gracefully.
    // CLI callers catch this in the command handler (index.ts).
    throw new Error(msg);
  }

  // -------------------------------------------------------------------------
  // Auto-detect quest from selected tasks' quest field (if --quest not given)
  // -------------------------------------------------------------------------
  if (!questId) {
    const taskQuests = new Set(selected.map((f) => f.quest).filter(Boolean));
    if (taskQuests.size === 1) {
      const autoQuestId = [...taskQuests][0]!;
      const quest = loadQuest(projectRoot, autoQuestId);
      if (quest && quest.status === "active") {
        questId = autoQuestId;

        // Ensure the quest branch exists
        if (!questBranchExists(projectRoot, autoQuestId)) {
          if (fmt === "text") console.log(`Creating quest branch "${quest.branch}" from "${quest.baseBranch}"...`);
          await createQuestBranch(projectRoot, autoQuestId, quest.baseBranch);
        } else {
          // Sync quest branch with baseBranch
          if (fmt === "text") console.log(`Syncing quest branch "${quest.branch}" with "${quest.baseBranch}"...`);
          const syncResult = await syncQuestBranch(projectRoot, quest.branch, quest.baseBranch);
          if (syncResult.conflicting) {
            outputError(fmt, syncResult.error ?? `Merge conflicts syncing ${quest.baseBranch} into ${quest.branch}.`);
            return;
          }
          if (syncResult.error) {
            outputError(fmt, `Failed to sync quest branch: ${syncResult.error}`);
            return;
          }
          if (syncResult.synced && fmt === "text") {
            console.log(`  Quest branch synced with ${quest.baseBranch}.`);
          }
        }

        // Override baseBranch — task branches will fork from the quest branch
        opts.baseBranch = quest.branch;
        if (fmt === "text") {
          console.log(`Auto-detected quest: ${quest.title} (${autoQuestId})`);
          console.log(`  Base branch overridden to: ${quest.branch}`);
        }

        // Apply quest config overrides
        config = resolveQuestConfig(config, quest);

        // Build quest prompt context
        const knowledge = loadQuestKnowledge(projectRoot, autoQuestId);
        questContext = {
          questId: quest.id,
          goal: quest.goal,
          addedConstraints: quest.constraints.add ?? [],
          addedForbidden: quest.constraints.ban ?? [],
          knowledge,
        };

        hitlMode = quest.hitlMode;
      }
    } else if (taskQuests.size > 1) {
      outputError(
        fmt,
        `Selected tasks belong to multiple quests: ${[...taskQuests].join(", ")}. ` +
        `Launch tasks from a single quest at a time, or use --quest to scope the wave.`
      );
      return;
    }
  }

  // Apply quest constraints to selected tasks (add/ban layered on each task)
  if (questId && questContext) {
    const quest = loadQuest(projectRoot, questId)!;
    selected = selected.map((f) => applyQuestConstraintsToTask(f, quest));
  }

  // Show selection
  if (fmt === "text") {
    printFeatureSelection(
      selected.map((f) => ({
        id: f.id,
        title: f.title,
        priority: f.priority,
        difficulty: f.difficulty,
        effort: f.effort,
      }))
    );
  }

  // Check per-task agent definitions exist
  if (!opts.agent) {
    const taskAgents = new Set(
      selected.map((f) => f.agent).filter((a): a is string => !!a)
    );
    for (const agentName of taskAgents) {
      ensureAgentDefinition(projectRoot, config, agentName);
    }
  }

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
      outputError(fmt, `${err.message}\nFix dependency issues before launching.`);
    }

    // Build scheduling plan
    schedulePlan = buildSchedulePlan(depGraph);
    if (fmt === "text") console.log(`\n${formatSchedulePlan(schedulePlan)}\n`);
  }

  if (opts.dryRun) {
    const dryRunResult = {
      dry_run: true,
      base_branch: opts.baseBranch,
      max_concurrent: opts.maxConcurrent,
      model: opts.model ?? null,
      interactive: opts.interactive,
      selected: selected.map((f) => ({
        id: f.id,
        title: f.title,
        priority: f.priority,
        difficulty: f.difficulty,
        effort: f.effort,
      })),
      schedule_plan: schedulePlan ? {
        streams: schedulePlan.streams.map((s) => s.featureIds),
        merge_gates: schedulePlan.mergeGates.map((g) => ({
          feature_id: g.featureId,
          wait_for: g.waitFor,
        })),
        topological_order: schedulePlan.topologicalOrder,
      } : null,
    };

    output(fmt, dryRunResult, () => {
      console.log("Dry run — not launching agents.");
    }, () => {
      console.log(renderLaunchDryRun(dryRunResult));
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Agent registry: resolve specialized agents for tasks with agent_type
  // ---------------------------------------------------------------------------
  let agentResolutions: Map<string, AgentResolution> | undefined;

  if (config.agentRegistry.mode !== "disabled") {
    const tasksWithAgentType = selected.filter((t) => t.agent_type);
    if (tasksWithAgentType.length > 0) {
      if (fmt === "text") console.log(`\nResolving ${tasksWithAgentType.length} specialized agent(s) from registry...`);
      agentResolutions = await prepareAgentDefinitions(selected, config, projectRoot);

      const specialized = [...agentResolutions.values()].filter(isSpecializedAgent);
      const cached = specialized.filter((r) => r.fromCache);
      if (fmt === "text") {
        console.log(
          `  ${specialized.length} specialized (${cached.length} cached, ${specialized.length - cached.length} fetched), ` +
          `${selected.length - specialized.length} generalist`
        );
      }
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
      outputMessage(fmt, "Launch cancelled.");
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
    questId,
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
    const agent = createAgentState(feature.id, branch, wtPath, opts.baseBranch, opts.maxRetries);

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

    // Per-task local agent override: CLI --agent flag takes precedence,
    // then task-level `agent` field, then registry resolution (above).
    // This is for local agent definitions in .opencode/agents/<name>.md.
    const localAgent = opts.agent ?? feature.agent;
    if (localAgent && !agent.agent_name) {
      // Only set if not already resolved from the external registry
      agent.agent_name = localAgent;
    } else if (opts.agent) {
      // CLI --agent flag overrides even registry agents
      agent.agent_name = opts.agent;
    }

    state.agents.push(agent);
  }

  saveState(projectRoot, state);
  if (fmt === "text") console.log(`Wave ${state.wave_id} created with ${selected.length} agents.`);

  // Launch agents up to max_concurrent
  if (opts.interactive) {
    await launchWaveInteractive(projectRoot, state, selected, opts, agentResolutions, questContext, hitlMode);
  } else {
    await launchWaveHeadless(projectRoot, state, selected, opts, agentResolutions, questContext, hitlMode);
  }
}
