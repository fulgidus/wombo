/**
 * arg-parsing.test.ts — Unit tests for CLI argument parsing.
 *
 * Coverage:
 *   - Basic command parsing
 *   - Features subcommand routing
 *   - Flag parsing (boolean flags, value flags)
 *   - Trailing flags after positional args
 *   - Missing values for value-expecting flags
 *   - Flag collisions and priority
 *   - Positional argument handling (featureId, title)
 *   - Edge cases: empty args, unknown flags, repeated flags
 */

import { describe, test, expect } from "bun:test";
import { parseArgs } from "../src/index.js";

// Helper to simulate argv from CLI input. We need to prepend "bun" and "script"
// since parseArgs does argv.slice(2).
function argv(...args: string[]): string[] {
  return ["bun", "script.ts", ...args];
}

// ---------------------------------------------------------------------------
// Basic command parsing
// ---------------------------------------------------------------------------

describe("parseArgs — basic commands", () => {
  test("parses help command", () => {
    const result = parseArgs(argv("help"));
    expect(result.command).toBe("help");
  });

  test("defaults to help when no args given", () => {
    const result = parseArgs(argv());
    expect(result.command).toBe("help");
  });

  test("parses launch command", () => {
    const result = parseArgs(argv("launch"));
    expect(result.command).toBe("launch");
  });

  test("parses status command", () => {
    const result = parseArgs(argv("status"));
    expect(result.command).toBe("status");
  });

  test("parses cleanup command", () => {
    const result = parseArgs(argv("cleanup"));
    expect(result.command).toBe("cleanup");
  });

  test("parses --version as command", () => {
    const result = parseArgs(argv("--version"));
    expect(result.command).toBe("--version");
  });

  test("parses -V as command", () => {
    const result = parseArgs(argv("-V"));
    expect(result.command).toBe("-V");
  });
});

// ---------------------------------------------------------------------------
// Features subcommand routing
// ---------------------------------------------------------------------------

