/**
 * test-runner.ts — Run test commands and capture results.
 *
 * Responsibilities:
 *   - Run the configured test command (e.g. `bun test`) in a worktree
 *   - Capture exit code, stdout, stderr
 *   - Parse test output to extract pass/fail counts
 *   - Produce structured TestRunResult for the TDD verification pipeline
 *
 * This module is used by tdd-verifier.ts as part of the TDD verification step.
 */

import { exec } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of running the test command */
export interface TestRunResult {
  /** Whether the test command exited successfully (exit code 0) */
  passed: boolean;
  /** Process exit code */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Parsed test counts (best-effort extraction from output) */
  testCounts: TestCounts;
  /** Error summary for retry prompts (empty if passed) */
  errorSummary: string;
}

/** Parsed test pass/fail counts from test runner output */
export interface TestCounts {
  /** Total number of tests detected */
  total: number;
  /** Number of passing tests */
  passed: number;
  /** Number of failing tests */
  failed: number;
  /** Number of skipped tests */
  skipped: number;
  /** Whether counts could be parsed from output */
  parsed: boolean;
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

/**
 * Run the test command in a worktree directory.
 *
 * @param worktreePath - Absolute path to the worktree
 * @param testCommand - Test command to run (e.g., "bun test")
 * @param timeout - Timeout in milliseconds (default: 120_000)
 * @returns Structured test run result
 */
export function runTests(
  worktreePath: string,
  testCommand: string,
  timeout: number = 120_000
): Promise<TestRunResult> {
  return new Promise((resolvePromise) => {
    const start = Date.now();

    exec(
      testCommand,
      {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const exitCode = error ? (error as any).code ?? 1 : 0;
        const passed = !error;

        const testCounts = parseTestCounts(stdout ?? "", stderr ?? "");

        let errorSummary = "";
        if (!passed) {
          errorSummary = extractTestErrorSummary(stdout ?? "", stderr ?? "");
        }

        resolvePromise({
          passed,
          exitCode,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          durationMs,
          testCounts,
          errorSummary,
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Output Parsing
// ---------------------------------------------------------------------------

/**
 * Parse test counts from test runner output.
 *
 * Supports common formats:
 *   - Bun test: "42 pass, 3 fail, 2 skip" or "X pass\nY fail"
 *   - Generic: "Tests: X passed, Y failed, Z skipped, W total"
 *   - Jest-like: "Tests:  X passed, Y failed, Z total"
 */
export function parseTestCounts(stdout: string, stderr: string): TestCounts {
  const combined = stdout + "\n" + stderr;
  const result: TestCounts = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    parsed: false,
  };

  // Bun test format: "42 pass" and "3 fail" on separate or same lines
  const bunPassMatch = combined.match(/(\d+)\s+pass/i);
  const bunFailMatch = combined.match(/(\d+)\s+fail/i);
  const bunSkipMatch = combined.match(/(\d+)\s+skip/i);

  if (bunPassMatch || bunFailMatch) {
    result.passed = bunPassMatch ? parseInt(bunPassMatch[1], 10) : 0;
    result.failed = bunFailMatch ? parseInt(bunFailMatch[1], 10) : 0;
    result.skipped = bunSkipMatch ? parseInt(bunSkipMatch[1], 10) : 0;
    result.total = result.passed + result.failed + result.skipped;
    result.parsed = true;
    return result;
  }

  // Jest-like format: "Tests:  X passed, Y failed, Z total"
  const jestMatch = combined.match(
    /Tests:\s+(\d+)\s+passed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+skipped)?(?:,\s+(\d+)\s+total)?/i
  );
  if (jestMatch) {
    result.passed = parseInt(jestMatch[1], 10);
    result.failed = jestMatch[2] ? parseInt(jestMatch[2], 10) : 0;
    result.skipped = jestMatch[3] ? parseInt(jestMatch[3], 10) : 0;
    result.total = jestMatch[4]
      ? parseInt(jestMatch[4], 10)
      : result.passed + result.failed + result.skipped;
    result.parsed = true;
    return result;
  }

  return result;
}

/**
 * Extract a concise error summary from test output.
 * Used for retry prompts when tests fail.
 */
export function extractTestErrorSummary(
  stdout: string,
  stderr: string
): string {
  const combined = stdout + "\n" + stderr;
  const lines = combined.split("\n");

  const errorLines: string[] = [];
  let capturing = false;
  let contextLines = 0;

  for (const line of lines) {
    const isError =
      /(?:error|fail|FAIL|Error|AssertionError|expect\()/i.test(line) &&
      !/warning/i.test(line);

    if (isError) {
      capturing = true;
      contextLines = 0;
      errorLines.push(line);
    } else if (capturing) {
      contextLines++;
      if (contextLines <= 5) {
        errorLines.push(line);
      } else {
        capturing = false;
      }
    }
  }

  if (errorLines.length === 0) {
    // Fall back to last 30 lines
    const tail = lines.slice(-30).join("\n");
    return truncate(tail, 3000);
  }

  return truncate(errorLines.join("\n"), 3000);
}

/**
 * Truncate a string to maxLen characters.
 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\n\n[... truncated]";
}
