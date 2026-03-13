/**
 * portless.ts — Portless integration for localhost server testing.
 *
 * Responsibilities:
 *   - Detect portless availability on the system
 *   - Resolve portless binary path
 *   - Generate portless-aware environment variables for agent processes
 *   - Ensure the portless proxy is running before agents launch
 *   - Provide wrapper commands for server-starting operations
 *
 * Portless replaces port numbers with stable, named .localhost URLs.
 * This prevents port collisions when multiple agents run concurrent
 * dev servers in different worktrees. Each worktree gets a unique
 * name derived from the feature ID, e.g.:
 *   http://woco-my-feature.localhost:1355
 *
 * Integration is transparent to agents — they don't need to know
 * about portless. The orchestrator sets up the environment so that
 * `portless run <cmd>` is available and the proxy is running.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WomboConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Portless Binary Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the portless binary path. Priority:
 *   1. config.portless.bin (explicit)
 *   2. PORTLESS_BIN env var
 *   3. 'portless' in PATH (auto-detect)
 *
 * Returns null if portless is not found.
 */
export function resolvePortlessBin(config: WomboConfig): string | null {
  if (!config.portless.enabled) return null;

  // Explicit config
  if (config.portless.bin) {
    return existsSync(config.portless.bin) ? config.portless.bin : null;
  }

  // Environment variable
  if (process.env.PORTLESS_BIN) {
    return existsSync(process.env.PORTLESS_BIN)
      ? process.env.PORTLESS_BIN
      : null;
  }

  // Auto-detect in PATH
  try {
    const path = execSync("which portless", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return path || null;
  } catch {
    return null;
  }
}

/**
 * Check if portless is available on the system.
 */
export function isPortlessAvailable(config: WomboConfig): boolean {
  return resolvePortlessBin(config) !== null;
}

// ---------------------------------------------------------------------------
// Proxy Management
// ---------------------------------------------------------------------------

/**
 * Check if the portless proxy is currently running.
 */
export function isProxyRunning(config: WomboConfig): boolean {
  const bin = resolvePortlessBin(config);
  if (!bin) return false;

  try {
    const output = execSync(`"${bin}" list`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5000,
    });
    // If `portless list` succeeds, the proxy is running
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the portless proxy is running. Starts it if needed.
 * Returns true if the proxy is now running, false if it could not be started.
 */
export function ensureProxyRunning(config: WomboConfig): boolean {
  if (!config.portless.enabled) return false;

  const bin = resolvePortlessBin(config);
  if (!bin) {
    console.warn(
      "\x1b[33m[portless]\x1b[0m portless not found. Install with: npm install -g portless"
    );
    return false;
  }

  if (isProxyRunning(config)) {
    return true;
  }

  // Start the proxy
  try {
    const args: string[] = ["proxy", "start"];

    if (config.portless.proxyPort !== 1355) {
      args.push("-p", String(config.portless.proxyPort));
    }

    if (config.portless.https) {
      args.push("--https");
    }

    execSync(`"${bin}" ${args.join(" ")}`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 10000,
    });

    console.log(
      `\x1b[32m[portless]\x1b[0m proxy started on port ${config.portless.proxyPort}`
    );
    return true;
  } catch (err: any) {
    console.warn(
      `\x1b[33m[portless]\x1b[0m failed to start proxy: ${err.message?.split("\n")[0]}`
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Environment Generation
// ---------------------------------------------------------------------------

/**
 * Generate portless-aware environment variables for an agent process.
 *
 * These variables ensure that any server started by the agent (or by
 * the project's dev/build scripts) will be routed through portless
 * rather than binding to a potentially conflicting port.
 *
 * The agent itself doesn't need to know about portless — the env vars
 * make it transparent.
 */
export function portlessEnv(
  featureId: string,
  config: WomboConfig
): Record<string, string> {
  if (!config.portless.enabled) return {};

  const bin = resolvePortlessBin(config);
  if (!bin) return {};

  const env: Record<string, string> = {};

  // Set PORTLESS_PORT so child processes know the proxy port
  env.PORTLESS_PORT = String(config.portless.proxyPort);

  // Set PORTLESS_HTTPS if configured
  if (config.portless.https) {
    env.PORTLESS_HTTPS = "1";
  }

  // Make portless binary available via env var for scripts
  env.PORTLESS_BIN = bin;

  // Set a unique app name based on the feature ID.
  // This ensures each worktree's server gets a unique .localhost URL
  // and avoids collisions between concurrent agents.
  env.PORTLESS_APP_NAME = `woco-${featureId}`;

  return env;
}

/**
 * Get the expected portless URL for a feature's dev server.
 * Useful for logging and informational purposes.
 */
export function portlessUrl(
  featureId: string,
  config: WomboConfig
): string {
  const protocol = config.portless.https ? "https" : "http";
  const port = config.portless.proxyPort;
  return `${protocol}://woco-${featureId}.localhost:${port}`;
}

// ---------------------------------------------------------------------------
// Command Wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap a command to run through portless.
 *
 * Given a command like "npm run dev", returns:
 *   portless woco-<featureId> npm run dev
 *
 * If portless is not available or disabled, returns the original command.
 */
export function wrapWithPortless(
  command: string,
  featureId: string,
  config: WomboConfig
): string {
  if (!config.portless.enabled) return command;

  const bin = resolvePortlessBin(config);
  if (!bin) return command;

  const appName = `woco-${featureId}`;
  return `"${bin}" ${appName} ${command}`;
}

/**
 * Generate a portless-wrapped script for use in package.json scripts
 * or as a shell alias. This is a convenience for worktree setup.
 */
export function portlessRunCommand(
  featureId: string,
  config: WomboConfig
): string | null {
  if (!config.portless.enabled) return null;

  const bin = resolvePortlessBin(config);
  if (!bin) return null;

  return `"${bin}" run --name woco-${featureId}`;
}

// ---------------------------------------------------------------------------
// Status / Diagnostics
// ---------------------------------------------------------------------------

/**
 * Get portless integration status for display purposes.
 */
export function portlessStatus(config: WomboConfig): {
  enabled: boolean;
  available: boolean;
  proxyRunning: boolean;
  bin: string | null;
  proxyPort: number;
} {
  const bin = resolvePortlessBin(config);
  return {
    enabled: config.portless.enabled,
    available: bin !== null,
    proxyRunning: bin !== null && isProxyRunning(config),
    bin,
    proxyPort: config.portless.proxyPort,
  };
}
