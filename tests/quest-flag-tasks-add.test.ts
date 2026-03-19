/**
 * quest-flag-tasks-add.test.ts — Tests for the --quest flag on `woco tasks add`.
 *
 * Verifies:
 *   - The citty add subcommand exposes a `quest` arg
 *   - cmdTasksAdd validates that the quest exists before saving
 *   - cmdTasksAdd sets task.quest when a valid quest ID is provided
 *   - cmdTasksAdd rejects non-existent quest IDs with an error
 *   - Dry-run output includes the quest field
 *   - Quest text output is displayed after successful add
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import type { WomboConfig } from "../src/config";
import { cmdTasksAdd } from "../src/commands/tasks/add";
import { loadFeatures } from "../src/lib/tasks";

// Helper to resolve citty's Resolvable<T> values
async function resolveValue<T>(val: T | (() => T) | (() => Promise<T>) | Promise<T>): Promise<T> {
  if (typeof val === "function") {
    return await (val as () => T | Promise<T>)();
  }
  return await val;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): WomboConfig {
  return {
    tasksDir: "tasks",
    archiveDir: "archive",
    baseBranch: "main",
    build: { command: "bun run build", timeout: 300_000, artifactDir: "dist" },
    install: { command: "bun install", timeout: 120_000 },
    git: { branchPrefix: "feature/", remote: "origin", mergeStrategy: "--no-ff" },
    agent: { bin: null, name: "generalist-agent", configFiles: [], tmuxPrefix: "wombo" },
    portless: { enabled: true, bin: null, proxyPort: 1355, https: false },
    backup: { maxBackups: 5 },
    defaults: { maxConcurrent: 6, maxRetries: 2 },
    browser: { enabled: false, bin: null, headless: true, testCommand: null, launchTimeout: 30_000, testTimeout: 60_000, defaultViewport: { width: 1280, height: 720 } },
    agentRegistry: { mode: "auto", source: "msitarzewski/agency-agents", cacheDir: "agents-cache", cacheTTL: 86400000 },
    tdd: { enabled: false, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 },
    merge: { maxEscalation: "tier4" },
    devMode: false,
  } as WomboConfig;
}

function setupTaskStore(dir: string): void {
  const tasksDir = join(dir, ".wombo-combo", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "_meta.yml"), stringifyYaml({
    version: "1",
    meta: { created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", project: "test", generator: "test", maintainer: "test" },
  }));
}

function createQuest(dir: string, questId: string): void {
  const questsDir = join(dir, ".wombo-combo", "quests");
  mkdirSync(questsDir, { recursive: true });
  writeFileSync(join(questsDir, `${questId}.yml`), stringifyYaml({
    id: questId, title: `Quest: ${questId}`, description: "test", status: "active",
    tasks: [], created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z",
  }));
}

/**
 * Custom error class thrown when process.exit is mocked.
 * Prevents the test runner from actually exiting.
 */
class MockExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

/**
 * Run a function with process.exit mocked to throw MockExitError.
 * Returns captured stderr lines and the exit code (if any).
 */
async function withMockedExit(fn: () => Promise<void>): Promise<{ errors: string[]; exitCode: number | null }> {
  const errors: string[] = [];
  const origExit = process.exit;
  const origErr = console.error;
  const origWarn = console.warn;

  // Suppress console.warn (e.g. quest-schema validation warnings)
  console.warn = () => {};
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  let exitCode: number | null = null;
  // Mock process.exit to throw instead of actually exiting
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new MockExitError(exitCode);
  }) as never;

  try {
    await fn();
  } catch (err) {
    if (!(err instanceof MockExitError)) {
      throw err; // Re-throw unexpected errors
    }
  } finally {
    process.exit = origExit;
    console.error = origErr;
    console.warn = origWarn;
  }

  return { errors, exitCode };
}

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "wombo-qf-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Citty command definition tests
// ---------------------------------------------------------------------------

