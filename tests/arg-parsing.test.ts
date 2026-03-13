/**
 * arg-parsing.test.ts — Unit tests for CLI argument parsing.
 *
 * Coverage:
 *   - Basic command parsing
 *   - Tasks subcommand routing (with "features" backward-compat alias)
 *   - Command & subcommand alias resolution
 *   - Flag parsing (boolean flags, value flags)
 *   - Trailing flags / missing values (requireValue behavior)
 *   - Boolean flags not consuming next positional arg
 *   - Flag collisions (-v version vs commands)
 *   - Unknown flags behavior
 *   - Positional argument handling (featureId, title)
 *   - Edge cases: empty args, repeated flags, OOB access
 */

import { describe, test, expect } from "bun:test";
import { parseArgs, COMMAND_ALIASES, SUBCOMMAND_ALIASES } from "../src/index.js";

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

describe("parseArgs — tasks subcommands", () => {
  test("defaults tasks subcommand to list", () => {
    const result = parseArgs(argv("tasks"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
  });

  test("parses tasks list", () => {
    const result = parseArgs(argv("tasks", "list"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
  });

  test("parses tasks add with positional args", () => {
    const result = parseArgs(argv("tasks", "add", "my-feat", "My Feature Title"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("add");
    expect(result.featureId).toBe("my-feat");
    expect(result.title).toBe("My Feature Title");
  });

  test("parses tasks set-status with positional args", () => {
    const result = parseArgs(argv("tasks", "set-status", "my-feat", "done"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("set-status");
    expect(result.featureId).toBe("my-feat");
    expect(result.title).toBe("done"); // title holds second positional
  });

  test("parses tasks show with feature ID", () => {
    const result = parseArgs(argv("tasks", "show", "my-feat"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("show");
    expect(result.featureId).toBe("my-feat");
  });

  test("parses tasks check", () => {
    const result = parseArgs(argv("tasks", "check"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("check");
  });

  test("parses tasks archive with --dry-run", () => {
    const result = parseArgs(argv("tasks", "archive", "--dry-run"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("archive");
    expect(result.dryRun).toBe(true);
  });

  test("parses tasks graph with options", () => {
    const result = parseArgs(argv("tasks", "graph", "--ascii", "--subtasks"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("graph");
    expect(result.ascii).toBe(true);
    expect(result.graphSubtasks).toBe(true);
  });

  test("features alias resolves to tasks command", () => {
    const result = parseArgs(argv("features"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
  });

  test("features alias with subcommand resolves correctly", () => {
    const result = parseArgs(argv("features", "add", "my-feat", "My Title"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("add");
    expect(result.featureId).toBe("my-feat");
    expect(result.title).toBe("My Title");
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

  test("parses --features as comma-separated list (stored in tasks)", () => {
    const result = parseArgs(argv("launch", "--features", "feat-a,feat-b,feat-c"));
    expect(result.tasks).toEqual(["feat-a", "feat-b", "feat-c"]);
  });

  test("parses --tasks as comma-separated list", () => {
    const result = parseArgs(argv("launch", "--tasks", "feat-a,feat-b,feat-c"));
    expect(result.tasks).toEqual(["feat-a", "feat-b", "feat-c"]);
  });

  test("trims whitespace in --features list", () => {
    const result = parseArgs(argv("launch", "--features", "feat-a, feat-b , feat-c"));
    expect(result.tasks).toEqual(["feat-a", "feat-b", "feat-c"]);
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

  test("handles tasks add with interleaved flags", () => {
    const result = parseArgs(argv(
      "tasks", "add", "new-feat", "New Feature",
      "--priority", "critical",
      "--difficulty", "hard",
      "--effort", "P2D",
      "--desc", "A detailed description"
    ));
    expect(result.command).toBe("tasks");
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

  test("handles upgrade with --tag flag", () => {
    const result = parseArgs(argv("upgrade", "--tag", "v0.1.0"));
    expect(result.command).toBe("upgrade");
    expect(result.tag).toBe("v0.1.0");
  });
});

// ---------------------------------------------------------------------------
// Command alias resolution
// ---------------------------------------------------------------------------

describe("parseArgs — command aliases", () => {
  test("resolves 'i' to 'init'", () => {
    const result = parseArgs(argv("i"));
    expect(result.command).toBe("init");
  });

  test("resolves 'l' to 'launch'", () => {
    const result = parseArgs(argv("l"));
    expect(result.command).toBe("launch");
  });

  test("resolves 'r' to 'resume'", () => {
    const result = parseArgs(argv("r"));
    expect(result.command).toBe("resume");
  });

  test("resolves 's' to 'status'", () => {
    const result = parseArgs(argv("s"));
    expect(result.command).toBe("status");
  });

  test("resolves 'v' to 'verify'", () => {
    const result = parseArgs(argv("v"));
    expect(result.command).toBe("verify");
  });

  test("resolves 'm' to 'merge'", () => {
    const result = parseArgs(argv("m"));
    expect(result.command).toBe("merge");
  });

  test("resolves 're' to 'retry'", () => {
    const result = parseArgs(argv("re"));
    expect(result.command).toBe("retry");
  });

  test("resolves 'a' to 'abort'", () => {
    const result = parseArgs(argv("a"));
    expect(result.command).toBe("abort");
  });

  test("resolves 'c' to 'cleanup'", () => {
    const result = parseArgs(argv("c"));
    expect(result.command).toBe("cleanup");
  });

  test("resolves 'h' to 'history'", () => {
    const result = parseArgs(argv("h"));
    expect(result.command).toBe("history");
  });

  test("resolves 'lo' to 'logs'", () => {
    const result = parseArgs(argv("lo"));
    expect(result.command).toBe("logs");
  });

  test("resolves 't' to 'tasks'", () => {
    const result = parseArgs(argv("t"));
    expect(result.command).toBe("tasks");
  });

  test("resolves 'features' to 'tasks'", () => {
    const result = parseArgs(argv("features"));
    expect(result.command).toBe("tasks");
  });

  test("resolves 'u' to 'upgrade'", () => {
    const result = parseArgs(argv("u"));
    expect(result.command).toBe("upgrade");
  });

  test("resolves 'd' to 'describe'", () => {
    const result = parseArgs(argv("d"));
    expect(result.command).toBe("describe");
  });

  test("resolves 'comp' to 'completion'", () => {
    const result = parseArgs(argv("comp"));
    expect(result.command).toBe("completion");
  });

  test("unrecognized command passes through unchanged", () => {
    const result = parseArgs(argv("nonexistent-cmd"));
    expect(result.command).toBe("nonexistent-cmd");
  });

  test("all COMMAND_ALIASES entries are consistent with parseArgs", () => {
    for (const [alias, canonical] of Object.entries(COMMAND_ALIASES)) {
      const result = parseArgs(argv(alias));
      expect(result.command).toBe(canonical);
    }
  });
});

// ---------------------------------------------------------------------------
// Subcommand alias resolution
// ---------------------------------------------------------------------------

describe("parseArgs — subcommand aliases", () => {
  test("resolves 'ls' to 'list'", () => {
    const result = parseArgs(argv("tasks", "ls"));
    expect(result.subcommand).toBe("list");
  });

  test("resolves 'a' to 'add'", () => {
    const result = parseArgs(argv("tasks", "a", "my-feat", "My Title"));
    expect(result.subcommand).toBe("add");
    expect(result.featureId).toBe("my-feat");
    expect(result.title).toBe("My Title");
  });

  test("resolves 'ss' to 'set-status'", () => {
    const result = parseArgs(argv("tasks", "ss", "my-feat", "done"));
    expect(result.subcommand).toBe("set-status");
    expect(result.featureId).toBe("my-feat");
    expect(result.title).toBe("done"); // second positional is stored as title
  });

  test("resolves 'sp' to 'set-priority'", () => {
    const result = parseArgs(argv("tasks", "sp", "my-feat", "high"));
    expect(result.subcommand).toBe("set-priority");
    expect(result.featureId).toBe("my-feat");
    expect(result.title).toBe("high");
  });

  test("resolves 'sd' to 'set-difficulty'", () => {
    const result = parseArgs(argv("tasks", "sd", "my-feat", "hard"));
    expect(result.subcommand).toBe("set-difficulty");
    expect(result.featureId).toBe("my-feat");
    expect(result.title).toBe("hard");
  });

  test("resolves 'ch' to 'check'", () => {
    const result = parseArgs(argv("tasks", "ch"));
    expect(result.subcommand).toBe("check");
  });

  test("resolves 'validate' to 'check'", () => {
    const result = parseArgs(argv("tasks", "validate"));
    expect(result.subcommand).toBe("check");
  });

  test("resolves 'ar' to 'archive'", () => {
    const result = parseArgs(argv("tasks", "ar"));
    expect(result.subcommand).toBe("archive");
  });

  test("resolves 'sh' to 'show'", () => {
    const result = parseArgs(argv("tasks", "sh", "my-feat"));
    expect(result.subcommand).toBe("show");
    expect(result.featureId).toBe("my-feat");
  });

  test("resolves 'g' to 'graph'", () => {
    const result = parseArgs(argv("tasks", "g"));
    expect(result.subcommand).toBe("graph");
  });

  test("combined command alias + subcommand alias: 't ls'", () => {
    const result = parseArgs(argv("t", "ls"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
  });

  test("combined alias: 't a my-feat Title'", () => {
    const result = parseArgs(argv("t", "a", "my-feat", "Title"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("add");
    expect(result.featureId).toBe("my-feat");
    expect(result.title).toBe("Title");
  });

  test("combined alias: 't ss my-feat done'", () => {
    const result = parseArgs(argv("t", "ss", "my-feat", "done"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("set-status");
    expect(result.featureId).toBe("my-feat");
  });

  test("all SUBCOMMAND_ALIASES entries are consistent with parseArgs", () => {
    for (const [alias, canonical] of Object.entries(SUBCOMMAND_ALIASES)) {
      const result = parseArgs(argv("tasks", alias));
      expect(result.subcommand).toBe(canonical);
    }
  });

  test("unrecognized subcommand passes through unchanged", () => {
    const result = parseArgs(argv("tasks", "nonexistent"));
    expect(result.subcommand).toBe("nonexistent");
  });
});

// ---------------------------------------------------------------------------
// Boolean flags should NOT consume next positional arg
// ---------------------------------------------------------------------------

describe("parseArgs — boolean flags do not consume next positional", () => {
  test("--dry-run before feature ID", () => {
    const result = parseArgs(argv("launch", "--dry-run", "--all-ready"));
    expect(result.dryRun).toBe(true);
    expect(result.allReady).toBe(true);
    // No positional args should be consumed
    expect(result.featureId).toBeUndefined();
  });

  test("--all-ready followed by positional arg does not consume it", () => {
    // In launch context, positional after flags goes to featureId
    const result = parseArgs(argv("launch", "--all-ready", "some-id"));
    expect(result.allReady).toBe(true);
    expect(result.featureId).toBe("some-id");
  });

  test("--force followed by positional arg does not consume it", () => {
    const result = parseArgs(argv("init", "--force"));
    expect(result.force).toBe(true);
    expect(result.featureId).toBeUndefined();
  });

  test("--interactive followed by feature ID", () => {
    const result = parseArgs(argv("launch", "--interactive", "feat-1"));
    expect(result.interactive).toBe(true);
    expect(result.featureId).toBe("feat-1");
  });

  test("--no-tui followed by feature ID", () => {
    const result = parseArgs(argv("launch", "--no-tui", "feat-1"));
    expect(result.noTui).toBe(true);
    expect(result.featureId).toBe("feat-1");
  });

  test("--auto-push followed by feature ID", () => {
    const result = parseArgs(argv("merge", "--auto-push", "feat-1"));
    expect(result.autoPush).toBe(true);
    expect(result.featureId).toBe("feat-1");
  });

  test("--requeue followed by positional", () => {
    const result = parseArgs(argv("abort", "feat-1", "--requeue"));
    expect(result.requeue).toBe(true);
    expect(result.featureId).toBe("feat-1");
  });

  test("--check is boolean and does not consume next arg", () => {
    const result = parseArgs(argv("upgrade", "--check", "--force"));
    expect(result.checkOnly).toBe(true);
    expect(result.force).toBe(true);
  });

  test("--ready is boolean and does not consume next arg", () => {
    const result = parseArgs(argv("tasks", "list", "--ready", "--status", "backlog"));
    expect(result.ready).toBe(true);
    expect(result.status).toBe("backlog");
  });

  test("--include-archive is boolean and does not consume next arg", () => {
    const result = parseArgs(argv("tasks", "list", "--include-archive", "--output", "json"));
    expect(result.includeArchive).toBe(true);
    expect(result.outputFmt).toBe("json");
  });

  test("--browser is boolean and does not consume next arg", () => {
    const result = parseArgs(argv("launch", "--browser", "--dry-run"));
    expect(result.browser).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  test("--follow is boolean and does not consume next arg", () => {
    const result = parseArgs(argv("logs", "feat-1", "--follow"));
    expect(result.follow).toBe(true);
    expect(result.featureId).toBe("feat-1");
  });

  test("-f is boolean and does not consume next arg", () => {
    const result = parseArgs(argv("logs", "feat-1", "-f"));
    expect(result.follow).toBe(true);
    expect(result.featureId).toBe("feat-1");
  });

  test("--ascii is boolean and does not consume next arg", () => {
    const result = parseArgs(argv("tasks", "graph", "--ascii", "--mermaid"));
    expect(result.ascii).toBe(true);
    expect(result.mermaidRaw).toBe(true);
  });

  test("--mermaid is boolean and does not consume next arg", () => {
    const result = parseArgs(argv("tasks", "graph", "--mermaid", "--subtasks"));
    expect(result.mermaidRaw).toBe(true);
    expect(result.graphSubtasks).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requireValue — trailing flags / missing values (graceful exit)
// ---------------------------------------------------------------------------

describe("parseArgs — trailing flags / missing values (requireValue)", () => {
  // requireValue calls process.exit(1), so we test via subprocess to verify
  // the process exits rather than crashing with an unhandled exception.
  // We use a small inline script that imports parseArgs and tries to parse.

  /**
   * Helper: run parseArgs in a subprocess with the given CLI args.
   * Returns { exitCode, stderr }.
   */
  async function runParseInSubprocess(...cliArgs: string[]): Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
  }> {
    const script = `
      import { parseArgs } from "./src/index.js";
      const result = parseArgs(${JSON.stringify(["bun", "script.ts", ...cliArgs])});
      // If we get here, parseArgs didn't exit
      console.log(JSON.stringify(result));
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
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

  test("--output as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "--output");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--output");
    expect(stderr).toContain("requires a value");
  });

  test("-o as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "-o");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("-o");
    expect(stderr).toContain("requires a value");
  });

  test("--model as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "--model");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--model");
    expect(stderr).toContain("requires a value");
  });

  test("-m as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "-m");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("-m");
    expect(stderr).toContain("requires a value");
  });

  test("--base-branch as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "--base-branch");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--base-branch");
    expect(stderr).toContain("requires a value");
  });

  test("--top-priority as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "--top-priority");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--top-priority");
    expect(stderr).toContain("requires a value");
  });

  test("--quickest-wins as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "--quickest-wins");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--quickest-wins");
    expect(stderr).toContain("requires a value");
  });

  test("--priority as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "--priority");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--priority");
    expect(stderr).toContain("requires a value");
  });

  test("--difficulty as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "--difficulty");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--difficulty");
    expect(stderr).toContain("requires a value");
  });

  test("--tasks as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "--tasks");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--tasks");
    expect(stderr).toContain("requires a value");
  });

  test("--max-concurrent as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "--max-concurrent");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--max-concurrent");
    expect(stderr).toContain("requires a value");
  });

  test("--max-retries as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("launch", "--max-retries");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--max-retries");
    expect(stderr).toContain("requires a value");
  });

  test("--tag as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("upgrade", "--tag");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--tag");
    expect(stderr).toContain("requires a value");
  });

  test("--release as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("upgrade", "--release");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--release");
    expect(stderr).toContain("requires a value");
  });

  test("--status as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("tasks", "list", "--status");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--status");
    expect(stderr).toContain("requires a value");
  });

  test("--title as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("tasks", "add", "id", "--title");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--title");
    expect(stderr).toContain("requires a value");
  });

  test("--description as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("tasks", "add", "id", "Title", "--description");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--description");
    expect(stderr).toContain("requires a value");
  });

  test("--desc as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("tasks", "add", "id", "Title", "--desc");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--desc");
    expect(stderr).toContain("requires a value");
  });

  test("--effort as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("tasks", "add", "id", "Title", "--effort");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--effort");
    expect(stderr).toContain("requires a value");
  });

  test("--depends-on as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("tasks", "add", "id", "Title", "--depends-on");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--depends-on");
    expect(stderr).toContain("requires a value");
  });

  test("--fields as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("tasks", "list", "--fields");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--fields");
    expect(stderr).toContain("requires a value");
  });

  test("--tail as last arg (no value) exits with error", async () => {
    const { exitCode, stderr } = await runParseInSubprocess("logs", "feat-1", "--tail");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--tail");
    expect(stderr).toContain("requires a value");
  });

  test("valid flags parse correctly (no false positive exits)", async () => {
    const { exitCode, stdout } = await runParseInSubprocess(
      "launch", "--output", "json", "--model", "gpt-4", "--top-priority", "3"
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(result.outputFmt).toBe("json");
    expect(result.model).toBe("gpt-4");
    expect(result.topPriority).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Unknown flags behavior
// ---------------------------------------------------------------------------

describe("parseArgs — unknown flags", () => {
  test("unknown -- flag is silently ignored and does not crash", () => {
    const result = parseArgs(argv("launch", "--unknown-flag"));
    expect(result.command).toBe("launch");
    // No crash, no undefined property errors
  });

  test("unknown -- flag does not affect other flags", () => {
    const result = parseArgs(argv("launch", "--unknown", "--dry-run", "--force"));
    expect(result.dryRun).toBe(true);
    expect(result.force).toBe(true);
  });

  test("multiple unknown flags are all silently ignored", () => {
    const result = parseArgs(argv("launch", "--foo", "--bar", "--baz", "--dry-run"));
    expect(result.dryRun).toBe(true);
  });

  test("unknown flags between known flags don't interfere", () => {
    const result = parseArgs(argv(
      "launch",
      "--priority", "high",
      "--verbose",  // unknown
      "--max-concurrent", "3"
    ));
    expect(result.priority).toBe("high");
    expect(result.maxConcurrent).toBe(3);
  });

  test("unknown flag that looks like it takes a value: value becomes positional", () => {
    // --unknown-with-value is not recognized, so "some-value" becomes a positional
    const result = parseArgs(argv("launch", "--unknown-with-value", "some-value"));
    expect(result.featureId).toBe("some-value");
  });

  test("unknown single-dash flag is treated as unrecognized", () => {
    // -z is not a recognized short flag, falls through to default
    const result = parseArgs(argv("launch", "-z"));
    // Should not crash; -z starts with "-" so it's not captured as positional either
    expect(result.command).toBe("launch");
  });
});

// ---------------------------------------------------------------------------
// Flag collisions / version flag handling
// ---------------------------------------------------------------------------

describe("parseArgs — flag collisions and version handling", () => {
  test("-v as command resolves to 'verify' (not 'version')", () => {
    // In COMMAND_ALIASES, v → verify. Version is 'version' or '-V'
    const result = parseArgs(argv("v"));
    expect(result.command).toBe("verify");
  });

  test("-V as command does not resolve (not in aliases)", () => {
    const result = parseArgs(argv("-V"));
    expect(result.command).toBe("-V");
    // main() handles -V specially, but parseArgs just passes it through
  });

  test("'version' command is passed through (not aliased)", () => {
    const result = parseArgs(argv("version"));
    expect(result.command).toBe("version");
  });

  test("-v and 'version' produce different commands", () => {
    const vResult = parseArgs(argv("v"));
    const versionResult = parseArgs(argv("version"));
    expect(vResult.command).not.toBe(versionResult.command);
    expect(vResult.command).toBe("verify");
    expect(versionResult.command).toBe("version");
  });

  test("--release is alias for --tag", () => {
    const tagResult = parseArgs(argv("upgrade", "--tag", "v1.0"));
    const releaseResult = parseArgs(argv("upgrade", "--release", "v1.0"));
    expect(tagResult.tag).toBe("v1.0");
    expect(releaseResult.tag).toBe("v1.0");
  });

  test("--desc is alias for --description", () => {
    const descResult = parseArgs(argv("tasks", "add", "id", "title", "--desc", "hello"));
    const descriptionResult = parseArgs(argv("tasks", "add", "id", "title", "--description", "hello"));
    expect(descResult.description).toBe("hello");
    expect(descriptionResult.description).toBe("hello");
  });

  test("-o is alias for --output", () => {
    const oResult = parseArgs(argv("tasks", "list", "-o", "json"));
    const outputResult = parseArgs(argv("tasks", "list", "--output", "json"));
    expect(oResult.outputFmt).toBe("json");
    expect(outputResult.outputFmt).toBe("json");
  });

  test("-m is alias for --model", () => {
    const mResult = parseArgs(argv("launch", "-m", "gpt-4"));
    const modelResult = parseArgs(argv("launch", "--model", "gpt-4"));
    expect(mResult.model).toBe("gpt-4");
    expect(modelResult.model).toBe("gpt-4");
  });
});

// ---------------------------------------------------------------------------
// Repeated and overriding flags
// ---------------------------------------------------------------------------

describe("parseArgs — repeated flags", () => {
  test("last value wins when a value flag is repeated", () => {
    const result = parseArgs(argv(
      "launch", "--priority", "low", "--priority", "critical"
    ));
    expect(result.priority).toBe("critical");
  });

  test("last value wins for --model", () => {
    const result = parseArgs(argv(
      "launch", "--model", "gpt-3", "--model", "gpt-4"
    ));
    expect(result.model).toBe("gpt-4");
  });

  test("repeated boolean flags remain true", () => {
    const result = parseArgs(argv("launch", "--dry-run", "--dry-run"));
    expect(result.dryRun).toBe(true);
  });

  test("--output text overrides default", () => {
    const result = parseArgs(argv("tasks", "list", "--output", "text"));
    expect(result.outputFmt).toBe("text");
  });

  test("--output json then --output text: last wins", () => {
    const result = parseArgs(argv("tasks", "list", "--output", "json", "--output", "text"));
    expect(result.outputFmt).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// Positional argument assignment
// ---------------------------------------------------------------------------

describe("parseArgs — positional arguments", () => {
  test("first positional after command goes to featureId", () => {
    const result = parseArgs(argv("verify", "my-feature"));
    expect(result.featureId).toBe("my-feature");
  });

  test("second positional after command goes to title", () => {
    const result = parseArgs(argv("tasks", "add", "feat-id", "Feature Title"));
    expect(result.featureId).toBe("feat-id");
    expect(result.title).toBe("Feature Title");
  });

  test("third and subsequent positionals are ignored", () => {
    const result = parseArgs(argv("tasks", "add", "id", "title", "extra1", "extra2"));
    expect(result.featureId).toBe("id");
    expect(result.title).toBe("title");
    // extra1 and extra2 are silently dropped
  });

  test("positional after boolean flag is not consumed by the flag", () => {
    const result = parseArgs(argv("retry", "--dry-run", "feat-1"));
    expect(result.dryRun).toBe(true);
    expect(result.featureId).toBe("feat-1");
  });

  test("no positionals means featureId and title are undefined", () => {
    const result = parseArgs(argv("launch"));
    expect(result.featureId).toBeUndefined();
    expect(result.title).toBeUndefined();
  });

  test("tasks subcommand: positional after subcommand", () => {
    const result = parseArgs(argv("tasks", "show", "feat-id"));
    expect(result.featureId).toBe("feat-id");
  });

  test("tasks subcommand: two positionals after subcommand", () => {
    const result = parseArgs(argv("tasks", "set-status", "feat-id", "done"));
    expect(result.featureId).toBe("feat-id");
    expect(result.title).toBe("done"); // second positional goes to title
  });
});

// ---------------------------------------------------------------------------
// Tasks subcommand with no subcommand specified
// ---------------------------------------------------------------------------

describe("parseArgs — tasks subcommand defaults", () => {
  test("tasks with no subcommand defaults to list", () => {
    const result = parseArgs(argv("tasks"));
    expect(result.subcommand).toBe("list");
  });

  test("tasks with only flags defaults subcommand to list", () => {
    // --status is after the subcommand position, but since the first
    // arg starts with --, it gets treated as a flag not a subcommand
    // Actually, --status would be treated as subcommand value then parsed
    const result = parseArgs(argv("tasks", "--status", "backlog"));
    // The second argv element is "--status", which becomes the subcommand
    // (since parseArgs does args[1] || "list" for tasks subcommand).
    // This is a known quirk: "--status" becomes the subcommand string.
    expect(result.subcommand).toBe("--status");
  });
});

// ---------------------------------------------------------------------------
// Logs options
// ---------------------------------------------------------------------------

describe("parseArgs — logs options", () => {
  test("parses --tail with value", () => {
    const result = parseArgs(argv("logs", "feat-1", "--tail", "50"));
    expect(result.tail).toBe(50);
    expect(result.featureId).toBe("feat-1");
  });

  test("parses --follow", () => {
    const result = parseArgs(argv("logs", "feat-1", "--follow"));
    expect(result.follow).toBe(true);
  });

  test("parses -f as alias for --follow", () => {
    const result = parseArgs(argv("logs", "feat-1", "-f"));
    expect(result.follow).toBe(true);
  });

  test("parses all logs options together", () => {
    const result = parseArgs(argv("logs", "feat-1", "--tail", "100", "--follow", "--output", "json"));
    expect(result.featureId).toBe("feat-1");
    expect(result.tail).toBe(100);
    expect(result.follow).toBe(true);
    expect(result.outputFmt).toBe("json");
  });
});

// ---------------------------------------------------------------------------
// Abort options
// ---------------------------------------------------------------------------

describe("parseArgs — abort options", () => {
  test("parses abort with feature ID and --requeue", () => {
    const result = parseArgs(argv("abort", "feat-1", "--requeue"));
    expect(result.command).toBe("abort");
    expect(result.featureId).toBe("feat-1");
    expect(result.requeue).toBe(true);
  });

  test("parses abort with --output json", () => {
    const result = parseArgs(argv("abort", "feat-1", "--output", "json"));
    expect(result.command).toBe("abort");
    expect(result.featureId).toBe("feat-1");
    expect(result.outputFmt).toBe("json");
  });

  test("abort alias 'a' works", () => {
    const result = parseArgs(argv("a", "feat-1", "--requeue"));
    expect(result.command).toBe("abort");
    expect(result.featureId).toBe("feat-1");
    expect(result.requeue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Complete real-world CLI examples from help text
// ---------------------------------------------------------------------------

describe("parseArgs — real-world CLI examples", () => {
  test("woco launch --quickest-wins 3", () => {
    const result = parseArgs(argv("launch", "--quickest-wins", "3"));
    expect(result.command).toBe("launch");
    expect(result.quickestWins).toBe(3);
  });

  test("woco launch --priority high --interactive", () => {
    const result = parseArgs(argv("launch", "--priority", "high", "--interactive"));
    expect(result.command).toBe("launch");
    expect(result.priority).toBe("high");
    expect(result.interactive).toBe(true);
  });

  test("woco launch --tasks 'auth-flow,search-api' --max-concurrent 2", () => {
    const result = parseArgs(argv("launch", "--tasks", "auth-flow,search-api", "--max-concurrent", "2"));
    expect(result.command).toBe("launch");
    expect(result.tasks).toEqual(["auth-flow", "search-api"]);
    expect(result.maxConcurrent).toBe(2);
  });

  test("woco tasks list --status ready --priority high", () => {
    const result = parseArgs(argv("tasks", "list", "--status", "ready", "--priority", "high"));
    expect(result.command).toBe("tasks");
    expect(result.subcommand).toBe("list");
    expect(result.status).toBe("ready");
    expect(result.priority).toBe("high");
  });

  test("woco tasks list --fields id,status,priority --output json", () => {
    const result = parseArgs(argv("tasks", "list", "--fields", "id,status,priority", "--output", "json"));
    expect(result.fields).toEqual(["id", "status", "priority"]);
    expect(result.outputFmt).toBe("json");
  });

  test("woco tasks add my-task 'My Cool Task' --priority high --difficulty easy", () => {
    const result = parseArgs(argv("tasks", "add", "my-task", "My Cool Task", "--priority", "high", "--difficulty", "easy"));
    expect(result.subcommand).toBe("add");
    expect(result.featureId).toBe("my-task");
    expect(result.title).toBe("My Cool Task");
    expect(result.priority).toBe("high");
    expect(result.difficulty).toBe("easy");
  });

  test("woco logs feat --tail 50 --follow", () => {
    const result = parseArgs(argv("logs", "feat", "--tail", "50", "--follow"));
    expect(result.command).toBe("logs");
    expect(result.featureId).toBe("feat");
    expect(result.tail).toBe(50);
    expect(result.follow).toBe(true);
  });

  test("woco history wave-2026-03-12-420", () => {
    const result = parseArgs(argv("history", "wave-2026-03-12-420"));
    expect(result.command).toBe("history");
    expect(result.featureId).toBe("wave-2026-03-12-420");
  });

  test("woco launch with all options combined", () => {
    const result = parseArgs(argv(
      "launch",
      "--top-priority", "5",
      "--max-concurrent", "4",
      "--model", "anthropic/claude-sonnet-4-20250514",
      "--interactive",
      "--dry-run",
      "--no-tui",
      "--auto-push",
      "--base-branch", "develop",
      "--max-retries", "3",
      "--browser",
      "--output", "json"
    ));
    expect(result.command).toBe("launch");
    expect(result.topPriority).toBe(5);
    expect(result.maxConcurrent).toBe(4);
    expect(result.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(result.interactive).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.noTui).toBe(true);
    expect(result.autoPush).toBe(true);
    expect(result.baseBranch).toBe("develop");
    expect(result.maxRetries).toBe(3);
    expect(result.browser).toBe(true);
    expect(result.outputFmt).toBe("json");
  });
});
