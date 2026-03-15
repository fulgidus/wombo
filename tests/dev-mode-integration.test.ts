/**
 * dev-mode-integration.test.ts — Integration tests for --dev devMode behavior.
 *
 * TDD: Verifies that --dev flag correctly integrates across the full stack:
 *   - parseArgs extracts --dev from any position and sets dev: true
 *   - resolveGlobalFlagsAndCommand extracts --dev and maps bare --dev to tui
 *   - extractGlobalFlags strips --dev and preserves remaining args
 *   - --dev combined with all other global flags works correctly
 *   - e2e: --dev doesn't interfere with help or version output
 *
 * These tests focus on the integration between layers, not individual
 * unit behavior (which is tested in the per-module test files).
 */

import { describe, test, expect } from "bun:test";
import { parseArgs } from "../src/index.js";
import { extractGlobalFlags } from "../src/commands/citty/global-flags.js";
import { resolveGlobalFlagsAndCommand } from "../src/commands/citty/router.js";

// Helper to simulate argv from CLI input
function argv(...args: string[]): string[] {
  return ["bun", "script.ts", ...args];
}

// ---------------------------------------------------------------------------
// Cross-layer consistency: parseArgs ↔ extractGlobalFlags ↔ resolveGlobalFlagsAndCommand
// ---------------------------------------------------------------------------

describe("--dev integration — cross-layer consistency", () => {
  test("all three layers agree: --dev before command", () => {
    // extractGlobalFlags (lowest level)
    const extracted = extractGlobalFlags(["--dev", "launch"]);
    expect(extracted.flags.dev).toBe(true);
    expect(extracted.remaining).toEqual(["launch"]);

    // resolveGlobalFlagsAndCommand (mid level — uses extractGlobalFlags)
    const resolved = resolveGlobalFlagsAndCommand(["--dev", "launch"]);
    expect(resolved.globalFlags.dev).toBe(true);
    expect(resolved.command).toBe("launch");

    // parseArgs (top level — own pre-scan logic)
    const parsed = parseArgs(argv("--dev", "launch"));
    expect(parsed.dev).toBe(true);
    expect(parsed.command).toBe("launch");
  });

  test("all three layers agree: --dev after command", () => {
    const extracted = extractGlobalFlags(["launch", "--dev"]);
    expect(extracted.flags.dev).toBe(true);
    expect(extracted.remaining).toEqual(["launch"]);

    const resolved = resolveGlobalFlagsAndCommand(["launch", "--dev"]);
    expect(resolved.globalFlags.dev).toBe(true);
    expect(resolved.command).toBe("launch");

    const parsed = parseArgs(argv("launch", "--dev"));
    expect(parsed.dev).toBe(true);
    expect(parsed.command).toBe("launch");
  });

  test("all three layers agree: bare --dev defaults to tui", () => {
    const extracted = extractGlobalFlags(["--dev"]);
    expect(extracted.flags.dev).toBe(true);
    expect(extracted.remaining).toEqual([]);

    const resolved = resolveGlobalFlagsAndCommand(["--dev"]);
    expect(resolved.globalFlags.dev).toBe(true);
    expect(resolved.command).toBe("tui");

    const parsed = parseArgs(argv("--dev"));
    expect(parsed.dev).toBe(true);
    expect(parsed.command).toBe("tui");
  });

  test("all three layers agree: --dev with --force and --output", () => {
    const args = ["--dev", "--force", "--output", "json", "launch"];

    const extracted = extractGlobalFlags(args);
    expect(extracted.flags.dev).toBe(true);
    expect(extracted.flags.force).toBe(true);
    expect(extracted.flags.output).toBe("json");
    expect(extracted.remaining).toEqual(["launch"]);

    const resolved = resolveGlobalFlagsAndCommand(args);
    expect(resolved.globalFlags.dev).toBe(true);
    expect(resolved.globalFlags.force).toBe(true);
    expect(resolved.globalFlags.output).toBe("json");
    expect(resolved.command).toBe("launch");

    const parsed = parseArgs(argv(...args));
    expect(parsed.dev).toBe(true);
    expect(parsed.force).toBe(true);
    expect(parsed.outputFmt).toBe("json");
    expect(parsed.command).toBe("launch");
  });
});

// ---------------------------------------------------------------------------
// --dev with tasks subcommands
// ---------------------------------------------------------------------------

describe("--dev integration — tasks subcommands", () => {
  test("'--dev tasks list' preserves subcommand across layers", () => {
    const args = ["--dev", "tasks", "list"];

    const extracted = extractGlobalFlags(args);
    expect(extracted.flags.dev).toBe(true);
    expect(extracted.remaining).toEqual(["tasks", "list"]);

    const resolved = resolveGlobalFlagsAndCommand(args);
    expect(resolved.command).toBe("tasks");
    expect(resolved.remaining).toEqual(["list"]);

    const parsed = parseArgs(argv(...args));
    expect(parsed.dev).toBe(true);
    expect(parsed.command).toBe("tasks");
    expect(parsed.subcommand).toBe("list");
  });

  test("'tasks --dev list' extracts --dev from mid-position", () => {
    const args = ["tasks", "--dev", "list"];

    const extracted = extractGlobalFlags(args);
    expect(extracted.flags.dev).toBe(true);
    expect(extracted.remaining).toEqual(["tasks", "list"]);

    const resolved = resolveGlobalFlagsAndCommand(args);
    expect(resolved.command).toBe("tasks");
    expect(resolved.remaining).toEqual(["list"]);

    // parseArgs handles this correctly because --dev is stripped in pre-scan
    const parsed = parseArgs(argv(...args));
    expect(parsed.dev).toBe(true);
    expect(parsed.command).toBe("tasks");
    expect(parsed.subcommand).toBe("list");
  });

  test("'tasks list --dev' extracts --dev from end position", () => {
    const args = ["tasks", "list", "--dev"];

    const extracted = extractGlobalFlags(args);
    expect(extracted.flags.dev).toBe(true);
    expect(extracted.remaining).toEqual(["tasks", "list"]);

    const parsed = parseArgs(argv(...args));
    expect(parsed.dev).toBe(true);
    expect(parsed.command).toBe("tasks");
    expect(parsed.subcommand).toBe("list");
  });
});