describe("citty add subcommand --quest arg", () => {
  test("add subcommand has a quest arg defined", async () => {
    const { tasksCommand } = await import("../src/commands/citty/tasks");
    const subCommands = await resolveValue(tasksCommand.subCommands!);
    const addCmd = await resolveValue(subCommands["add"]);
    const args = await resolveValue(addCmd.args!);
    expect(args.quest).toBeDefined();
    expect(args.quest.type).toBe("string");
    expect(args.quest.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cmdTasksAdd quest validation tests
// ---------------------------------------------------------------------------

describe("cmdTasksAdd --quest validation", () => {
  test("rejects non-existent quest ID with error and exits", async () => {
    setupTaskStore(tmpDir);
    const { errors, exitCode } = await withMockedExit(async () => {
      await cmdTasksAdd({
        projectRoot: tmpDir,
        config: makeConfig(),
        id: "test-task",
        title: "Test Task",
        quest: "nonexistent-quest",
        outputFmt: "text",
      });
    });

    expect(exitCode).toBe(1);
    const errorOutput = errors.join("\n");
    expect(errorOutput).toContain("nonexistent-quest");
    expect(errorOutput.toLowerCase()).toContain("not found");
  });

  test("task not saved when quest does not exist", async () => {
    setupTaskStore(tmpDir);
    await withMockedExit(async () => {
      await cmdTasksAdd({
        projectRoot: tmpDir,
        config: makeConfig(),
        id: "should-not-be-saved",
        title: "Should Not Be Saved",
        quest: "bogus-quest",
        outputFmt: "text",
      });
    });

    const data = loadFeatures(tmpDir, makeConfig());
    const task = data.tasks.find((t) => t.id === "should-not-be-saved");
    expect(task).toBeUndefined();
  });

  test("accepts valid quest ID and sets task.quest", async () => {
    setupTaskStore(tmpDir);
    createQuest(tmpDir, "my-quest");

    // Suppress console output (loadQuest validation warnings, success messages)
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};

    try {
      await cmdTasksAdd({
        projectRoot: tmpDir,
        config: makeConfig(),
        id: "test-task-with-quest",
        title: "Test Task With Quest",
        quest: "my-quest",
        outputFmt: "text",
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    }

    const data = loadFeatures(tmpDir, makeConfig());
    const task = data.tasks.find((t) => t.id === "test-task-with-quest");
    expect(task).toBeDefined();
    expect(task!.quest).toBe("my-quest");
  });

  test("task has no quest field when --quest is not provided", async () => {
    setupTaskStore(tmpDir);

    // Suppress console output
    const origLog = console.log;
    console.log = () => {};
    try {
      await cmdTasksAdd({
        projectRoot: tmpDir,
        config: makeConfig(),
        id: "test-task-no-quest",
        title: "Test Task No Quest",
        outputFmt: "text",
      });
    } finally {
      console.log = origLog;
    }

    const data = loadFeatures(tmpDir, makeConfig());
    const task = data.tasks.find((t) => t.id === "test-task-no-quest");
    expect(task).toBeDefined();
    expect(task!.quest).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dry-run and output tests
// ---------------------------------------------------------------------------

describe("cmdTasksAdd --quest output", () => {
  test("dry-run with quest does not save task", async () => {
    setupTaskStore(tmpDir);
    createQuest(tmpDir, "dry-run-quest");

    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};

    try {
      await cmdTasksAdd({
        projectRoot: tmpDir,
        config: makeConfig(),
        id: "dry-run-task",
        title: "Dry Run Task",
        quest: "dry-run-quest",
        outputFmt: "text",
        dryRun: true,
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    }

    const data = loadFeatures(tmpDir, makeConfig());
    const task = data.tasks.find((t) => t.id === "dry-run-task");
    expect(task).toBeUndefined();
  });

  test("dry-run JSON output includes quest field", async () => {
    setupTaskStore(tmpDir);
    createQuest(tmpDir, "json-quest");

    const logs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.warn = () => {};
    console.error = () => {};

    try {
      await cmdTasksAdd({
        projectRoot: tmpDir,
        config: makeConfig(),
        id: "json-dry-run-task",
        title: "JSON Dry Run Task",
        quest: "json-quest",
        outputFmt: "json",
        dryRun: true,
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    }

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.quest).toBe("json-quest");
    expect(parsed.dry_run).toBe(true);
  });

  test("quest text output displayed after successful add", async () => {
    setupTaskStore(tmpDir);
    createQuest(tmpDir, "output-quest");

    const logs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.warn = () => {};
    console.error = () => {};

    try {
      await cmdTasksAdd({
        projectRoot: tmpDir,
        config: makeConfig(),
        id: "output-task",
        title: "Output Task",
        quest: "output-quest",
        outputFmt: "text",
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    }

    const output = logs.join("\n");
    expect(output).toContain("quest: output-quest");
  });
});
