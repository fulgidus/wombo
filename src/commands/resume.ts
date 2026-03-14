/**
 * resume.ts — Resume a previously stopped wave.
 *
 * Usage: woco resume [options] [--output json]
 *
 * Restores from .wombo-combo/state.json:
 *   - Agents in "running"/"installing" whose PID is dead → re-check or re-launch
 *   - Agents in "queued" → launch them
 *   - Agents in terminal states (verified/failed/merged) → leave alone
 *
 * ## Agent Recovery (audit: wave-detach-audit)
 *
 * This is the primary recovery mechanism for agents that died when the parent
 * process was terminated (gracefully via SIGINT, or ungracefully via SIGKILL/crash).
 *
 * Recovery triage for each agent:
 *   - PID still alive → leave it running (another wombo instance may still be active)
 *   - PID dead + worktree has commits → run build verification on existing work
 *   - PID dead + no commits → reset to "queued" for a fresh re-launch
 *   - "completed" → verify build
 *   - "verified" → attempt merge
 *   - "failed" with retries remaining + worktree has commits → re-verify
 *   - "failed" with retries remaining + no commits → re-launch
 *   - "failed" with retries exhausted → leave alone (user can `woco retry`)
 *
 * This design means no agent work is permanently lost unless the worktree
 * itself is destroyed (e.g., by `woco cleanup`).
 */