// ---------------------------------------------------------------------------
// --dev combined with -h/--help
// ---------------------------------------------------------------------------

describe("--dev integration — combined with help", () => {
  test("'--dev -h' → tui with dev + help", () => {
    const parsed = parseArgs(argv("--dev", "-h"));
    expect(parsed.dev).toBe(true);
    expect(parsed.help).toBe(true);
    expect(parsed.command).toBe("tui");
  });

  test("'--dev launch -h' → launch with dev + help", () => {
    const parsed = parseArgs(argv("--dev", "launch", "-h"));
    expect(parsed.dev).toBe(true);
    expect(parsed.help).toBe(true);
    expect(parsed.command).toBe("launch");
  });

  test("'-h --dev' → tui with dev + help (order doesn't matter)", () => {
    const parsed = parseArgs(argv("-h", "--dev"));
    expect(parsed.dev).toBe(true);
    expect(parsed.help).toBe(true);
    expect(parsed.command).toBe("tui");
  });

  test("'launch -h --dev' → launch with dev + help", () => {
    const parsed = parseArgs(argv("launch", "-h", "--dev"));
    expect(parsed.dev).toBe(true);
    expect(parsed.help).toBe(true);
    expect(parsed.command).toBe("launch");
  });
});

// ---------------------------------------------------------------------------
// --dev with command-specific flags (no interference)
// ---------------------------------------------------------------------------

describe("--dev integration — no interference with command flags", () => {
  test("'--dev launch --dry-run --max-concurrent 3' preserves all flags", () => {
    const parsed = parseArgs(argv("--dev", "launch", "--dry-run", "--max-concurrent", "3"));
    expect(parsed.dev).toBe(true);
    expect(parsed.command).toBe("launch");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.maxConcurrent).toBe(3);
  });

  test("'--dev --output json launch --dry-run' combines global + command flags", () => {
    const parsed = parseArgs(argv("--dev", "--output", "json", "launch", "--dry-run"));
    expect(parsed.dev).toBe(true);
    expect(parsed.outputFmt).toBe("json");
    expect(parsed.command).toBe("launch");
    expect(parsed.dryRun).toBe(true);
  });

  test("'launch --model claude --dev --force' dev and force extracted, model preserved", () => {
    const parsed = parseArgs(argv("launch", "--model", "claude", "--dev", "--force"));
    expect(parsed.dev).toBe(true);
    expect(parsed.force).toBe(true);
    expect(parsed.command).toBe("launch");
    expect(parsed.model).toBe("claude");
  });

  test("'--dev tasks add my-task \"My Task\" --priority high' preserves positional + named args", () => {
    const parsed = parseArgs(argv("--dev", "tasks", "add", "my-task", "My Task", "--priority", "high"));
    expect(parsed.dev).toBe(true);
    expect(parsed.command).toBe("tasks");
    expect(parsed.subcommand).toBe("add");
    expect(parsed.priority).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// e2e: --dev doesn't break help or version output
// ---------------------------------------------------------------------------

describe("--dev integration e2e — subprocess tests", () => {
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

  test("'--dev version' still shows version string", async () => {
    const { stdout, exitCode } = await runWoco("--dev", "version");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/wombo-combo \d+\.\d+\.\d+/);
  });

  test("'version --dev' still shows version string", async () => {
    const { stdout, exitCode } = await runWoco("version", "--dev");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/wombo-combo \d+\.\d+\.\d+/);
  });

  test("'--dev -h' still shows global help", async () => {
    const { stdout, exitCode } = await runWoco("--dev", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain("wombo-combo");
  });

  test("'--dev launch -h' still shows launch help", async () => {
    const { stdout, exitCode } = await runWoco("--dev", "launch", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("launch");
  });

  test("'--dev --output json -h' still shows global help", async () => {
    const { stdout, exitCode } = await runWoco("--dev", "--output", "json", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
  });

  test("'--dev --force init -h' still shows init help", async () => {
    const { stdout, exitCode } = await runWoco("--dev", "--force", "init", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("init");
  });

  test("'--dev tasks -h' shows tasks parent help", async () => {
    const { stdout, exitCode } = await runWoco("--dev", "tasks", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("tasks");
  });

  test("'--dev tasks list -h' shows tasks list help", async () => {
    const { stdout, exitCode } = await runWoco("--dev", "tasks", "list", "-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("list");
  });
});
