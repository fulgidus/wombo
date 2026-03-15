/**
 * registry-parity.test.ts — Verify BRIDGE_REGISTRY matches COMMAND_REGISTRY
 * for all consumer-facing functions.
 *
 * Known acceptable differences (improvements, not regressions):
 *   - launch: bridge has --agent, --quest (new citty flags)
 *   - merge: bridge has --model (new citty flag)
 *   - retry: bridge has --dev (new citty flag)
 *   - logs --tail: bridge has alias "-n" (citty correct), old has undefined
 *
 * These are documented and intentional. The tests below verify everything
 * from the old registry is present in the bridge, plus explicitly test
 * the known improvements.
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
// Known acceptable differences — new flags added during citty migration
// ---------------------------------------------------------------------------

/** Flags in bridge but NOT in old registry (new additions, not regressions) */
const KNOWN_NEW_FLAGS: Record<string, string[]> = {
  launch: ["--agent", "--quest"],
  merge: ["--model"],
  retry: ["--dev"],
};

/** Flag alias improvements: bridge has alias where old had undefined */
const KNOWN_ALIAS_IMPROVEMENTS: Record<string, Record<string, string>> = {
  logs: { "--tail": "-n" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BRIDGE_REGISTRY parity with COMMAND_REGISTRY", () => {
  test("same number of top-level commands", () => {
    expect(BRIDGE_REGISTRY.length).toBe(COMMAND_REGISTRY.length);
  });

  test("same top-level command names in same order", () => {
    const bridgeNames = BRIDGE_REGISTRY.map((c) => c.name);
    const oldNames = COMMAND_REGISTRY.map((c) => c.name);
    expect(bridgeNames).toEqual(oldNames);
  });

  // Per-command parity
  for (const oldCmd of COMMAND_REGISTRY) {
    describe(`command: ${oldCmd.name}`, () => {
      const bridgeCmd = BRIDGE_REGISTRY.find((c) => c.name === oldCmd.name);

      test("exists in bridge registry", () => {
        expect(bridgeCmd).toBeDefined();
      });

      test("same summary", () => {
        expect(bridgeCmd!.summary).toBe(oldCmd.summary);
      });

      test("same aliases", () => {
        expect(bridgeCmd!.aliases ?? []).toEqual(oldCmd.aliases ?? []);
      });

      test("same mutating flag", () => {
        expect(bridgeCmd!.mutating).toBe(oldCmd.mutating);
      });

      test("same supportsDryRun flag", () => {
        expect(bridgeCmd!.supportsDryRun).toBe(oldCmd.supportsDryRun);
      });

      test("same completionSummary", () => {
        expect(bridgeCmd!.completionSummary).toBe(oldCmd.completionSummary);
      });

      test("same description", () => {
        expect(bridgeCmd!.description).toBe(oldCmd.description);
      });

      test("same positionals", () => {
        const oldPos = oldCmd.positionals.map(positionalShape);
        const bridgePos = bridgeCmd!.positionals.map(positionalShape);
        expect(bridgePos).toEqual(oldPos);
      });

      test("bridge has all old flags (superset check)", () => {
        const bridgeFlagNames = new Set(bridgeCmd!.flags.map((f) => f.name));
        for (const oldFlag of oldCmd.flags) {
          expect(bridgeFlagNames.has(oldFlag.name)).toBe(true);
        }
      });

      test("bridge-only flags are known new additions", () => {
        const oldFlagNames = new Set(oldCmd.flags.map((f) => f.name));
        const newFlags = bridgeCmd!.flags
          .filter((f) => !oldFlagNames.has(f.name))
          .map((f) => f.name);
        const expectedNew = KNOWN_NEW_FLAGS[oldCmd.name] ?? [];
        expect(newFlags.sort()).toEqual(expectedNew.sort());
      });

      test("shared flags have same details (allowing alias improvements)", () => {
        const oldFlagMap = new Map(oldCmd.flags.map((f) => [f.name, f]));
        const aliasImprovements = KNOWN_ALIAS_IMPROVEMENTS[oldCmd.name] ?? {};

        for (const bridgeFlag of bridgeCmd!.flags) {
          const oldFlag = oldFlagMap.get(bridgeFlag.name);
          if (!oldFlag) continue; // new flag, already tested above

          expect(bridgeFlag.type).toBe(oldFlag.type);
          expect(bridgeFlag.description).toBe(oldFlag.description);
          expect(bridgeFlag.default).toEqual(oldFlag.default);
          expect(bridgeFlag.enum ? [...bridgeFlag.enum] : undefined).toEqual(
            oldFlag.enum ? [...oldFlag.enum] : undefined
          );
          expect(bridgeFlag.required).toBe(oldFlag.required);

          // Alias: allow known improvements
          if (aliasImprovements[bridgeFlag.name]) {
            expect(bridgeFlag.alias).toBe(aliasImprovements[bridgeFlag.name]);
          } else {
            expect(bridgeFlag.alias).toBe(oldFlag.alias);
          }
        }
      });

      // Subcommand parity
      if (oldCmd.subcommands?.length) {
        test("same number of subcommands", () => {
          expect(bridgeCmd!.subcommands?.length).toBe(oldCmd.subcommands!.length);
        });

        test("same subcommand names", () => {
          const oldSubNames = oldCmd.subcommands!.map((sc) => sc.name);
          const bridgeSubNames = bridgeCmd!.subcommands!.map((sc) => sc.name);
          expect(bridgeSubNames).toEqual(oldSubNames);
        });

        for (const oldSub of oldCmd.subcommands!) {
          describe(`subcommand: ${oldSub.name}`, () => {
            const bridgeSub = bridgeCmd!.subcommands!.find((sc) => sc.name === oldSub.name);

            test("exists", () => {
              expect(bridgeSub).toBeDefined();
            });

            test("same summary", () => {
              expect(bridgeSub!.summary).toBe(oldSub.summary);
            });

            test("same aliases", () => {
              expect(bridgeSub!.aliases ?? []).toEqual(oldSub.aliases ?? []);
            });

            test("same mutating", () => {
              expect(bridgeSub!.mutating).toBe(oldSub.mutating);
            });

            test("same supportsDryRun", () => {
              expect(bridgeSub!.supportsDryRun).toBe(oldSub.supportsDryRun);
            });

            test("same positionals", () => {
              const oldPos = oldSub.positionals.map(positionalShape);
              const bridgePos = bridgeSub!.positionals.map(positionalShape);
              expect(bridgePos).toEqual(oldPos);
            });

            test("same flags", () => {
              const oldFlags = sortFlags(oldSub.flags).map(flagShape);
              const bridgeFlags = sortFlags(bridgeSub!.flags).map(flagShape);
              expect(bridgeFlags).toEqual(oldFlags);
            });
          });
        }
      } else {
        test("no subcommands in bridge either", () => {
          expect(bridgeCmd!.subcommands?.length ?? 0).toBe(0);
        });
      }
    });
  }

  // Verify known improvements are actually present
  describe("known improvements", () => {
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
  describe("buildAliasMap parity", () => {
    test("top-level aliases match", () => {
      const oldAliases = buildAliasMap(COMMAND_REGISTRY);
      const bridgeAliases = buildAliasMap(BRIDGE_REGISTRY);
      expect(bridgeAliases).toEqual(oldAliases);
    });

    test("tasks subcommand aliases match", () => {
      const oldTasks = COMMAND_REGISTRY.find((c) => c.name === "tasks")!;
      const bridgeTasks = BRIDGE_REGISTRY.find((c) => c.name === "tasks")!;
      const oldAliases = buildAliasMap(oldTasks.subcommands ?? []);
      const bridgeAliases = buildAliasMap(bridgeTasks.subcommands ?? []);
      expect(bridgeAliases).toEqual(oldAliases);
    });

    test("quest subcommand aliases match", () => {
      const oldQuest = COMMAND_REGISTRY.find((c) => c.name === "quest")!;
      const bridgeQuest = BRIDGE_REGISTRY.find((c) => c.name === "quest")!;
      const oldAliases = buildAliasMap(oldQuest.subcommands ?? []);
      const bridgeAliases = buildAliasMap(bridgeQuest.subcommands ?? []);
      expect(bridgeAliases).toEqual(oldAliases);
    });

    test("wishlist subcommand aliases match", () => {
      const oldWish = COMMAND_REGISTRY.find((c) => c.name === "wishlist")!;
      const bridgeWish = BRIDGE_REGISTRY.find((c) => c.name === "wishlist")!;
      const oldAliases = buildAliasMap(oldWish.subcommands ?? []);
      const bridgeAliases = buildAliasMap(bridgeWish.subcommands ?? []);
      expect(bridgeAliases).toEqual(oldAliases);
    });
  });

  describe("getCommandFlags parity (superset check)", () => {
    for (const oldCmd of COMMAND_REGISTRY) {
      test(`${oldCmd.name}: bridge has all old merged flags`, () => {
        const bridgeCmd = BRIDGE_REGISTRY.find((c) => c.name === oldCmd.name)!;
        const oldMerged = getCommandFlags(oldCmd);
        const bridgeMerged = getCommandFlags(bridgeCmd);
        const bridgeMergedNames = new Set(bridgeMerged.map((f) => f.name));
        for (const oldFlag of oldMerged) {
          expect(bridgeMergedNames.has(oldFlag.name)).toBe(true);
        }
      });

      if (oldCmd.subcommands) {
        for (const oldSub of oldCmd.subcommands) {
          test(`${oldSub.name}: bridge has all old merged flags`, () => {
            const bridgeCmd = BRIDGE_REGISTRY.find((c) => c.name === oldCmd.name)!;
            const bridgeSub = bridgeCmd.subcommands!.find((sc) => sc.name === oldSub.name)!;
            const oldMerged = getCommandFlags(oldSub);
            const bridgeMerged = getCommandFlags(bridgeSub);
            const bridgeMergedNames = new Set(bridgeMerged.map((f) => f.name));
            for (const oldFlag of oldMerged) {
              expect(bridgeMergedNames.has(oldFlag.name)).toBe(true);
            }
          });
        }
      }
    }
  });

  describe("findCommandDef parity", () => {
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
        const oldResult = findCommandDef(name);
        const bridgeResult = findBridgeCommandDef(name);
        if (!oldResult) {
          expect(bridgeResult).toBeUndefined();
        } else {
          expect(bridgeResult).toBeDefined();
          expect(bridgeResult!.name).toBe(oldResult.name);
          expect(bridgeResult!.summary).toBe(oldResult.summary);
        }
      });
    }
  });
});
