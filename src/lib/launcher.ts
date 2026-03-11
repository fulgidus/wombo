/**
 * launcher.ts — Process spawning and tmux session management.
 *
 * Responsibilities:
 *   - Launch agent in headless mode (agent run --format json)
 *   - Launch agent in interactive mode (tmux session with TUI)
 *   - Resume sessions for auto-retry
 *   - Manage tmux sessions (create, list, kill)
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import type { WomboConfig } from "../config.js";
import { resolveAgentBin } from "../config.js";

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

function tmuxSessionName(featureId: string, config: WomboConfig): string {
  return `${config.agent.tmuxPrefix}-${featureId}`;
}

function runSilent(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
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
    "--agent", opts.config.agent.name,
    "--dir", opts.worktreePath,
    "--title", `wombo: ${opts.featureId}`,
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  args.push(opts.prompt);

  const child = spawn(agentBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    env: {
      ...process.env,
      OPENCODE_DIR: opts.worktreePath,
    },
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
    env: {
      ...process.env,
      OPENCODE_DIR: opts.worktreePath,
    },
  });

  child.stdin?.end();

  return {
    pid: child.pid!,
    process: child,
  };
}

// ---------------------------------------------------------------------------
// Interactive (tmux) Launch
// ---------------------------------------------------------------------------

/**
 * Launch agent in a tmux session for interactive use.
 */
export function launchInteractive(opts: LaunchOptions): LaunchResult {
  const agentBin = resolveAgentBin(opts.config);
  const sessionName = tmuxSessionName(opts.featureId, opts.config);

  // Kill existing session if any
  killTmuxSession(opts.featureId, opts.config);

  // Build the agent command to run inside tmux
  const ocArgs = [
    agentBin,
    "--dir", JSON.stringify(opts.worktreePath),
  ];

  if (opts.model) {
    ocArgs.push("--model", JSON.stringify(opts.model));
  }

  const tmuxCmd = ocArgs.join(" ");

  // Create a detached tmux session running the agent
  execSync(
    `tmux new-session -d -s "${sessionName}" -c "${opts.worktreePath}" "${tmuxCmd}"`,
    { stdio: "pipe" }
  );

  // Send the prompt as initial message after a brief delay
  setTimeout(() => {
    try {
      const tmpFile = `/tmp/wombo-prompt-${opts.featureId}.txt`;
      writeFileSync(tmpFile, opts.prompt);
      execSync(`tmux load-buffer "${tmpFile}"`, { stdio: "pipe" });
      execSync(`tmux paste-buffer -t "${sessionName}"`, { stdio: "pipe" });
      execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: "pipe" });
      try { unlinkSync(tmpFile); } catch {}
    } catch {
      // If prompt sending fails, user can type manually
    }
  }, 3000);

  // Get the PID of the tmux server pane process
  const panePid = runSilent(
    `tmux list-panes -t "${sessionName}" -F "#{pane_pid}"`
  );

  return {
    pid: parseInt(panePid) || 0,
    process: null as any, // No direct process handle in tmux mode
  };
}

/**
 * Resume an interactive session with retry message.
 */
export function retryInteractive(opts: RetryOptions): LaunchResult {
  const sessionName = tmuxSessionName(opts.featureId, opts.config);

  const exists = tmuxSessionExists(opts.featureId, opts.config);

  if (exists) {
    const retryMsg = `The build failed. Fix these errors:\n${opts.buildErrors}`;
    const tmpFile = `/tmp/wombo-retry-${opts.featureId}.txt`;
    writeFileSync(tmpFile, retryMsg);
    execSync(`tmux load-buffer "${tmpFile}"`, { stdio: "pipe" });
    execSync(`tmux paste-buffer -t "${sessionName}"`, { stdio: "pipe" });
    execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: "pipe" });
    try { unlinkSync(tmpFile); } catch {}

    const panePid = runSilent(
      `tmux list-panes -t "${sessionName}" -F "#{pane_pid}"`
    );

    return {
      pid: parseInt(panePid) || 0,
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
// tmux Session Management
// ---------------------------------------------------------------------------

/**
 * Check if a tmux session exists for a feature.
 */
export function tmuxSessionExists(
  featureId: string,
  config: WomboConfig
): boolean {
  const sessionName = tmuxSessionName(featureId, config);
  return runSilent(`tmux has-session -t "${sessionName}" 2>/dev/null && echo yes`) === "yes";
}

/**
 * Kill a tmux session for a feature.
 */
export function killTmuxSession(
  featureId: string,
  config: WomboConfig
): void {
  const sessionName = tmuxSessionName(featureId, config);
  runSilent(`tmux kill-session -t "${sessionName}" 2>/dev/null`);
}

/**
 * List all wombo-related tmux sessions.
 */
export function listTmuxSessions(config: WomboConfig): string[] {
  const output = runSilent(
    `tmux list-sessions -F "#{session_name}" 2>/dev/null`
  );
  if (!output) return [];
  return output
    .split("\n")
    .filter((s) => s.startsWith(config.agent.tmuxPrefix + "-"));
}

/**
 * Kill all wombo-related tmux sessions.
 */
export function killAllTmuxSessions(config: WomboConfig): number {
  const sessions = listTmuxSessions(config);
  for (const s of sessions) {
    runSilent(`tmux kill-session -t "${s}" 2>/dev/null`);
  }
  return sessions.length;
}

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
