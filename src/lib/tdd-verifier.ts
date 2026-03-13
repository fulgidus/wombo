/**
 * tdd-verifier.ts — TDD verification step for the build pipeline.
 *
 * Responsibilities:
 *   - Run tests via test-runner.ts and capture results
 *   - Run test-detection.ts to check new files have tests
 *   - Combine results into a structured TddVerificationResult
 *   - Support strict mode (blocking) vs warn mode (non-blocking)
 *   - Render human-readable reports
 *
 * This module is called by verifier.ts as an additional step in the
 * full verification pipeline, after the build passes.
 */

import type { WomboConfig } from "../config.js";
import { runTests, type TestRunResult } from "./test-runner.js";
import {
  detectTests,
  renderTestDetectionReport,
  type TestDetectionReport,
} from "./test-detection.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for running TDD verification */
export interface TddVerificationOptions {
  /** Absolute path to the worktree */
  worktreePath: string;
  /** Feature ID (used for git diff comparison) */
  featureId: string;
  /** Full config */
  config: WomboConfig;
  /** Skip running tests entirely */
  skipTests?: boolean;
  /** Strict TDD mode: fail verification if tests are missing */
  strictTdd?: boolean;
  /** Base branch for git diff comparison (default: from config) */
  baseBranch?: string;
}

/** Result of TDD verification */
export interface TddVerificationResult {
  /** Whether TDD verification was run at all */
  ran: boolean;
  /** Why it was skipped (null if it ran) */
  skipReason: string | null;
  /** Test run results (null if tests were skipped or not run) */
  testRun: TestRunResult | null;
  /** Test detection report (null if skipped) */
  testDetection: TestDetectionReport | null;
  /** Whether TDD verification passed overall */
  passed: boolean;
  /** Whether there are warnings (missing tests in non-strict mode) */
  hasWarnings: boolean;
  /** Human-readable summary */
  summary: string;
  /** Whether strict mode was used */
  strictMode: boolean;
}

// ---------------------------------------------------------------------------
// TDD Verification Runner
// ---------------------------------------------------------------------------

/**
 * Run the TDD verification step.
 *
 * This is the main entry point called by the verification pipeline.
 * It runs in two sub-steps:
 *   1. Run the test command and capture results
 *   2. Run test detection to find files missing tests
 *
 * In non-strict mode (default), missing tests produce warnings but don't
 * fail verification. In strict mode (--strict-tdd), missing tests cause
 * verification to fail.
 */
export async function runTddVerification(
  opts: TddVerificationOptions
): Promise<TddVerificationResult> {
  const { worktreePath, config } = opts;
  const strictMode = opts.strictTdd ?? false;

  // Check if TDD is enabled in config
  if (!config.tdd?.enabled) {
    return {
      ran: false,
      skipReason: "TDD is disabled (set tdd.enabled: true in .wombo-combo/config.json)",
      testRun: null,
      testDetection: null,
      passed: true,
      hasWarnings: false,
      summary: "TDD verification skipped (disabled)",
      strictMode,
    };
  }

  // Check if tests should be skipped via --skip-tests flag
  if (opts.skipTests) {
    return {
      ran: false,
      skipReason: "Tests skipped via --skip-tests flag",
      testRun: null,
      testDetection: null,
      passed: true,
      hasWarnings: false,
      summary: "TDD verification skipped (--skip-tests)",
      strictMode,
    };
  }

  const testCommand = config.tdd.testCommand || "bun test";
  const baseBranch = opts.baseBranch ?? config.baseBranch;

  // Step 1: Run the test command
  let testRun: TestRunResult | null = null;
  try {
    testRun = await runTests(worktreePath, testCommand);
  } catch (err: any) {
    // Test command failed to execute (not the same as tests failing)
    return {
      ran: true,
      skipReason: null,
      testRun: null,
      testDetection: null,
      passed: false,
      hasWarnings: false,
      summary: `Test command failed to execute: ${err.message}`,
      strictMode,
    };
  }

  // Step 2: Run test detection (check if new files have tests)
  let testDetection: TestDetectionReport | null = null;
  try {
    testDetection = detectTests(worktreePath, baseBranch);
  } catch (err: any) {
    // Test detection failed — non-fatal, just skip it
    testDetection = null;
  }

  // Step 3: Determine overall pass/fail
  const testsPassed = testRun.passed;
  const hasMissingTests =
    testDetection !== null && testDetection.missingTests.length > 0;
  const hasWarnings = hasMissingTests && !strictMode;

  // In strict mode, missing tests cause failure
  // In non-strict mode, only test failures cause failure
  const passed = strictMode
    ? testsPassed && !hasMissingTests
    : testsPassed;

  // Build summary
  const summary = buildSummary(testRun, testDetection, strictMode);

  return {
    ran: true,
    skipReason: null,
    testRun,
    testDetection,
    passed,
    hasWarnings,
    summary,
    strictMode,
  };
}

