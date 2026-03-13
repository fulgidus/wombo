/**
 * tdd-verifier.test.ts — Unit tests for tdd-verifier.ts
 *
 * Coverage:
 *   - runTddVerification: disabled TDD config, skip-tests flag,
 *     test command execution, strict vs non-strict mode,
 *     overall pass/fail logic, summary building
 *   - extractTddErrorSummary: test failure extraction, missing tests in strict mode
 *   - renderTddVerificationReport: basic rendering (doesn't crash)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runTddVerification,
  extractTddErrorSummary,
  renderTddVerificationReport,
  type TddVerificationResult,
  type TddVerificationOptions,
} from "../src/lib/tdd-verifier.js";
import type { WomboConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wombo-tdd-verifier-"));
  // Initialize a git repo so git diff commands work
  const { execSync } = require("node:child_process");
  execSync("git init && git commit --allow-empty -m 'init'", {
    cwd: tmpDir,
    stdio: "pipe",
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides?: Partial<WomboConfig>): WomboConfig {
  return {
    tasksDir: "tasks",
    archiveDir: "archive",
    baseBranch: "main",
    build: { command: "echo build", timeout: 300_000, artifactDir: "dist" },
    install: { command: "echo install", timeout: 120_000 },
    git: {
      branchPrefix: "feature/",
      remote: "origin",
      mergeStrategy: "--no-ff",
    },
    agent: {
      bin: null,
      name: "generalist-agent",
      configFiles: [],
      tmuxPrefix: "wombo",
      multiplexer: "auto",
    },
    portless: {
      enabled: false,
      bin: null,
      proxyPort: 1355,
      https: false,
    },
    backup: { maxBackups: 5 },
    defaults: { maxConcurrent: 6, maxRetries: 2 },
    browser: {
      enabled: false,
      bin: null,
      headless: true,
      testCommand: null,
      launchTimeout: 30_000,
      testTimeout: 60_000,
      defaultViewport: { width: 1280, height: 720 },
    },
    agentRegistry: {
      mode: "auto",
      source: "msitarzewski/agency-agents",
      cacheDir: "agents-cache",
      cacheTTL: 24 * 60 * 60 * 1000,
    },
    tdd: {
      enabled: true,
      testCommand: "echo '3 pass'",
      strictTdd: false,
      testTimeout: 120_000,
    },
    ...overrides,
  } as WomboConfig;
}

// ---------------------------------------------------------------------------
// runTddVerification — Config-based skipping
// ---------------------------------------------------------------------------

describe("runTddVerification — skipping", () => {
  test("skips when TDD is disabled in config", async () => {
    const config = makeConfig({ tdd: { enabled: false, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 } });
    const result = await runTddVerification({
      worktreePath: tmpDir,
      featureId: "test-feat",
      config,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toContain("disabled");
    expect(result.passed).toBe(true);
    expect(result.testRun).toBeNull();
    expect(result.testDetection).toBeNull();
  });

  test("skips when --skip-tests flag is set", async () => {
    const config = makeConfig();
    const result = await runTddVerification({
      worktreePath: tmpDir,
      featureId: "test-feat",
      config,
      skipTests: true,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toContain("--skip-tests");
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runTddVerification — Test execution
// ---------------------------------------------------------------------------

describe("runTddVerification — test execution", () => {
  test("runs test command and reports success", async () => {
    const config = makeConfig({
      tdd: { enabled: true, testCommand: "echo '5 pass'", strictTdd: false, testTimeout: 120_000 },
    });
    const result = await runTddVerification({
      worktreePath: tmpDir,
      featureId: "test-feat",
      config,
    });
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.testRun).not.toBeNull();
    expect(result.testRun!.passed).toBe(true);
    expect(result.testRun!.testCounts.passed).toBe(5);
  });

  test("reports failure when tests fail", async () => {
    const config = makeConfig({
      tdd: { enabled: true, testCommand: "echo '2 fail' && exit 1", strictTdd: false, testTimeout: 120_000 },
    });
    const result = await runTddVerification({
      worktreePath: tmpDir,
      featureId: "test-feat",
      config,
    });
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.testRun).not.toBeNull();
    expect(result.testRun!.passed).toBe(false);
  });

  test("uses custom test command from config", async () => {
    const config = makeConfig({
      tdd: { enabled: true, testCommand: "echo 'custom 10 pass'", strictTdd: false, testTimeout: 120_000 },
    });
    const result = await runTddVerification({
      worktreePath: tmpDir,
      featureId: "test-feat",
      config,
    });
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.testRun!.stdout).toContain("custom");
  });

  test("falls back to 'bun test' when testCommand is empty", async () => {
    const config = makeConfig({
      tdd: { enabled: true, testCommand: "", strictTdd: false, testTimeout: 120_000 },
    });
    // This will likely fail since there are no tests in tmpDir,
    // but it should still run (uses "bun test" fallback)
    const result = await runTddVerification({
      worktreePath: tmpDir,
      featureId: "test-feat",
      config,
    });
    expect(result.ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runTddVerification — Strict mode
// ---------------------------------------------------------------------------

describe("runTddVerification — strict mode", () => {
  test("reports strictMode flag in result", async () => {
    const config = makeConfig();
    const result = await runTddVerification({
      worktreePath: tmpDir,
      featureId: "test-feat",
      config,
      strictTdd: true,
    });
    expect(result.strictMode).toBe(true);
  });

  test("non-strict mode is default", async () => {
    const config = makeConfig();
    const result = await runTddVerification({
      worktreePath: tmpDir,
      featureId: "test-feat",
      config,
    });
    expect(result.strictMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runTddVerification — Summary
// ---------------------------------------------------------------------------

describe("runTddVerification — summary", () => {
  test("includes test pass/fail info in summary", async () => {
    const config = makeConfig({
      tdd: { enabled: true, testCommand: "echo '5 pass'", strictTdd: false, testTimeout: 120_000 },
    });
    const result = await runTddVerification({
      worktreePath: tmpDir,
      featureId: "test-feat",
      config,
    });
    expect(result.summary).toContain("5 passed");
    expect(result.summary).toContain("0 failed");
  });

  test("includes duration in summary", async () => {
    const config = makeConfig({
      tdd: { enabled: true, testCommand: "echo '1 pass'", strictTdd: false, testTimeout: 120_000 },
    });
    const result = await runTddVerification({
      worktreePath: tmpDir,
      featureId: "test-feat",
      config,
    });
    // Summary includes duration like "(0s)"
    expect(result.summary).toMatch(/\d+s/);
  });
});

// ---------------------------------------------------------------------------
// extractTddErrorSummary
// ---------------------------------------------------------------------------

describe("extractTddErrorSummary", () => {
  test("extracts test run failures", () => {
    const result: TddVerificationResult = {
      ran: true,
      skipReason: null,
      testRun: {
        passed: false,
        exitCode: 1,
        stdout: "",
        stderr: "",
        durationMs: 100,
        testCounts: { total: 5, passed: 3, failed: 2, skipped: 0, parsed: true },
        errorSummary: "expect(true).toBe(false) at test.ts:42",
      },
      testDetection: null,
      passed: false,
      hasWarnings: false,
      summary: "",
      strictMode: false,
    };
    const summary = extractTddErrorSummary(result);
    expect(summary).toContain("Test Failures");
    expect(summary).toContain("expect(true).toBe(false)");
  });

  test("includes missing test files in strict mode", () => {
    const result: TddVerificationResult = {
      ran: true,
      skipReason: null,
      testRun: {
        passed: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 100,
        testCounts: { total: 5, passed: 5, failed: 0, skipped: 0, parsed: true },
        errorSummary: "",
      },
      testDetection: {
        sourceFiles: [],
        withTests: [],
        missingTests: ["src/lib/new-module.ts", "src/lib/another.ts"],
        excludedFiles: [],
        testableCount: 3,
        coveredCount: 1,
        coverageRatio: 0.33,
        coveragePercent: "33.3%",
        comparedTo: "main",
      },
      passed: false,
      hasWarnings: false,
      summary: "",
      strictMode: true,
    };
    const summary = extractTddErrorSummary(result);
    expect(summary).toContain("Missing Tests");
    expect(summary).toContain("src/lib/new-module.ts");
    expect(summary).toContain("src/lib/another.ts");
  });

  test("does not include missing tests in non-strict mode", () => {
    const result: TddVerificationResult = {
      ran: true,
      skipReason: null,
      testRun: {
        passed: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 100,
        testCounts: { total: 5, passed: 5, failed: 0, skipped: 0, parsed: true },
        errorSummary: "",
      },
      testDetection: {
        sourceFiles: [],
        withTests: [],
        missingTests: ["src/lib/new-module.ts"],
        excludedFiles: [],
        testableCount: 2,
        coveredCount: 1,
        coverageRatio: 0.5,
        coveragePercent: "50.0%",
        comparedTo: "main",
      },
      passed: true,
      hasWarnings: true,
      summary: "",
      strictMode: false,
    };
    const summary = extractTddErrorSummary(result);
    expect(summary).not.toContain("Missing Tests");
  });

  test("handles result with no test run errors", () => {
    const result: TddVerificationResult = {
      ran: true,
      skipReason: null,
      testRun: {
        passed: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 100,
        testCounts: { total: 5, passed: 5, failed: 0, skipped: 0, parsed: true },
        errorSummary: "",
      },
      testDetection: null,
      passed: true,
      hasWarnings: false,
      summary: "",
      strictMode: false,
    };
    const summary = extractTddErrorSummary(result);
    expect(summary).toBe("");
  });

  test("truncates very long error summaries", () => {
    const result: TddVerificationResult = {
      ran: true,
      skipReason: null,
      testRun: {
        passed: false,
        exitCode: 1,
        stdout: "",
        stderr: "",
        durationMs: 100,
        testCounts: { total: 1, passed: 0, failed: 1, skipped: 0, parsed: true },
        errorSummary: "x".repeat(5000),
      },
      testDetection: null,
      passed: false,
      hasWarnings: false,
      summary: "",
      strictMode: false,
    };
    const summary = extractTddErrorSummary(result);
    expect(summary.length).toBeLessThanOrEqual(4000);
  });
});

// ---------------------------------------------------------------------------
// renderTddVerificationReport — smoke test
// ---------------------------------------------------------------------------

describe("renderTddVerificationReport", () => {
  test("renders skipped result without error", () => {
    const result: TddVerificationResult = {
      ran: false,
      skipReason: "TDD disabled",
      testRun: null,
      testDetection: null,
      passed: true,
      hasWarnings: false,
      summary: "Skipped",
      strictMode: false,
    };
    // Should not throw
    expect(() => renderTddVerificationReport(result)).not.toThrow();
  });

  test("renders full result without error", () => {
    const result: TddVerificationResult = {
      ran: true,
      skipReason: null,
      testRun: {
        passed: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 500,
        testCounts: { total: 10, passed: 10, failed: 0, skipped: 0, parsed: true },
        errorSummary: "",
      },
      testDetection: {
        sourceFiles: [],
        withTests: ["src/lib/foo.ts"],
        missingTests: [],
        excludedFiles: ["src/types.d.ts"],
        testableCount: 1,
        coveredCount: 1,
        coverageRatio: 1.0,
        coveragePercent: "100.0%",
        comparedTo: "main",
      },
      passed: true,
      hasWarnings: false,
      summary: "Tests: 10 passed, 0 failed (0s)",
      strictMode: false,
    };
    expect(() => renderTddVerificationReport(result)).not.toThrow();
  });

  test("renders failed result with warnings without error", () => {
    const result: TddVerificationResult = {
      ran: true,
      skipReason: null,
      testRun: {
        passed: false,
        exitCode: 1,
        stdout: "",
        stderr: "",
        durationMs: 200,
        testCounts: { total: 5, passed: 3, failed: 2, skipped: 0, parsed: true },
        errorSummary: "2 tests failed",
      },
      testDetection: null,
      passed: false,
      hasWarnings: true,
      summary: "Tests: 3 passed, 2 failed (0s)",
      strictMode: true,
    };
    expect(() => renderTddVerificationReport(result)).not.toThrow();
  });
});
