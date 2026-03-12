/**
 * multiplexer.ts — Abstraction layer for terminal multiplexers (dmux/tmux).
 *
 * Provides a unified API for session management that works with either
 * dmux (preferred, Rust-based) or tmux (fallback). Auto-detects which
 * multiplexer is available, preferring dmux when both are present.
 *
 * Configurable via wombo.json `agent.multiplexer` field:
 *   - "auto"  — prefer dmux, fall back to tmux (default)
 *   - "dmux"  — use dmux only (error if not available)
 *   - "tmux"  — use tmux only (error if not available)
 */

import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MultiplexerBackend = "dmux" | "tmux";
export type MultiplexerPreference = "auto" | "dmux" | "tmux";

export interface MultiplexerInfo {
  /** Which backend is active */
  backend: MultiplexerBackend;
  /** The binary name (e.g., "dmux" or "tmux") */
  bin: string;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Cache the detection result so we only check once per process. */
let cachedDetection: MultiplexerInfo | null = null;
let cachedPreference: MultiplexerPreference | null = null;

function isAvailable(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which multiplexer is available. Results are cached.
 *
 * @param preference - User preference from config ("auto", "dmux", "tmux")
 * @returns MultiplexerInfo with the selected backend
 * @throws Error if the preferred multiplexer is not available
 */
export function detectMultiplexer(
  preference: MultiplexerPreference = "auto"
): MultiplexerInfo {
  // Return cached result if preference hasn't changed
  if (cachedDetection && cachedPreference === preference) {
    return cachedDetection;
  }

  let result: MultiplexerInfo;

  switch (preference) {
    case "dmux":
      if (!isAvailable("dmux")) {
        throw new Error(
          "dmux is configured as the multiplexer but is not installed. " +
            "Install dmux or set agent.multiplexer to 'auto' or 'tmux' in wombo.json."
        );
      }
      result = { backend: "dmux", bin: "dmux" };
      break;

    case "tmux":
      if (!isAvailable("tmux")) {
        throw new Error(
          "tmux is configured as the multiplexer but is not installed. " +
            "Install tmux or set agent.multiplexer to 'auto' or 'dmux' in wombo.json."
        );
      }
      result = { backend: "tmux", bin: "tmux" };
      break;

    case "auto":
    default:
      if (isAvailable("dmux")) {
        result = { backend: "dmux", bin: "dmux" };
      } else if (isAvailable("tmux")) {
        result = { backend: "tmux", bin: "tmux" };
      } else {
        throw new Error(
          "No terminal multiplexer found. Install dmux (preferred) or tmux.\n" +
            "  dmux: https://github.com/nicholasgasior/dmux\n" +
            "  tmux: https://github.com/tmux/tmux"
        );
      }
      break;
  }

  cachedDetection = result;
  cachedPreference = preference;
  return result;
}

/**
 * Reset the cached detection (useful for testing or config changes).
 */
export function resetMultiplexerCache(): void {
  cachedDetection = null;
  cachedPreference = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runSilent(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Unified Session Management API
// ---------------------------------------------------------------------------

/**
 * Create a new detached session running a command.
 */
export function muxNewSession(
  mux: MultiplexerInfo,
  sessionName: string,
  workDir: string,
  command: string
): void {
  switch (mux.backend) {
    case "dmux":
      execSync(
        `dmux new-session -d -s "${sessionName}" -c "${workDir}" "${command}"`,
        { stdio: "pipe" }
      );
      break;
    case "tmux":
      execSync(
        `tmux new-session -d -s "${sessionName}" -c "${workDir}" "${command}"`,
        { stdio: "pipe" }
      );
      break;
  }
}

/**
 * Check if a session with the given name exists.
 */
export function muxHasSession(
  mux: MultiplexerInfo,
  sessionName: string
): boolean {
  switch (mux.backend) {
    case "dmux":
      return (
        runSilent(
          `dmux has-session -t "${sessionName}" 2>/dev/null && echo yes`
        ) === "yes"
      );
    case "tmux":
      return (
        runSilent(
          `tmux has-session -t "${sessionName}" 2>/dev/null && echo yes`
        ) === "yes"
      );
  }
}

/**
 * Kill a specific session.
 */
export function muxKillSession(
  mux: MultiplexerInfo,
  sessionName: string
): void {
  switch (mux.backend) {
    case "dmux":
      runSilent(`dmux kill-session -t "${sessionName}" 2>/dev/null`);
      break;
    case "tmux":
      runSilent(`tmux kill-session -t "${sessionName}" 2>/dev/null`);
      break;
  }
}

/**
 * List all session names.
 */
export function muxListSessions(mux: MultiplexerInfo): string[] {
  let output: string;
  switch (mux.backend) {
    case "dmux":
      output = runSilent(
        `dmux list-sessions -F "#{session_name}" 2>/dev/null`
      );
      break;
    case "tmux":
      output = runSilent(
        `tmux list-sessions -F "#{session_name}" 2>/dev/null`
      );
      break;
  }
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

/**
 * Get the PID of the main pane in a session.
 */
export function muxGetPanePid(
  mux: MultiplexerInfo,
  sessionName: string
): number {
  let output: string;
  switch (mux.backend) {
    case "dmux":
      output = runSilent(
        `dmux list-panes -t "${sessionName}" -F "#{pane_pid}"`
      );
      break;
    case "tmux":
      output = runSilent(
        `tmux list-panes -t "${sessionName}" -F "#{pane_pid}"`
      );
      break;
  }
  return parseInt(output) || 0;
}

/**
 * Load text into the paste buffer.
 */
export function muxLoadBuffer(
  mux: MultiplexerInfo,
  filePath: string
): void {
  switch (mux.backend) {
    case "dmux":
      execSync(`dmux load-buffer "${filePath}"`, { stdio: "pipe" });
      break;
    case "tmux":
      execSync(`tmux load-buffer "${filePath}"`, { stdio: "pipe" });
      break;
  }
}

/**
 * Paste the buffer into a session.
 */
export function muxPasteBuffer(
  mux: MultiplexerInfo,
  sessionName: string
): void {
  switch (mux.backend) {
    case "dmux":
      execSync(`dmux paste-buffer -t "${sessionName}"`, { stdio: "pipe" });
      break;
    case "tmux":
      execSync(`tmux paste-buffer -t "${sessionName}"`, { stdio: "pipe" });
      break;
  }
}

/**
 * Send keys (e.g., Enter) to a session.
 */
export function muxSendKeys(
  mux: MultiplexerInfo,
  sessionName: string,
  keys: string
): void {
  switch (mux.backend) {
    case "dmux":
      execSync(`dmux send-keys -t "${sessionName}" ${keys}`, {
        stdio: "pipe",
      });
      break;
    case "tmux":
      execSync(`tmux send-keys -t "${sessionName}" ${keys}`, {
        stdio: "pipe",
      });
      break;
  }
}

/**
 * Attach to a session (blocks until user detaches).
 */
export function muxAttach(
  mux: MultiplexerInfo,
  sessionName: string
): void {
  switch (mux.backend) {
    case "dmux":
      execSync(`dmux attach -t "${sessionName}"`, { stdio: "inherit" });
      break;
    case "tmux":
      execSync(`tmux attach -t "${sessionName}"`, { stdio: "inherit" });
      break;
  }
}

/**
 * Get the multiplexer name for display purposes.
 * Returns "dmux" or "tmux".
 */
export function muxDisplayName(mux: MultiplexerInfo): string {
  return mux.backend;
}

/**
 * Build the attach command string (for display to user).
 */
export function muxAttachCommand(
  mux: MultiplexerInfo,
  sessionName: string
): string {
  return `${mux.bin} attach -t ${sessionName}`;
}

/**
 * Build the list-sessions command string (for display to user).
 */
export function muxListCommand(mux: MultiplexerInfo): string {
  return `${mux.bin} ls`;
}
