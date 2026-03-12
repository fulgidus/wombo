/**
 * browser-verifier.ts — Browser-based verification for the build/verify pipeline.
 *
 * Responsibilities:
 *   - Run browser tests as part of the verification step
 *   - Manage browser instance lifecycle during verification
 *   - Produce BrowserVerifyResult alongside BuildResult
 *   - Support optional browser testing (skip if not configured or no browser found)
 *
 * This module bridges the BrowserManager (browser.ts) with the verification
 * pipeline (verifier.ts). It's called after the build passes to perform
 * browser-based testing when browser.enabled is true in config.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WomboConfig } from "../config.js";
import { BrowserManager, type BrowserVerifyResult, type BrowserTestResult } from "./browser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserVerificationOptions {
  /** Path to the agent's worktree */
  worktreePath: string;
  /** Feature ID (used to isolate browser instance) */
  featureId: string;
  /** Full config */
  config: WomboConfig;
  /** Override headless setting (e.g. for CI) */
  headless?: boolean;
}

export interface BrowserVerificationResult {
  /** Whether browser verification was run at all */
  ran: boolean;
  /** Why it was skipped (null if it ran) */
  skipReason: string | null;
  /** Browser test results (null if skipped) */
  browserResult: BrowserVerifyResult | null;
}

// ---------------------------------------------------------------------------
// Browser Test Detection
// ---------------------------------------------------------------------------

/**
 * Check if a worktree has browser tests configured.
 * Returns true if either:
 *   - config.browser.testCommand is set
 *   - The worktree contains .wombo-browser/tests/ with test scripts
 */
export function hasBrowserTests(
  worktreePath: string,
  config: WomboConfig
): boolean {
  // Custom test command always counts
  if (config.browser.testCommand) return true;

  // Check for test scripts in the conventional directory
  const testDir = resolve(worktreePath, ".wombo-browser", "tests");
  if (!existsSync(testDir)) return false;

  try {
    const { readdirSync } = require("node:fs");
    const files = readdirSync(testDir) as string[];
    return files.some(
      (f: string) => f.endsWith(".sh") || f.endsWith(".ts") || f.endsWith(".js")
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Browser Verification Runner
// ---------------------------------------------------------------------------

/**
 * Run browser-based verification for a feature's worktree.
 *
 * This is the main entry point called by the verification pipeline.
 * It handles the full lifecycle:
 *   1. Check if browser testing is enabled and available
 *   2. Launch an isolated browser instance
 *   3. Run browser test scripts
 *   4. Collect results and screenshots
 *   5. Clean up browser instance
 *
 * Returns a result indicating whether tests ran and their outcomes.
 */
export async function runBrowserVerification(
  opts: BrowserVerificationOptions
): Promise<BrowserVerificationResult> {
  const { worktreePath, featureId, config } = opts;

  // Check if browser testing is enabled
  if (!config.browser.enabled) {
    return {
      ran: false,
      skipReason: "Browser testing is disabled (set browser.enabled: true in wombo.json)",
      browserResult: null,
    };
  }

  // Check if there are browser tests to run
  if (!hasBrowserTests(worktreePath, config)) {
    return {
      ran: false,
      skipReason: "No browser tests found (no .wombo-browser/tests/ or testCommand)",
      browserResult: null,
    };
  }

  // Create browser manager with optional headless override
  const browserConfig = {
    ...config.browser,
    headless: opts.headless ?? config.browser.headless,
  };
  const manager = new BrowserManager(browserConfig);

  // Check if a browser is available
  if (!manager.isAvailable()) {
    return {
      ran: false,
      skipReason: "No browser binary found (install chromium or set browser.bin in wombo.json)",
      browserResult: null,
    };
  }

  try {
    // Launch isolated browser instance for this feature
    manager.launch(featureId, worktreePath);

    // Give browser a moment to start up
    await new Promise((r) => setTimeout(r, 2000));

    // Run browser tests
    const result = await manager.runTests(featureId, worktreePath);

    return {
      ran: true,
      skipReason: null,
      browserResult: result,
    };
  } catch (err: any) {
    return {
      ran: true,
      skipReason: null,
      browserResult: {
        allPassed: false,
        results: [{
          testName: "browser-setup",
          passed: false,
          exitCode: 1,
          stdout: "",
          stderr: err.message,
          durationMs: 0,
          screenshotPath: null,
        }],
        summary: `Browser verification failed: ${err.message}`,
        totalDurationMs: 0,
      },
    };
  } finally {
    // Always clean up browser instance
    manager.kill(featureId);
  }
}

// ---------------------------------------------------------------------------
// Error Summary Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a concise error summary from browser verification results.
 * Used for retry prompts when browser tests fail.
 */
export function extractBrowserErrorSummary(
  result: BrowserVerifyResult
): string {
  const failedTests = result.results.filter((r) => !r.passed);
  if (failedTests.length === 0) return "";

  const lines: string[] = [
    `Browser Tests Failed: ${failedTests.length}/${result.results.length}`,
    "",
  ];

  for (const test of failedTests) {
    lines.push(`--- ${test.testName} (exit code ${test.exitCode}) ---`);
    if (test.stderr.trim()) {
      lines.push(test.stderr.trim().slice(0, 500));
    }
    if (test.stdout.trim()) {
      lines.push(test.stdout.trim().slice(0, 500));
    }
    if (test.screenshotPath) {
      lines.push(`Screenshot: ${test.screenshotPath}`);
    }
    lines.push("");
  }

  return lines.join("\n").slice(0, 4000);
}
