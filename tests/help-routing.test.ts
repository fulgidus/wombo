/**
 * help-routing.test.ts — Tests for help routing with global flags.
 *
 * TDD: Verifies that -h/--help correctly routes to:
 *   - Global help when no command is present
 *   - Per-command help when a command is present
 *   - Parent help for commands with subcommands (tasks, quest, wishlist)
 *   - Subcommand help when a subcommand is explicitly typed
 *
 * Also tests that --dev and other global flags don't interfere with help routing.
 */

import { describe, test, expect } from "bun:test";
import { parseArgs } from "../src/index.js";

// Helper to simulate argv from CLI input
function argv(...args: string[]): string[] {
  return ["bun", "script.ts", ...args];
}

// ---------------------------------------------------------------------------
// Help flag routing through parseArgs
// ---------------------------------------------------------------------------

describe("help routing — parseArgs level", () => {
  test("bare -h: command=tui, help=true (global help)", () => {
    const result = parseArgs(argv("-h"));
    expect(result.command).toBe("tui");
    expect(result.help).toBe(true);
  });

  test("bare --help: command=tui, help=true (global help)", () => {
    const result = parseArgs(argv("--help"));
    expect(result.command).toBe("tui");
    expect(result.help).toBe(true);
  });

  test("'launch -h': command=launch, help=true (per-command help)", () => {
    const result = parseArgs(argv("launch", "-h"));
    expect(result.command).toBe("launch");
    expect(result.help).toBe(true);
  });

  test("'launch --help': command=launch, help=true (per-command help)", () => {
    const result = parseArgs(argv("launch", "--help"));
    expect(result.command).toBe("launch");
    expect(result.help).toBe(true);
  });

  test("'-h launch': command=launch, help=true (help before command)", () => {
    const result = parseArgs(argv("-h", "launch"));
    expect(result.command).toBe("launch");
    expect(result.help).toBe(true);
  });

  test("'--help launch': command=launch, help=true (help before command)", () => {
    const result = parseArgs(argv("--help", "launch"));
    expect(result.command).toBe("launch");
    expect(result.help).toBe(true);
  });

  test("'tasks -h': command=tasks, help=true (parent help)", () => {
    const result = parseArgs(argv("tasks", "-h"));
    expect(result.command).toBe("tasks");
    expect(result.help).toBe(true);
  });

  test("'tasks list -h': command=tasks, subcommand=list, help=true", () => {
    const result = parseArgs(argv("tasks", "list", "-h"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
    expect(result.help).toBe(true);
  });

  test("'quest -h': command=quest, help=true (parent help)", () => {
    const result = parseArgs(argv("quest", "-h"));
    expect(result.command).toBe("quest");
    expect(result.help).toBe(true);
  });

  test("'wishlist -h': command=wishlist, help=true (parent help)", () => {
    const result = parseArgs(argv("wishlist", "-h"));
    expect(result.command).toBe("wishlist");
    expect(result.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Help + --dev combined
// ---------------------------------------------------------------------------

describe("help routing — with --dev flag", () => {
  test("'--dev -h': dev=true, command=tui, help=true (global help in dev mode)", () => {
    const result = parseArgs(argv("--dev", "-h"));
    expect(result.dev).toBe(true);
    expect(result.command).toBe("tui");
    expect(result.help).toBe(true);
  });

  test("'--dev launch -h': dev=true, command=launch, help=true", () => {
    const result = parseArgs(argv("--dev", "launch", "-h"));
    expect(result.dev).toBe(true);
    expect(result.command).toBe("launch");
    expect(result.help).toBe(true);
  });

  test("'-h --dev launch': dev=true, command=launch, help=true", () => {
    const result = parseArgs(argv("-h", "--dev", "launch"));
    expect(result.dev).toBe(true);
    expect(result.command).toBe("launch");
    expect(result.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Help + --output combined
// ---------------------------------------------------------------------------

describe("help routing — with --output flag", () => {
  test("'--output json -h': output=json, command=tui, help=true", () => {
    const result = parseArgs(argv("--output", "json", "-h"));
    expect(result.outputFmt).toBe("json");
    expect(result.command).toBe("tui");
    expect(result.help).toBe(true);
  });

  test("'--output json launch -h': output=json, command=launch, help=true", () => {
    const result = parseArgs(argv("--output", "json", "launch", "-h"));
    expect(result.outputFmt).toBe("json");
    expect(result.command).toBe("launch");
    expect(result.help).toBe(true);
  });

  test("'-o json tasks list -h': output=json, tasks list help", () => {
    const result = parseArgs(argv("-o", "json", "tasks", "list", "-h"));
    expect(result.outputFmt).toBe("json");
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
    expect(result.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Help + --force combined
// ---------------------------------------------------------------------------

describe("help routing — with --force flag", () => {
  test("'--force -h': force=true, command=tui, help=true", () => {
    const result = parseArgs(argv("--force", "-h"));
    expect(result.force).toBe(true);
    expect(result.command).toBe("tui");
    expect(result.help).toBe(true);
  });

  test("'--force init -h': force=true, command=init, help=true", () => {
    const result = parseArgs(argv("--force", "init", "-h"));
    expect(result.force).toBe(true);
    expect(result.command).toBe("init");
    expect(result.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Help with alias commands
// ---------------------------------------------------------------------------

describe("help routing — with command aliases", () => {
  test("'l -h': alias l → launch, help=true", () => {
    const result = parseArgs(argv("l", "-h"));
    expect(result.command).toBe("launch");
    expect(result.help).toBe(true);
  });

  test("'t -h': alias t → tasks, help=true (parent help)", () => {
    const result = parseArgs(argv("t", "-h"));
    expect(result.command).toBe("tasks");
    expect(result.help).toBe(true);
  });

  test("'t ls -h': alias t ls → tasks list, help=true (subcommand help)", () => {
    const result = parseArgs(argv("t", "ls", "-h"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
    expect(result.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Help with "help" as explicit command (not flag)
// ---------------------------------------------------------------------------

describe("help routing — explicit help command", () => {
  test("'help' as command", () => {
    const result = parseArgs(argv("help"));
    expect(result.command).toBe("help");
    expect(result.help).toBeUndefined();
  });

  test("'--help' as command (not flag when it's the only arg)", () => {
    // When --help is in the original args, it gets stripped and help=true,
    // command defaults to tui
    const result = parseArgs(argv("--help"));
    expect(result.help).toBe(true);
    expect(result.command).toBe("tui");
  });
});