import type { WomboConfig } from "../config.js";
import type { Feature } from "../lib/tasks.js";
import { loadFeatures } from "../lib/tasks.js";
import {
  loadState,
  saveState,
  flushState,
  updateAgent,
  queuedAgents,
  readyToLaunchAgents,
  cancelDownstream,
  isWaveComplete,
  type WaveState,
  type AgentState,
} from "../lib/state.js";
import {
  createWorktree,
  installDeps,
  worktreeReady,
  worktreeExists,
  branchHasChanges,
  removeWorktree,
  log as wtLog,
} from "../lib/worktree.js";
import { generatePrompt, type QuestPromptContext } from "../lib/prompt.js";
import {
  launchInteractive,
  isProcessRunning,
  getMultiplexerName,
} from "../lib/launcher.js";
import { ProcessMonitor } from "../lib/monitor.js";
import { pushBaseBranch } from "../lib/merger.js";
import { runBuild } from "../lib/verifier.js";
import { printDashboard, printAgentUpdate } from "../lib/ui.js";
import { WomboTUI } from "../lib/tui.js";
import {
  launchSingleHeadless,
  handleBuildVerification,
  handleRetry,
  launchNextQueued,
  launchAllReady,
  markFeatureDone,
  attemptMerge,
  dumpFailedAgentLogs,
} from "./launch.js";
import {
  detectMultiplexer,
  muxAttachCommand,
} from "../lib/multiplexer.js";
import { exportWaveHistory } from "../lib/history.js";
import { outputError, outputMessage, type OutputFormat } from "../lib/output.js";
import {
  prepareAgentDefinitions,
  isSpecializedAgent,
  type AgentResolution,
} from "../lib/agent-registry.js";
import { patchImportedAgent } from "../lib/templates.js";
import { writeAgentToWorktree } from "../lib/agent-registry.js";
import { loadQuest, loadQuestKnowledge } from "../lib/quest-store.js";
import { resolveQuestConfig, type QuestHitlMode } from "../lib/quest.js";
import { getPendingQuestions, cleanupAll as cleanupHitl, submitAnswer, type HitlQuestion } from "../lib/hitl-channel.js";

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
  outputFmt?: OutputFormat;
  /**
   * When true, pressing Q in the monitor detaches (returns to caller) instead
   * of killing agents and exiting. Used by cmdTui so the user can switch
   * between the monitor and task browser while agents keep running.
   */
  detachOnQuit?: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdResume(opts: ResumeCommandOptions): Promise<void> {
  const { projectRoot } = opts;
  let { config } = opts;
  const fmt = opts.outputFmt ?? "text";

  const state = loadState(projectRoot);
  if (!state) {
    outputError(fmt, "No wave state found. Use 'woco launch' to start a new wave.");
    return; // unreachable — outputError calls process.exit
  }

  if (fmt === "text") {
    console.log(`\n--- wombo-combo: Resume ${state.wave_id} ---\n`);
  }

  // Reconstruct quest context from wave state (if quest-scoped)
  let questContext: QuestPromptContext | undefined;
  let hitlMode: string | undefined;
  if (state.quest_id) {
    const quest = loadQuest(projectRoot, state.quest_id);
    if (quest) {
      config = resolveQuestConfig(config, quest);
      hitlMode = quest.hitlMode;
      const knowledge = loadQuestKnowledge(projectRoot, state.quest_id);
      questContext = {
        questId: quest.id,
        goal: quest.goal,
        addedConstraints: quest.constraints.add ?? [],
        addedForbidden: quest.constraints.ban ?? [],
        knowledge,
      };
      if (fmt === "text") {
        console.log(`Quest: ${quest.title} (${quest.id})\n`);
      }
    } else if (fmt === "text") {
      console.warn(`Warning: wave references quest "${state.quest_id}" but it was not found.\n`);
    }
  }

  // Load feature data for prompt generation
  const data = loadFeatures(projectRoot, config);
  const featureMap = new Map(data.tasks.map((f: Feature) => [f.id, f]));

  // Triage agents by current state
  let toRelaunch: AgentState[] = [];
  let toVerify: AgentState[] = [];
  let stillAlive: AgentState[] = [];

  for (const agent of state.agents) {
    switch (agent.status) {
      case "running":
      case "installing":
      case "retry":
      case "resolving_conflict":
        // Was in-flight when we stopped — check if PID is still alive
        if (agent.pid && isProcessRunning(agent.pid)) {
          if (fmt === "text") console.log(`  ${agent.feature_id}: still running (PID ${agent.pid})`);
          stillAlive.push(agent);
        } else {
          // Process is dead — check if worktree exists with meaningful changes.
          // Use worktreeExists (not worktreeReady) because node_modules may be
          // missing — the worktree still has code that should be verified.
          if (worktreeExists(agent.worktree) && branchHasChanges(projectRoot, agent.branch, state.base_branch)) {
            // Worktree exists AND branch has commits — try build verification
            if (fmt === "text") console.log(`  ${agent.feature_id}: process dead, worktree has changes — will verify build`);
            toVerify.push(agent);
          } else {
            // No worktree, or worktree exists but branch has no commits (agent did nothing)
            const reason = worktreeExists(agent.worktree)
              ? "worktree exists but no code changes"
              : "no worktree";
            if (fmt === "text") console.log(`  ${agent.feature_id}: process dead, ${reason} — will re-launch`);
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
        if (fmt === "text") console.log(`  ${agent.feature_id}: queued — will launch`);
        toRelaunch.push(agent);
        break;

      case "completed":
        // Completed but not verified — verify
        if (fmt === "text") console.log(`  ${agent.feature_id}: completed — will verify build`);
        toVerify.push(agent);
        break;

      case "verified":
        // Build passed but NOT yet merged — need to attempt merge (+ conflict resolution)
        if (fmt === "text") console.log(`  ${agent.feature_id}: verified — will attempt merge`);
        toVerify.push(agent);
        break;

      case "merged":
        if (fmt === "text") console.log(`  ${agent.feature_id}: merged — marking feature as done`);
        markFeatureDone(projectRoot, agent.feature_id, config, state.base_branch, fmt);
        try {
          removeWorktree(projectRoot, agent.worktree, true);
          if (fmt === "text") console.log(`  ${agent.feature_id}: worktree and branch removed`);
        } catch {
          // Already cleaned — not critical
        }
        break;

      case "failed":
        // If the worktree exists with code changes and retries remain,
        // attempt build verification rather than discarding the work.
        if (agent.retries < agent.max_retries &&
            worktreeExists(agent.worktree) &&
            branchHasChanges(projectRoot, agent.branch, state.base_branch)) {
          if (fmt === "text") console.log(`  ${agent.feature_id}: failed but has work (retry ${agent.retries}/${agent.max_retries}) — will verify build`);
          // Clear stale error and mark as completed so handleBuildVerification
          // processes it correctly (it expects a non-failed agent)
          updateAgent(state, agent.feature_id, {
            status: "completed",
            error: null,
            build_passed: null,
            build_output: null,
            completed_at: new Date().toISOString(),
          });
          toVerify.push(agent);
        } else if (agent.retries < agent.max_retries) {
          // No worktree or no changes — re-launch from scratch
          if (fmt === "text") console.log(`  ${agent.feature_id}: failed, no salvageable work (retry ${agent.retries}/${agent.max_retries}) — will re-launch`);
          updateAgent(state, agent.feature_id, {
            status: "queued",
            pid: null,
            error: null,
            build_passed: null,
            build_output: null,
            activity: null,
            session_id: null,
            completed_at: null,
          });
          toRelaunch.push(agent);
        } else {
          if (fmt === "text") console.log(`  ${agent.feature_id}: failed — max retries reached (use 'woco retry' to reset)`);
        }
        break;
    }
  }

  saveState(projectRoot, state);

  // ---------------------------------------------------------------------------
  // Phase 1: Parallel build verification
  // Each agent's worktree is independent, so dep install + build can run
  // concurrently. Merges must remain sequential (they mutate the project root).
  // ---------------------------------------------------------------------------
  if (toVerify.length > 0) {
    if (fmt === "text") console.log(`\nVerifying ${toVerify.length} agent(s) in parallel...\n`);

    const verifyResults = await Promise.all(
      toVerify.map(async (agent): Promise<{ agent: AgentState; needsMerge: boolean }> => {
        const feature = featureMap.get(agent.feature_id);
        if (!feature) return { agent, needsMerge: false };

        // Already verified — skip build, go straight to merge
        if (agent.status === "verified") {
          printAgentUpdate(agent, "already verified — queued for merge");
          return { agent, needsMerge: true };
        }

        printAgentUpdate(agent, "verifying build...");

        // Ensure deps are installed — worktree may exist without node_modules
        // (e.g., failed agents whose setup was interrupted)
        if (!worktreeReady(agent.worktree) && worktreeExists(agent.worktree)) {
          try {
            printAgentUpdate(agent, "installing deps...");
            await installDeps(agent.worktree, agent.feature_id, config);
          } catch (depErr: any) {
            printAgentUpdate(agent, `dep install failed: ${depErr.message}`);
            updateAgent(state, agent.feature_id, {
              status: "failed",
              error: `Dependency install failed: ${depErr.message}`,
              retries: agent.retries + 1,
              completed_at: new Date().toISOString(),
            });
            saveState(projectRoot, state);
            return { agent, needsMerge: false };
          }
        }

        try {
          const buildResult = await runBuild(agent.worktree, config);
          if (buildResult.passed) {
            updateAgent(state, agent.feature_id, {
              status: "verified",
              build_passed: true,
              build_output: null,
            });
            saveState(projectRoot, state);
            printAgentUpdate(agent, `BUILD PASSED (${Math.round(buildResult.durationMs / 1000)}s)`);
            return { agent, needsMerge: true };
          } else {
            // Build failed
            if (agent.retries < agent.max_retries) {
              updateAgent(state, agent.feature_id, {
                status: "retry",
                retries: agent.retries + 1,
                build_passed: false,
                build_output: buildResult.errorSummary,
              });
              saveState(projectRoot, state);
              printAgentUpdate(agent, `BUILD FAILED — will retry (${agent.retries + 1}/${agent.max_retries})`);
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
            return { agent, needsMerge: false };
          }
        } catch (err: any) {
          printAgentUpdate(agent, `verify error: ${err.message}`);
          updateAgent(state, agent.feature_id, {
            status: "failed",
            error: `Build verification error: ${err.message}`,
            completed_at: new Date().toISOString(),
          });
          saveState(projectRoot, state);
          return { agent, needsMerge: false };
        }
      })
    );

    saveState(projectRoot, state);

    // -------------------------------------------------------------------------
    // Phase 2: Sequential merge for verified agents
    // Merges must be sequential because they operate on the project root.
    // -------------------------------------------------------------------------
    const toMerge = verifyResults.filter((r) => r.needsMerge);
    if (toMerge.length > 0) {
      if (fmt === "text") console.log(`\nMerging ${toMerge.length} verified agent(s)...\n`);
      for (const { agent } of toMerge) {
        const feature = featureMap.get(agent.feature_id);
        if (!feature) continue;
        try {
          await attemptMerge(projectRoot, state, agent, feature, config, opts.model);
        } catch (err: any) {
          printAgentUpdate(agent, `merge error: ${err.message}`);
        }
      }
    }

    // Collect agents that need re-launching from verify results
    for (const { agent } of verifyResults) {
      if (agent.status === "retry" || agent.status === "running") {
        toRelaunch.push(agent);
      }
    }
  }

  // Re-launch agents
  const maxConcurrent = opts.maxConcurrent ?? state.max_concurrent;
  const toLaunchNow = toRelaunch.slice(0, maxConcurrent);
  if (toLaunchNow.length === 0 && stillAlive.length === 0) {
    outputMessage(fmt, "No agents need (re)launching.", {
      wave_id: state.wave_id,
      triage: {
        to_verify: toVerify.length,
        to_relaunch: 0,
      },
      agents: state.agents.map((a) => ({
        feature_id: a.feature_id,
        status: a.status,
        build_passed: a.build_passed,
        error: a.error,
      })),
    });
    if (fmt === "text") printDashboard(state);
    return;
  }

  // ---------------------------------------------------------------------------
  // Re-resolve specialized agents for relaunched tasks that have agent_type
  // ---------------------------------------------------------------------------
  let agentResolutions: Map<string, AgentResolution> | undefined;

  if (config.agentRegistry.mode !== "disabled") {
    const agentsWithType = toLaunchNow.filter((a) => a.agent_type);
    if (agentsWithType.length > 0) {
      // Build feature list for tasks being relaunched
      const featuresToResolve = agentsWithType
        .map((a) => featureMap.get(a.feature_id))
        .filter((f): f is Feature => !!f);
      if (featuresToResolve.length > 0) {
        if (fmt === "text") console.log(`\nRe-resolving ${featuresToResolve.length} specialized agent(s) from registry...`);
        try {
          agentResolutions = await prepareAgentDefinitions(featuresToResolve, config, projectRoot);
        } catch (err: any) {
          if (fmt === "text") console.log(`  WARN: agent resolution failed, using cached agent names: ${err.message}`);
        }
      }
    }
  }

  if (fmt === "text") {
    const parts: string[] = [];
    if (toLaunchNow.length > 0) parts.push(`re-launching ${toLaunchNow.length}`);
    if (stillAlive.length > 0) parts.push(`reconnecting ${stillAlive.length}`);
    console.log(`\n${parts.join(", ")} agent(s)...\n`);
    printDashboard(state);
  }
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

          // Write specialized agent to worktree if applicable
          const resolution = agentResolutions?.get(agent.feature_id);
          const agentName = agent.agent_name ?? undefined;
          if (resolution && isSpecializedAgent(resolution)) {
            try {
              const patchedContent = patchImportedAgent(resolution.rawContent, config, projectRoot);
              writeAgentToWorktree(agent.worktree, resolution.name, patchedContent);
              wtLog(agent.feature_id, `wrote specialized agent: ${resolution.name}`);
            } catch (err: any) {
              wtLog(agent.feature_id, `WARN: failed to write specialized agent: ${err.message}`);
            }
          }

          const prompt = generatePrompt(feature, state.base_branch, config, questContext, hitlMode as QuestHitlMode | undefined);
          const result = launchInteractive({
            worktreePath: agent.worktree,
            featureId: feature.id,
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

    if (fmt === "text") {
      printDashboard(state);
      const mux = detectMultiplexer(config.agent.multiplexer);
      console.log(`\nResume complete. Use '${muxAttachCommand(mux, `${config.agent.tmuxPrefix}-<id>`)}' to check sessions.`);
    }
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
        handleBuildVerification(projectRoot, state, agent, feature, config, model, monitor, undefined, hitlMode)
          .then(() => launchAllReady(projectRoot, state, featureMap, monitor, config, model, undefined, questContext, hitlMode))
          .catch((err) => {
            wtLog(featureId, `BUILD VERIFICATION UNHANDLED ERROR: ${err.message}`);
            launchAllReady(projectRoot, state, featureMap, monitor, config, model, undefined, questContext, hitlMode);
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
          handleRetry(projectRoot, state, agent, monitor, config, model, hitlMode);
        } else {
          updateAgent(state, featureId, {
            status: "failed",
            error,
            activity: null,
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
        launchAllReady(projectRoot, state, featureMap, monitor, config, model, undefined, questContext, hitlMode);
      },
      onActivity: (featureId, activity) => {
        updateAgent(state, featureId, {
          activity,
          activity_updated_at: new Date().toISOString(),
        });
      },
    });

    // Handle graceful shutdown
    // Audit (wave-detach-audit): Same pattern as launch.ts — see launch.ts
    // SIGINT handler for detailed lifecycle documentation. Agents are
    // non-detached children; killAll() gives them SIGTERM before exit.
    let detached = false;
    const tuiRef = { current: null as WomboTUI | null };
    const gracefulShutdown = (signal: string) => {
      if (tuiRef.current) tuiRef.current.stop();
      for (const agent of state.agents) {
        if (agent.status === "running" || agent.status === "resolving_conflict") {
          updateAgent(state, agent.feature_id, {
            activity: "interrupted",
          });
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

    // Reconnect to agents that are still alive — register them in the monitor
    // so the TUI shows their activity and the polling loop detects their death.
    for (const agent of stillAlive) {
      monitor.reconnectProcess(agent.feature_id, agent.pid!, agent.session_id);
      if (fmt === "text") console.log(`  ${agent.feature_id}: reconnected to PID ${agent.pid}`);
    }

    await Promise.all(
      toLaunchNow.map((agent) => {
        const feature = featureMap.get(agent.feature_id);
        if (!feature) return Promise.resolve();
        return launchSingleHeadless(projectRoot, state, agent, feature, monitor, config, model, agentResolutions, questContext, hitlMode);
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
    } else {
      if (fmt === "text") console.log("(--no-tui mode, dashboard prints every 15s)\n");
      printDashboard(state);
    }

    // Monitoring loop
    const POLL_INTERVAL = 5000;
    let dashboardCounter = 0;
    while (!isWaveComplete(state) && !detached) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));

      for (const agent of state.agents) {
        if (
          (agent.status === "running" || agent.status === "resolving_conflict") &&
          agent.pid &&
          !isProcessRunning(agent.pid) &&
          !monitor.isRunning(agent.feature_id)
        ) {
          if (agent.status === "resolving_conflict") {
            // Conflict resolver died unexpectedly — mark as failed
            updateAgent(state, agent.feature_id, {
              status: "failed",
              error: "Conflict resolver process died unexpectedly",
              activity: null,
              completed_at: new Date().toISOString(),
            });
            saveState(projectRoot, state);
            wtLog(agent.feature_id, "conflict resolver died — marked failed");

            // Cascade failure to downstream agents
            const cancelled = cancelDownstream(state, agent.feature_id);
            if (cancelled.length > 0) {
              wtLog(agent.feature_id, `downstream cancelled: ${cancelled.join(", ")}`);
              saveState(projectRoot, state);
            }

            launchAllReady(projectRoot, state, featureMap, monitor, config, model, undefined, questContext, hitlMode);
            continue;
          }
          // Check if the agent actually made any commits
          if (!branchHasChanges(projectRoot, agent.branch, state.base_branch)) {
            // Agent died without producing any code — mark as failed
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
            const feature = featureMap.get(agent.feature_id)!;
            try {
              await handleBuildVerification(projectRoot, state, agent, feature, config, model, monitor, undefined, hitlMode);
            } catch (err: any) {
              wtLog(agent.feature_id, `POLL VERIFY ERROR: ${err.message}`);
            }
          }
          launchAllReady(projectRoot, state, featureMap, monitor, config, model, undefined, questContext, hitlMode);
        }
      }

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

      if (tuiRef.current) {
        tuiRef.current.updateState(state);
      } else if (opts.noTui) {
        dashboardCounter++;
        if (dashboardCounter % 3 === 0) {
          printDashboard(state);
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
      await tuiRef.current.waitForQuit();
    }

    if (fmt === "text") {
      printDashboard(state);

      // Dump full logs for failed agents (post-mortem)
      dumpFailedAgentLogs(projectRoot, state, fmt);
    }

    // Clean up HITL files
    try {
      cleanupHitl(projectRoot);
    } catch {
      // Non-fatal
    }

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

    if (fmt === "text") console.log("Wave complete.");
  }
}
