/**
 * launcher.ts — Process spawning and terminal multiplexer session management.
 *
 * Responsibilities:
 *   - Launch agent in headless mode (agent run --format json)
 *   - Launch agent in interactive mode (dmux/tmux session with TUI)
 *   - Resume sessions for auto-retry
 *   - Manage multiplexer sessions (create, list, kill)
 *
 * Supports both dmux (preferred) and tmux (fallback) via the multiplexer
 * abstraction layer. The active backend is determined by config.agent.multiplexer.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import type { WomboConfig } from "../config.js";
import { resolveAgentBin } from "../config.js";
import {
  detectMultiplexer,
  muxNewSession,
  muxHasSession,
  muxKillSession,
  muxListSessions,
  muxGetPanePid,
  muxLoadBuffer,
  muxPasteBuffer,
  muxSendKeys,
  muxDisplayName,
  type MultiplexerInfo,
} from "./multiplexer.js";
import { portlessEnv } from "./portless.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LaunchResult {
  pid: number;
  process: ChildProcess;
  sessionId?: string;
}

export interface LaunchOptions {
  worktreePath: string;
  featureId: string;
  prompt: string;
  model?: string;
  interactive?: boolean;
  config: WomboConfig;
  /** Override the agent name (for specialized agents from the registry) */
  agentName?: string;
}

