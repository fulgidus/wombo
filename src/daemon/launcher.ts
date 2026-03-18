/**
 * launcher.ts -- Daemon lifecycle management from the CLI/TUI side.
 *
 * Provides:
 * - ensureDaemonRunning() — check if daemon is alive, start it if not
 * - startDaemon() — spawn daemon as a detached background process
 * - stopDaemon() — send shutdown command via WebSocket (or kill PID)
 * - getDaemonStatus() — check running/stopped, PID, port
 *
 * The daemon is spawned as a detached Bun child process running
 * src/daemon/daemon.ts. It writes a PID file to .wombo-combo/daemon.pid.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { WOMBO_DIR } from "../config";
import { DEFAULT_WS_PORT, PID_FILE, DEFAULT_IDLE_TIMEOUT_MS } from "./protocol";
import { isDaemonRunning } from "./pid-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port: number;
  /** Daemon health info (only if running and reachable). */
  health?: {
    uptime: number;
    clients: number;
    schedulerStatus: string;
  };
}

export interface StartDaemonOptions {
  projectRoot: string;
  port?: number;
  idleTimeoutMs?: number;
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Check if a daemon is running for the given project root. */
export function getDaemonStatus(projectRoot: string, port?: number): DaemonStatus {
  const effectivePort = port ?? DEFAULT_WS_PORT;
  const check = isDaemonRunning(projectRoot);

  return {
    running: check.running,
    pid: check.pid,
    port: effectivePort,
  };
}

/** Check if a daemon is running and reachable via its health endpoint. */
export async function getDaemonHealthStatus(
  projectRoot: string,
  port?: number
): Promise<DaemonStatus> {
  const effectivePort = port ?? DEFAULT_WS_PORT;
  const status = getDaemonStatus(projectRoot, effectivePort);

  if (!status.running) return status;

  // Try to reach the health endpoint
  try {
    const resp = await fetch(`http://localhost:${effectivePort}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const data = (await resp.json()) as {
        status: string;
        pid: number;
        uptime: number;
        clients: number;
        schedulerStatus: string;
      };
      status.health = {
        uptime: data.uptime,
        clients: data.clients,
        schedulerStatus: data.schedulerStatus,
      };
    }
  } catch {
    // Health endpoint unreachable — process may be starting up or broken
  }

  return status;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Start a daemon process in the background.
 * Spawns `bun src/daemon/daemon.ts` as a detached child process.
 * Returns the PID of the spawned process.
 */
export async function startDaemon(opts: StartDaemonOptions): Promise<number> {
  const { projectRoot, port, idleTimeoutMs, verbose } = opts;
  const effectivePort = port ?? DEFAULT_WS_PORT;

  // Check if already running
  const existing = getDaemonStatus(projectRoot, effectivePort);
  if (existing.running && existing.pid) {
    return existing.pid;
  }

  // Resolve the daemon entry point
  // In development: run src/daemon/daemon.ts directly via bun
  // In production: run the compiled dist/daemon/daemon.js
  const daemonEntry = resolveDaemonEntry();

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    WOMBO_DAEMON_PROJECT_ROOT: projectRoot,
    WOMBO_DAEMON_PORT: String(effectivePort),
    WOMBO_DAEMON_IDLE_TIMEOUT: String(idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS),
  };
  if (verbose) {
    env.WOMBO_DAEMON_VERBOSE = "true";
  }

  // Spawn as a detached child process
  const child = Bun.spawn(["bun", "run", daemonEntry], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: verbose ? "inherit" : "ignore",
  });

  // Detach so the parent can exit without killing the daemon
  child.unref();

  const pid = child.pid;

  // Wait for the daemon to become ready (PID file written + health check)
  await waitForDaemonReady(projectRoot, effectivePort, 10_000);

  return pid;
}

/**
 * Ensure a daemon is running. If not, start one.
 * Returns the DaemonStatus with the running daemon info.
 */
export async function ensureDaemonRunning(
  projectRoot: string,
  port?: number
): Promise<DaemonStatus> {
  const effectivePort = port ?? DEFAULT_WS_PORT;
  const status = getDaemonStatus(projectRoot, effectivePort);

  if (status.running) return status;

  const pid = await startDaemon({ projectRoot, port: effectivePort });
  return {
    running: true,
    pid,
    port: effectivePort,
  };
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/**
 * Stop a running daemon.
 * First tries graceful shutdown via WebSocket. Falls back to SIGTERM.
 */
export async function stopDaemon(
  projectRoot: string,
  port?: number,
  force = false
): Promise<boolean> {
  const effectivePort = port ?? DEFAULT_WS_PORT;
  const status = getDaemonStatus(projectRoot, effectivePort);

  if (!status.running || !status.pid) {
    // Clean up stale PID file if present
    cleanupPidFile(projectRoot);
    return false;
  }

  if (!force) {
    // Try graceful shutdown via HTTP
    try {
      // We can't easily do a full WS handshake just to send shutdown,
      // so send SIGTERM which the daemon handles gracefully
      process.kill(status.pid, "SIGTERM");

      // Wait for it to actually stop
      const stopped = await waitForDaemonStop(projectRoot, 10_000);
      if (stopped) return true;
    } catch {
      // Process might already be dead
    }
  }

  // Force kill
  try {
    process.kill(status.pid, "SIGKILL");
  } catch {
    // Already dead
  }

  // Clean up PID file
  cleanupPidFile(projectRoot);

  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the daemon entry point file. */
function resolveDaemonEntry(): string {
  // Check for source (development) first
  const srcEntry = resolve(import.meta.dir, "daemon.ts");
  if (existsSync(srcEntry)) return srcEntry;

  // Fall back to dist (production)
  const distEntry = resolve(import.meta.dir, "../../dist/daemon/daemon.js");
  if (existsSync(distEntry)) return distEntry;

  // Last resort — assume src
  return srcEntry;
}

/** Wait for the daemon to become ready (PID file + health check). */
async function waitForDaemonReady(
  projectRoot: string,
  port: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 200;

  while (Date.now() < deadline) {
    const status = getDaemonStatus(projectRoot, port);
    if (status.running) {
      // Try health endpoint
      try {
        const resp = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (resp.ok) return; // Daemon is ready
      } catch {
        // Not ready yet
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Daemon failed to start within ${timeoutMs}ms`);
}

/** Wait for the daemon to stop (PID file removed). */
async function waitForDaemonStop(
  projectRoot: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 200;

  while (Date.now() < deadline) {
    const status = getDaemonStatus(projectRoot);
    if (!status.running) return true;
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return false;
}

/** Remove stale PID file. */
function cleanupPidFile(projectRoot: string): void {
  const pidPath = resolve(projectRoot, WOMBO_DIR, PID_FILE);
  try {
    unlinkSync(pidPath);
  } catch {
    // Already removed
  }
}
