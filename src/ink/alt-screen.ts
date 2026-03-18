/**
 * alt-screen.ts — Alternate screen buffer management for the Ink-based TUI.
 *
 * Ink v6 does not natively use the terminal's alternate screen buffer.
 * This module provides enter/exit helpers so the TUI gets a true fullscreen
 * experience: the alternate buffer replaces the main scrollback while the
 * TUI is active, and restores the original content on exit.
 *
 * Escape codes:
 *   \x1b[?1049h  — Enter alternate screen buffer (smcup)
 *   \x1b[?1049l  — Exit alternate screen buffer (rmcup)
 *   \x1b[H       — Move cursor to home position (1,1)
 *   \x1b[?25l    — Hide cursor
 *   \x1b[?25h    — Show cursor
 */

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H";
const EXIT_ALT_SCREEN = "\x1b[?25h\x1b[?1049l";

let active = false;

/**
 * Enter the alternate screen buffer.
 * Safe to call multiple times — only the first call takes effect.
 */
export function enterAltScreen(): void {
  if (active) return;
  if (process.stdout.isTTY) {
    process.stdout.write(ENTER_ALT_SCREEN);
    active = true;
  }
}

/**
 * Exit the alternate screen buffer and restore the main scrollback.
 * Safe to call multiple times — only effective if currently in alt screen.
 */
export function exitAltScreen(): void {
  if (!active) return;
  if (process.stdout.isTTY) {
    process.stdout.write(EXIT_ALT_SCREEN);
    active = false;
  }
}

/** Returns whether the alternate screen buffer is currently active. */
export function isAltScreenActive(): boolean {
  return active;
}

/**
 * Clear the current screen (works in both main and alt buffers).
 * Use this for view transitions within the alt screen.
 */
export function clearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
}

/**
 * Install a safety-net handler that exits the alternate screen buffer
 * on process exit, SIGINT, and SIGTERM. Without this, a crash could
 * leave the terminal stuck in the alt buffer.
 *
 * We intentionally do NOT hook `uncaughtException` — Ink throws
 * recoverable errors (e.g. raw-mode warnings) that would be caught
 * and turned into hard crashes. The `process.on('exit')` handler
 * is sufficient to clean up alt-screen on any exit path.
 *
 * Call once at TUI session start. Returns a cleanup function that removes
 * the handlers.
 */
export function installAltScreenGuard(): () => void {
  const onExit = () => exitAltScreen();
  const onSignal = () => {
    exitAltScreen();
    process.exit(0);
  };

  process.on("exit", onExit);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return () => {
    process.removeListener("exit", onExit);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
}