// ---------------------------------------------------------------------------
// Summary Building
// ---------------------------------------------------------------------------

/**
 * Build a human-readable summary of TDD verification results.
 */
function buildSummary(
  testRun: TestRunResult,
  testDetection: TestDetectionReport | null,
  strictMode: boolean
): string {
  const parts: string[] = [];

  // Test run summary
  if (testRun.testCounts.parsed) {
    parts.push(
      `Tests: ${testRun.testCounts.passed} passed, ` +
      `${testRun.testCounts.failed} failed` +
      (testRun.testCounts.skipped > 0
        ? `, ${testRun.testCounts.skipped} skipped`
        : "") +
      ` (${Math.round(testRun.durationMs / 1000)}s)`
    );
  } else {
    parts.push(
      `Tests: ${testRun.passed ? "PASSED" : "FAILED"} ` +
      `(exit code ${testRun.exitCode}, ${Math.round(testRun.durationMs / 1000)}s)`
    );
  }

  // Test detection summary
  if (testDetection) {
    const { missingTests, coveredCount, testableCount, coveragePercent } =
      testDetection;
    if (missingTests.length > 0) {
      const label = strictMode ? "FAIL" : "WARN";
      parts.push(
        `Coverage: ${coveredCount}/${testableCount} files (${coveragePercent}) — ` +
        `${label}: ${missingTests.length} file(s) missing tests`
      );
    } else if (testableCount > 0) {
      parts.push(
        `Coverage: ${coveredCount}/${testableCount} files (${coveragePercent})`
      );
    }
  }

  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// Error Summary Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a concise error summary from TDD verification results.
 * Used for retry prompts when TDD verification fails.
 */
export function extractTddErrorSummary(
  result: TddVerificationResult
): string {
  const parts: string[] = [];

  if (result.testRun && !result.testRun.passed) {
    parts.push("--- Test Failures ---");
    parts.push(result.testRun.errorSummary || "(no error details)");
  }

  if (
    result.strictMode &&
    result.testDetection &&
    result.testDetection.missingTests.length > 0
  ) {
    parts.push("");
    parts.push("--- Missing Tests (strict TDD mode) ---");
    for (const path of result.testDetection.missingTests) {
      parts.push(`  ${path}`);
    }
  }

  return parts.join("\n").slice(0, 4000);
}

// ---------------------------------------------------------------------------
// Text Rendering
// ---------------------------------------------------------------------------

/**
 * Render a TDD verification result as human-readable text to stdout.
 */
export function renderTddVerificationReport(
  result: TddVerificationResult
): void {
  if (!result.ran) {
    console.log(`\n  TDD: ${result.skipReason}\n`);
    return;
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  TDD Verification Report`);
  console.log(`${"─".repeat(60)}`);

  // Test run results
  if (result.testRun) {
    const tr = result.testRun;
    const statusIcon = tr.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`\n  ${statusIcon} Test Run: ${tr.passed ? "PASSED" : "FAILED"}`);
    console.log(`    Command exit code: ${tr.exitCode}`);
    console.log(`    Duration: ${Math.round(tr.durationMs / 1000)}s`);

    if (tr.testCounts.parsed) {
      console.log(
        `    Results: ${tr.testCounts.passed} passed, ` +
        `${tr.testCounts.failed} failed, ` +
        `${tr.testCounts.skipped} skipped ` +
        `(${tr.testCounts.total} total)`
      );
    }
  }

  // Test detection results
  if (result.testDetection) {
    renderTestDetectionReport(result.testDetection);
  }

  // Overall status
  const overallIcon = result.passed
    ? "\x1b[32m✓\x1b[0m"
    : "\x1b[31m✗\x1b[0m";
  const modeLabel = result.strictMode ? " (strict)" : "";
  console.log(`  ${overallIcon} TDD Overall: ${result.passed ? "PASSED" : "FAILED"}${modeLabel}`);

  if (result.hasWarnings) {
    console.log(
      `  \x1b[33m⚠\x1b[0m Warnings: Some new files are missing tests ` +
      `(non-blocking — use --strict-tdd to enforce)`
    );
  }

  console.log(`${"─".repeat(60)}\n`);
}
