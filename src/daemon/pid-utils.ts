/**
 * pid-utils.ts -- Lightweight PID-file utilities for daemon status checks.
 *
 * Extracted from Daemon class so that launcher.ts (and anything else needing
 * to know whether a daemon is running) can check without pulling in the
 * entire daemon server code (Bun.serve, AgentRunner, Scheduler, etc.).
 */

import { resolve } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { WOMBO_DIR } from "../config";
import { PID_FILE } from "./protocol";

/**
 * Check if a daemon is already running for the given project root.
 * Reads the PID file and verifies the process is alive (signal 0).
 * Cleans up stale PID files automatically.
 */
export function isDaemonRunning(projectRoot: string): { running: boolean; pid?: number } {
  const pidPath = resolve(projectRoot, WOMBO_DIR, PID_FILE);
  if (!existsSync(pidPath)) return { running: false };

  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (isNaN(pid)) return { running: false };

    // Check if process is actually alive
    try {
      process.kill(pid, 0); // signal 0 = existence check
      return { running: true, pid };
    } catch {
      // Process doesn't exist — stale PID file
      try {
        unlinkSync(pidPath);
      } catch {
        // Ignore cleanup errors
      }
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}
