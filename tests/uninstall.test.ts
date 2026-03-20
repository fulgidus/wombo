/**
 * uninstall.test.ts — Tests for the woco uninstall command.
 *
 * Tests verify the cmdUninstall() function:
 *   - Detects what would be removed (dry-run)
 *   - Removes .wombo-combo/ directory
 *   - Optionally removes git hooks (pre-push, post-merge)
 *   - --keep-data flag preserves history and tasks
 *   - Returns structured results
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

// Helper to create a temp project dir with .wombo-combo structure
function createTempProject(): string {
  const dir = join(tmpdir(), `woco-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  // Create .wombo-combo directory structure
  const womboDir = join(dir, ".wombo-combo");
  mkdirSync(womboDir, { recursive: true });
  mkdirSync(join(womboDir, "logs"), { recursive: true });
  mkdirSync(join(womboDir, "history"), { recursive: true });
  mkdirSync(join(womboDir, "tasks"), { recursive: true });
  mkdirSync(join(womboDir, "archive"), { recursive: true });
  writeFileSync(join(womboDir, "config.json"), '{"baseBranch":"main"}');
  writeFileSync(join(womboDir, "state.json"), '{}');
  writeFileSync(join(womboDir, "history", "wave-1.json"), '{"id":"wave-1"}');
  writeFileSync(join(womboDir, "tasks", "task-1.yml"), 'id: task-1\ntitle: Test task');
  // Create .git/hooks directory
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  return dir;
}

// Create git hooks in the temp project
function createGitHooks(projectRoot: string): void {
  const hooksDir = join(projectRoot, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "pre-push"), "#!/bin/sh\n# wombo-combo hook\nexit 0");
  writeFileSync(join(hooksDir, "post-merge"), "#!/bin/sh\n# wombo-combo hook\nexit 0");
}

describe("cmdUninstall - dry-run mode", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = createTempProject();
  });

  afterEach(() => {
    if (existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("dry-run returns what would be removed without deleting anything", async () => {
    const { cmdUninstall } = await import("../src/commands/uninstall");

    const result = await cmdUninstall({
      projectRoot,
      dryRun: true,
      force: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.wombo_dir_exists).toBe(true);
    // .wombo-combo should NOT have been removed
    expect(existsSync(join(projectRoot, ".wombo-combo"))).toBe(true);
  });

  test("dry-run reports wombo-combo directory in items_to_remove", async () => {
    const { cmdUninstall } = await import("../src/commands/uninstall");

    const result = await cmdUninstall({
      projectRoot,
      dryRun: true,
      force: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.items_to_remove).toContain(".wombo-combo");
  });

  test("dry-run reports git hooks if they exist", async () => {
    createGitHooks(projectRoot);
    const { cmdUninstall } = await import("../src/commands/uninstall");

    const result = await cmdUninstall({
      projectRoot,
      dryRun: true,
      force: true,
    });

    expect(result.hooks_found).toBeInstanceOf(Array);
    expect(result.hooks_found.length).toBeGreaterThan(0);
    expect(result.hooks_found).toContain("pre-push");
    expect(result.hooks_found).toContain("post-merge");
  });

  test("dry-run does not report hooks when none installed", async () => {
    const { cmdUninstall } = await import("../src/commands/uninstall");

    const result = await cmdUninstall({
      projectRoot,
      dryRun: true,
      force: true,
    });

    expect(result.hooks_found).toBeInstanceOf(Array);
    expect(result.hooks_found.length).toBe(0);
  });
});

describe("cmdUninstall - actual removal", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = createTempProject();
  });

  afterEach(() => {
    if (existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("removes .wombo-combo directory", async () => {
    const { cmdUninstall } = await import("../src/commands/uninstall");

    const result = await cmdUninstall({
      projectRoot,
      dryRun: false,
      force: true,
    });

    expect(result.wombo_dir_removed).toBe(true);
    expect(existsSync(join(projectRoot, ".wombo-combo"))).toBe(false);
  });

  test("removes git hooks when present", async () => {
    createGitHooks(projectRoot);
    const { cmdUninstall } = await import("../src/commands/uninstall");

    const result = await cmdUninstall({
      projectRoot,
      dryRun: false,
      force: true,
    });

    expect(result.hooks_removed).toBeInstanceOf(Array);
    expect(result.hooks_removed).toContain("pre-push");
    expect(result.hooks_removed).toContain("post-merge");
    expect(existsSync(join(projectRoot, ".git", "hooks", "pre-push"))).toBe(false);
    expect(existsSync(join(projectRoot, ".git", "hooks", "post-merge"))).toBe(false);
  });

  test("keeps data when --keep-data flag is set (preserves tasks and history)", async () => {
    const { cmdUninstall } = await import("../src/commands/uninstall");

    const result = await cmdUninstall({
      projectRoot,
      dryRun: false,
      force: true,
      keepData: true,
    });

    // .wombo-combo itself should be kept (or the data subdirs)
    expect(result.data_preserved).toBe(true);
    // history and tasks should still exist
    expect(existsSync(join(projectRoot, ".wombo-combo", "history"))).toBe(true);
    expect(existsSync(join(projectRoot, ".wombo-combo", "tasks"))).toBe(true);
  });

  test("without keep-data, removes everything including history and tasks", async () => {
    const { cmdUninstall } = await import("../src/commands/uninstall");

    const result = await cmdUninstall({
      projectRoot,
      dryRun: false,
      force: true,
      keepData: false,
    });

    expect(result.data_preserved).toBe(false);
    expect(existsSync(join(projectRoot, ".wombo-combo"))).toBe(false);
  });

  test("returns wombo_dir_exists=false when project not initialized", async () => {
    const emptyDir = join(tmpdir(), `woco-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    const { cmdUninstall } = await import("../src/commands/uninstall");

    try {
      const result = await cmdUninstall({
        projectRoot: emptyDir,
        dryRun: true,
        force: true,
      });

      expect(result.wombo_dir_exists).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("cmdUninstall - result shape", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = createTempProject();
  });

  afterEach(() => {
    if (existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("result has expected fields in dry-run mode", async () => {
    const { cmdUninstall } = await import("../src/commands/uninstall");

    const result = await cmdUninstall({
      projectRoot,
      dryRun: true,
      force: true,
    });

    expect(result).toHaveProperty("dry_run");
    expect(result).toHaveProperty("wombo_dir_exists");
    expect(result).toHaveProperty("items_to_remove");
    expect(result).toHaveProperty("hooks_found");
  });

  test("result has expected fields after removal", async () => {
    const { cmdUninstall } = await import("../src/commands/uninstall");

    const result = await cmdUninstall({
      projectRoot,
      dryRun: false,
      force: true,
    });

    expect(result).toHaveProperty("dry_run");
    expect(result).toHaveProperty("wombo_dir_removed");
    expect(result).toHaveProperty("hooks_removed");
    expect(result).toHaveProperty("data_preserved");
  });
});
