/**
 * test-runner.test.ts — Unit tests for test-runner.ts
 *
 * Coverage:
 *   - parseTestCounts: Bun format, Jest format, unparseable output
 *   - extractTestErrorSummary: error line extraction, context lines, fallback
 *   - runTests: integration test with real commands (echo, exit codes)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseTestCounts,
  extractTestErrorSummary,
  runTests,
} from "../src/lib/test-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wombo-test-runner-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseTestCounts — Bun format
// ---------------------------------------------------------------------------

describe("parseTestCounts — Bun format", () => {
  test("parses pass count", () => {
    const result = parseTestCounts("42 pass", "");
    expect(result.parsed).toBe(true);
    expect(result.passed).toBe(42);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(42);
  });

  test("parses pass and fail counts", () => {
    const result = parseTestCounts("10 pass\n3 fail", "");
    expect(result.parsed).toBe(true);
    expect(result.passed).toBe(10);
    expect(result.failed).toBe(3);
    expect(result.total).toBe(13);
  });

  test("parses pass, fail, and skip counts", () => {
    const result = parseTestCounts("10 pass\n3 fail\n2 skip", "");
    expect(result.parsed).toBe(true);
    expect(result.passed).toBe(10);
    expect(result.failed).toBe(3);
    expect(result.skipped).toBe(2);
    expect(result.total).toBe(15);
  });

  test("parses counts from stderr", () => {
    const result = parseTestCounts("", "5 pass\n1 fail");
    expect(result.parsed).toBe(true);
    expect(result.passed).toBe(5);
    expect(result.failed).toBe(1);
  });

  test("handles case-insensitive matching", () => {
    const result = parseTestCounts("10 PASS", "");
    expect(result.parsed).toBe(true);
    expect(result.passed).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// parseTestCounts — Jest format
// ---------------------------------------------------------------------------

describe("parseTestCounts — Jest format", () => {
  test("parses Tests: X passed, Y total format", () => {
    const result = parseTestCounts("Tests:  5 passed, 5 total", "");
    // The Bun format regex also matches "5 passed" so it may catch this first
    expect(result.parsed).toBe(true);
    expect(result.passed).toBe(5);
  });

  test("parses Tests with failures", () => {
    const result = parseTestCounts("Tests:  3 passed, 2 failed, 5 total", "");
    expect(result.parsed).toBe(true);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// parseTestCounts — Unparseable
// ---------------------------------------------------------------------------

describe("parseTestCounts — Unparseable", () => {
  test("returns parsed=false for empty output", () => {
    const result = parseTestCounts("", "");
    expect(result.parsed).toBe(false);
    expect(result.total).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  test("returns parsed=false for unrecognized format", () => {
    const result = parseTestCounts("All checks completed successfully", "");
    expect(result.parsed).toBe(false);
  });

  test("returns parsed=false for only 'fail' without match pattern", () => {
    // Just the word 'fail' alone won't match because the regex needs \d+\s+fail
    const result = parseTestCounts("Some tests failed\nno counts here", "");
    expect(result.parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractTestErrorSummary
// ---------------------------------------------------------------------------

describe("extractTestErrorSummary", () => {
  test("extracts error lines with context", () => {
    const stdout = [
      "test 1 passed",
      "error: expected true but got false",
      "  at test.ts:42",
      "  at suite.ts:10",
      "test 2 passed",
    ].join("\n");
    const summary = extractTestErrorSummary(stdout, "");
    expect(summary).toContain("error");
    expect(summary).toContain("expected true but got false");
  });

  test("extracts FAIL markers", () => {
    const stdout = "FAIL tests/foo.test.ts\n  some failure details\n  more details";
    const summary = extractTestErrorSummary(stdout, "");
    expect(summary).toContain("FAIL");
  });

  test("falls back to last 30 lines when no error patterns found", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `output line ${i}`);
    const stdout = lines.join("\n");
    const summary = extractTestErrorSummary(stdout, "");
    // Should contain the last lines as fallback (last 30 lines of combined stdout+stderr)
    expect(summary).toContain("output line 49");
    expect(summary).toContain("output line 21");
  });

  test("truncates long error output", () => {
    const longError = "error: ".padEnd(4000, "x");
    const summary = extractTestErrorSummary(longError, "");
    expect(summary.length).toBeLessThanOrEqual(3020); // 3000 + some context
  });

  test("handles empty output", () => {
    const summary = extractTestErrorSummary("", "");
    expect(typeof summary).toBe("string");
  });

  test("captures expect() patterns", () => {
    const stdout = "expect(received).toBe(expected)\n  Expected: true\n  Received: false";
    const summary = extractTestErrorSummary(stdout, "");
    expect(summary).toContain("expect");
  });
});

// ---------------------------------------------------------------------------
// runTests — Integration
// ---------------------------------------------------------------------------

describe("runTests", () => {
  test("captures successful command output", async () => {
    const result = await runTests(tmpDir, "echo '5 pass'");
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("5 pass");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.testCounts.parsed).toBe(true);
    expect(result.testCounts.passed).toBe(5);
  });

  test("captures failing command", async () => {
    const result = await runTests(tmpDir, "exit 1");
    expect(result.passed).toBe(false);
    // Exit code may vary depending on shell
    expect(result.errorSummary).toBeDefined();
  });

  test("captures command with stderr output", async () => {
    const result = await runTests(tmpDir, "echo 'output' && echo 'error' >&2");
    expect(result.passed).toBe(true);
    expect(result.stdout).toContain("output");
    expect(result.stderr).toContain("error");
  });

  test("returns error summary for failed tests", async () => {
    const result = await runTests(
      tmpDir,
      "echo 'error: test failed' && exit 1"
    );
    expect(result.passed).toBe(false);
    expect(result.errorSummary).toContain("error");
  });

  test("respects timeout", async () => {
    // Use a very short timeout
    const result = await runTests(tmpDir, "sleep 10", 100);
    expect(result.passed).toBe(false);
  });

  test("measures duration", async () => {
    const result = await runTests(tmpDir, "echo done");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });
});
