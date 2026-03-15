/**
 * citty-core-commands.test.ts — Tests for citty command definitions.
 *
 * TDD: These tests verify that the citty command definitions for
 * init, status, verify, merge, abort, cleanup, history, logs, usage,
 * upgrade, and completion work correctly, including:
 *   - Command metadata is correct
 *   - Args/flags are properly defined with correct types
 *   - Commands are registered in the citty router
 */

import { describe, test, expect } from "bun:test";

// Helper to resolve citty's Resolvable<T> values
async function resolveValue<T>(val: T | (() => T) | (() => Promise<T>) | Promise<T>): Promise<T> {
  if (typeof val === "function") {
    return await (val as () => T | Promise<T>)();
  }
  return await val;
}

// ---------------------------------------------------------------------------
// Init command tests
// ---------------------------------------------------------------------------

describe("citty init command", () => {
  test("initCommand is a valid citty CommandDef", async () => {
    const { initCommand } = await import("../src/commands/citty/init.js");
    expect(initCommand).toBeDefined();
    expect(initCommand.meta).toBeDefined();
    expect(initCommand.run).toBeDefined();
  });

  test("initCommand has correct meta name", async () => {
    const { initCommand } = await import("../src/commands/citty/init.js");
    const meta = await resolveValue(initCommand.meta!);
    expect(meta.name).toBe("init");
  });

  test("initCommand has force flag defined", async () => {
    const { initCommand } = await import("../src/commands/citty/init.js");
    const args = await resolveValue(initCommand.args!);
    expect(args).toBeDefined();
    expect(args.force).toBeDefined();
    expect(args.force.type).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Status command tests
// ---------------------------------------------------------------------------

describe("citty status command", () => {
  test("statusCommand is a valid citty CommandDef", async () => {
    const { statusCommand } = await import("../src/commands/citty/status.js");
    expect(statusCommand).toBeDefined();
    expect(statusCommand.meta).toBeDefined();
    expect(statusCommand.run).toBeDefined();
  });

  test("statusCommand has correct meta name", async () => {
    const { statusCommand } = await import("../src/commands/citty/status.js");
    const meta = await resolveValue(statusCommand.meta!);
    expect(meta.name).toBe("status");
  });

  test("statusCommand has output flag defined", async () => {
    const { statusCommand } = await import("../src/commands/citty/status.js");
    const args = await resolveValue(statusCommand.args!);
    expect(args).toBeDefined();
    expect(args.output).toBeDefined();
    expect(args.output.type).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Verify command tests
// ---------------------------------------------------------------------------

describe("citty verify command", () => {
  test("verifyCommand is a valid citty CommandDef", async () => {
    const { verifyCommand } = await import("../src/commands/citty/verify.js");
    expect(verifyCommand).toBeDefined();
    expect(verifyCommand.meta).toBeDefined();
    expect(verifyCommand.run).toBeDefined();
  });

  test("verifyCommand has correct meta name", async () => {
    const { verifyCommand } = await import("../src/commands/citty/verify.js");
    const meta = await resolveValue(verifyCommand.meta!);
    expect(meta.name).toBe("verify");
  });

  test("verifyCommand has feature-id positional arg", async () => {
    const { verifyCommand } = await import("../src/commands/citty/verify.js");
    const args = await resolveValue(verifyCommand.args!);
    expect(args).toBeDefined();
    expect(args.featureId).toBeDefined();
    expect(args.featureId.type).toBe("positional");
    expect(args.featureId.required).toBe(false);
  });

  test("verifyCommand has browser, skip-tests, strict-tdd flags", async () => {
    const { verifyCommand } = await import("../src/commands/citty/verify.js");
    const args = await resolveValue(verifyCommand.args!);
    expect(args.browser).toBeDefined();
    expect(args.browser.type).toBe("boolean");
    expect(args.skipTests).toBeDefined();
    expect(args.skipTests.type).toBe("boolean");
    expect(args.strictTdd).toBeDefined();
    expect(args.strictTdd.type).toBe("boolean");
  });

  test("verifyCommand has model and output flags", async () => {
    const { verifyCommand } = await import("../src/commands/citty/verify.js");
    const args = await resolveValue(verifyCommand.args!);
    expect(args.model).toBeDefined();
    expect(args.model.type).toBe("string");
    expect(args.output).toBeDefined();
    expect(args.output.type).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Merge command tests
// ---------------------------------------------------------------------------

describe("citty merge command", () => {
  test("mergeCommand is a valid citty CommandDef", async () => {
    const { mergeCommand } = await import("../src/commands/citty/merge.js");
    expect(mergeCommand).toBeDefined();
    expect(mergeCommand.meta).toBeDefined();
    expect(mergeCommand.run).toBeDefined();
  });

  test("mergeCommand has correct meta name", async () => {
    const { mergeCommand } = await import("../src/commands/citty/merge.js");
    const meta = await resolveValue(mergeCommand.meta!);
    expect(meta.name).toBe("merge");
  });

  test("mergeCommand has feature-id positional arg", async () => {
    const { mergeCommand } = await import("../src/commands/citty/merge.js");
    const args = await resolveValue(mergeCommand.args!);
    expect(args.featureId).toBeDefined();
    expect(args.featureId.type).toBe("positional");
    expect(args.featureId.required).toBe(false);
  });

  test("mergeCommand has auto-push, dry-run, model flags", async () => {
    const { mergeCommand } = await import("../src/commands/citty/merge.js");
    const args = await resolveValue(mergeCommand.args!);
    expect(args.autoPush).toBeDefined();
    expect(args.autoPush.type).toBe("boolean");
    expect(args.dryRun).toBeDefined();
    expect(args.dryRun.type).toBe("boolean");
    expect(args.model).toBeDefined();
    expect(args.model.type).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Abort command tests
// ---------------------------------------------------------------------------

describe("citty abort command", () => {
  test("abortCommand is a valid citty CommandDef", async () => {
    const { abortCommand } = await import("../src/commands/citty/abort.js");
    expect(abortCommand).toBeDefined();
    expect(abortCommand.meta).toBeDefined();
    expect(abortCommand.run).toBeDefined();
  });

  test("abortCommand has correct meta name", async () => {
    const { abortCommand } = await import("../src/commands/citty/abort.js");
    const meta = await resolveValue(abortCommand.meta!);
    expect(meta.name).toBe("abort");
  });

  test("abortCommand has feature-id positional arg (required)", async () => {
    const { abortCommand } = await import("../src/commands/citty/abort.js");
    const args = await resolveValue(abortCommand.args!);
    expect(args.featureId).toBeDefined();
    expect(args.featureId.type).toBe("positional");
    expect(args.featureId.required).toBe(true);
  });

  test("abortCommand has requeue flag", async () => {
    const { abortCommand } = await import("../src/commands/citty/abort.js");
    const args = await resolveValue(abortCommand.args!);
    expect(args.requeue).toBeDefined();
    expect(args.requeue.type).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Cleanup command tests
// ---------------------------------------------------------------------------

describe("citty cleanup command", () => {
  test("cleanupCommand is a valid citty CommandDef", async () => {
    const { cleanupCommand } = await import("../src/commands/citty/cleanup.js");
    expect(cleanupCommand).toBeDefined();
    expect(cleanupCommand.meta).toBeDefined();
    expect(cleanupCommand.run).toBeDefined();
  });

  test("cleanupCommand has correct meta name", async () => {
    const { cleanupCommand } = await import("../src/commands/citty/cleanup.js");
    const meta = await resolveValue(cleanupCommand.meta!);
    expect(meta.name).toBe("cleanup");
  });

  test("cleanupCommand has dry-run flag", async () => {
    const { cleanupCommand } = await import("../src/commands/citty/cleanup.js");
    const args = await resolveValue(cleanupCommand.args!);
    expect(args.dryRun).toBeDefined();
    expect(args.dryRun.type).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// History command tests
// ---------------------------------------------------------------------------

describe("citty history command", () => {
  test("historyCommand is a valid citty CommandDef", async () => {
    const { historyCommand } = await import("../src/commands/citty/history.js");
    expect(historyCommand).toBeDefined();
    expect(historyCommand.meta).toBeDefined();
    expect(historyCommand.run).toBeDefined();
  });

  test("historyCommand has correct meta name", async () => {
    const { historyCommand } = await import("../src/commands/citty/history.js");
    const meta = await resolveValue(historyCommand.meta!);
    expect(meta.name).toBe("history");
  });

  test("historyCommand has wave-id positional arg", async () => {
    const { historyCommand } = await import("../src/commands/citty/history.js");
    const args = await resolveValue(historyCommand.args!);
    expect(args.waveId).toBeDefined();
    expect(args.waveId.type).toBe("positional");
    expect(args.waveId.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Logs command tests
// ---------------------------------------------------------------------------

describe("citty logs command", () => {
  test("logsCommand is a valid citty CommandDef", async () => {
    const { logsCommand } = await import("../src/commands/citty/logs.js");
    expect(logsCommand).toBeDefined();
    expect(logsCommand.meta).toBeDefined();
    expect(logsCommand.run).toBeDefined();
  });

  test("logsCommand has correct meta name", async () => {
    const { logsCommand } = await import("../src/commands/citty/logs.js");
    const meta = await resolveValue(logsCommand.meta!);
    expect(meta.name).toBe("logs");
  });

  test("logsCommand has feature-id positional arg (required)", async () => {
    const { logsCommand } = await import("../src/commands/citty/logs.js");
    const args = await resolveValue(logsCommand.args!);
    expect(args.featureId).toBeDefined();
    expect(args.featureId.type).toBe("positional");
    expect(args.featureId.required).toBe(true);
  });

  test("logsCommand has tail and follow flags", async () => {
    const { logsCommand } = await import("../src/commands/citty/logs.js");
    const args = await resolveValue(logsCommand.args!);
    expect(args.tail).toBeDefined();
    expect(args.tail.type).toBe("string");
    expect(args.follow).toBeDefined();
    expect(args.follow.type).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Usage command tests
// ---------------------------------------------------------------------------

describe("citty usage command", () => {
  test("usageCommand is a valid citty CommandDef", async () => {
    const { usageCommand } = await import("../src/commands/citty/usage.js");
    expect(usageCommand).toBeDefined();
    expect(usageCommand.meta).toBeDefined();
    expect(usageCommand.run).toBeDefined();
  });

  test("usageCommand has correct meta name", async () => {
    const { usageCommand } = await import("../src/commands/citty/usage.js");
    const meta = await resolveValue(usageCommand.meta!);
    expect(meta.name).toBe("usage");
  });

  test("usageCommand has by, since, until, format flags", async () => {
    const { usageCommand } = await import("../src/commands/citty/usage.js");
    const args = await resolveValue(usageCommand.args!);
    expect(args.by).toBeDefined();
    expect(args.by.type).toBe("string");
    expect(args.since).toBeDefined();
    expect(args.since.type).toBe("string");
    expect(args.until).toBeDefined();
    expect(args.until.type).toBe("string");
    expect(args.format).toBeDefined();
    expect(args.format.type).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Upgrade command tests
// ---------------------------------------------------------------------------

describe("citty upgrade command", () => {
  test("upgradeCommand is a valid citty CommandDef", async () => {
    const { upgradeCommand } = await import("../src/commands/citty/upgrade.js");
    expect(upgradeCommand).toBeDefined();
    expect(upgradeCommand.meta).toBeDefined();
    expect(upgradeCommand.run).toBeDefined();
  });

  test("upgradeCommand has correct meta name", async () => {
    const { upgradeCommand } = await import("../src/commands/citty/upgrade.js");
    const meta = await resolveValue(upgradeCommand.meta!);
    expect(meta.name).toBe("upgrade");
  });

  test("upgradeCommand has force, tag, check flags", async () => {
    const { upgradeCommand } = await import("../src/commands/citty/upgrade.js");
    const args = await resolveValue(upgradeCommand.args!);
    expect(args.force).toBeDefined();
    expect(args.force.type).toBe("boolean");
    expect(args.tag).toBeDefined();
    expect(args.tag.type).toBe("string");
    expect(args.check).toBeDefined();
    expect(args.check.type).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Completion command tests
// ---------------------------------------------------------------------------

describe("citty completion command", () => {
  test("completionCommand is a valid citty CommandDef", async () => {
    const { completionCommand } = await import("../src/commands/citty/completion.js");
    expect(completionCommand).toBeDefined();
    expect(completionCommand.meta).toBeDefined();
    expect(completionCommand.run).toBeDefined();
  });

  test("completionCommand has correct meta name", async () => {
    const { completionCommand } = await import("../src/commands/citty/completion.js");
    const meta = await resolveValue(completionCommand.meta!);
    expect(meta.name).toBe("completion");
  });

  test("completionCommand has shell positional arg", async () => {
    const { completionCommand } = await import("../src/commands/citty/completion.js");
    const args = await resolveValue(completionCommand.args!);
    expect(args.shell).toBeDefined();
    expect(args.shell.type).toBe("positional");
    expect(args.shell.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Router integration tests
// ---------------------------------------------------------------------------

describe("citty router — core commands", () => {
  test("isCittyCommand identifies all migrated commands", async () => {
    const { isCittyCommand } = await import("../src/commands/citty/router.js");
    expect(isCittyCommand("init")).toBe(true);
    expect(isCittyCommand("status")).toBe(true);
    expect(isCittyCommand("verify")).toBe(true);
    expect(isCittyCommand("merge")).toBe(true);
    expect(isCittyCommand("abort")).toBe(true);
    expect(isCittyCommand("cleanup")).toBe(true);
    expect(isCittyCommand("history")).toBe(true);
    expect(isCittyCommand("logs")).toBe(true);
    expect(isCittyCommand("usage")).toBe(true);
    expect(isCittyCommand("upgrade")).toBe(true);
    expect(isCittyCommand("completion")).toBe(true);
  });

  test("isCittyCommand still identifies existing commands", async () => {
    const { isCittyCommand } = await import("../src/commands/citty/router.js");
    expect(isCittyCommand("version")).toBe(true);
    expect(isCittyCommand("-v")).toBe(true);
    expect(isCittyCommand("help")).toBe(true);
    expect(isCittyCommand("describe")).toBe(true);
  });

  test("isCittyCommand returns false for non-citty commands", async () => {
    const { isCittyCommand } = await import("../src/commands/citty/router.js");
    expect(isCittyCommand("tui")).toBe(false);
    expect(isCittyCommand("genesis")).toBe(false);
  });

  test("isCittyCommand identifies aliases for migrated commands", async () => {
    const { isCittyCommand } = await import("../src/commands/citty/router.js");
    // Common aliases from schema
    expect(isCittyCommand("i")).toBe(true);   // init
    expect(isCittyCommand("s")).toBe(true);   // status
    expect(isCittyCommand("v")).toBe(true);   // verify
    expect(isCittyCommand("m")).toBe(true);   // merge
    expect(isCittyCommand("a")).toBe(true);   // abort
    expect(isCittyCommand("c")).toBe(true);   // cleanup
    expect(isCittyCommand("h")).toBe(true);   // history
    expect(isCittyCommand("lo")).toBe(true);  // logs
    expect(isCittyCommand("us")).toBe(true);  // usage
    expect(isCittyCommand("comp")).toBe(true); // completion
  });
});
