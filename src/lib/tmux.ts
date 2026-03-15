/**
 * tmux.ts — Direct tmux session management.
 *
 * Thin wrapper around tmux CLI commands for agent session management.
 * No abstraction layer — just tmux.
 */

import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

let tmuxAvailable: boolean | null = null;

/**
 * Check if tmux is installed and available on PATH.
 * Result is cached per-process.
 */
export function ensureTmux(): void {
  if (tmuxAvailable === true) return;
  if (tmuxAvailable === false) {
    throw new Error(
      "tmux is not installed. Install tmux for interactive mode:\n" +
        "  macOS:  brew install tmux\n" +
        "  Ubuntu: sudo apt-get install -y tmux\n" +
        "  Fedora: sudo dnf install -y tmux\n" +
        "  Arch:   sudo pacman -S --noconfirm tmux"
    );
  }

  try {
    execSync("which tmux", { encoding: "utf-8", stdio: "pipe" });
    tmuxAvailable = true;
  } catch {
    tmuxAvailable = false;
    throw new Error(
      "tmux is not installed. Install tmux for interactive mode:\n" +
        "  macOS:  brew install tmux\n" +
        "  Ubuntu: sudo apt-get install -y tmux\n" +
        "  Fedora: sudo dnf install -y tmux\n" +
        "  Arch:   sudo pacman -S --noconfirm tmux"
    );
  }
}

/** Reset the detection cache (for testing). */
export function resetTmuxCache(): void {
  tmuxAvailable = null;
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
// Session Management
// ---------------------------------------------------------------------------

/**
 * Create a new detached tmux session running a command.
 */
export function tmuxNewSession(
  sessionName: string,
  workDir: string,
  command: string
): void {
  ensureTmux();
  execSync(
    `tmux new-session -d -s "${sessionName}" -c "${workDir}" "${command}"`,
    { stdio: "pipe" }
  );
}

/**
 * Check if a tmux session with the given name exists.
 */
export function tmuxHasSession(sessionName: string): boolean {
  ensureTmux();
  return (
    runSilent(
      `tmux has-session -t "${sessionName}" 2>/dev/null && echo yes`
    ) === "yes"
  );
}

/**
 * Kill a specific tmux session.
 */
export function tmuxKillSession(sessionName: string): void {
  runSilent(`tmux kill-session -t "${sessionName}" 2>/dev/null`);
}

/**
 * List all tmux session names.
 */
export function tmuxListSessions(): string[] {
  const output = runSilent(
    `tmux list-sessions -F "#{session_name}" 2>/dev/null`
  );
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

/**
 * Get the PID of the main pane in a tmux session.
 */
export function tmuxGetPanePid(sessionName: string): number {
  ensureTmux();
  const output = runSilent(
    `tmux list-panes -t "${sessionName}" -F "#{pane_pid}"`
  );
  return parseInt(output) || 0;
}

/**
 * Load text into the tmux paste buffer.
 */
export function tmuxLoadBuffer(filePath: string): void {
  ensureTmux();
  execSync(`tmux load-buffer "${filePath}"`, { stdio: "pipe" });
}

/**
 * Paste the tmux buffer into a session.
 */
export function tmuxPasteBuffer(sessionName: string): void {
  ensureTmux();
  execSync(`tmux paste-buffer -t "${sessionName}"`, { stdio: "pipe" });
}

/**
 * Send keys to a tmux session.
 */
export function tmuxSendKeys(sessionName: string, keys: string): void {
  ensureTmux();
  execSync(`tmux send-keys -t "${sessionName}" ${keys}`, { stdio: "pipe" });
}

/**
 * Attach to a tmux session (blocks until user detaches).
 */
export function tmuxAttach(sessionName: string): void {
  ensureTmux();
  execSync(`tmux attach -t "${sessionName}"`, { stdio: "inherit" });
}

/**
 * Capture the visible text content of a tmux session's pane.
 *
 * Returns the pane text as a string, or null if the session doesn't exist
 * or the capture fails.
 */
export function tmuxCapturePaneText(sessionName: string): string | null {
  try {
    return execSync(
      `tmux capture-pane -t "${sessionName}" -p`,
      { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8", timeout: 5000 }
    );
  } catch {
    return null;
  }
}