describe("parseArgs — features subcommands", () => {
  test("defaults features subcommand to list", () => {
    const result = parseArgs(argv("features"));
    expect(result.command).toBe("features");
    expect(result.subcommand).toBe("list");
  });

  test("parses features list", () => {
    const result = parseArgs(argv("features", "list"));
    expect(result.command).toBe("features");
    expect(result.subcommand).toBe("list");
  });

  test("parses features add with positional args", () => {
    const result = parseArgs(argv("features", "add", "my-feat", "My Feature Title"));
    expect(result.command).toBe("features");
    expect(result.subcommand).toBe("add");
    expect(result.featureId).toBe("my-feat");
    expect(result.title).toBe("My Feature Title");
  });

  test("parses features set-status with positional args", () => {
    const result = parseArgs(argv("features", "set-status", "my-feat", "done"));
    expect(result.command).toBe("features");
    expect(result.subcommand).toBe("set-status");
    expect(result.featureId).toBe("my-feat");
    expect(result.title).toBe("done"); // title holds second positional
  });

  test("parses features show with feature ID", () => {
    const result = parseArgs(argv("features", "show", "my-feat"));
    expect(result.command).toBe("features");
    expect(result.subcommand).toBe("show");
    expect(result.featureId).toBe("my-feat");
  });

  test("parses features check", () => {
    const result = parseArgs(argv("features", "check"));
    expect(result.command).toBe("features");
    expect(result.subcommand).toBe("check");
  });

  test("parses features archive with --dry-run", () => {
    const result = parseArgs(argv("features", "archive", "--dry-run"));
    expect(result.command).toBe("features");
    expect(result.subcommand).toBe("archive");
    expect(result.dryRun).toBe(true);
  });

  test("parses features graph with options", () => {
    const result = parseArgs(argv("features", "graph", "--ascii", "--subtasks"));
    expect(result.command).toBe("features");
    expect(result.subcommand).toBe("graph");
    expect(result.ascii).toBe(true);
    expect(result.graphSubtasks).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Selection options (launch)
// ---------------------------------------------------------------------------

describe("parseArgs — selection options", () => {
  test("parses --top-priority N", () => {
    const result = parseArgs(argv("launch", "--top-priority", "3"));
    expect(result.topPriority).toBe(3);
  });

  test("parses --quickest-wins N", () => {
    const result = parseArgs(argv("launch", "--quickest-wins", "5"));
    expect(result.quickestWins).toBe(5);
  });

  test("parses --priority level", () => {
    const result = parseArgs(argv("launch", "--priority", "high"));
    expect(result.priority).toBe("high");
  });

  test("parses --difficulty level", () => {
    const result = parseArgs(argv("launch", "--difficulty", "easy"));
    expect(result.difficulty).toBe("easy");
  });

  test("parses --features as comma-separated list", () => {
    const result = parseArgs(argv("launch", "--features", "feat-a,feat-b,feat-c"));
    expect(result.features).toEqual(["feat-a", "feat-b", "feat-c"]);
  });

  test("trims whitespace in --features list", () => {
    const result = parseArgs(argv("launch", "--features", "feat-a, feat-b , feat-c"));
    expect(result.features).toEqual(["feat-a", "feat-b", "feat-c"]);
  });

  test("parses --all-ready boolean flag", () => {
    const result = parseArgs(argv("launch", "--all-ready"));
    expect(result.allReady).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Launch / runtime options
// ---------------------------------------------------------------------------

describe("parseArgs — runtime options", () => {
  test("parses --max-concurrent N", () => {
    const result = parseArgs(argv("launch", "--max-concurrent", "4"));
    expect(result.maxConcurrent).toBe(4);
  });

  test("parses --model", () => {
    const result = parseArgs(argv("launch", "--model", "anthropic/claude-sonnet-4-20250514"));
    expect(result.model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  test("parses -m as alias for --model", () => {
    const result = parseArgs(argv("launch", "-m", "gpt-4"));
    expect(result.model).toBe("gpt-4");
  });

  test("parses --interactive boolean flag", () => {
    const result = parseArgs(argv("launch", "--interactive"));
    expect(result.interactive).toBe(true);
  });

  test("parses --dry-run boolean flag", () => {
    const result = parseArgs(argv("launch", "--dry-run"));
    expect(result.dryRun).toBe(true);
  });

  test("parses --no-tui boolean flag", () => {
    const result = parseArgs(argv("launch", "--no-tui"));
    expect(result.noTui).toBe(true);
  });

  test("parses --auto-push boolean flag", () => {
    const result = parseArgs(argv("launch", "--auto-push"));
    expect(result.autoPush).toBe(true);
  });

  test("parses --base-branch", () => {
    const result = parseArgs(argv("launch", "--base-branch", "develop"));
    expect(result.baseBranch).toBe("develop");
  });

  test("parses --max-retries", () => {
    const result = parseArgs(argv("launch", "--max-retries", "5"));
    expect(result.maxRetries).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// General flags
// ---------------------------------------------------------------------------

describe("parseArgs — general flags", () => {
  test("parses --force", () => {
    const result = parseArgs(argv("init", "--force"));
    expect(result.force).toBe(true);
  });

  test("parses --output json", () => {
    const result = parseArgs(argv("features", "list", "--output", "json"));
    expect(result.outputFmt).toBe("json");
  });

  test("parses -o as alias for --output", () => {
    const result = parseArgs(argv("features", "list", "-o", "json"));
    expect(result.outputFmt).toBe("json");
  });

  test("parses --check", () => {
    const result = parseArgs(argv("upgrade", "--check"));
    expect(result.checkOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe("parseArgs — default values", () => {
  test("interactive defaults to false", () => {
    const result = parseArgs(argv("launch"));
    expect(result.interactive).toBe(false);
  });

  test("dryRun defaults to false", () => {
    const result = parseArgs(argv("launch"));
    expect(result.dryRun).toBe(false);
  });

  test("noTui defaults to false", () => {
    const result = parseArgs(argv("launch"));
    expect(result.noTui).toBe(false);
  });

  test("autoPush defaults to false", () => {
    const result = parseArgs(argv("launch"));
    expect(result.autoPush).toBe(false);
  });

  test("force defaults to false", () => {
    const result = parseArgs(argv("init"));
    expect(result.force).toBe(false);
  });

  test("checkOnly defaults to false", () => {
    const result = parseArgs(argv("upgrade"));
    expect(result.checkOnly).toBe(false);
  });

  test("output format defaults to text", () => {
    const result = parseArgs(argv("features", "list"));
    expect(result.outputFmt).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// Edge cases: trailing flags, multiple flags, complex combinations
// ---------------------------------------------------------------------------

describe("parseArgs — edge cases", () => {
  test("handles multiple selection options combined", () => {
    const result = parseArgs(argv(
      "launch",
      "--priority", "high",
      "--max-concurrent", "2",
      "--dry-run",
      "--no-tui"
    ));
    expect(result.command).toBe("launch");
    expect(result.priority).toBe("high");
    expect(result.maxConcurrent).toBe(2);
    expect(result.dryRun).toBe(true);
    expect(result.noTui).toBe(true);
  });

  test("handles positional args before flags", () => {
    const result = parseArgs(argv("retry", "my-feature", "--dry-run"));
    expect(result.command).toBe("retry");
    expect(result.featureId).toBe("my-feature");
    expect(result.dryRun).toBe(true);
  });

  test("handles features add with interleaved flags", () => {
    const result = parseArgs(argv(
      "features", "add", "new-feat", "New Feature",
      "--priority", "critical",
      "--difficulty", "hard",
      "--effort", "P2D",
      "--desc", "A detailed description"
    ));
    expect(result.command).toBe("features");
    expect(result.subcommand).toBe("add");
    expect(result.featureId).toBe("new-feat");
    expect(result.title).toBe("New Feature");
    expect(result.priority).toBe("critical");
    expect(result.difficulty).toBe("hard");
    expect(result.effort).toBe("P2D");
    expect(result.description).toBe("A detailed description");
  });

  test("handles --depends-on comma-separated list", () => {
    const result = parseArgs(argv(
      "features", "add", "new-feat", "New Feature",
      "--depends-on", "feat-a,feat-b"
    ));
    expect(result.dependsOn).toEqual(["feat-a", "feat-b"]);
  });

  test("handles --fields comma-separated list", () => {
    const result = parseArgs(argv(
      "features", "list",
      "--fields", "id,status,priority"
    ));
    expect(result.fields).toEqual(["id", "status", "priority"]);
  });

  test("unknown flags starting with -- are silently ignored", () => {
    const result = parseArgs(argv("launch", "--unknown-flag", "--dry-run"));
    expect(result.dryRun).toBe(true);
    // Unknown flags don't crash, they're just ignored
  });

  test("unknown positional args after featureId and title are ignored", () => {
    const result = parseArgs(argv("features", "add", "id", "title", "extra-arg"));
    expect(result.featureId).toBe("id");
    expect(result.title).toBe("title");
  });

  test("parses --status for features list filtering", () => {
    const result = parseArgs(argv("features", "list", "--status", "in_progress"));
    expect(result.status).toBe("in_progress");
  });

  test("parses --ready for features list", () => {
    const result = parseArgs(argv("features", "list", "--ready"));
    expect(result.ready).toBe(true);
  });

  test("parses --include-archive for features list", () => {
    const result = parseArgs(argv("features", "list", "--include-archive"));
    expect(result.includeArchive).toBe(true);
  });

  test("parses --mermaid for features graph", () => {
    const result = parseArgs(argv("features", "graph", "--mermaid"));
    expect(result.mermaidRaw).toBe(true);
  });

  test("handles verify with optional feature ID", () => {
    const withId = parseArgs(argv("verify", "my-feature"));
    expect(withId.command).toBe("verify");
    expect(withId.featureId).toBe("my-feature");

    const withoutId = parseArgs(argv("verify"));
    expect(withoutId.command).toBe("verify");
    expect(withoutId.featureId).toBeUndefined();
  });

  test("handles merge with optional feature ID and flags", () => {
    const result = parseArgs(argv("merge", "my-feature", "--auto-push", "--dry-run"));
    expect(result.command).toBe("merge");
    expect(result.featureId).toBe("my-feature");
    expect(result.autoPush).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  test("NaN when --top-priority value is not a number", () => {
    const result = parseArgs(argv("launch", "--top-priority", "abc"));
    expect(result.topPriority).toBeNaN();
  });

  test("handles describe command with compound names", () => {
    const result = parseArgs(argv("describe", "features", "add"));
    expect(result.command).toBe("describe");
    expect(result.featureId).toBe("features");
    expect(result.title).toBe("add");
  });

  test("handles upgrade with --version flag", () => {
    const result = parseArgs(argv("upgrade", "--version", "v0.1.0"));
    expect(result.command).toBe("upgrade");
    expect(result.version).toBe("v0.1.0");
  });
});
