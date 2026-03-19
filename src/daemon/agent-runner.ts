/**
 * agent-runner.ts — Agent lifecycle management for the daemon.
 *
 * Wraps the existing launch, monitoring, verification, merge, and retry logic
 * from src/commands/launch.ts into a clean interface that the scheduler calls.
 *
 * Responsibilities:
 * - Accept task submissions and manage the full lifecycle:
 *   worktree creation → agent launch → monitoring → build verification → merge
 * - Process monitoring via ProcessMonitor
 * - Build verification and tiered merge conflict resolution
 * - Retry logic with session reuse
 * - Chain predecessor rescue on failure
 * - Merge serialization via enqueueMerge
 * - Dead process reaping
 */

import { execSync } from "node:child_process";
import type { WomboConfig, MaxEscalationTier } from "../config";
import type { Task, Feature, FeaturesFile } from "../lib/tasks";
import { loadFeatures, parseDurationMinutes } from "../lib/tasks";
import { saveTaskToStore } from "../lib/task-store";
import { createWorktree, installDeps, worktreePath, featureBranchName, removeWorktree } from "../lib/worktree";
import { launchHeadless, retryHeadless, launchConflictResolver, isProcessRunning } from "../lib/launcher";
import type { LaunchResult } from "../lib/launcher";
import { ProcessMonitor } from "../lib/monitor";
import type { MonitorCallbacks } from "../lib/monitor";
import {
  generatePrompt,
  generateConflictResolutionPrompt,
  generateTier4RerunPrompt,
  generateRebaseCommitPrompt,
  type QuestPromptContext,
  type ConflictResolutionContext,
} from "../lib/prompt";
import { runBuild, runFullVerification } from "../lib/verifier";
import {
  mergeBranch,
  mergeBaseIntoFeature,
  enqueueMerge,
  canMerge,
  tieredMergeBaseIntoFeature,
  startRebaseStrategy,
  beginRebase,
  getRebaseConflicts,
  continueRebase,
  abortRebase,
  cleanupRebaseBranch,
  finalizeRebase,
} from "../lib/merger";
import type { Tier25Result } from "../lib/conflict-hunks";
import { buildDepGraph, buildSchedulePlan } from "../lib/dependency-graph";
import { prepareAgentDefinitions, writeAgentToWorktree, isSpecializedAgent } from "../lib/agent-registry";
import { resolveQuestConfig, applyQuestConstraintsToTask, getQuestTaskIds } from "../lib/quest";
import { loadQuest, loadQuestKnowledge } from "../lib/quest-store";
import { patchImportedAgent } from "../lib/templates";
import type { QuestHitlMode } from "../lib/quest";
import type { DaemonState, InternalAgentState } from "./state";
import { createDaemonAgentState } from "./state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRunnerConfig {
  projectRoot: string;
  config: WomboConfig;
}

// ---------------------------------------------------------------------------
// Standalone helpers (pure functions, no class dependency)
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around exec for simple git commands in the escalation pipeline.
 * Returns { ok, output } without throwing.
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
 * Check if a given conflict resolution tier is allowed by the maxEscalation config.
 */
function isTierAllowed(tier: "tier3" | "tier3.5" | "tier4", maxEscalation: MaxEscalationTier): boolean {
  const tierOrder: MaxEscalationTier[] = ["tier3", "tier3.5", "tier4"];
  return tierOrder.indexOf(tier) <= tierOrder.indexOf(maxEscalation);
}

/**
 * Get git diffs for enriched conflict resolution context.
 */
