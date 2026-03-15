/**
 * citty-retry.test.ts — Tests for citty retry command definition.
 *
 * TDD: These tests verify that the citty retry command definition
 * correctly defines all expected args/flags and produces the right
 * parsed options when processed.
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

describe("citty retry command", () => {
  test("retryCommand is a valid citty CommandDef", async () => {
    const { retryCommand } = await import("../src/commands/citty/retry.js");
    expect(retryCommand).toBeDefined();
    expect(retryCommand.meta).toBeDefined();
    expect(retryCommand.run).toBeDefined();
    expect(retryCommand.args).toBeDefined();
  });

  test("retryCommand has correct meta name", async () => {
    const { retryCommand } = await import("../src/commands/citty/retry.js");
    const meta = await resolveValue(retryCommand.meta!);
    expect(meta.name).toBe("retry");
  });

  test("retryCommand meta has description", async () => {
    const { retryCommand } = await import("../src/commands/citty/retry.js");
    const meta = await resolveValue(retryCommand.meta!);
    expect(meta.description).toBeDefined();
    expect(typeof meta.description).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Args definition tests
// ---------------------------------------------------------------------------

describe("citty retry command args", () => {
  test("defines feature-id as positional arg", async () => {
    const { retryCommand } = await import("../src/commands/citty/retry.js");
    const args = await resolveValue(retryCommand.args!);
    expect(args.featureId).toBeDefined();
    expect(args.featureId.type).toBe("positional");
    expect(args.featureId.description).toBeDefined();
  });

  test("defines --model / -m as string arg", async () => {
    const { retryCommand } = await import("../src/commands/citty/retry.js");
    const args = await resolveValue(retryCommand.args!);
    expect(args.model).toBeDefined();
    expect(args.model.type).toBe("string");
    expect(args.model.alias).toBe("m");
  });

  test("defines --interactive as boolean arg", async () => {
    const { retryCommand } = await import("../src/commands/citty/retry.js");
    const args = await resolveValue(retryCommand.args!);
    expect(args.interactive).toBeDefined();
    expect(args.interactive.type).toBe("boolean");
  });

  test("defines --dry-run as boolean arg", async () => {
    const { retryCommand } = await import("../src/commands/citty/retry.js");
    const args = await resolveValue(retryCommand.args!);
    expect(args.dryRun).toBeDefined();
    expect(args.dryRun.type).toBe("boolean");
  });

  test("defines --output / -o as string arg", async () => {
    const { retryCommand } = await import("../src/commands/citty/retry.js");
    const args = await resolveValue(retryCommand.args!);
    expect(args.output).toBeDefined();
    expect(args.output.type).toBe("string");
    expect(args.output.alias).toBe("o");
  });
});

// ---------------------------------------------------------------------------
// parseRetryArgs integration tests
// ---------------------------------------------------------------------------

describe("parseRetryArgs", () => {
  test("parses minimal args with defaults", async () => {
    const { parseRetryArgs } = await import("../src/commands/citty/retry.js");
    const result = parseRetryArgs({});
    expect(result.interactive).toBe(false);
    expect(result.dryRun).toBe(false);
  });

  test("parses featureId from positional", async () => {
    const { parseRetryArgs } = await import("../src/commands/citty/retry.js");
    const result = parseRetryArgs({ featureId: "feat-auth" });
    expect(result.featureId).toBe("feat-auth");
  });

  test("parses --model value", async () => {
    const { parseRetryArgs } = await import("../src/commands/citty/retry.js");
    const result = parseRetryArgs({ model: "gpt-4" });
    expect(result.model).toBe("gpt-4");
  });

  test("parses --interactive flag", async () => {
    const { parseRetryArgs } = await import("../src/commands/citty/retry.js");
    const result = parseRetryArgs({ interactive: true });
    expect(result.interactive).toBe(true);
  });

  test("parses --dry-run flag", async () => {
    const { parseRetryArgs } = await import("../src/commands/citty/retry.js");
    const result = parseRetryArgs({ dryRun: true });
    expect(result.dryRun).toBe(true);
  });

  test("parses --output value", async () => {
    const { parseRetryArgs } = await import("../src/commands/citty/retry.js");
    const result = parseRetryArgs({ output: "json" });
    expect(result.outputFmt).toBe("json");
  });

  test("parses all flags together", async () => {
    const { parseRetryArgs } = await import("../src/commands/citty/retry.js");
    const result = parseRetryArgs({
      featureId: "feat-auth",
      model: "anthropic/claude-sonnet-4-20250514",
      interactive: true,
      dryRun: true,
      output: "toon",
    });
    expect(result.featureId).toBe("feat-auth");
    expect(result.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(result.interactive).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.outputFmt).toBe("toon");
  });

  test("undefined values remain undefined", async () => {
    const { parseRetryArgs } = await import("../src/commands/citty/retry.js");
    const result = parseRetryArgs({});
    expect(result.featureId).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.outputFmt).toBeUndefined();
  });
});
