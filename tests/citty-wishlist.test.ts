/**
 * citty-wishlist.test.ts — Tests for the citty wishlist command definition.
 *
 * Verifies that the wishlist parent command and its 4 subcommands are correctly
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

describe("citty wishlist command", () => {
  test("wishlistCommand is a valid citty CommandDef", async () => {
    const { wishlistCommand } = await import("../src/commands/citty/wishlist.js");
    expect(wishlistCommand).toBeDefined();
    expect(wishlistCommand.meta).toBeDefined();
    expect(wishlistCommand.subCommands).toBeDefined();
  });

  test("wishlistCommand has correct meta name", async () => {
    const { wishlistCommand } = await import("../src/commands/citty/wishlist.js");
    const meta = await resolveValue(wishlistCommand.meta!);
    expect(meta.name).toBe("wishlist");
  });

  test("wishlistCommand has correct meta description", async () => {
    const { wishlistCommand } = await import("../src/commands/citty/wishlist.js");
    const meta = await resolveValue(wishlistCommand.meta!);
    expect(meta.description).toBeDefined();
    expect(meta.description!.length).toBeGreaterThan(0);
  });

  test("wishlistCommand has all 4 subcommands defined (plus aliases)", async () => {
    const { wishlistCommand } = await import("../src/commands/citty/wishlist");
    const subCommands = await resolveValue(wishlistCommand.subCommands!);
    const subCommandNames = Object.keys(subCommands);
    expect(subCommandNames).toContain("add");
    expect(subCommandNames).toContain("list");
    expect(subCommandNames).toContain("move");
    expect(subCommandNames).toContain("delete");
    // Also has aliases: a, ls, mv, rm, del, d
    expect(subCommandNames.length).toBe(10);
  });

  test("wishlistCommand has no run handler (default subcommand injected by router)", async () => {
    const { wishlistCommand } = await import("../src/commands/citty/wishlist.js");
    // Parent run() was removed to prevent citty's double-execution bug.
    // Default subcommand ("list") is injected by injectDefaultSubcommand() in router.ts.
    expect(wishlistCommand.run).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Subcommand structure tests
// ---------------------------------------------------------------------------

describe("citty wishlist subcommands structure", () => {
  test("add subcommand has text positional and tag flag", async () => {
    const { wishlistCommand } = await import("../src/commands/citty/wishlist.js");
    const subCommands = await resolveValue(wishlistCommand.subCommands!);
    const cmd = await resolveValue(subCommands["add"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.text).toBeDefined();
    expect(args.text.type).toBe("positional");
    expect(args.tag).toBeDefined();
  });

  test("list subcommand is defined with no required args", async () => {
    const { wishlistCommand } = await import("../src/commands/citty/wishlist.js");
    const subCommands = await resolveValue(wishlistCommand.subCommands!);
    const cmd = await resolveValue(subCommands["list"]);
    expect(cmd).toBeDefined();
    // list has optional output flag
    expect(cmd.run).toBeDefined();
  });

  test("delete subcommand has id positional", async () => {
    const { wishlistCommand } = await import("../src/commands/citty/wishlist.js");
    const subCommands = await resolveValue(wishlistCommand.subCommands!);
    const cmd = await resolveValue(subCommands["delete"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.id).toBeDefined();
    expect(args.id.type).toBe("positional");
  });

  test("move subcommand has id and position positionals", async () => {
    const { wishlistCommand } = await import("../src/commands/citty/wishlist.js");
    const subCommands = await resolveValue(wishlistCommand.subCommands!);
    const cmd = await resolveValue(subCommands["move"]);
    expect(cmd).toBeDefined();
    const args = await resolveValue(cmd.args!);
    expect(args.id).toBeDefined();
    expect(args.id.type).toBe("positional");
    expect(args.position).toBeDefined();
    expect(args.position.type).toBe("positional");
  });

  test("each subcommand has a run handler", async () => {
    const { wishlistCommand } = await import("../src/commands/citty/wishlist.js");
    const subCommands = await resolveValue(wishlistCommand.subCommands!);
    for (const [name, cmdDef] of Object.entries(subCommands)) {
      const cmd = await resolveValue(cmdDef);
      expect(cmd.run).toBeDefined();
    }
  });
});