async function getConflictDiffs(
  wtPath: string,
  baseBranch: string,
  remote: string
): Promise<{ featureDiff: string; upstreamDiff: string }> {
  const mergeBaseResult = await runSafeCmd(`git merge-base HEAD "${remote}/${baseBranch}"`, wtPath);
  const mergeBase = mergeBaseResult.ok ? mergeBaseResult.output.trim() : "";

  let featureDiff = "";
  let upstreamDiff = "";

  if (mergeBase) {
    const fdResult = await runSafeCmd(`git diff "${mergeBase}...HEAD" --stat -p`, wtPath);
    featureDiff = fdResult.ok ? fdResult.output : "";

    const udResult = await runSafeCmd(`git diff "${mergeBase}...${remote}/${baseBranch}" --stat -p`, wtPath);
    upstreamDiff = udResult.ok ? udResult.output : "";
  }

  return { featureDiff, upstreamDiff };
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

export class AgentRunner {
  private projectRoot: string;
  private config: WomboConfig;
  private state: DaemonState;
  private monitor: ProcessMonitor;

  /** Stagger delay between launches to avoid SQLite races (ms). */
  private static readonly LAUNCH_STAGGER_MS = 800;

  /** Queue for staggered launches. */
  private launchQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;

  constructor(opts: AgentRunnerConfig, state: DaemonState) {
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.state = state;

    // Create monitor with daemon-integrated callbacks
    this.monitor = new ProcessMonitor(this.projectRoot, this.buildCallbacks());
  }

  // -------------------------------------------------------------------------
  // Monitor callbacks
  // -------------------------------------------------------------------------

  private buildCallbacks(): MonitorCallbacks {
    return {
      onSessionId: (featureId, sessionId) => {
        this.state.updateAgent(featureId, { sessionId });
      },

      onComplete: (featureId) => {
        this.state.updateAgentStatus(featureId, "completed", "Agent process exited cleanly");

        // Fire-and-forget build verification → merge pipeline
        this.handleBuildVerification(featureId).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.state.updateAgentStatus(featureId, "failed", `Verification error: ${msg}`);
          this.state.updateAgent(featureId, { error: msg });
          this.rescueChainPredecessors(featureId);
        });
      },

      onError: (featureId, error) => {
        const agent = this.state.getAgent(featureId);
        if (!agent) return;

        if (agent.retries < agent.maxRetries) {
          // Retry
          this.state.updateAgent(featureId, {
            retries: agent.retries + 1,
            error,
          });
          this.state.updateAgentStatus(
            featureId,
            "retry",
            `Retry ${agent.retries + 1}/${agent.maxRetries}: ${error}`
          );
          this.handleRetry(featureId);
        } else {
          // Final failure
          this.state.updateAgentStatus(featureId, "failed", error);
          this.state.updateAgent(featureId, { error });
          this.state.cancelDownstream(featureId);
          this.rescueChainPredecessors(featureId);
        }
      },

      onActivity: (featureId, activity) => {
        this.state.updateAgentActivity(featureId, activity);
      },

      onOutput: (featureId, data) => {
        this.state.emit("evt:agent-output", { featureId, data });
      },

      onQuestion: (featureId, questionText) => {
        const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const agent = this.state.getAgent(featureId);
        if (agent) {
          agent.pendingQuestions.push({
            questionId,
            questionText,
            askedAt: new Date().toISOString(),
          });
          this.state.emit("evt:hitl-question", {
            featureId,
            questionId,
            questionText,
          });
        }
      },

      onUsage: (featureId, record) => {
        const agent = this.state.getAgent(featureId);
        if (agent) {
          if (!agent.tokenUsage) {
            agent.tokenUsage = { inputTokens: 0, outputTokens: 0, totalCost: 0 };
          }
          agent.tokenUsage.inputTokens += record.input_tokens ?? 0;
          agent.tokenUsage.outputTokens += record.output_tokens ?? 0;
          this.state.emit("evt:token-usage", {
            featureId,
            inputTokens: agent.tokenUsage.inputTokens,
            outputTokens: agent.tokenUsage.outputTokens,
            totalTokens: agent.tokenUsage.inputTokens + agent.tokenUsage.outputTokens,
          });
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Task submission (called by Scheduler)
  // -------------------------------------------------------------------------

  /** Submit a new task for execution. Creates agent state, worktree, and launches. */
  submitTask(task: Task): void {
    const config = this.config;
    const branch = featureBranchName(task.id, config);
    const wt = worktreePath(this.projectRoot, task.id, config);
    const baseBranch = this.resolveBaseBranch(task);

    const agentState = createDaemonAgentState({
      featureId: task.id,
      taskTitle: task.title,
      branch,
      baseBranch,
      worktree: wt,
      maxRetries: config.defaults.maxRetries,
      dependsOn: task.depends_on,
      dependedOnBy: this.findDependents(task.id),
      agentName: task.agent ?? null,
      agentType: task.agent_type ?? null,
      effortEstimateMs: parseDurationMinutes(task.effort) * 60_000,
    });

    this.state.addAgent(agentState);

    // Queue the launch (staggered to avoid SQLite races)
    this.enqueueLaunch(() => this.doLaunch(task.id, task));
  }

  /** Launch a queued agent that's already in state (used for dependency-unblocked agents). */
  launchAgent(featureId: string): void {
    const agent = this.state.getAgent(featureId);
    if (!agent || agent.status !== "queued") return;

    // Load the task from disk
    const task = this.loadTask(featureId);
    if (!task) {
      this.state.updateAgentStatus(featureId, "failed", "Task not found on disk");
      return;
    }

    this.enqueueLaunch(() => this.doLaunch(featureId, task));
  }

  // -------------------------------------------------------------------------
  // Launch pipeline
  // -------------------------------------------------------------------------

  /** Actually launch an agent: worktree → install → prompt → spawn. */
  private async doLaunch(featureId: string, task: Task): Promise<void> {
    const agent = this.state.getAgent(featureId);
    if (!agent) return;

    try {
      this.state.updateAgentStatus(featureId, "installing", "Creating worktree");

      // Create worktree
      const wt = await createWorktree(
        this.projectRoot,
        featureId,
        agent.baseBranch,
        this.config
      );
      this.state.updateAgent(featureId, { worktree: wt });

      // Install dependencies
      this.state.updateAgentActivity(featureId, "Installing dependencies...");
      await installDeps(wt, featureId, this.config);

      // Resolve quest context if applicable
      let questContext: any = undefined;
      let hitlMode: string | undefined = undefined;
      if (task.quest) {
        const quest = loadQuest(this.projectRoot, task.quest);
        if (quest) {
          const resolvedTask = applyQuestConstraintsToTask(task, quest);
          Object.assign(task, resolvedTask);
          hitlMode = quest.hitlMode;
        }
      }

      // Write agent definition if using a specialized agent
      if (agent.agentName) {
        try {
          const agentDefs = await prepareAgentDefinitions(
            [task],
            this.config,
            this.projectRoot
          );
          const resolution = agentDefs.get(task.id);
          if (resolution && isSpecializedAgent(resolution)) {
            const patchedContent = patchImportedAgent(
              resolution.rawContent,
              this.config,
              this.projectRoot,
              hitlMode as QuestHitlMode | undefined
            );
            writeAgentToWorktree(wt, resolution.name, patchedContent);
          }
        } catch {
          // Non-fatal: fall back to generalist
        }
      }

      // Generate prompt
      const prompt = generatePrompt(
        task as Feature,
        agent.baseBranch,
        this.config,
        questContext,
        hitlMode as any
      );

      // Launch the agent process
      this.state.updateAgentStatus(featureId, "running", "Agent spawned");

      const result: LaunchResult = launchHeadless({
        worktreePath: wt,
        featureId,
        prompt,
        model: this.state.getModel() ?? undefined,
        config: this.config,
        agentName: agent.agentName ?? undefined,
        hitlMode,
        projectRoot: this.projectRoot,
      });

      this.state.updateAgent(featureId, {
        pid: result.pid,
        sessionId: result.sessionId ?? null,
        startedAt: new Date().toISOString(),
      });

      // Register with monitor
      this.monitor.addProcess(featureId, result.process);

      this.state.emit("evt:task-picked", {
        taskId: featureId,
        queuePosition: 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.updateAgentStatus(featureId, "failed", `Launch error: ${msg}`);
      this.state.updateAgent(featureId, { error: msg });
    }
  }

  // -------------------------------------------------------------------------
  // Build verification
  // -------------------------------------------------------------------------

  private async handleBuildVerification(featureId: string): Promise<void> {
    const agent = this.state.getAgent(featureId);
    if (!agent) return;

    this.state.updateAgentActivity(featureId, "Running build verification...");

    try {
      const result = await runFullVerification(agent.worktree, featureId, this.config);

      if (result.overallPassed) {
        agent.buildPassed = true;
        agent.buildOutput = result.combinedErrorSummary || null;
        this.state.updateAgentStatus(featureId, "verified", "Build passed");

        this.state.emit("evt:build-result", {
          featureId,
          passed: true,
          output: result.combinedErrorSummary || undefined,
        });

        // Attempt merge
        await this.attemptMerge(featureId);
      } else {
        // Build failed
        agent.buildPassed = false;
        agent.buildOutput = result.combinedErrorSummary || null;

        this.state.emit("evt:build-result", {
          featureId,
          passed: false,
          output: result.combinedErrorSummary || undefined,
        });

        if (agent.retries < agent.maxRetries) {
          // Retry with build error context
          this.state.updateAgent(featureId, {
            retries: agent.retries + 1,
            error: `Build failed: ${(result.combinedErrorSummary ?? "").slice(0, 500)}`,
          });
          this.state.updateAgentStatus(
            featureId,
            "retry",
            `Build failed, retry ${agent.retries + 1}/${agent.maxRetries}`
          );
          this.handleRetry(featureId);
        } else {
          this.state.updateAgentStatus(featureId, "failed", "Build failed, retries exhausted");
          this.state.updateAgent(featureId, {
            error: `Build failed: ${(result.combinedErrorSummary ?? "").slice(0, 500)}`,
          });
          this.state.cancelDownstream(featureId);
          this.rescueChainPredecessors(featureId);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.updateAgentStatus(featureId, "failed", `Verification error: ${msg}`);
      this.state.updateAgent(featureId, { error: msg });
      this.rescueChainPredecessors(featureId);
    }
  }

  // -------------------------------------------------------------------------
  // Merge
  // -------------------------------------------------------------------------

  private async attemptMerge(featureId: string): Promise<void> {
    const agent = this.state.getAgent(featureId);
    if (!agent) return;

    await enqueueMerge(async () => {
      this.state.updateAgentActivity(featureId, "Merging...");

      try {
        // Pre-flight check
        const mergeCheck = await canMerge(
          this.projectRoot,
          agent.branch,
          agent.baseBranch
        );

        if (!mergeCheck.canMerge) {
          // Merge conflicts detected — enter tiered resolution
          this.state.updateAgentStatus(
            featureId,
            "resolving_conflict",
            "Merge conflicts detected"
          );

          const feature = this.loadTask(featureId);
          if (!feature) {
            this.state.updateAgentStatus(featureId, "failed", "Task not found for conflict resolution");
            return;
          }

          await this.handleMergeConflict(
            featureId,
            feature,
            mergeCheck.reason ?? "merge conflicts"
          );
          return;
        }

        const mergeResult = await mergeBranch(
          this.projectRoot,
          agent.branch,
          agent.baseBranch,
          this.config
        );

        if (mergeResult.success) {
          this.handleMergeSuccess(featureId, mergeResult.commitHash, "MERGED");
        } else {
          // Direct merge failed unexpectedly (canMerge said OK but merge failed)
          const feature = this.loadTask(featureId);
          if (feature) {
            await this.handleMergeConflict(
              featureId,
              feature,
              mergeResult.error ?? "merge failed"
            );
          } else {
            this.state.updateAgentStatus(featureId, "failed", `Merge error: ${mergeResult.error}`);
            this.state.updateAgent(featureId, { error: mergeResult.error ?? "merge failed" });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.state.updateAgentStatus(featureId, "failed", `Merge error: ${msg}`);
        this.state.updateAgent(featureId, { error: msg });
        this.state.emit("evt:merge-result", {
          featureId,
          success: false,
          error: msg,
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Merge success
  // -------------------------------------------------------------------------

  /**
   * Handle a successful merge: mark merged, promote chain predecessors,
   * mark tasks done, clean up worktrees and branches.
   */
  private handleMergeSuccess(
    featureId: string,
    commitHash: string | null,
    label: string
  ): void {
    const agent = this.state.getAgent(featureId);
    if (!agent) return;

    this.state.updateAgentStatus(featureId, "merged", `${label} (${commitHash?.slice(0, 7)})`);
    this.state.updateAgent(featureId, { completedAt: new Date().toISOString() });
    this.state.emit("evt:merge-result", { featureId, success: true });

    // Mark the task as done on disk
    this.markFeatureDone(featureId, agent.baseBranch);

    // Walk back the chain and mark all deferred predecessors as merged.
    // Their work was carried forward through branch continuity and is now
    // included in the terminal merge — no separate merge needed.
    const chainPredecessors = this.getChainPredecessors(agent);
    for (const predAgent of chainPredecessors) {
      if (predAgent.status === "verified") {
        this.state.updateAgentStatus(
          predAgent.featureId,
          "merged",
          `MERGED (via chain terminal ${featureId})`
        );
        this.state.updateAgent(predAgent.featureId, {
          completedAt: new Date().toISOString(),
        });
        this.markFeatureDone(predAgent.featureId, predAgent.baseBranch, true);

        // Clean up predecessor branch — its commits are now reachable via
        // the terminal branch's merge into base.
        try {
          execSync(`git branch -D "${predAgent.branch}"`, {
            cwd: this.projectRoot,
            stdio: "pipe",
          });
        } catch {
          // Branch may already be gone
        }
      }
    }

    // Clean up worktree — but preserve it if downstream agents in the same
    // chain share this worktree.
    const hasChainSuccessor = agent.dependedOnBy.some((depId) => {
      const depAgent = this.state.getAgent(depId);
      return depAgent && depAgent.worktree === agent.worktree;
    });

    if (!hasChainSuccessor) {
      try {
        removeWorktree(this.projectRoot, agent.worktree, true);
      } catch {
        // Stale worktrees waste disk space but aren't fatal
      }
    }
  }

  /**
   * Mark a task as "done" on disk. Optionally skips git ancestry check
   * (used when we already know the merge succeeded and the branch ref may
   * have been deleted).
   */
  private markFeatureDone(
    featureId: string,
    baseBranch: string,
    skipAncestryCheck = false
  ): void {
    try {
      if (!skipAncestryCheck) {
        const branch = featureBranchName(featureId, this.config);

        // Check if the branch ref even exists before testing ancestry.
        let branchExists = true;
        try {
          execSync(`git rev-parse --verify "${branch}"`, {
            cwd: this.projectRoot,
            stdio: "pipe",
          });
        } catch {
          branchExists = false;
        }

        if (branchExists) {
          try {
            execSync(
              `git merge-base --is-ancestor "${branch}" "${baseBranch}"`,
              { cwd: this.projectRoot, stdio: "pipe" }
            );
          } catch {
            // Not an ancestor — refuse to mark as done
            return;
          }
        }
        // Branch ref is gone — can't verify ancestry, but the branch was
        // likely already cleaned up after merge, so proceed.
      }

      const data = loadFeatures(this.projectRoot, this.config);
      const feature = data.tasks.find((f: Feature) => f.id === featureId);
      if (feature && feature.status !== "done") {
        feature.status = "done";
        feature.completion = 100;
        feature.ended_at = new Date().toISOString();
        saveTaskToStore(this.projectRoot, this.config, feature);
      }
    } catch {
      // Non-fatal — don't crash the pipeline
    }
  }

  // -------------------------------------------------------------------------
  // Merge conflict resolution (tiered escalation)
  // -------------------------------------------------------------------------

  /**
   * Handle a merge conflict: use tiered merge strategy.
   *
   * Tier 1/2/2.5: Handled by tieredMergeBaseIntoFeature (auto-resolve)
   * Tier 3: Enriched single-shot LLM resolve
   * Tier 3.5: Rebase strategy with per-commit LLM resolution
   * Tier 4: Nuclear re-run (re-implement from scratch)
   */
  private async handleMergeConflict(
    featureId: string,
    task: Task,
    mergeError: string
  ): Promise<void> {
    const agent = this.state.getAgent(featureId);
    if (!agent) return;

    const baseBranch = agent.baseBranch;

    try {
      // Tiered merge: attempts tier 1 (clean merge), tier 2 (trivial auto-resolve),
      // and tier 2.5 (surgical per-hunk resolution)
      const tieredResult = await tieredMergeBaseIntoFeature(
        agent.worktree,
        baseBranch,
        this.config
      );

      if (tieredResult.success && (tieredResult.tier === 1 || tieredResult.tier === 2 || tieredResult.tier === 2.5)) {
        // Tier 1, 2, or 2.5 resolved the conflicts — retry merge into base
        const tierLabel = tieredResult.tier === 1
          ? "base merged cleanly into feature"
          : tieredResult.tier === 2
          ? "trivial conflicts auto-resolved (whitespace only)"
          : `tier 2.5 surgical resolution (${tieredResult.tier25Result?.resolvedHunkCount ?? 0}/${tieredResult.tier25Result?.totalHunks ?? 0} hunks)`;

        this.state.updateAgentActivity(featureId, `${tierLabel} — retrying merge...`);
        const retryMerge = await mergeBranch(this.projectRoot, agent.branch, baseBranch, this.config);
        if (retryMerge.success) {
          const successLabel = tieredResult.tier === 1
            ? "MERGED after rebase"
            : tieredResult.tier === 2
            ? "MERGED after trivial auto-resolve"
            : "MERGED after tier 2.5 surgical resolution";
          this.handleMergeSuccess(featureId, retryMerge.commitHash, successLabel);
          return;
        }

        // Retry still failed — escalate to tier 3+
        this.state.updateAgentActivity(featureId, `retry merge still failed after tier ${tieredResult.tier} — escalating...`);
        mergeError = retryMerge.error ?? mergeError;

        // Re-merge base into feature to get fresh conflict state for escalation
        const freshConflict = await mergeBaseIntoFeature(
          agent.worktree,
          baseBranch,
          this.config
        );
        const conflictFiles = freshConflict.conflicting ? freshConflict.files : [];

        await this.escalatingConflictResolution(
          featureId, task, mergeError, conflictFiles, tieredResult.tier25Result ?? null
        );
        return;
      }

      if (tieredResult.tier === null && tieredResult.error) {
        // Setup itself failed — stay as "verified" (retryable) with error
        this.state.updateAgentStatus(featureId, "verified", "Conflict setup failed");
        this.state.updateAgent(featureId, {
          error: `Conflict setup failed: ${tieredResult.error}`,
        });
        return;
      }

      // Tier 3+: Real conflicts remain after tiers 1, 2, 2.5
      this.state.updateAgentActivity(
        featureId,
        `${tieredResult.conflictFiles.length} non-trivial conflict(s) — escalating...`
      );

      await this.escalatingConflictResolution(
        featureId, task, mergeError,
        tieredResult.conflictFiles, tieredResult.tier25Result ?? null
      );
    } catch (conflictErr: any) {
      // Unexpected error during conflict handling — stay "verified" with error
      const msg = conflictErr instanceof Error ? conflictErr.message : String(conflictErr);
      this.state.updateAgentStatus(featureId, "verified", "Conflict resolution error");
      this.state.updateAgent(featureId, {
        error: `Conflict resolution error: ${msg}`,
      });
    }
  }

  /**
   * Escalating conflict resolution pipeline (Tiers 3 → 3.5 → 4).
   * Runs through tiers, stopping at the first success or when maxEscalation is reached.
   */
  private async escalatingConflictResolution(
    featureId: string,
    task: Task,
    mergeError: string,
    conflictFiles: string[],
    tier25Result: Tier25Result | null
  ): Promise<void> {
    const agent = this.state.getAgent(featureId);
    if (!agent) return;

    const maxEscalation = this.config.merge.maxEscalation;
    const model = this.state.getModel() ?? undefined;

    // ── Tier 3: Enriched single-shot LLM resolve ──────────────────────
    if (isTierAllowed("tier3", maxEscalation)) {
      this.state.updateAgentActivity(featureId, "tier 3: launching enriched LLM conflict resolver...");

      const tier3Result = await this.runTier3(
        featureId, task, model, mergeError, conflictFiles, tier25Result
      );

      if (tier3Result === "merged") return;
      if (tier3Result === "build-failed" || tier3Result === "merge-failed") {
        this.state.updateAgentActivity(featureId, `tier 3 failed (${tier3Result}) — checking escalation options...`);
      }
    }

    // ── Tier 3.5: Rebase strategy ─────────────────────────────────────
    if (isTierAllowed("tier3.5", maxEscalation)) {
      this.state.updateAgentActivity(featureId, "tier 3.5: attempting rebase strategy...");

      // Abort any in-progress merge to start fresh for rebase
      await runSafeCmd("git merge --abort", agent.worktree);

      const tier35Result = await this.runTier35(featureId, task, model);

      if (tier35Result === "merged") return;
      if (tier35Result === "failed") {
        this.state.updateAgentActivity(featureId, "tier 3.5 rebase strategy failed — checking escalation options...");
      }
    }

    // ── Tier 4: Nuclear re-run ────────────────────────────────────────
    if (isTierAllowed("tier4", maxEscalation)) {
      this.state.updateAgentActivity(featureId, "tier 4: nuclear re-run — re-implementing feature from scratch...");

      const tier4Result = await this.runTier4(featureId, task, model);

      if (tier4Result === "merged") return;
      this.state.updateAgentActivity(featureId, "tier 4 nuclear re-run failed");
    }

    // ── All tiers exhausted ───────────────────────────────────────────
    this.state.updateAgentStatus(
      featureId,
      "failed",
      `All conflict resolution tiers exhausted (max: ${maxEscalation})`
    );
    this.state.updateAgent(featureId, {
      error: `All conflict resolution tiers exhausted (max escalation: ${maxEscalation})`,
      completedAt: new Date().toISOString(),
    });
    this.state.cancelDownstream(featureId);
  }

  /**
   * Tier 3: Enriched single-shot LLM resolve.
   * ONE attempt with structured hunks, contextual diffs, and feature description.
   */
  private async runTier3(
    featureId: string,
    task: Task,
    model: string | undefined,
    mergeError: string,
    conflictFiles: string[],
    tier25Result: Tier25Result | null
  ): Promise<"merged" | "build-failed" | "merge-failed"> {
    const agent = this.state.getAgent(featureId);
    if (!agent) return "merge-failed";

    const baseBranch = agent.baseBranch;

    // Gather contextual diffs
    const diffs = await getConflictDiffs(agent.worktree, baseBranch, this.config.git.remote);

    const conflictContext: ConflictResolutionContext = {
      tier25Result: tier25Result ?? undefined,
      featureDiff: diffs.featureDiff || undefined,
      upstreamDiff: diffs.upstreamDiff || undefined,
    };

    const questContext = this.buildQuestContext();

    const conflictPrompt = generateConflictResolutionPrompt(
      task as Feature, baseBranch, mergeError, this.config,
      questContext,
      conflictContext
    );

    this.state.updateAgentStatus(featureId, "resolving_conflict",
      `tier 3: resolving ${conflictFiles.length} conflict(s)...`
    );

    const resolverResult = launchConflictResolver({
      worktreePath: agent.worktree,
      featureId: agent.featureId,
      prompt: conflictPrompt,
      model,
      config: this.config,
    });

    this.state.updateAgent(featureId, { pid: resolverResult.pid });

    // Wait for resolver to complete
    const resolverExitCode = await new Promise<number | null>((resolve) => {
      resolverResult.process.on("exit", (code) => resolve(code));
      resolverResult.process.on("error", () => resolve(null));
    });

    this.state.updateAgentActivity(featureId, `tier 3 resolver exited (code ${resolverExitCode}) — re-verifying build...`);

    // Re-verify build
    const rebuildResult = await runBuild(agent.worktree, this.config);
    if (!rebuildResult.passed) {
      this.state.updateAgentActivity(featureId, "tier 3 POST-CONFLICT BUILD FAILED");
      return "build-failed";
    }

    // Retry merge into base
    this.state.updateAgentActivity(featureId, "tier 3 build passed — retrying merge...");
    const retryMerge = await mergeBranch(this.projectRoot, agent.branch, baseBranch, this.config);
    if (retryMerge.success) {
      this.handleMergeSuccess(featureId, retryMerge.commitHash, "MERGED after tier 3 enriched resolution");
      return "merged";
    }

    this.state.updateAgentActivity(featureId, `tier 3 POST-CONFLICT MERGE FAILED: ${retryMerge.error?.slice(0, 100)}`);
    return "merge-failed";
  }

  /**
   * Tier 3.5: Rebase strategy — replay commits one-at-a-time on a throwaway branch.
   */
  private async runTier35(
    featureId: string,
    task: Task,
    model: string | undefined
  ): Promise<"merged" | "failed"> {
    const agent = this.state.getAgent(featureId);
    if (!agent) return "failed";

    const baseBranch = agent.baseBranch;
    const featureBranch = agent.branch;

    // Start the rebase on a throwaway branch
    const rebaseSetup = await startRebaseStrategy(
      agent.worktree, featureBranch, baseBranch, agent.featureId, this.config
    );

    if (rebaseSetup.error) {
      this.state.updateAgentActivity(featureId, `tier 3.5 setup failed: ${rebaseSetup.error.slice(0, 100)}`);
      return "failed";
    }

    const { tempBranch, commitsToReplay } = rebaseSetup;
    this.state.updateAgentActivity(featureId, `tier 3.5: rebasing ${commitsToReplay.length} commit(s) on ${tempBranch}...`);

    // Start the rebase
    const rebaseResult = await beginRebase(agent.worktree, baseBranch, this.config);

    if (rebaseResult.clean) {
      // Rebase completed cleanly — finalize
      this.state.updateAgentActivity(featureId, "tier 3.5: rebase completed cleanly!");
      const finalizeResult = await finalizeRebase(agent.worktree, tempBranch, featureBranch);
      if (!finalizeResult.success) {
        this.state.updateAgentActivity(featureId, `tier 3.5 finalize failed: ${finalizeResult.error?.slice(0, 100)}`);
        await cleanupRebaseBranch(agent.worktree, tempBranch, featureBranch);
        return "failed";
      }

      // Retry merge into base
      const retryMerge = await mergeBranch(this.projectRoot, featureBranch, baseBranch, this.config);
      if (retryMerge.success) {
        this.handleMergeSuccess(featureId, retryMerge.commitHash, "MERGED after tier 3.5 rebase");
        return "merged";
      }
      this.state.updateAgentActivity(featureId, `tier 3.5 merge after rebase failed: ${retryMerge.error?.slice(0, 100)}`);
      return "failed";
    }

    if (rebaseResult.error) {
      this.state.updateAgentActivity(featureId, `tier 3.5 rebase error: ${rebaseResult.error.slice(0, 100)}`);
      await abortRebase(agent.worktree);
      await cleanupRebaseBranch(agent.worktree, tempBranch, featureBranch);
      return "failed";
    }

    // Rebase paused at a conflict — handle per-commit resolution
    let commitIndex = 0;
    const maxCommits = commitsToReplay.length;

    while (true) {
      const conflicts = await getRebaseConflicts(agent.worktree);
      if (conflicts.length === 0) break; // No more conflicts

      commitIndex++;
      const currentCommit = commitsToReplay[Math.min(commitIndex - 1, maxCommits - 1)];
      this.state.updateAgentActivity(
        featureId,
        `tier 3.5: resolving conflict in commit ${commitIndex}/${maxCommits}: ${currentCommit?.message?.slice(0, 50) ?? "unknown"}...`
      );

      // Launch a per-commit resolver
      const commitPrompt = generateRebaseCommitPrompt(
        task as Feature,
        currentCommit?.message ?? "unknown",
        currentCommit?.hash ?? "unknown",
        conflicts,
        maxCommits,
        commitIndex,
        this.config
      );

      const resolverResult = launchConflictResolver({
        worktreePath: agent.worktree,
        featureId: agent.featureId,
        prompt: commitPrompt,
        model,
        config: this.config,
      });

      this.state.updateAgent(featureId, { pid: resolverResult.pid });

      // Wait for resolver
      const exitCode = await new Promise<number | null>((resolve) => {
        resolverResult.process.on("exit", (code) => resolve(code));
        resolverResult.process.on("error", () => resolve(null));
      });

      this.state.updateAgentActivity(featureId, `tier 3.5 commit resolver exited (code ${exitCode})`);

      // Check if conflicts are resolved
      const remainingConflicts = await getRebaseConflicts(agent.worktree);
      if (remainingConflicts.length > 0) {
        // Resolver didn't fully resolve — abort the whole rebase
        this.state.updateAgentActivity(featureId, `tier 3.5: resolver failed to resolve commit ${commitIndex} — aborting rebase`);
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
        this.state.updateAgentActivity(featureId, `tier 3.5 continue error: ${continueResult.error.slice(0, 100)}`);
        await abortRebase(agent.worktree);
        await cleanupRebaseBranch(agent.worktree, tempBranch, featureBranch);
        return "failed";
      }
      // If not clean, loop back to handle the next conflict
    }

    // Rebase completed — finalize
    this.state.updateAgentActivity(featureId, `tier 3.5: rebase completed after resolving ${commitIndex} conflict(s)`);

    const finalizeResult = await finalizeRebase(agent.worktree, tempBranch, featureBranch);
    if (!finalizeResult.success) {
      this.state.updateAgentActivity(featureId, `tier 3.5 finalize failed: ${finalizeResult.error?.slice(0, 100)}`);
      await cleanupRebaseBranch(agent.worktree, tempBranch, featureBranch);
      return "failed";
    }

    // Verify build after rebase
    const rebuildResult = await runBuild(agent.worktree, this.config);
    if (!rebuildResult.passed) {
      this.state.updateAgentActivity(featureId, "tier 3.5 POST-REBASE BUILD FAILED");
      return "failed";
    }

    // Retry merge into base
    const retryMerge = await mergeBranch(this.projectRoot, featureBranch, baseBranch, this.config);
    if (retryMerge.success) {
      this.handleMergeSuccess(featureId, retryMerge.commitHash, "MERGED after tier 3.5 rebase");
      return "merged";
    }

    this.state.updateAgentActivity(featureId, `tier 3.5 merge after rebase failed: ${retryMerge.error?.slice(0, 100)}`);
    return "failed";
  }

  /**
   * Tier 4: Nuclear re-run — re-implement the feature from scratch.
   * Creates a fresh worktree state from the current base branch and re-launches.
   */
  private async runTier4(
    featureId: string,
    task: Task,
    model: string | undefined
  ): Promise<"merged" | "failed"> {
    const agent = this.state.getAgent(featureId);
    if (!agent) return "failed";

    const baseBranch = agent.baseBranch;

    // Get the feature's diff (what it changed vs the merge base)
    const diffResult = await runSafeCmd(
      `git log --format="" -p "${this.config.git.remote}/${baseBranch}..${agent.branch}"`,
      agent.worktree
    );
    const featureDiff = diffResult.ok ? diffResult.output : "(diff unavailable)";

    // Abort any in-progress merge/rebase
    await runSafeCmd("git merge --abort", agent.worktree);
    await runSafeCmd("git rebase --abort", agent.worktree);

    // Reset the worktree to a clean state on the base branch
    await runSafeCmd(`git fetch ${this.config.git.remote} "${baseBranch}"`, agent.worktree);
    const resetResult = await runSafeCmd(`git reset --hard "${this.config.git.remote}/${baseBranch}"`, agent.worktree);
    if (!resetResult.ok) {
      this.state.updateAgentActivity(featureId, `tier 4: failed to reset worktree to base: ${resetResult.output.slice(0, 100)}`);
      return "failed";
    }

    this.state.updateAgentActivity(featureId, "tier 4: re-implementing feature from scratch...");

    // Generate the tier 4 prompt
    const questContext = this.buildQuestContext();
    const rerunPrompt = generateTier4RerunPrompt(
      task as Feature, baseBranch, featureDiff, this.config,
      questContext
    );

    // Launch the agent
    const resolverResult = launchConflictResolver({
      worktreePath: agent.worktree,
      featureId: agent.featureId,
      prompt: rerunPrompt,
      model,
      config: this.config,
    });

    this.state.updateAgent(featureId, { pid: resolverResult.pid });

    // Wait for completion
    const exitCode = await new Promise<number | null>((resolve) => {
      resolverResult.process.on("exit", (code) => resolve(code));
      resolverResult.process.on("error", () => resolve(null));
    });

    this.state.updateAgentActivity(featureId, `tier 4 agent exited (code ${exitCode}) — verifying build...`);

    // Verify build
    const rebuildResult = await runBuild(agent.worktree, this.config);
    if (!rebuildResult.passed) {
      this.state.updateAgentActivity(featureId, "tier 4 BUILD FAILED");
      return "failed";
    }

    // Commit if the agent didn't already
    await runSafeCmd("git add -A", agent.worktree);
    await runSafeCmd(
      `git diff --cached --quiet || git commit -m "feat(${agent.featureId}): re-implement ${task.title} (tier 4)"`,
      agent.worktree
    );

    // Merge into base
    this.state.updateAgentActivity(featureId, "tier 4 build passed — merging into base...");
    const retryMerge = await mergeBranch(this.projectRoot, agent.branch, baseBranch, this.config);
    if (retryMerge.success) {
      this.handleMergeSuccess(featureId, retryMerge.commitHash, "MERGED after tier 4 nuclear re-run");
      return "merged";
    }

    this.state.updateAgentActivity(featureId, `tier 4 MERGE FAILED: ${retryMerge.error?.slice(0, 100)}`);
    return "failed";
  }

  /**
   * Build quest context for conflict resolution prompts.
   */
  private buildQuestContext(): QuestPromptContext | undefined {
    const questId = this.state.getQuestId();
    if (!questId) return undefined;

    const quest = loadQuest(this.projectRoot, questId);
    if (!quest) return undefined;

    const knowledge = loadQuestKnowledge(this.projectRoot, questId);
    return {
      questId: quest.id,
      goal: quest.goal,
      addedConstraints: quest.constraints.add ?? [],
      addedForbidden: quest.constraints.ban ?? [],
      knowledge,
    };
  }

  // -------------------------------------------------------------------------
  // Retry
  // -------------------------------------------------------------------------

  private handleRetry(featureId: string): void {
    const agent = this.state.getAgent(featureId);
    if (!agent) return;

    if (!agent.sessionId) {
      // No session — queue for fresh launch
      this.state.updateAgentStatus(featureId, "queued", "No session, re-queuing");
      return;
    }

    try {
      const result = retryHeadless({
        worktreePath: agent.worktree,
        featureId,
        sessionId: agent.sessionId,
        buildErrors: agent.error ?? "Previous attempt failed",
        model: this.state.getModel() ?? undefined,
        config: this.config,
      });

      this.state.updateAgent(featureId, { pid: result.pid });
      this.state.updateAgentStatus(featureId, "running", "Retry launched");
      this.monitor.addProcess(featureId, result.process);
    } catch {
      // Retry launch failed — queue for fresh launch
      this.state.updateAgentStatus(featureId, "queued", "Retry launch failed, re-queuing");
    }
  }

  // -------------------------------------------------------------------------
  // Chain predecessor helpers
  // -------------------------------------------------------------------------

  /**
   * Walk back through chain predecessors (agents sharing the same worktree
   * via depends_on links). Returns predecessors in reverse order (immediate
   * predecessor first, chain root last).
   */
  private getChainPredecessors(agent: InternalAgentState): InternalAgentState[] {
    const predecessors: InternalAgentState[] = [];
    let current: InternalAgentState | undefined = agent;

    while (current && current.dependsOn.length > 0) {
      const predId = current.dependsOn[0]; // Follow first dependency
      const pred = this.state.getAgent(predId);
      if (!pred || pred.worktree !== agent.worktree) break;
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
  private rescueChainPredecessors(failedFeatureId: string): void {
    const agent = this.state.getAgent(failedFeatureId);
    if (!agent) return;

    const predecessors = this.getChainPredecessors(agent);
    const verifiedPred = predecessors.find((p) => p.status === "verified");
    if (verifiedPred) {
      // Attempt merge of the verified predecessor
      this.attemptMerge(verifiedPred.featureId).catch(() => {
        // If rescue merge fails too, nothing more we can do
      });
    }
  }

  // -------------------------------------------------------------------------
  // Process management
  // -------------------------------------------------------------------------

  /** Kill a specific agent's process. */
  cancelAgent(featureId: string): void {
    this.monitor.remove(featureId);
  }

  /** Kill all running agents. */
  async killAll(): Promise<void> {
    this.monitor.killAll();
    // Wait for processes to actually die
    await this.monitor.waitAll(500);
  }

  /** Detect dead agent processes and handle them. */
  reapDeadProcesses(): void {
    for (const agent of this.state.getAgentsByStatus("running", "installing")) {
      if (agent.pid && !isProcessRunning(agent.pid)) {
        this.state.emit("evt:log", { level: "warn", message: `Agent ${agent.featureId} PID ${agent.pid} is dead — reaping` });
        // Reset task back to "planned" so scheduler picks it up again
        this.resetTaskToPlanned(agent.featureId);
        // Clean up worktree if present
        if (agent.worktree) {
          try { removeWorktree(this.projectRoot, agent.worktree); } catch { /* best-effort */ }
        }
        // Remove from daemon state entirely (scheduler will re-submit from disk)
        this.state.removeAgent(agent.featureId);
      }
    }

    // Safety net: agents stuck in "retry" with no process
    for (const agent of this.state.getAgentsByStatus("retry")) {
      if (!agent.pid || !isProcessRunning(agent.pid)) {
        if (agent.retries >= agent.maxRetries) {
          this.resetTaskToPlanned(agent.featureId);
          if (agent.worktree) {
            try { removeWorktree(this.projectRoot, agent.worktree); } catch { /* best-effort */ }
          }
          this.state.removeAgent(agent.featureId);
        } else {
          this.state.updateAgentStatus(agent.featureId, "queued", "Re-queuing stuck retry");
        }
      }
    }
  }

  /** Reset a task file back to "planned" so the scheduler picks it up again. */
  private resetTaskToPlanned(featureId: string): void {
    try {
      const data = loadFeatures(this.projectRoot, this.config);
      const task = data.tasks.find((t) => t.id === featureId);
      if (task && task.status !== "done" && task.status !== "cancelled") {
        task.status = "planned";
        task.started_at = null;
        saveTaskToStore(this.projectRoot, this.config, task);
      }
    } catch { /* best-effort */ }
  }

  // -------------------------------------------------------------------------
  // Staggered launch queue
  // -------------------------------------------------------------------------

  private enqueueLaunch(fn: () => Promise<void>): void {
    this.launchQueue.push(fn);
    if (!this.isProcessingQueue) {
      this.processLaunchQueue();
    }
  }

  private async processLaunchQueue(): Promise<void> {
    this.isProcessingQueue = true;
    while (this.launchQueue.length > 0) {
      const fn = this.launchQueue.shift()!;
      try {
        await fn();
      } catch {
        // Individual launch errors are handled inside doLaunch
      }
      // Stagger between launches
      if (this.launchQueue.length > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, AgentRunner.LAUNCH_STAGGER_MS)
        );
      }
    }
    this.isProcessingQueue = false;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Resolve the base branch for a task (quest branch or project base). */
  private resolveBaseBranch(task: Task): string {
    if (task.quest) {
      // Quest tasks fork from the quest branch
      return `quest/${task.quest}`;
    }
    return this.state.getBaseBranch();
  }

  /** Find task IDs that depend on the given task. */
  private findDependents(taskId: string): string[] {
    try {
      const data = loadFeatures(this.projectRoot, this.config);
      return data.tasks
        .filter((t) => t.depends_on.includes(taskId))
        .map((t) => t.id);
    } catch {
      return [];
    }
  }

  /** Load a single task by ID from disk. */
  private loadTask(featureId: string): Task | null {
    try {
      const data = loadFeatures(this.projectRoot, this.config);
      return data.tasks.find((t) => t.id === featureId) ?? null;
    } catch {
      return null;
    }
  }

  /** Destroy: clean up resources. */
  destroy(): void {
    this.monitor.killAll();
    this.launchQueue = [];
  }
}
