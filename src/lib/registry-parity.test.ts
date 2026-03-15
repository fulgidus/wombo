/**
 * registry-parity.test.ts — Verify COMMAND_REGISTRY (from schema.ts) is
 * backed by BRIDGE_REGISTRY (from citty-registry.ts).
 *
 * After the citty-schema-bridge swap, COMMAND_REGISTRY is a lazy proxy
 * over BRIDGE_REGISTRY. These tests verify:
 *   1. Both expose the same commands in the same order.
 *   2. Consumer-facing helpers (buildAliasMap, getCommandFlags, findCommandDef)
 *      work correctly through the proxy.
 *   3. The bridge-generated registry has the expected shape.
 */

import { describe, expect, test } from "bun:test";
import { BRIDGE_REGISTRY, findBridgeCommandDef } from "./citty-registry.js";
import {
  COMMAND_REGISTRY,
  findCommandDef,
  buildAliasMap,
  getCommandFlags,
  GLOBAL_FLAGS,
  type CommandDef,
  type FlagDef,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sort flags by name for stable comparison */
function sortFlags(flags: FlagDef[]): FlagDef[] {
  return [...flags].sort((a, b) => a.name.localeCompare(b.name));
}

/** Extract a simplified flag shape for comparison */
function flagShape(f: FlagDef) {
  return {
    name: f.name,
    type: f.type,
    description: f.description,
    alias: f.alias,
    default: f.default,
    enum: f.enum ? [...f.enum] : undefined,
    required: f.required,
  };
}

/** Extract a simplified positional shape for comparison */
function positionalShape(p: { name: string; description: string; required?: boolean }) {
  return {
    name: p.name,
    description: p.description,
    required: p.required,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("COMMAND_REGISTRY is backed by BRIDGE_REGISTRY", () => {
  test("same number of top-level commands", () => {
    expect(COMMAND_REGISTRY.length).toBe(BRIDGE_REGISTRY.length);
  });

  test("same top-level command names in same order", () => {
    const registryNames = COMMAND_REGISTRY.map((c) => c.name);
    const bridgeNames = BRIDGE_REGISTRY.map((c) => c.name);
    expect(registryNames).toEqual(bridgeNames);
  });

  test("each entry is the same object", () => {
    for (let i = 0; i < BRIDGE_REGISTRY.length; i++) {
      expect(COMMAND_REGISTRY[i]).toBe(BRIDGE_REGISTRY[i]);
    }
  });

  // Per-command shape validation
  for (const cmd of BRIDGE_REGISTRY) {
    describe(`command: ${cmd.name}`, () => {
      test("has summary", () => {
        expect(cmd.summary).toBeTruthy();
      });

      test("has mutating flag", () => {
        expect(typeof cmd.mutating).toBe("boolean");
      });

      test("has supportsDryRun flag", () => {
        expect(typeof cmd.supportsDryRun).toBe("boolean");
      });

      test("positionals are well-formed", () => {
        for (const p of cmd.positionals) {
          expect(p.name).toBeTruthy();
          expect(p.description).toBeTruthy();
        }
      });

      test("flags are well-formed", () => {
        for (const f of cmd.flags) {
          expect(f.name).toMatch(/^--/);
          expect(f.description).toBeTruthy();
          expect(["string", "number", "boolean", "string[]"]).toContain(f.type);
        }
      });

      // Subcommand shape validation
      if (cmd.subcommands?.length) {
        test("has subcommands", () => {
          expect(cmd.subcommands!.length).toBeGreaterThan(0);
        });

        for (const sub of cmd.subcommands!) {
          describe(`subcommand: ${sub.name}`, () => {
            test("has summary", () => {
              expect(sub.summary).toBeTruthy();
            });

            test("has compound name", () => {
              expect(sub.name).toContain(" ");
            });

            test("positionals are well-formed", () => {
              for (const p of sub.positionals) {
                expect(p.name).toBeTruthy();
                expect(p.description).toBeTruthy();
              }
            });

            test("flags are well-formed", () => {
              for (const f of sub.flags) {
                expect(f.name).toMatch(/^--/);
                expect(f.description).toBeTruthy();
                expect(["string", "number", "boolean", "string[]"]).toContain(f.type);
              }
            });
          });
        }
      }
    });
  }

  // Verify notable flags are present (formerly "known improvements")
  describe("citty-migrated flags present", () => {
    test("launch has --agent and --quest flags", () => {
      const cmd = BRIDGE_REGISTRY.find((c) => c.name === "launch")!;
      const names = cmd.flags.map((f) => f.name);
      expect(names).toContain("--agent");
      expect(names).toContain("--quest");
    });

    test("merge has --model flag", () => {
      const cmd = BRIDGE_REGISTRY.find((c) => c.name === "merge")!;
      expect(cmd.flags.map((f) => f.name)).toContain("--model");
    });

    test("retry has --dev flag", () => {
      const cmd = BRIDGE_REGISTRY.find((c) => c.name === "retry")!;
      expect(cmd.flags.map((f) => f.name)).toContain("--dev");
    });

    test("logs --tail has alias -n", () => {
      const cmd = BRIDGE_REGISTRY.find((c) => c.name === "logs")!;
      const tail = cmd.flags.find((f) => f.name === "--tail");
      expect(tail!.alias).toBe("-n");
    });
  });

  // Helper function parity
  describe("buildAliasMap works through COMMAND_REGISTRY proxy", () => {
    test("top-level aliases match", () => {
      const registryAliases = buildAliasMap(COMMAND_REGISTRY);
      const bridgeAliases = buildAliasMap(BRIDGE_REGISTRY);
      expect(registryAliases).toEqual(bridgeAliases);
    });

    test("tasks subcommand aliases match", () => {
      const registryTasks = COMMAND_REGISTRY.find((c: CommandDef) => c.name === "tasks")!;
      const bridgeTasks = BRIDGE_REGISTRY.find((c) => c.name === "tasks")!;
      const registryAliases = buildAliasMap(registryTasks.subcommands ?? []);
      const bridgeAliases = buildAliasMap(bridgeTasks.subcommands ?? []);
      expect(registryAliases).toEqual(bridgeAliases);
    });

    test("quest subcommand aliases match", () => {
      const registryQuest = COMMAND_REGISTRY.find((c: CommandDef) => c.name === "quest")!;
      const bridgeQuest = BRIDGE_REGISTRY.find((c) => c.name === "quest")!;
      const registryAliases = buildAliasMap(registryQuest.subcommands ?? []);
      const bridgeAliases = buildAliasMap(bridgeQuest.subcommands ?? []);
      expect(registryAliases).toEqual(bridgeAliases);
    });

    test("wishlist subcommand aliases match", () => {
      const registryWish = COMMAND_REGISTRY.find((c: CommandDef) => c.name === "wishlist")!;
      const bridgeWish = BRIDGE_REGISTRY.find((c) => c.name === "wishlist")!;
      const registryAliases = buildAliasMap(registryWish.subcommands ?? []);
      const bridgeAliases = buildAliasMap(bridgeWish.subcommands ?? []);
      expect(registryAliases).toEqual(bridgeAliases);
    });
  });

  describe("getCommandFlags works through COMMAND_REGISTRY proxy", () => {
    for (const cmd of BRIDGE_REGISTRY) {
      test(`${cmd.name}: merged flags include globals`, () => {
        const registryCmd = COMMAND_REGISTRY.find((c: CommandDef) => c.name === cmd.name)!;
        const merged = getCommandFlags(registryCmd);
        const mergedNames = new Set(merged.map((f) => f.name));
        // Should have all command-specific flags
        for (const f of cmd.flags) {
          expect(mergedNames.has(f.name)).toBe(true);
        }
        // Should have global flags (unless overridden by command)
        const cmdFlagNames = new Set(cmd.flags.map((f) => f.name));
        for (const gf of GLOBAL_FLAGS) {
          if (!cmdFlagNames.has(gf.name)) {
            expect(mergedNames.has(gf.name)).toBe(true);
          }
        }
      });
    }
  });

  describe("findCommandDef delegates to findBridgeCommandDef", () => {
    const testNames = [
      "init", "launch", "resume", "status", "verify", "merge", "retry",
      "cleanup", "history", "usage", "abort", "upgrade", "logs", "tasks",
      "help", "version", "describe", "quest", "genesis", "wishlist", "completion",
      "tasks list", "tasks add", "tasks set-status", "tasks check", "tasks archive",
      "tasks show", "tasks graph", "tasks set-priority", "tasks set-difficulty",
      "quest create", "quest list", "quest show", "quest plan",
      "quest activate", "quest pause", "quest complete", "quest abandon",
      "wishlist add", "wishlist list", "wishlist delete",
      "nonexistent",
    ];

    for (const name of testNames) {
      test(`"${name}": same result`, () => {
        const registryResult = findCommandDef(name);
        const bridgeResult = findBridgeCommandDef(name);
        if (!registryResult) {
          expect(bridgeResult).toBeUndefined();
        } else {
          expect(bridgeResult).toBeDefined();
          expect(bridgeResult!.name).toBe(registryResult.name);
          expect(bridgeResult!.summary).toBe(registryResult.summary);
        }
      });
    }
  });
});
