/**
 * browser.ts — Browser instance management for agent-based testing.
 *
 * Responsibilities:
 *   - Launch isolated browser instances per agent (no shared state)
 *   - Support headless operation for CI environments
 *   - Provide a uniform interface for browser interaction
 *   - Manage browser lifecycle (start, navigate, screenshot, cleanup)
 *   - Support user-defined browser test scripts
 *
 * Architecture:
 *   Uses system-installed browsers (chromium/chrome/firefox) via child_process
 *   with a lightweight HTTP-based control protocol. No npm dependency on
 *   puppeteer/playwright — keeps the dependency tree minimal per AGENTS.md.
 *
 *   Browser tests are shell scripts that agents can write and execute.
 *   The BrowserManager orchestrates: spawn browser → run test script → collect results.
 */

import { exec, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import type { WomboConfig, BrowserConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserInstance {
  /** Unique ID for this browser instance (derived from agent/feature ID) */
  id: string;
  /** PID of the browser process */
  pid: number;
  /** Browser process handle */
  process: ChildProcess;
  /** User data directory (isolated per instance) */
  userDataDir: string;
  /** Port for the DevTools protocol */
  debugPort: number;
  /** Whether browser is headless */
  headless: boolean;
  /** Whether the browser is still running */
  running: boolean;
}

export interface BrowserTestResult {
  /** Name/path of the test script */
  testName: string;
  /** Whether the test passed */
  passed: boolean;
  /** Exit code of the test script */
  exitCode: number;
  /** stdout from the test */
  stdout: string;
  /** stderr from the test */
  stderr: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Path to screenshot if captured */
  screenshotPath: string | null;
}

export interface BrowserVerifyResult {
  /** Whether all browser tests passed */
  allPassed: boolean;
  /** Individual test results */
  results: BrowserTestResult[];
  /** Summary string for display */
  summary: string;
  /** Total duration in milliseconds */
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Browser Discovery
// ---------------------------------------------------------------------------

/**
 * Discover available browser binary on the system.
 * Checks common locations for Chromium-based browsers.
 */
export function discoverBrowserBin(): string | null {
  const candidates = [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];

  for (const bin of candidates) {
    try {
      execSync(`which "${bin}" 2>/dev/null || test -x "${bin}"`, {
        stdio: "pipe",
        timeout: 5000,
      });
      return bin;
    } catch {
      // Not found, try next
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Port Allocation
// ---------------------------------------------------------------------------

/** Track allocated ports to avoid collisions between concurrent agents */
const allocatedPorts = new Set<number>();

/**
 * Find an available port for the Chrome DevTools Protocol.
 * Uses a range of ports (9222-9322) and checks for conflicts.
 */
function allocateDebugPort(): number {
  const BASE_PORT = 9222;
  const MAX_PORT = 9322;

  for (let port = BASE_PORT; port <= MAX_PORT; port++) {
    if (!allocatedPorts.has(port)) {
      // Quick check if port is available
      try {
        execSync(`! (lsof -i :${port} -t 2>/dev/null | head -1)`, {
          stdio: "pipe",
          timeout: 2000,
        });
        allocatedPorts.add(port);
        return port;
      } catch {
        // Port in use or lsof not available, try next
      }
    }
  }

  // Fallback: use a random high port
  const fallback = 10000 + Math.floor(Math.random() * 50000);
  allocatedPorts.add(fallback);
  return fallback;
}

/**
 * Release a previously allocated port.
 */
function releasePort(port: number): void {
  allocatedPorts.delete(port);
}

// ---------------------------------------------------------------------------
// BrowserManager
// ---------------------------------------------------------------------------

/**
 * Manages isolated browser instances for agent testing.
 *
 * Each agent gets its own browser instance with a unique user data directory,
 * ensuring no shared state between concurrent agents.
 */
export class BrowserManager {
  private instances: Map<string, BrowserInstance> = new Map();
  private browserBin: string | null;
  private browserConfig: BrowserConfig;

  constructor(browserConfig: BrowserConfig) {
    this.browserConfig = browserConfig;
    this.browserBin = browserConfig.bin ?? discoverBrowserBin();
  }

  /**
   * Check if browser testing is available (browser binary found).
   */
  isAvailable(): boolean {
    return this.browserBin !== null;
  }

  /**
   * Get the resolved browser binary path.
   */
  getBrowserBin(): string | null {
    return this.browserBin;
  }

  /**
   * Launch an isolated browser instance for a specific agent/feature.
   *
   * Each instance gets:
   *   - Its own user data directory (no shared cookies/cache/state)
   *   - Its own DevTools protocol port
   *   - Headless mode based on config
   */
  launch(featureId: string, worktreePath: string): BrowserInstance {
    if (!this.browserBin) {
      throw new Error(
        "No browser binary found. Install chromium or set browser.bin in wombo.json"
      );
    }

    if (this.instances.has(featureId)) {
      throw new Error(`Browser instance already exists for feature: ${featureId}`);
    }

    // Create isolated user data directory
    const userDataDir = resolve(worktreePath, ".wombo-browser", featureId);
    mkdirSync(userDataDir, { recursive: true });

    // Allocate a unique debug port
    const debugPort = allocateDebugPort();

    // Build browser launch args
    const headless = this.browserConfig.headless;
    const args: string[] = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-popup-blocking",
      "--disable-translate",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-device-discovery-notifications",
      "--no-sandbox", // Required in many CI environments
    ];

    if (headless) {
      args.push("--headless=new");
    }

    // Add viewport size
    const viewport = this.browserConfig.defaultViewport;
    args.push(`--window-size=${viewport.width},${viewport.height}`);

    // Launch browser process
    const child = exec(
      `"${this.browserBin}" ${args.join(" ")}`,
      {
        timeout: this.browserConfig.launchTimeout,
        env: {
          ...process.env,
          // Ensure display is available (for non-headless mode)
          DISPLAY: process.env.DISPLAY || ":0",
        },
      }
    );

    const instance: BrowserInstance = {
      id: featureId,
      pid: child.pid!,
      process: child,
      userDataDir,
      debugPort,
      headless,
      running: true,
    };

    child.on("exit", () => {
      instance.running = false;
    });

    child.on("error", () => {
      instance.running = false;
    });

    this.instances.set(featureId, instance);
    return instance;
  }

  /**
   * Get a running browser instance for a feature.
   */
  getInstance(featureId: string): BrowserInstance | undefined {
    return this.instances.get(featureId);
  }

  /**
   * Kill a browser instance and clean up.
   */
  kill(featureId: string): void {
    const instance = this.instances.get(featureId);
    if (!instance) return;

    if (instance.running) {
      try {
        instance.process.kill("SIGTERM");
      } catch {
        // Process may already be dead
      }

      // Force kill after timeout
      setTimeout(() => {
        if (instance.running) {
          try {
            instance.process.kill("SIGKILL");
          } catch {
            // Already dead
          }
        }
      }, 5000);
    }

    releasePort(instance.debugPort);
    this.instances.delete(featureId);
  }

  /**
   * Kill all browser instances.
   */
  killAll(): void {
    for (const id of this.instances.keys()) {
      this.kill(id);
    }
  }

  /**
   * Run browser test scripts found in a worktree.
   *
   * Looks for test scripts in:
   *   - <worktree>/.wombo-browser/tests/*.sh
   *   - <worktree>/.wombo-browser/tests/*.ts  (run with bun)
   *   - Or a custom testCommand from config
   *
   * Each script receives the browser debug port as an env variable.
   */
  async runTests(
    featureId: string,
    worktreePath: string
  ): Promise<BrowserVerifyResult> {
    const startTime = Date.now();
    const results: BrowserTestResult[] = [];

    // Check for custom test command first
    if (this.browserConfig.testCommand) {
      const result = await this.runSingleTest(
        featureId,
        worktreePath,
        this.browserConfig.testCommand,
        "custom-browser-test"
      );
      results.push(result);
    } else {
      // Look for test scripts in the conventional directory
      const testDir = resolve(worktreePath, ".wombo-browser", "tests");
      if (existsSync(testDir)) {
        const scripts = readdirSync(testDir)
          .filter((f) => f.endsWith(".sh") || f.endsWith(".ts") || f.endsWith(".js"))
          .sort();

        for (const script of scripts) {
          const scriptPath = resolve(testDir, script);
          const cmd = script.endsWith(".sh")
            ? `bash "${scriptPath}"`
            : `bun "${scriptPath}"`;

          const result = await this.runSingleTest(
            featureId,
            worktreePath,
            cmd,
            script
          );
          results.push(result);

          // Stop on first failure if not running all
          if (!result.passed) break;
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;
    const allPassed = results.length > 0 && results.every((r) => r.passed);
    const passCount = results.filter((r) => r.passed).length;

    return {
      allPassed,
      results,
      summary: results.length === 0
        ? "No browser tests found"
        : `${passCount}/${results.length} browser tests passed`,
      totalDurationMs,
    };
  }

  /**
   * Run a single test script with browser context.
   */
  private runSingleTest(
    featureId: string,
    worktreePath: string,
    command: string,
    testName: string
  ): Promise<BrowserTestResult> {
    const instance = this.instances.get(featureId);
    const debugPort = instance?.debugPort ?? 0;
    const screenshotDir = resolve(worktreePath, ".wombo-browser", "screenshots");
    mkdirSync(screenshotDir, { recursive: true });

    const screenshotPath = resolve(screenshotDir, `${testName.replace(/[^a-zA-Z0-9-_]/g, "_")}.png`);

    return new Promise((resolvePromise) => {
      const start = Date.now();

      exec(
        command,
        {
          cwd: worktreePath,
          encoding: "utf-8",
          timeout: this.browserConfig.testTimeout,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            BROWSER_DEBUG_PORT: String(debugPort),
            BROWSER_WS_ENDPOINT: `ws://localhost:${debugPort}`,
            BROWSER_HEADLESS: String(instance?.headless ?? true),
            BROWSER_SCREENSHOT_PATH: screenshotPath,
            BROWSER_USER_DATA_DIR: instance?.userDataDir ?? "",
          },
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - start;
          const exitCode = error ? (error as any).code ?? 1 : 0;

          resolvePromise({
            testName,
            passed: !error,
            exitCode,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            durationMs,
            screenshotPath: existsSync(screenshotPath) ? screenshotPath : null,
          });
        }
      );
    });
  }

  /**
   * Get info about all active browser instances.
   */
  listInstances(): { id: string; pid: number; port: number; headless: boolean; running: boolean }[] {
    return Array.from(this.instances.values()).map((inst) => ({
      id: inst.id,
      pid: inst.pid,
      port: inst.debugPort,
      headless: inst.headless,
      running: inst.running,
    }));
  }
}
