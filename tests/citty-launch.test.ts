/**
 * citty-launch.test.ts — Tests for citty launch command definition.
 *
 * TDD: These tests verify that the citty launch command definition
 * correctly defines all expected args/flags and produces the right
 * LaunchCommandOptions when parsed.
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
// Command definition structure tests
// ---------------------------------------------------------------------------

describe("citty launch command", () => {
  test("launchCommand is a valid citty CommandDef", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    expect(launchCommand).toBeDefined();
    expect(launchCommand.meta).toBeDefined();
    expect(launchCommand.run).toBeDefined();
    expect(launchCommand.args).toBeDefined();
  });

  test("launchCommand has correct meta name", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const meta = await resolveValue(launchCommand.meta!);
    expect(meta.name).toBe("launch");
  });

  test("launchCommand meta has description", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const meta = await resolveValue(launchCommand.meta!);
    expect(meta.description).toBeDefined();
    expect(typeof meta.description).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Args definition tests — selection options
// ---------------------------------------------------------------------------

describe("citty launch command args — selection options", () => {
  test("defines --top-priority as string arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.topPriority).toBeDefined();
    expect(args.topPriority.type).toBe("string");
    expect(args.topPriority.description).toBeDefined();
  });

  test("defines --quickest-wins as string arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.quickestWins).toBeDefined();
    expect(args.quickestWins.type).toBe("string");
    expect(args.quickestWins.description).toBeDefined();
  });

  test("defines --priority as string arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.priority).toBeDefined();
    expect(args.priority.type).toBe("string");
    expect(args.priority.description).toBeDefined();
  });

  test("defines --difficulty as string arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.difficulty).toBeDefined();
    expect(args.difficulty.type).toBe("string");
    expect(args.difficulty.description).toBeDefined();
  });

  test("defines --tasks as string arg (comma-separated)", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.tasks).toBeDefined();
    expect(args.tasks.type).toBe("string");
    expect(args.tasks.description).toBeDefined();
  });

  test("defines --all-ready as boolean arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.allReady).toBeDefined();
    expect(args.allReady.type).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Args definition tests — launch/runtime options
// ---------------------------------------------------------------------------

describe("citty launch command args — launch options", () => {
  test("defines --max-concurrent as string arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.maxConcurrent).toBeDefined();
    expect(args.maxConcurrent.type).toBe("string");
  });

  test("defines --model / -m as string arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.model).toBeDefined();
    expect(args.model.type).toBe("string");
    expect(args.model.alias).toBe("m");
  });

  test("defines --interactive as boolean arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.interactive).toBeDefined();
    expect(args.interactive.type).toBe("boolean");
  });

  test("defines --dry-run as boolean arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.dryRun).toBeDefined();
    expect(args.dryRun.type).toBe("boolean");
  });

  test("defines --base-branch as string arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.baseBranch).toBeDefined();
    expect(args.baseBranch.type).toBe("string");
  });

  test("defines --max-retries as string arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.maxRetries).toBeDefined();
    expect(args.maxRetries.type).toBe("string");
  });

  test("defines --no-tui as boolean arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.noTui).toBeDefined();
    expect(args.noTui.type).toBe("boolean");
  });

  test("defines --auto-push as boolean arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.autoPush).toBeDefined();
    expect(args.autoPush.type).toBe("boolean");
  });

  test("defines --agent as string arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.agent).toBeDefined();
    expect(args.agent.type).toBe("string");
  });

  test("defines --quest as string arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.quest).toBeDefined();
    expect(args.quest.type).toBe("string");
  });

  test("defines --browser as boolean arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.browser).toBeDefined();
    expect(args.browser.type).toBe("boolean");
  });

  test("defines --output / -o as string arg", async () => {
    const { launchCommand } = await import("../src/commands/citty/launch.js");
    const args = await resolveValue(launchCommand.args!);
    expect(args.output).toBeDefined();
    expect(args.output.type).toBe("string");
    expect(args.output.alias).toBe("o");
  });
});

// ---------------------------------------------------------------------------
// parseLaunchArgs integration tests
// ---------------------------------------------------------------------------

describe("parseLaunchArgs", () => {
  test("parses minimal args with defaults", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({});
    expect(result.interactive).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.noTui).toBe(false);
    expect(result.autoPush).toBe(false);
    expect(result.allReady).toBe(false);
  });

  test("parses --top-priority as number", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ topPriority: "3" });
    expect(result.topPriority).toBe(3);
  });

  test("parses --quickest-wins as number", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ quickestWins: "5" });
    expect(result.quickestWins).toBe(5);
  });

  test("parses --priority as Priority string", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ priority: "high" });
    expect(result.priority).toBe("high");
  });

  test("parses --difficulty as Difficulty string", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ difficulty: "easy" });
    expect(result.difficulty).toBe("easy");
  });

  test("parses --tasks as comma-separated list", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ tasks: "feat-a,feat-b,feat-c" });
    expect(result.features).toEqual(["feat-a", "feat-b", "feat-c"]);
  });

  test("parses --tasks trims whitespace from items", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ tasks: "feat-a , feat-b , feat-c" });
    expect(result.features).toEqual(["feat-a", "feat-b", "feat-c"]);
  });

  test("parses --all-ready as boolean", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ allReady: true });
    expect(result.allReady).toBe(true);
  });

  test("parses --max-concurrent as number", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ maxConcurrent: "4" });
    expect(result.maxConcurrent).toBe(4);
  });

  test("parses --model value", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ model: "anthropic/claude-sonnet-4-20250514" });
    expect(result.model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  test("parses --interactive flag", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ interactive: true });
    expect(result.interactive).toBe(true);
  });

  test("parses --dry-run flag", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ dryRun: true });
    expect(result.dryRun).toBe(true);
  });

  test("parses --base-branch value", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ baseBranch: "develop" });
    expect(result.baseBranch).toBe("develop");
  });

  test("parses --max-retries as number", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ maxRetries: "2" });
    expect(result.maxRetries).toBe(2);
  });

  test("parses --no-tui flag", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ noTui: true });
    expect(result.noTui).toBe(true);
  });

  test("parses --auto-push flag", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ autoPush: true });
    expect(result.autoPush).toBe(true);
  });

  test("parses --agent value", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ agent: "my-agent" });
    expect(result.agent).toBe("my-agent");
  });

  test("parses --quest value", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ quest: "quest-1" });
    expect(result.questId).toBe("quest-1");
  });

  test("parses --output / -o value", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({ output: "json" });
    expect(result.outputFmt).toBe("json");
  });

  test("parses all flags together", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({
      topPriority: "3",
      allReady: true,
      maxConcurrent: "2",
      model: "gpt-4",
      interactive: true,
      dryRun: true,
      baseBranch: "develop",
      maxRetries: "5",
      noTui: true,
      autoPush: true,
      agent: "custom-agent",
      quest: "quest-42",
      output: "json",
      browser: true,
    });
    expect(result.topPriority).toBe(3);
    expect(result.allReady).toBe(true);
    expect(result.maxConcurrent).toBe(2);
    expect(result.model).toBe("gpt-4");
    expect(result.interactive).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.baseBranch).toBe("develop");
    expect(result.maxRetries).toBe(5);
    expect(result.noTui).toBe(true);
    expect(result.autoPush).toBe(true);
    expect(result.agent).toBe("custom-agent");
    expect(result.questId).toBe("quest-42");
    expect(result.outputFmt).toBe("json");
    expect(result.browser).toBe(true);
  });

  test("undefined numeric values remain undefined", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({});
    expect(result.topPriority).toBeUndefined();
    expect(result.quickestWins).toBeUndefined();
    expect(result.maxConcurrent).toBeUndefined();
    expect(result.maxRetries).toBeUndefined();
  });

  test("undefined string values remain undefined", async () => {
    const { parseLaunchArgs } = await import("../src/commands/citty/launch.js");
    const result = parseLaunchArgs({});
    expect(result.model).toBeUndefined();
    expect(result.baseBranch).toBeUndefined();
    expect(result.agent).toBeUndefined();
    expect(result.questId).toBeUndefined();
    expect(result.features).toBeUndefined();
    expect(result.priority).toBeUndefined();
    expect(result.difficulty).toBeUndefined();
    expect(result.outputFmt).toBeUndefined();
  });
});
