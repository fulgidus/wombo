/**
 * citty-quest.test.ts — Tests for the citty quest command definition.
 *
 * Verifies that the quest parent command and its 8 subcommands are correctly
 * defined as citty commands with proper metadata, args, and subCommands.
 */

import { describe, test, expect } from "bun:test";

// Helper to resolve citty's Resolvable<T> values
async function resolveValue<T>(val: T | (() => T) | (() => Promise<T>) | Promise<T>): Promise<T> {
  if (typeof val === "function") {
    return await (val as () => T | Promise<T>)();
  }
  return await val;
}

describe("citty quest command", () => {
  test("questCommand is a valid citty CommandDef", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    expect(questCommand).toBeDefined();
    expect(questCommand.meta).toBeDefined();
    expect(questCommand.subCommands).toBeDefined();
  });

  test("questCommand has correct meta name", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const meta = await resolveValue(questCommand.meta!);
    expect(meta.name).toBe("quest");
  });

  test("questCommand has correct meta description", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const meta = await resolveValue(questCommand.meta!);
    expect(meta.description).toBeDefined();
    expect(meta.description!.length).toBeGreaterThan(0);
  });

  test("questCommand has all 8 subcommands defined", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const subCommands = await resolveValue(questCommand.subCommands!);
    const subCommandNames = Object.keys(subCommands);
    expect(subCommandNames).toContain("create");
    expect(subCommandNames).toContain("list");
    expect(subCommandNames).toContain("show");
    expect(subCommandNames).toContain("plan");
    expect(subCommandNames).toContain("activate");
    expect(subCommandNames).toContain("pause");
    expect(subCommandNames).toContain("complete");
    expect(subCommandNames).toContain("abandon");
    expect(subCommandNames.length).toBe(8);
  });

  test("questCommand has a run handler for default subcommand behavior", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    // The parent command should have a run handler that defaults to 'list'
    expect(questCommand.run).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Subcommand structure tests
// ---------------------------------------------------------------------------

describe("citty quest subcommands structure", () => {
  test("create subcommand has id and title positionals and flag args", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const subCommands = await resolveValue(questCommand.subCommands!);
    const cmd = await resolveValue(subCommands["create"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.id).toBeDefined();
    expect(args.id.type).toBe("positional");
    expect(args.title).toBeDefined();
    expect(args.title.type).toBe("positional");
    expect(args.goal).toBeDefined();
    expect(args.priority).toBeDefined();
    expect(args.difficulty).toBeDefined();
    expect(args.hitl).toBeDefined();
    expect(args.agent).toBeDefined();
    expect(args.dryRun).toBeDefined();
  });

  test("list subcommand has status filter arg", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const subCommands = await resolveValue(questCommand.subCommands!);
    const cmd = await resolveValue(subCommands["list"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.status).toBeDefined();
  });

  test("show subcommand has questId positional and fields arg", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const subCommands = await resolveValue(questCommand.subCommands!);
    const cmd = await resolveValue(subCommands["show"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.questId).toBeDefined();
    expect(args.questId.type).toBe("positional");
    expect(args.fields).toBeDefined();
  });

  test("plan subcommand has questId positional and model flag", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const subCommands = await resolveValue(questCommand.subCommands!);
    const cmd = await resolveValue(subCommands["plan"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.questId).toBeDefined();
    expect(args.questId.type).toBe("positional");
    expect(args.model).toBeDefined();
    expect(args.dryRun).toBeDefined();
  });

  test("activate subcommand has questId positional", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const subCommands = await resolveValue(questCommand.subCommands!);
    const cmd = await resolveValue(subCommands["activate"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.questId).toBeDefined();
    expect(args.questId.type).toBe("positional");
  });

  test("pause subcommand has questId positional", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const subCommands = await resolveValue(questCommand.subCommands!);
    const cmd = await resolveValue(subCommands["pause"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.questId).toBeDefined();
    expect(args.questId.type).toBe("positional");
  });

  test("complete subcommand has questId positional and force flag", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const subCommands = await resolveValue(questCommand.subCommands!);
    const cmd = await resolveValue(subCommands["complete"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.questId).toBeDefined();
    expect(args.questId.type).toBe("positional");
    expect(args.force).toBeDefined();
  });

  test("abandon subcommand has questId positional and force flag", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const subCommands = await resolveValue(questCommand.subCommands!);
    const cmd = await resolveValue(subCommands["abandon"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.questId).toBeDefined();
    expect(args.questId.type).toBe("positional");
    expect(args.force).toBeDefined();
  });

  test("each subcommand has a run handler", async () => {
    const { questCommand } = await import("../src/commands/citty/quest.js");
    const subCommands = await resolveValue(questCommand.subCommands!);
    for (const [name, cmdDef] of Object.entries(subCommands)) {
      const cmd = await resolveValue(cmdDef);
      expect(cmd.run).toBeDefined();
    }
  });
});
