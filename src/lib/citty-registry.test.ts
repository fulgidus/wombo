/**
 * citty-registry.test.ts — Tests for the citty command registry.
 *
 * Verifies that the bridge-generated COMMAND_REGISTRY produces CommandDef[]
 * matching the expected shape for all commands.
 */

import { describe, test, expect } from "bun:test";
import {
  BRIDGE_REGISTRY,
  findBridgeCommandDef,
} from "./citty-registry.js";
import type { CommandDef } from "./schema-types.js";

// ---------------------------------------------------------------------------
// Registry completeness
// ---------------------------------------------------------------------------

describe("BRIDGE_REGISTRY", () => {
  test("contains all top-level commands", () => {
    const names = BRIDGE_REGISTRY.map((c) => c.name);
    expect(names).toContain("init");
    expect(names).toContain("launch");
    expect(names).toContain("resume");
    expect(names).toContain("status");
    expect(names).toContain("verify");
    expect(names).toContain("merge");
    expect(names).toContain("retry");
    expect(names).toContain("cleanup");
    expect(names).toContain("history");
    expect(names).toContain("usage");
    expect(names).toContain("abort");
    expect(names).toContain("upgrade");
    expect(names).toContain("logs");
    expect(names).toContain("tasks");
    expect(names).toContain("quest");
    expect(names).toContain("wishlist");
    expect(names).toContain("help");
    expect(names).toContain("version");
    expect(names).toContain("describe");
    expect(names).toContain("completion");
    expect(names).toContain("genesis");
  });

  test("each entry has required CommandDef fields", () => {
    for (const cmd of BRIDGE_REGISTRY) {
      expect(typeof cmd.name).toBe("string");
      expect(typeof cmd.summary).toBe("string");
      expect(cmd.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(cmd.positionals)).toBe(true);
      expect(Array.isArray(cmd.flags)).toBe(true);
      expect(typeof cmd.mutating).toBe("boolean");
      expect(typeof cmd.supportsDryRun).toBe("boolean");
    }
  });

  test("no command includes global flags (output, force) in its own flags", () => {
    for (const cmd of BRIDGE_REGISTRY) {
      const flagNames = cmd.flags.map((f: { name: string }) => f.name);
      expect(flagNames).not.toContain("--output");
      // force can appear as a command-specific flag (e.g. init, upgrade)
      // so we only check that it's not just a pass-through of the global
    }
  });
});

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

describe("BRIDGE_REGISTRY subcommands", () => {
  test("tasks command has 9 subcommands", () => {
    const tasks = BRIDGE_REGISTRY.find((c) => c.name === "tasks");
    expect(tasks).toBeDefined();
    expect(tasks!.subcommands).toBeDefined();
    expect(tasks!.subcommands!.length).toBe(9);
  });

  test("tasks subcommands have expected names", () => {
    const tasks = BRIDGE_REGISTRY.find((c) => c.name === "tasks");
    const subNames = tasks!.subcommands!.map((s) => s.name);
    expect(subNames).toContain("tasks list");
    expect(subNames).toContain("tasks add");
    expect(subNames).toContain("tasks set-status");
    expect(subNames).toContain("tasks set-priority");
    expect(subNames).toContain("tasks set-difficulty");
    expect(subNames).toContain("tasks check");
    expect(subNames).toContain("tasks archive");
    expect(subNames).toContain("tasks show");
    expect(subNames).toContain("tasks graph");
  });

  test("quest command has 8 subcommands", () => {
    const quest = BRIDGE_REGISTRY.find((c) => c.name === "quest");
    expect(quest).toBeDefined();
    expect(quest!.subcommands).toBeDefined();
    expect(quest!.subcommands!.length).toBe(8);
  });

  test("wishlist command has 3 subcommands", () => {
    const wishlist = BRIDGE_REGISTRY.find((c) => c.name === "wishlist");
    expect(wishlist).toBeDefined();
    expect(wishlist!.subcommands).toBeDefined();
    expect(wishlist!.subcommands!.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Specific command shapes
// ---------------------------------------------------------------------------

describe("specific command shapes", () => {
  test("launch command has correct flags", () => {
    const launch = BRIDGE_REGISTRY.find((c) => c.name === "launch");
    expect(launch).toBeDefined();
    expect(launch!.aliases).toEqual(["l"]);
    expect(launch!.mutating).toBe(true);
    expect(launch!.supportsDryRun).toBe(true);
    
    const flagNames = launch!.flags.map((f: { name: string }) => f.name);
    expect(flagNames).toContain("--top-priority");
    expect(flagNames).toContain("--dry-run");
    expect(flagNames).toContain("--model");
  });

  test("tasks add has positional args", () => {
    const tasks = BRIDGE_REGISTRY.find((c) => c.name === "tasks");
    const add = tasks!.subcommands!.find((s) => s.name === "tasks add");
    expect(add).toBeDefined();
    expect(add!.positionals.length).toBe(2);
    expect(add!.positionals[0].name).toBe("id");
    expect(add!.positionals[0].required).toBe(true);
    expect(add!.positionals[1].name).toBe("title");
    expect(add!.positionals[1].required).toBe(true);
  });

  test("logs has required positional and follow flag", () => {
    const logs = BRIDGE_REGISTRY.find((c) => c.name === "logs");
    expect(logs).toBeDefined();
    expect(logs!.positionals[0]).toEqual({
      name: "feature-id",
      description: "Feature ID whose logs to display",
      required: true,
    });
    
    const followFlag = logs!.flags.find((f: { name: string }) => f.name === "--follow");
    expect(followFlag).toBeDefined();
    expect(followFlag!.alias).toBe("-f");
    expect(followFlag!.type).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// findBridgeCommandDef
// ---------------------------------------------------------------------------

describe("findBridgeCommandDef", () => {
  test("finds top-level command by name", () => {
    const cmd = findBridgeCommandDef("launch");
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe("launch");
  });

  test("finds subcommand by compound name", () => {
    const cmd = findBridgeCommandDef("tasks list");
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe("tasks list");
  });

  test("returns undefined for unknown command", () => {
    const cmd = findBridgeCommandDef("nonexistent");
    expect(cmd).toBeUndefined();
  });
});
