/**
 * verifier.ts — Build verification in worktrees.
 *
 * Responsibilities:
 *   - Run the project build command in a worktree
 *   - Capture and parse build output
 *   - Determine pass/fail
 *   - Extract error messages for retry prompts
 *   - Run browser-based verification when enabled
 *   - Run TDD verification (tests + test detection) when enabled
 *
 * IMPORTANT: runBuild is ASYNC — does not block the event loop.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WomboConfig } from "../config.js";
import {
  runBrowserVerification,
  extractBrowserErrorSummary,
  type BrowserVerificationResult,
} from "./browser-verifier.js";
import {
  runTddVerification,
  extractTddErrorSummary,
  type TddVerificationResult,
} from "./tdd-verifier.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Combined output, truncated for use in retry prompts */
  errorSummary: string;
  /** Duration in milliseconds */
  durationMs: number;
}

/** Options for controlling the full verification pipeline */
export interface FullVerificationOptions {
  /** Skip running tests (--skip-tests) */
  skipTests?: boolean;
  /** Strict TDD mode — fail if new files are missing tests (--strict-tdd) */
  strictTdd?: boolean;
}

/**
 * Combined result of build verification + browser verification + TDD verification.
 */
export interface FullVerificationResult {
  /** Build result (always runs) */
  build: BuildResult;
  /** Browser verification result (may be skipped) */
  browser: BrowserVerificationResult;
  /** TDD verification result (may be skipped) */
  tdd: TddVerificationResult;
  /** Overall pass: build passed AND browser passed AND tdd passed */
  overallPassed: boolean;
  /** Combined error summary for retry prompts */
  combinedErrorSummary: string;
}

// ---------------------------------------------------------------------------
// Build Verification
// ---------------------------------------------------------------------------

/**
 * Run the build command in a worktree directory.
 * Uses config for the build command and timeout.
 */
export function runBuild(
  worktreePath: string,
  config: WomboConfig
): Promise<BuildResult> {
  return new Promise((resolvePromise) => {
    const start = Date.now();

    exec(
      config.build.command,
      {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: config.build.timeout,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const exitCode = error ? (error as any).code ?? 1 : 0;
        const passed = !error;

        let errorSummary = "";
        if (!passed) {
          errorSummary = extractErrorSummary(stdout ?? "", stderr ?? "");
        }

        resolvePromise({
          passed,
          exitCode,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          errorSummary,
          durationMs,
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Error Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a concise error summary from build output.
 */
function extractErrorSummary(stdout: string, stderr: string): string {
  const combined = stdout + "\n" + stderr;
  const lines = combined.split("\n");

  const errorLines: string[] = [];
  let capturing = false;
  let contextLines = 0;

  for (const line of lines) {
    const isError =
      /error/i.test(line) &&
      !/warning/i.test(line) &&
      !/^info/i.test(line);
    const isTypeError = /TS\d+/.test(line);

    if (isError || isTypeError) {
      capturing = true;
      contextLines = 0;
      errorLines.push(line);
    } else if (capturing) {
      contextLines++;
      if (contextLines <= 3) {
        errorLines.push(line);
      } else {
        capturing = false;
      }
    }
  }

  if (errorLines.length === 0) {
    const tail = lines.slice(-50).join("\n");
    return truncate(tail, 4000);
  }

  return truncate(errorLines.join("\n"), 4000);
}

/**
 * Truncate a string to maxLen characters.
 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\n\n[... truncated, showing first 4000 chars]";
}

// ---------------------------------------------------------------------------
// Quick Check
// ---------------------------------------------------------------------------

/**
 * Quick check if the build artifacts exist.
 */
export function hasBuildArtifacts(
  worktreePath: string,
  config: WomboConfig
): boolean {
  try {
    return existsSync(resolve(worktreePath, config.build.artifactDir));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Full Verification (Build + Browser)
// ---------------------------------------------------------------------------

/**
 * Run the complete verification pipeline:
 *   1. Run the build command
 *   2. If build passes and browser testing is enabled, run browser tests
 *   3. If build passes and TDD is enabled, run tests + test detection
 *
 * Browser testing and TDD verification are additive — they run AFTER the
 * build passes and are skipped if the build fails.
 */
export async function runFullVerification(
  worktreePath: string,
  featureId: string,
  config: WomboConfig,
  opts?: FullVerificationOptions
): Promise<FullVerificationResult> {
  const skipTests = opts?.skipTests ?? false;
  const strictTdd = opts?.strictTdd ?? false;

  // Default TDD result (skipped)
  const defaultTddResult: TddVerificationResult = {
    ran: false,
    skipReason: "Skipped because build failed",
    testRun: null,
    testDetection: null,
    passed: true,
    hasWarnings: false,
    summary: "TDD verification skipped (build failed)",
    strictMode: strictTdd,
  };

  // Step 1: Build verification (always runs)
  const buildResult = await runBuild(worktreePath, config);

  // If build failed, skip browser testing and TDD verification
  if (!buildResult.passed) {
    return {
      build: buildResult,
      browser: {
        ran: false,
        skipReason: "Skipped because build failed",
        browserResult: null,
      },
      tdd: defaultTddResult,
      overallPassed: false,
      combinedErrorSummary: buildResult.errorSummary,
    };
  }

  // Step 2: Browser verification (runs only if build passed and browser enabled)
  const browserResult = await runBrowserVerification({
    worktreePath,
    featureId,
    config,
  });

  // Step 3: TDD verification (runs only if build passed and TDD enabled)
  const tddResult = await runTddVerification({
    worktreePath,
    featureId,
    config,
    skipTests,
    strictTdd,
    baseBranch: config.baseBranch,
  });

  // Determine overall pass
  const browserPassed = !browserResult.ran || (browserResult.browserResult?.allPassed ?? true);
  const tddPassed = tddResult.passed;
  const overallPassed = buildResult.passed && browserPassed && tddPassed;

  // Combine error summaries
  let combinedErrorSummary = "";
  if (!buildResult.passed) {
    combinedErrorSummary = buildResult.errorSummary;
  }
  if (browserResult.ran && browserResult.browserResult && !browserResult.browserResult.allPassed) {
    const browserErrors = extractBrowserErrorSummary(browserResult.browserResult);
    combinedErrorSummary = combinedErrorSummary
      ? `${combinedErrorSummary}\n\n--- Browser Test Errors ---\n\n${browserErrors}`
      : browserErrors;
  }
  if (tddResult.ran && !tddResult.passed) {
    const tddErrors = extractTddErrorSummary(tddResult);
    combinedErrorSummary = combinedErrorSummary
      ? `${combinedErrorSummary}\n\n--- TDD Verification Errors ---\n\n${tddErrors}`
      : tddErrors;
  }

  return {
    build: buildResult,
    browser: browserResult,
    tdd: tddResult,
    overallPassed,
    combinedErrorSummary,
  };
}
