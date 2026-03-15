/**
 * global-flags-parseargs.test.ts — Tests for global flags in parseArgs.
 *
 * TDD: Verifies that parseArgs handles global flags (--output, --force,
 * --dev, -h/--help) correctly in all positions (before command, after
 * command, mixed with other flags).
 *
 * Focus areas:
 *   - --output and -o as pre-command global flags
 *   - --force as pre-command global flag
 *   - --dev sets devMode correctly from any position
 *   - -h/--help routing for all command levels
 *   - --dev bare (no command) defaults to TUI
 */

import { describe, test, expect } from "bun:test";
import { parseArgs } from "../src/index.js";

// Helper to simulate argv from CLI input
function argv(...args: string[]): string[] {
  return ["bun", "script.ts", ...args];
}

// ---------------------------------------------------------------------------
// --output as pre-command global flag
// ---------------------------------------------------------------------------

describe("parseArgs — --output as global pre-command flag", () => {
  test("--output json before command: 'woco --output json launch'", () => {
    const result = parseArgs(argv("--output", "json", "launch"));
    expect(result.command).toBe("launch");
    expect(result.outputFmt).toBe("json");
  });

  test("-o json before command: 'woco -o json tasks list'", () => {
    const result = parseArgs(argv("-o", "json", "tasks", "list"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
    expect(result.outputFmt).toBe("json");
  });

  test("--output toon before command: 'woco --output toon status'", () => {
    const result = parseArgs(argv("--output", "toon", "status"));
    expect(result.command).toBe("status");
    expect(result.outputFmt).toBe("toon");
  });

  test("--output after command still works: 'woco launch --output json'", () => {
    const result = parseArgs(argv("launch", "--output", "json"));
    expect(result.command).toBe("launch");
    expect(result.outputFmt).toBe("json");
  });

  test("-o after command still works: 'woco tasks list -o json'", () => {
    const result = parseArgs(argv("tasks", "list", "-o", "json"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
    expect(result.outputFmt).toBe("json");
  });
});

// ---------------------------------------------------------------------------
// --force as pre-command global flag
// ---------------------------------------------------------------------------

describe("parseArgs — --force as global pre-command flag", () => {
  test("--force before command: 'woco --force init'", () => {
    const result = parseArgs(argv("--force", "init"));
    expect(result.command).toBe("init");
    expect(result.force).toBe(true);
  });

  test("--force after command still works: 'woco init --force'", () => {
    const result = parseArgs(argv("init", "--force"));
    expect(result.command).toBe("init");
    expect(result.force).toBe(true);
  });

  test("--force between other global flags: 'woco --dev --force init'", () => {
    const result = parseArgs(argv("--dev", "--force", "init"));
    expect(result.command).toBe("init");
    expect(result.force).toBe(true);
    expect(result.dev).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --dev as global pre-command flag
// ---------------------------------------------------------------------------

describe("parseArgs — --dev as global pre-command flag", () => {
  test("--dev before command: 'woco --dev launch'", () => {
    const result = parseArgs(argv("--dev", "launch"));
    expect(result.command).toBe("launch");
    expect(result.dev).toBe(true);
  });

  test("--dev after command: 'woco launch --dev'", () => {
    const result = parseArgs(argv("launch", "--dev"));
    expect(result.command).toBe("launch");
    expect(result.dev).toBe(true);
  });

  test("--dev bare (no command): defaults to tui", () => {
    const result = parseArgs(argv("--dev"));
    expect(result.command).toBe("tui");
    expect(result.dev).toBe(true);
  });

  test("--dev with tasks subcommand", () => {
    const result = parseArgs(argv("--dev", "tasks", "list"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
    expect(result.dev).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// -h / --help routing
// ---------------------------------------------------------------------------

describe("parseArgs — -h/--help routing", () => {
  test("-h bare: global help (command defaults to tui)", () => {
    const result = parseArgs(argv("-h"));
    expect(result.command).toBe("tui");
    expect(result.help).toBe(true);
  });

  test("--help bare: global help (command defaults to tui)", () => {
    const result = parseArgs(argv("--help"));
    expect(result.command).toBe("tui");
    expect(result.help).toBe(true);
  });

  test("-h after command for per-command help: 'woco launch -h'", () => {
    const result = parseArgs(argv("launch", "-h"));
    expect(result.command).toBe("launch");
    expect(result.help).toBe(true);
  });

  test("--help after command: 'woco launch --help'", () => {
    const result = parseArgs(argv("launch", "--help"));
    expect(result.command).toBe("launch");
    expect(result.help).toBe(true);
  });

  test("-h before command: 'woco -h launch' extracts help and keeps command", () => {
    const result = parseArgs(argv("-h", "launch"));
    expect(result.command).toBe("launch");
    expect(result.help).toBe(true);
  });

  test("-h with tasks subcommand: 'woco tasks list -h'", () => {
    const result = parseArgs(argv("tasks", "list", "-h"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
    expect(result.help).toBe(true);
  });

  test("-h with tasks (no subcommand): 'woco tasks -h'", () => {
    const result = parseArgs(argv("tasks", "-h"));
    expect(result.command).toBe("tasks");
    expect(result.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// All global flags combined in various positions
// ---------------------------------------------------------------------------

describe("parseArgs — all global flags combined", () => {
  test("all global flags before command", () => {
    const result = parseArgs(argv("--dev", "--force", "--output", "json", "launch"));
    expect(result.command).toBe("launch");
    expect(result.dev).toBe(true);
    expect(result.force).toBe(true);
    expect(result.outputFmt).toBe("json");
  });

  test("global flags scattered: '--dev launch --output json --force'", () => {
    const result = parseArgs(argv("--dev", "launch", "--output", "json", "--force"));
    expect(result.command).toBe("launch");
    expect(result.dev).toBe(true);
    expect(result.force).toBe(true);
    expect(result.outputFmt).toBe("json");
  });

  test("global flags with command-specific flags: '--dev --output json launch --dry-run'", () => {
    const result = parseArgs(argv("--dev", "--output", "json", "launch", "--dry-run"));
    expect(result.command).toBe("launch");
    expect(result.dev).toBe(true);
    expect(result.outputFmt).toBe("json");
    expect(result.dryRun).toBe(true);
  });

  test("global flags with tasks subcommand: '--output json tasks list --status ready'", () => {
    const result = parseArgs(argv("--output", "json", "tasks", "list", "--status", "ready"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
    expect(result.outputFmt).toBe("json");
    expect(result.status).toBe("ready");
  });
});
