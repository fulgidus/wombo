/**
 * citty-bridge.test.ts — Tests for the citty-to-schema bridge.
 *
 * The bridge reads citty command definitions and produces CommandDef[]
 * compatible with the existing schema introspection layer.
 */

import { describe, test, expect } from "bun:test";
import { defineCommand } from "citty";
import {
  cittyArgToFlagDef,
  cittyCommandToCommandDef,
  type BridgeCommandMeta,
} from "./citty-bridge.js";
import type { FlagDef, PositionalDef, CommandDef } from "./schema-types.js";

// ---------------------------------------------------------------------------
// cittyArgToFlagDef — convert a single citty arg to FlagDef
// ---------------------------------------------------------------------------

describe("cittyArgToFlagDef", () => {
  test("converts a string arg to FlagDef", () => {
    const result = cittyArgToFlagDef("model", {
      type: "string",
      description: "AI model to use",
      alias: "m",
      required: false,
    });

    expect(result).toEqual({
      name: "--model",
      alias: "-m",
      description: "AI model to use",
      type: "string",
    });
  });

  test("converts a boolean arg to FlagDef", () => {
    const result = cittyArgToFlagDef("dryRun", {
      type: "boolean",
      description: "Show what would happen",
      required: false,
    });

    expect(result).toEqual({
      name: "--dry-run",
      description: "Show what would happen",
      type: "boolean",
    });
  });

  test("converts camelCase to kebab-case for flag name", () => {
    const result = cittyArgToFlagDef("maxConcurrent", {
      type: "string",
      description: "Max concurrent agents",
    });

    expect(result!.name).toBe("--max-concurrent");
  });

  test("returns null for positional args", () => {
    const result = cittyArgToFlagDef("featureId", {
      type: "positional",
      description: "Feature ID",
      required: true,
    });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cittyCommandToCommandDef — convert a full citty command to CommandDef
// ---------------------------------------------------------------------------

describe("cittyCommandToCommandDef", () => {
  test("converts a simple citty command to CommandDef", () => {
    const cmd = defineCommand({
      meta: {
        name: "status",
        description: "Show the status of the current wave",
      },
      args: {
        output: {
          type: "string",
          alias: "o",
          description: "Output format: text, json, or toon",
          required: false,
        },
      },
      run() {},
    });

    const meta: BridgeCommandMeta = {
      aliases: ["s"],
      mutating: false,
      supportsDryRun: false,
      completionSummary: "Show wave status",
    };

    const result = cittyCommandToCommandDef(cmd as any, meta);

    expect(result.name).toBe("status");
    expect(result.aliases).toEqual(["s"]);
    expect(result.summary).toBe("Show the status of the current wave");
    expect(result.completionSummary).toBe("Show wave status");
    expect(result.mutating).toBe(false);
    expect(result.supportsDryRun).toBe(false);
    expect(result.positionals).toEqual([]);
    // output flag should be filtered out (it's a global flag)
    expect(result.flags.some((f) => f.name === "--output")).toBe(false);
  });

  test("extracts positional args", () => {
    const cmd = defineCommand({
      meta: {
        name: "logs",
        description: "Pretty-print agent logs",
      },
      args: {
        featureId: {
          type: "positional",
          description: "Feature ID whose logs to display",
          required: true,
        },
        tail: {
          type: "string",
          description: "Show only the last N lines",
          required: false,
        },
        follow: {
          type: "boolean",
          alias: "f",
          description: "Stream new output",
          required: false,
        },
      },
      run() {},
    });

    const meta: BridgeCommandMeta = {
      aliases: ["lo"],
      mutating: false,
      supportsDryRun: false,
    };

    const result = cittyCommandToCommandDef(cmd as any, meta);

    expect(result.positionals).toEqual([
      { name: "feature-id", description: "Feature ID whose logs to display", required: true },
    ]);
    expect(result.flags.length).toBe(2); // tail and follow (output filtered)
    expect(result.flags[0].name).toBe("--tail");
    expect(result.flags[1].name).toBe("--follow");
    expect(result.flags[1].alias).toBe("-f");
  });

  test("applies enum overrides from meta", () => {
    const cmd = defineCommand({
      meta: {
        name: "launch",
        description: "Launch agents",
      },
      args: {
        priority: {
          type: "string",
          description: "Filter by priority",
          required: false,
        },
      },
      run() {},
    });

    const meta: BridgeCommandMeta = {
      aliases: ["l"],
      mutating: true,
      supportsDryRun: true,
      flagOverrides: {
        priority: {
          enum: ["critical", "high", "medium", "low", "wishlist"],
        },
      },
    };

    const result = cittyCommandToCommandDef(cmd as any, meta);
    const priorityFlag = result.flags.find((f) => f.name === "--priority");
    expect(priorityFlag).toBeDefined();
    expect(priorityFlag!.enum).toEqual(["critical", "high", "medium", "low", "wishlist"]);
  });

  test("applies default overrides from meta", () => {
    const cmd = defineCommand({
      meta: {
        name: "test-cmd",
        description: "Test command",
      },
      args: {
        dryRun: {
          type: "boolean",
          description: "Dry run mode",
          required: false,
        },
      },
      run() {},
    });

    const meta: BridgeCommandMeta = {
      mutating: true,
      supportsDryRun: true,
      flagOverrides: {
        dryRun: {
          default: false,
        },
      },
    };

    const result = cittyCommandToCommandDef(cmd as any, meta);
    const dryRunFlag = result.flags.find((f) => f.name === "--dry-run");
    expect(dryRunFlag).toBeDefined();
    expect(dryRunFlag!.default).toBe(false);
  });

  test("filters out global-equivalent flags (output only)", () => {
    const cmd = defineCommand({
      meta: {
        name: "test-cmd",
        description: "Test command",
      },
      args: {
        output: {
          type: "string",
          alias: "o",
          description: "Output format",
          required: false,
        },
        dev: {
          type: "boolean",
          description: "Dev mode",
          required: false,
        },
        force: {
          type: "boolean",
          description: "Force mode",
          required: false,
        },
        realFlag: {
          type: "string",
          description: "A real flag",
          required: false,
        },
      },
      run() {},
    });

    const meta: BridgeCommandMeta = {
      mutating: false,
      supportsDryRun: false,
    };

    const result = cittyCommandToCommandDef(cmd as any, meta);
    // output is filtered (global), but dev and force pass through
    expect(result.flags.length).toBe(3);
    expect(result.flags.map((f: any) => f.name).sort()).toEqual(["--dev", "--force", "--real-flag"]);
  });

  test("includes description from meta if provided", () => {
    const cmd = defineCommand({
      meta: {
        name: "init",
        description: "Short summary",
      },
      args: {},
      run() {},
    });

    const meta: BridgeCommandMeta = {
      aliases: ["i"],
      mutating: true,
      supportsDryRun: true,
      description: "Extended description for init command.",
    };

    const result = cittyCommandToCommandDef(cmd, meta);
    expect(result.summary).toBe("Short summary");
    expect(result.description).toBe("Extended description for init command.");
  });

  test("uses name/summary overrides when meta is a function (async meta)", () => {
    // Simulate a citty command with async meta (like versionCommand)
    const cmd = defineCommand({
      meta: async () => ({
        name: "version",
        description: "Print version and exit",
      }),
      args: {},
      run() {},
    });

    const meta: BridgeCommandMeta = {
      name: "version",
      summary: "Print version and exit (also: -v, -V)",
      mutating: false,
      supportsDryRun: false,
    };

    const result = cittyCommandToCommandDef(cmd, meta);
    expect(result.name).toBe("version");
    expect(result.summary).toBe("Print version and exit (also: -v, -V)");
  });

  test("meta name/summary overrides take precedence over citty meta", () => {
    const cmd = defineCommand({
      meta: {
        name: "citty-name",
        description: "citty description",
      },
      args: {},
      run() {},
    });

    const meta: BridgeCommandMeta = {
      name: "override-name",
      summary: "override summary",
      mutating: false,
      supportsDryRun: false,
    };

    const result = cittyCommandToCommandDef(cmd, meta);
    expect(result.name).toBe("override-name");
    expect(result.summary).toBe("override summary");
  });
});