export interface RetryOptions {
  worktreePath: string;
  featureId: string;
  sessionId: string;
  buildErrors: string;
  model?: string;
  interactive?: boolean;
  config: WomboConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function muxSessionName(featureId: string, config: WomboConfig): string {
  return `${config.agent.tmuxPrefix}-${featureId}`;
}

/**
 * Get the multiplexer info for this config.
 * Caches detection per-process.
 */
function getMux(config: WomboConfig): MultiplexerInfo {
  return detectMultiplexer(config.agent.multiplexer);
}

function runSilent(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

/**
 * Build the environment for an agent process.
 * Merges process.env with OPENCODE_DIR and portless env vars.
 */
function agentEnv(
  worktreePath: string,
  featureId: string,
  config: WomboConfig
): Record<string, string | undefined> {
  return {
    ...process.env,
    OPENCODE_DIR: worktreePath,
    ...portlessEnv(featureId, config),
  };
}

// ---------------------------------------------------------------------------
// Headless Launch
// ---------------------------------------------------------------------------

/**
 * Launch agent in headless mode with JSON output.
 */
export function launchHeadless(opts: LaunchOptions): LaunchResult {
  const agentBin = resolveAgentBin(opts.config);

  const args = [
    "run",
    "--format", "json",
    "--agent", opts.agentName ?? opts.config.agent.name,
    "--dir", opts.worktreePath,
    "--title", `woco: ${opts.featureId}`,
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  args.push(opts.prompt);

  const child = spawn(agentBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    env: agentEnv(opts.worktreePath, opts.featureId, opts.config),
  });

  // Close stdin so agent starts processing immediately
  child.stdin?.end();

  return {
    pid: child.pid!,
    process: child,
  };
}

/**
 * Resume a headless session with a retry message (build errors).
 */
export function retryHeadless(opts: RetryOptions): LaunchResult {
  const agentBin = resolveAgentBin(opts.config);

  const retryMessage = `The build failed. Please fix the following errors and run \`${opts.config.build.command}\` again:\n\n\`\`\`\n${opts.buildErrors}\n\`\`\`\n\nFix all errors, then verify the build passes.`;

  const args = [
    "run",
    "--format", "json",
    "--session", opts.sessionId,
    "--continue",
    "--dir", opts.worktreePath,
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  args.push(retryMessage);

  const child = spawn(agentBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    env: agentEnv(opts.worktreePath, opts.featureId, opts.config),
  });

  child.stdin?.end();

  return {
    pid: child.pid!,
    process: child,
  };
}

// ---------------------------------------------------------------------------
// Conflict Resolution Launch
// ---------------------------------------------------------------------------

export interface ConflictResolverOptions {
  worktreePath: string;
  featureId: string;
  prompt: string;
  model?: string;
  config: WomboConfig;
}

/**
 * Launch a headless agent to resolve merge conflicts.
 *
 * This is similar to `launchHeadless`, but the prompt is a conflict-resolution
 * prompt generated by `generateConflictResolutionPrompt()`. The agent runs in
 * the feature worktree where `git merge <baseBranch>` has already been run,
 * leaving conflict markers in the working tree.
 */
export function launchConflictResolver(opts: ConflictResolverOptions): LaunchResult {
  const agentBin = resolveAgentBin(opts.config);

  const args = [
    "run",
    "--format", "json",
    "--agent", opts.config.agent.name,
    "--dir", opts.worktreePath,
    "--title", `woco: conflict-resolve ${opts.featureId}`,
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  args.push(opts.prompt);

  const child = spawn(agentBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    env: agentEnv(opts.worktreePath, opts.featureId, opts.config),
  });

  child.stdin?.end();

  return {
    pid: child.pid!,
    process: child,
  };
}

// ---------------------------------------------------------------------------
// Interactive (multiplexer) Launch
// ---------------------------------------------------------------------------

/**
 * Launch agent in a terminal multiplexer session (dmux or tmux) for interactive use.
 */
export function launchInteractive(opts: LaunchOptions): LaunchResult {
  const agentBin = resolveAgentBin(opts.config);
  const mux = getMux(opts.config);
  const sessionName = muxSessionName(opts.featureId, opts.config);

  // Kill existing session if any
  killMuxSession(opts.featureId, opts.config);

  // Build the agent command to run inside the multiplexer
  // Include portless env vars so any server started in the session
  // is routed through the portless proxy
  const pEnv = portlessEnv(opts.featureId, opts.config);
  const envPrefix = Object.entries(pEnv)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");

  const ocArgs = [
    agentBin,
    "--dir", JSON.stringify(opts.worktreePath),
  ];

  // Pass agent name if specified (specialized agent from registry or per-task override)
  if (opts.agentName) {
    ocArgs.push("--agent", JSON.stringify(opts.agentName));
  }

  if (opts.model) {
    ocArgs.push("--model", JSON.stringify(opts.model));
  }

  const muxCmd = envPrefix ? `${envPrefix} ${ocArgs.join(" ")}` : ocArgs.join(" ");

  // Create a detached session running the agent
  muxNewSession(mux, sessionName, opts.worktreePath, muxCmd);

  // Send the prompt as initial message after a brief delay
  setTimeout(() => {
    try {
      const tmpFile = `/tmp/woco-prompt-${opts.featureId}.txt`;
      writeFileSync(tmpFile, opts.prompt);
      muxLoadBuffer(mux, tmpFile);
      muxPasteBuffer(mux, sessionName);
      muxSendKeys(mux, sessionName, "Enter");
      try { unlinkSync(tmpFile); } catch {}
    } catch {
      // If prompt sending fails, user can type manually
    }
  }, 3000);

  // Get the PID of the pane process
  const panePid = muxGetPanePid(mux, sessionName);

  return {
    pid: panePid,
    process: null as any, // No direct process handle in multiplexer mode
  };
}

/**
 * Resume an interactive session with retry message.
 */
export function retryInteractive(opts: RetryOptions): LaunchResult {
  const mux = getMux(opts.config);
  const sessionName = muxSessionName(opts.featureId, opts.config);

  const exists = muxSessionExists(opts.featureId, opts.config);

  if (exists) {
    const retryMsg = `The build failed. Fix these errors:\n${opts.buildErrors}`;
    const tmpFile = `/tmp/woco-retry-${opts.featureId}.txt`;
    writeFileSync(tmpFile, retryMsg);
    muxLoadBuffer(mux, tmpFile);
    muxPasteBuffer(mux, sessionName);
    muxSendKeys(mux, sessionName, "Enter");
    try { unlinkSync(tmpFile); } catch {}

    const panePid = muxGetPanePid(mux, sessionName);

    return {
      pid: panePid,
      process: null as any,
    };
  }

  // Session doesn't exist — launch a new interactive session
  return launchInteractive({
    worktreePath: opts.worktreePath,
    featureId: opts.featureId,
    prompt: `Continue from session ${opts.sessionId}. The build failed:\n${opts.buildErrors}\n\nFix all errors and verify the build passes.`,
    model: opts.model,
    interactive: true,
    config: opts.config,
  });
}

// ---------------------------------------------------------------------------
// Multiplexer Session Management
// ---------------------------------------------------------------------------

/**
 * Check if a multiplexer session exists for a feature.
 */
export function muxSessionExists(
  featureId: string,
  config: WomboConfig
): boolean {
  const mux = getMux(config);
  const sessionName = muxSessionName(featureId, config);
  return muxHasSession(mux, sessionName);
}

/**
 * Kill a multiplexer session for a feature.
 */
export function killMuxSession(
  featureId: string,
  config: WomboConfig
): void {
  const mux = getMux(config);
  const sessionName = muxSessionName(featureId, config);
  muxKillSession(mux, sessionName);
}

/**
 * List all woco-related multiplexer sessions.
 */
export function listMuxSessions(config: WomboConfig): string[] {
  const mux = getMux(config);
  const sessions = muxListSessions(mux);
  return sessions.filter((s) => s.startsWith(config.agent.tmuxPrefix + "-"));
}

/**
 * Kill all woco-related multiplexer sessions.
 */
export function killAllMuxSessions(config: WomboConfig): number {
  const mux = getMux(config);
  const sessions = listMuxSessions(config);
  for (const s of sessions) {
    muxKillSession(mux, s);
  }
  return sessions.length;
}

/**
 * Get the display name of the active multiplexer backend.
 */
export function getMultiplexerName(config: WomboConfig): string {
  try {
    const mux = getMux(config);
    return muxDisplayName(mux);
  } catch {
    return "tmux/dmux";
  }
}

// ---------------------------------------------------------------------------
// Backward Compatibility Aliases
// ---------------------------------------------------------------------------

/** @deprecated Use muxSessionExists instead */
export const tmuxSessionExists = muxSessionExists;
/** @deprecated Use killMuxSession instead */
export const killTmuxSession = killMuxSession;
/** @deprecated Use listMuxSessions instead */
export const listTmuxSessions = listMuxSessions;
/** @deprecated Use killAllMuxSessions instead */
export const killAllTmuxSessions = killAllMuxSessions;

/**
 * Check if a process is still running by PID.
 */
export function isProcessRunning(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
