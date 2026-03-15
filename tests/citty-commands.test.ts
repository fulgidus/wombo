/**
 * citty-commands.test.ts — Tests for citty command definitions.
 *
 * TDD: These tests verify that the citty command definitions for
 * help, version, and describe work correctly, including:
 *   - Command metadata is correct
 *   - Version command outputs the correct version string
 *   - Help command outputs global help text
 *   - Describe command outputs JSON schema
 *   - --output flag works with citty commands
 */

import { describe, test, expect, spyOn } from "bun:test";

// Helper to resolve citty's Resolvable<T> values
async function resolveValue<T>(val: T | (() => T) | (() => Promise<T>) | Promise<T>): Promise<T> {
  if (typeof val === "function") {
    return await (val as () => T | Promise<T>)();
  }
  return await val;
}

// ---------------------------------------------------------------------------
// Version command tests
// ---------------------------------------------------------------------------

describe("citty version command", () => {
  test("versionCommand is a valid citty CommandDef", async () => {
    const { versionCommand } = await import("../src/commands/citty/version.js");
    expect(versionCommand).toBeDefined();
    expect(versionCommand.meta).toBeDefined();
    expect(versionCommand.run).toBeDefined();
  });

  test("versionCommand has correct meta name", async () => {
    const { versionCommand } = await import("../src/commands/citty/version.js");
    const meta = await resolveValue(versionCommand.meta!);
    expect(meta.name).toBe("version");
  });

  test("versionCommand meta includes version from package.json", async () => {
    const { versionCommand } = await import("../src/commands/citty/version.js");
    const meta = await resolveValue(versionCommand.meta!);
    // The meta.version should be set from package.json
    expect(meta.version).toBeDefined();
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("versionCommand run outputs version string", async () => {
    const { versionCommand } = await import("../src/commands/citty/version.js");
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    try {
      await versionCommand.run!({ rawArgs: [], args: { _: [] } as any, cmd: versionCommand });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toMatch(/wombo-combo \d+\.\d+\.\d+/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Help command tests
// ---------------------------------------------------------------------------

describe("citty help command", () => {
  test("helpCommand is a valid citty CommandDef", async () => {
    const { helpCommand } = await import("../src/commands/citty/help.js");
    expect(helpCommand).toBeDefined();
    expect(helpCommand.meta).toBeDefined();
    expect(helpCommand.run).toBeDefined();
  });

  test("helpCommand has correct meta name", async () => {
    const { helpCommand } = await import("../src/commands/citty/help.js");
    const meta = await resolveValue(helpCommand.meta!);
    expect(meta.name).toBe("help");
  });

  test("helpCommand run outputs global help text", async () => {
    const { helpCommand } = await import("../src/commands/citty/help.js");
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    try {
      await helpCommand.run!({ rawArgs: [], args: { _: [] } as any, cmd: helpCommand });
      const output = logs.join("\n");
      // Should contain key elements of global help
      expect(output).toContain("wombo-combo");
      expect(output).toContain("Commands:");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Describe command tests
// ---------------------------------------------------------------------------

describe("citty describe command", () => {
  test("describeCommand is a valid citty CommandDef", async () => {
    const { describeCommand } = await import("../src/commands/citty/describe.js");
    expect(describeCommand).toBeDefined();
    expect(describeCommand.meta).toBeDefined();
    expect(describeCommand.run).toBeDefined();
  });

  test("describeCommand has correct meta name", async () => {
    const { describeCommand } = await import("../src/commands/citty/describe.js");
    const meta = await resolveValue(describeCommand.meta!);
    expect(meta.name).toBe("describe");
  });

  test("describeCommand has command positional arg defined", async () => {
    const { describeCommand } = await import("../src/commands/citty/describe.js");
    const args = await resolveValue(describeCommand.args!);
    expect(args).toBeDefined();
    expect(args.command).toBeDefined();
    expect(args.command.type).toBe("positional");
  });

  test("describeCommand has output flag defined", async () => {
    const { describeCommand } = await import("../src/commands/citty/describe.js");
    const args = await resolveValue(describeCommand.args!);
    expect(args).toBeDefined();
    expect(args.output).toBeDefined();
    expect(args.output.type).toBe("string");
  });

  test("describeCommand run with no command lists all commands", async () => {
    const { describeCommand } = await import("../src/commands/citty/describe.js");
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    try {
      await describeCommand.run!({
        rawArgs: [],
        args: { _: [], command: undefined, output: undefined } as any,
        cmd: describeCommand,
      });
      const output = logs.join("\n");
      // Should output valid JSON with all commands
      const parsed = JSON.parse(output);
      expect(parsed.tool).toBe("wombo-combo");
      expect(parsed.commands).toBeInstanceOf(Array);
      expect(parsed.commands.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("describeCommand run with specific command returns that command schema", async () => {
    const { describeCommand } = await import("../src/commands/citty/describe.js");
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    try {
      await describeCommand.run!({
        rawArgs: [],
        args: { _: [], command: "launch", output: undefined } as any,
        cmd: describeCommand,
      });
      const output = logs.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed.command).toBe("launch");
      expect(parsed.summary).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  test("describeCommand with --output toon emits TOON format", async () => {
    const { describeCommand } = await import("../src/commands/citty/describe.js");
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    try {
      await describeCommand.run!({
        rawArgs: [],
        args: { _: [], command: undefined, output: "toon" } as any,
        cmd: describeCommand,
      });
      const output = logs.join("\n");
      // TOON output starts with # TOON header
      expect(output).toContain("TOON");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Citty router tests
// ---------------------------------------------------------------------------

describe("citty router", () => {
  test("isCittyCommand identifies citty-handled commands", async () => {
    const { isCittyCommand } = await import("../src/commands/citty/router.js");
    expect(isCittyCommand("version")).toBe(true);
    expect(isCittyCommand("-v")).toBe(true);
    expect(isCittyCommand("-V")).toBe(true);
    expect(isCittyCommand("help")).toBe(true);
    expect(isCittyCommand("--help")).toBe(true);
    expect(isCittyCommand("-h")).toBe(true);
    expect(isCittyCommand("describe")).toBe(true);
    // New citty commands
    expect(isCittyCommand("launch")).toBe(true);
    expect(isCittyCommand("l")).toBe(true);
    expect(isCittyCommand("resume")).toBe(true);
    expect(isCittyCommand("r")).toBe(true);
    expect(isCittyCommand("retry")).toBe(true);
    expect(isCittyCommand("re")).toBe(true);
  });

  test("isCittyCommand returns false for non-citty commands", async () => {
    const { isCittyCommand } = await import("../src/commands/citty/router.js");
    expect(isCittyCommand("init")).toBe(false);
    expect(isCittyCommand("tasks")).toBe(false);
    expect(isCittyCommand("tui")).toBe(false);
    expect(isCittyCommand("status")).toBe(false);
  });

  test("runCittyCommand routes version correctly", async () => {
    const { runCittyCommand } = await import("../src/commands/citty/router.js");
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    try {
      await runCittyCommand("version", []);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toMatch(/wombo-combo \d+\.\d+\.\d+/);
    } finally {
      spy.mockRestore();
    }
  });

  test("runCittyCommand routes -v correctly", async () => {
    const { runCittyCommand } = await import("../src/commands/citty/router.js");
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    try {
      await runCittyCommand("-v", []);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toMatch(/wombo-combo \d+\.\d+\.\d+/);
    } finally {
      spy.mockRestore();
    }
  });

  test("runCittyCommand routes help correctly", async () => {
    const { runCittyCommand } = await import("../src/commands/citty/router.js");
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    try {
      await runCittyCommand("help", []);
      const output = logs.join("\n");
      expect(output).toContain("wombo-combo");
      expect(output).toContain("Commands:");
    } finally {
      spy.mockRestore();
    }
  });

  test("runCittyCommand routes describe correctly", async () => {
    const { runCittyCommand } = await import("../src/commands/citty/router.js");
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    try {
      await runCittyCommand("describe", []);
      const output = logs.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed.tool).toBe("wombo-combo");
    } finally {
      spy.mockRestore();
    }
  });

  test("runCittyCommand passes raw args to describe", async () => {
    const { runCittyCommand } = await import("../src/commands/citty/router.js");
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    try {
      await runCittyCommand("describe", ["launch"]);
      const output = logs.join("\n");
      const parsed = JSON.parse(output);
      expect(parsed.command).toBe("launch");
    } finally {
      spy.mockRestore();
    }
  });
});
