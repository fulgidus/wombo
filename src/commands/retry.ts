/**
 * retry.ts — Retry a specific failed agent.
 *
 * Usage: woco retry <feature-id> [--interactive] [--model <model>] [--output json]
 *
 * Resets the agent's retry count and re-launches it. Can launch in either
 * headless mode (default) or interactive (dmux/tmux) mode.
 */

import type { WomboConfig } from "../config.js";
import { loadFeatures, type Feature } from "../lib/tasks.js";
import {
  loadState,
  saveState,
  updateAgent,
} from "../lib/state.js";
import { worktreeReady } from "../lib/worktree.js";
import { generatePrompt } from "../lib/prompt.js";
import { launchInteractive, getMultiplexerName } from "../lib/launcher.js";
import { ProcessMonitor } from "../lib/monitor.js";
import { launchSingleHeadless } from "./launch.js";
import { output, outputError, outputMessage, type OutputFormat } from "../lib/output.js";
import { renderRetry } from "../lib/toon.js";
import {
  resolveAgentForTask,
  isSpecializedAgent,
  writeAgentToWorktree,
  type AgentResolution,
} from "../lib/agent-registry.js";
import { patchImportedAgent } from "../lib/templates.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId: string;
  model?: string;
  interactive: boolean;
  dryRun?: boolean;
  outputFmt?: OutputFormat;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdRetry(opts: RetryCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.featureId) {
    outputError(fmt, "Usage: woco retry <feature-id>");
    return; // unreachable — outputError calls process.exit
  }

  const state = loadState(projectRoot);
  if (!state) {
    outputMessage(fmt, "No active wave.", { wave_id: null });
    return;
  }

  const agent = state.agents.find((a) => a.feature_id === opts.featureId);
  if (!agent) {
    outputError(fmt, `Agent not found for feature: ${opts.featureId}`);
    return; // unreachable
  }

  if (agent.status !== "failed") {
    outputError(
      fmt,
      `Agent ${opts.featureId} is not in failed state (current: ${agent.status})`
    );
    return; // unreachable
  }

  // Dry-run: show what would be retried without doing it
  if (opts.dryRun) {
    const dryRunResult = {
      dry_run: true,
      feature_id: opts.featureId,
      current_status: agent.status,
      retries_so_far: agent.retries,
      worktree: agent.worktree,
      mode: opts.interactive ? "interactive" : "headless",
      model: opts.model ?? null,
    };

    output(fmt, dryRunResult, () => {
      console.log(`\n[dry-run] Would retry agent: ${opts.featureId}`);
      console.log(`  Current status: ${agent.status}`);
      console.log(`  Retries so far: ${agent.retries}`);
      console.log(`  Worktree: ${agent.worktree}`);
      console.log(`  Mode: ${opts.interactive ? "interactive (multiplexer)" : "headless"}`);
      if (opts.model) console.log(`  Model: ${opts.model}`);
    }, () => {
      console.log(renderRetry(dryRunResult));
    });
    return;
  }

  // Reset retry count and re-run
  updateAgent(state, agent.feature_id, {
    status: "queued",
    retries: 0,
    error: null,
    build_passed: null,
    build_output: null,
    completed_at: null,
  });
  saveState(projectRoot, state);

  const data = loadFeatures(projectRoot, config);
  const feature = data.tasks.find((f: Feature) => f.id === opts.featureId);
  if (!feature) {
    outputError(fmt, `Feature ${opts.featureId} not found in ${config.tasksDir}`);
    return; // unreachable
  }

  // Re-resolve specialized agent from registry if agent_type was set
  let agentResolution: AgentResolution | undefined;
  const agentName = agent.agent_name ?? undefined;

  if (agent.agent_type && config.agentRegistry.mode !== "disabled") {
    try {
      const resolution = await resolveAgentForTask(feature, config, projectRoot);
      if (isSpecializedAgent(resolution)) {
        agentResolution = resolution;
      }
    } catch (err: any) {
      if (fmt === "text") console.log(`  WARN: agent resolution failed for ${opts.featureId}, using cached agent name: ${err.message}`);
    }
  }

  if (opts.interactive) {
    // Write specialized agent to worktree if applicable
    if (agentResolution && isSpecializedAgent(agentResolution)) {
      try {
        const patchedContent = patchImportedAgent(agentResolution.rawContent, config, projectRoot);
        writeAgentToWorktree(agent.worktree, agentResolution.name, patchedContent);
      } catch {
        // Non-fatal — agent will fall back to default
      }
    }

    const prompt = generatePrompt(feature, state.base_branch, config);
    launchInteractive({
      worktreePath: agent.worktree,
      featureId: feature.id,
      prompt,
      model: opts.model,
      interactive: true,
      config,
      agentName,
    });

    updateAgent(state, agent.feature_id, {
      status: "running",
      started_at: new Date().toISOString(),
    });
    saveState(projectRoot, state);
    const muxName = getMultiplexerName(config);

    output(fmt, {
      feature_id: opts.featureId,
      mode: "interactive",
      status: "running",
      mux_session: `${config.agent.tmuxPrefix}-${opts.featureId}`,
    }, () => {
      console.log(`Retrying ${opts.featureId} in ${muxName} session ${config.agent.tmuxPrefix}-${opts.featureId}`);
    }, () => {
      console.log(renderRetry({
        feature_id: opts.featureId,
        mode: "interactive",
        status: "running",
        mux_session: `${config.agent.tmuxPrefix}-${opts.featureId}`,
      }));
    });
  } else {
    // Build agent resolutions map for launchSingleHeadless
    let agentResolutions: Map<string, AgentResolution> | undefined;
    if (agentResolution) {
      agentResolutions = new Map([[opts.featureId, agentResolution]]);
    }

    const monitor = new ProcessMonitor(projectRoot);
    await launchSingleHeadless(projectRoot, state, agent, feature, monitor, config, opts.model, agentResolutions);

    // Re-read agent after launch to get PID
    const updatedAgent = state.agents.find((a) => a.feature_id === opts.featureId);

    output(fmt, {
      feature_id: opts.featureId,
      mode: "headless",
      status: updatedAgent?.status ?? "running",
      pid: updatedAgent?.pid ?? null,
    }, () => {
      console.log(`Retrying ${opts.featureId} in headless mode`);
    }, () => {
      console.log(renderRetry({
        feature_id: opts.featureId,
        mode: "headless",
        status: updatedAgent?.status ?? "running",
        pid: updatedAgent?.pid ?? null,
      }));
    });
  }
}
