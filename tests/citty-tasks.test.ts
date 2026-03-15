/**
 * citty-tasks.test.ts — Tests for the citty tasks command definition.
 *
 * Verifies that the tasks parent command and its 9 subcommands are correctly
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

describe("citty tasks command", () => {
  test("tasksCommand is a valid citty CommandDef", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    expect(tasksCommand).toBeDefined();
    expect(tasksCommand.meta).toBeDefined();
    expect(tasksCommand.subCommands).toBeDefined();
  });

  test("tasksCommand has correct meta name", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const meta = await resolveValue(tasksCommand.meta!);
    expect(meta.name).toBe("tasks");
  });

  test("tasksCommand has correct meta description", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const meta = await resolveValue(tasksCommand.meta!);
    expect(meta.description).toBeDefined();
    expect(meta.description!.length).toBeGreaterThan(0);
  });

  test("tasksCommand has all 9 subcommands defined", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    const subCommandNames = Object.keys(subCommands);
    expect(subCommandNames).toContain("list");
    expect(subCommandNames).toContain("add");
    expect(subCommandNames).toContain("set-status");
    expect(subCommandNames).toContain("set-priority");
    expect(subCommandNames).toContain("set-difficulty");
    expect(subCommandNames).toContain("check");
    expect(subCommandNames).toContain("archive");
    expect(subCommandNames).toContain("show");
    expect(subCommandNames).toContain("graph");
    expect(subCommandNames.length).toBe(9);
  });

  test("tasksCommand has a run handler for default subcommand behavior", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    // The parent command should have a run handler that defaults to 'list'
    expect(tasksCommand.run).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Subcommand structure tests
// ---------------------------------------------------------------------------

describe("citty tasks subcommands structure", () => {
  test("list subcommand has correct meta and filtering args", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    const listCmd = await resolveValue(subCommands["list"]);
    expect(listCmd).toBeDefined();
    const meta = await resolveValue(listCmd.meta!);
    expect(meta.name).toBe("list");
    const args = await resolveValue(listCmd.args!);
    expect(args.status).toBeDefined();
    expect(args.priority).toBeDefined();
    expect(args.difficulty).toBeDefined();
    expect(args.ready).toBeDefined();
    expect(args.includeArchive).toBeDefined();
  });

  test("add subcommand has id and title positionals and flag args", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    const addCmd = await resolveValue(subCommands["add"]);
    expect(addCmd).toBeDefined();
    const args = await resolveValue(addCmd.args!);
    expect(args.id).toBeDefined();
    expect(args.id.type).toBe("positional");
    expect(args.title).toBeDefined();
    expect(args.title.type).toBe("positional");
    expect(args.description).toBeDefined();
    expect(args.priority).toBeDefined();
    expect(args.difficulty).toBeDefined();
    expect(args.effort).toBeDefined();
    expect(args.dependsOn).toBeDefined();
    expect(args.dryRun).toBeDefined();
  });

  test("set-status subcommand has taskId and status positionals", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    const cmd = await resolveValue(subCommands["set-status"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.taskId).toBeDefined();
    expect(args.taskId.type).toBe("positional");
    expect(args.status).toBeDefined();
    expect(args.status.type).toBe("positional");
    expect(args.dryRun).toBeDefined();
  });

  test("set-priority subcommand has taskId and priority positionals", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    const cmd = await resolveValue(subCommands["set-priority"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.taskId).toBeDefined();
    expect(args.taskId.type).toBe("positional");
    expect(args.priority).toBeDefined();
    expect(args.priority.type).toBe("positional");
    expect(args.dryRun).toBeDefined();
  });

  test("set-difficulty subcommand has taskId and difficulty positionals", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    const cmd = await resolveValue(subCommands["set-difficulty"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.taskId).toBeDefined();
    expect(args.taskId.type).toBe("positional");
    expect(args.difficulty).toBeDefined();
    expect(args.difficulty.type).toBe("positional");
    expect(args.dryRun).toBeDefined();
  });

  test("check subcommand has output arg", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    const cmd = await resolveValue(subCommands["check"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.output).toBeDefined();
  });

  test("archive subcommand has optional taskId positional", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    const cmd = await resolveValue(subCommands["archive"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.taskId).toBeDefined();
    expect(args.taskId.type).toBe("positional");
    expect(args.taskId.required).toBe(false);
    expect(args.dryRun).toBeDefined();
  });

  test("show subcommand has required taskId positional", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    const cmd = await resolveValue(subCommands["show"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.taskId).toBeDefined();
    expect(args.taskId.type).toBe("positional");
    expect(args.fields).toBeDefined();
  });

  test("graph subcommand has status, ascii, mermaid, subtasks args", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    const cmd = await resolveValue(subCommands["graph"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.status).toBeDefined();
    expect(args.ascii).toBeDefined();
    expect(args.mermaid).toBeDefined();
    expect(args.subtasks).toBeDefined();
  });

  test("each subcommand has a run handler", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks.js");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    for (const [name, cmdDef] of Object.entries(subCommands)) {
      const cmd = await resolveValue(cmdDef);
      expect(cmd.run).toBeDefined();
    }
  });
});
