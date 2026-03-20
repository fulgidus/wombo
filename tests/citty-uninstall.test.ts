/**
 * citty-uninstall.test.ts — Tests for the citty uninstall command definition.
 *
 * Verifies:
 *   - Command is a valid citty CommandDef
 *   - Meta name is "uninstall"
 *   - force, dry-run, keep-data, remove-binary flags are defined
 *   - Command is registered in the citty router
 */

import { describe, test, expect } from "bun:test";

// Helper to resolve citty's Resolvable<T> values
async function resolveValue<T>(val: T | (() => T) | (() => Promise<T>) | Promise<T>): Promise<T> {
  if (typeof val === "function") {
    return await (val as () => T | Promise<T>)();
  }
  return await val;
}

describe("citty uninstall command", () => {
  test("uninstallCommand is a valid citty CommandDef", async () => {
    const { uninstallCommand } = await import("../src/commands/citty/uninstall");
    expect(uninstallCommand).toBeDefined();
    expect(uninstallCommand.meta).toBeDefined();
    expect(uninstallCommand.run).toBeDefined();
  });

  test("uninstallCommand has correct meta name", async () => {
    const { uninstallCommand } = await import("../src/commands/citty/uninstall");
    const meta = await resolveValue(uninstallCommand.meta!);
    expect(meta.name).toBe("uninstall");
  });

  test("uninstallCommand has correct description", async () => {
    const { uninstallCommand } = await import("../src/commands/citty/uninstall");
    const meta = await resolveValue(uninstallCommand.meta!);
    expect(meta.description).toBeDefined();
    expect(meta.description).toContain(".wombo-combo");
  });

  test("uninstallCommand has force flag defined", async () => {
    const { uninstallCommand } = await import("../src/commands/citty/uninstall");
    const args = await resolveValue(uninstallCommand.args!);
    expect(args).toBeDefined();
    expect(args.force).toBeDefined();
    expect(args.force.type).toBe("boolean");
  });

  test("uninstallCommand has dryRun flag defined", async () => {
    const { uninstallCommand } = await import("../src/commands/citty/uninstall");
    const args = await resolveValue(uninstallCommand.args!);
    expect(args.dryRun).toBeDefined();
    expect(args.dryRun.type).toBe("boolean");
  });

  test("uninstallCommand has keepData flag defined", async () => {
    const { uninstallCommand } = await import("../src/commands/citty/uninstall");
    const args = await resolveValue(uninstallCommand.args!);
    expect(args.keepData).toBeDefined();
    expect(args.keepData.type).toBe("boolean");
  });

  test("uninstallCommand has removeBinary flag defined", async () => {
    const { uninstallCommand } = await import("../src/commands/citty/uninstall");
    const args = await resolveValue(uninstallCommand.args!);
    expect(args.removeBinary).toBeDefined();
    expect(args.removeBinary.type).toBe("boolean");
  });
});

describe("citty router — uninstall command", () => {
  test("isCittyCommand identifies 'uninstall'", async () => {
    const { isCittyCommand } = await import("../src/commands/citty/router");
    expect(isCittyCommand("uninstall")).toBe(true);
  });

  test("isCittyCommand identifies 'un' alias", async () => {
    const { isCittyCommand } = await import("../src/commands/citty/router");
    expect(isCittyCommand("un")).toBe(true);
  });

  test("runCittyCommand can route 'uninstall' with --dry-run", async () => {
    const { runCittyCommand } = await import("../src/commands/citty/router");
    const logs: string[] = [];
    const consoleSpy = {
      log: (...args: any[]) => { logs.push(args.join(" ")); },
      error: (...args: any[]) => { logs.push(args.join(" ")); },
    };

    const origLog = console.log;
    const origError = console.error;
    console.log = consoleSpy.log;
    console.error = consoleSpy.error;

    try {
      // dry-run with force should not fail even when .wombo-combo does not exist
      await runCittyCommand("uninstall", ["--dry-run", "--force"]);
      // Just verify it ran without throwing
      expect(true).toBe(true);
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  });
});
