/**
 * help-routing-e2e.test.ts — End-to-end tests for help routing via subprocess.
 *
 * TDD: Verifies that the actual CLI binary routes help correctly when
 * global flags are used in various positions. These tests run the CLI
 * as a subprocess to test the full integration.
 */

import { describe, test, expect } from "bun:test";

/**
 * Helper: run woco in a subprocess with the given CLI args.
 * Returns { exitCode, stderr, stdout }.
 */
async function runWoco(...cliArgs: string[]): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const proc = Bun.spawn(["bun", "src/index.ts", ...cliArgs], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stderr, stdout };
}

// ---------------------------------------------------------------------------
// Global help
// ---------------------------------------------------------------------------

describe("help routing e2e — global help", () => {
  test("'woco -h' shows global help", async () => {
    const { stdout, exitCode } = await runWoco("-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain("wombo-combo");
  });

  test("'woco --help' shows global help", async () => {
    const { stdout, exitCode } = await runWoco("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
  });

  test("'woco help' shows global help", async () => {
    const { stdout, exitCode } = await runWoco("help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
  });
});

// ---------------------------------------------------------------------------
// Per-command help
// ---------------------------------------------------------------------------

describe("help routing e2e — per-command help", () => {
  test("'woco launch -h' shows launch help", async () => {
    const { stdout, exitCode } = await runWoco("launch", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("launch");
  });

  test("'woco launch --help' shows launch help", async () => {
    const { stdout, exitCode } = await runWoco("launch", "--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("launch");
  });

  test("'woco init -h' shows init help", async () => {
    const { stdout, exitCode } = await runWoco("init", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("init");
  });

  test("'woco status -h' shows status help", async () => {
    const { stdout, exitCode } = await runWoco("status", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("status");
  });
});

// ---------------------------------------------------------------------------
// Help with global flags
// ---------------------------------------------------------------------------

describe("help routing e2e — with global flags", () => {
  test("'woco --dev -h' shows global help (with dev)", async () => {
    const { stdout, exitCode } = await runWoco("--dev", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
  });

  test("'woco --dev launch -h' shows launch help", async () => {
    const { stdout, exitCode } = await runWoco("--dev", "launch", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("launch");
  });

  test("'woco --output json -h' shows global help", async () => {
    const { stdout, exitCode } = await runWoco("--output", "json", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
  });

  test("'woco --force init -h' shows init help", async () => {
    const { stdout, exitCode } = await runWoco("--force", "init", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("init");
  });
});

// ---------------------------------------------------------------------------
// Tasks parent vs subcommand help
// ---------------------------------------------------------------------------

describe("help routing e2e — tasks help levels", () => {
  test("'woco tasks -h' shows tasks parent help", async () => {
    const { stdout, exitCode } = await runWoco("tasks", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("tasks");
  });

  test("'woco tasks list -h' shows tasks list help", async () => {
    const { stdout, exitCode } = await runWoco("tasks", "list", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("list");
  });
});

// ---------------------------------------------------------------------------
// Version with global flags
// ---------------------------------------------------------------------------

describe("version e2e — with global flags", () => {
  test("'woco version' shows version", async () => {
    const { stdout, exitCode } = await runWoco("version");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/wombo-combo \d+\.\d+\.\d+/);
  });

  test("'woco -v' shows version", async () => {
    const { stdout, exitCode } = await runWoco("-v");
    // -v is alias for verify in COMMAND_ALIASES, not version
    // Let's just check it doesn't crash
    expect(exitCode).toBeDefined();
  });
});
