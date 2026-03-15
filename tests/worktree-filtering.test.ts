/**
 * worktree-filtering.test.ts — Integration tests for worktree listing, filtering,
 * and safety guards using real temporary git repositories.
 *
 * Critical coverage:
 *   - listWomboWorktrees(): filters by -worktrees directory containment and branch prefix,
 *     excludes project root
 *   - removeWorktree(): safety guard must never remove project root or non-worktree dirs
 *   - cleanupAllWorktrees(): removes matching worktrees, skips non-matching ones
 *   - verifyConfigFiles(): ensures config files are copied into worktrees
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { WomboConfig } from "../src/config.js";
import type { WorktreeInfo } from "../src/lib/worktree.js";
import {
  listWorktrees,
  listWomboWorktrees,
  removeWorktree,
  cleanupAllWorktrees,
  verifyConfigFiles,
  createWorktree,
} from "../src/lib/worktree.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a git command synchronously in a given directory. */
function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Create a minimal WomboConfig for testing.
 */
function makeConfig(
  overrides?: Partial<WomboConfig["git"]>,
  agentOverrides?: Partial<WomboConfig["agent"]>
): WomboConfig {
  return {
    tasksDir: "tasks",
    archiveDir: "archive",
    baseBranch: "main",
    build: { command: "echo build", timeout: 300_000, artifactDir: "dist" },
    install: { command: "echo install", timeout: 120_000 },
    git: {
      branchPrefix: "feature/",
      remote: "origin",
      mergeStrategy: "--no-ff",
      ...overrides,
    },
    agent: {
      bin: null,
      name: "generalist-agent",
      configFiles: [".opencode/", "opencode.json", "AGENTS.md"],
      tmuxPrefix: "wombo",
      multiplexer: "auto",
      ...agentOverrides,
    },
    portless: {
      enabled: true,
      bin: null,
      proxyPort: 1355,
      https: false,
    },
    backup: { maxBackups: 5 },
    defaults: { maxConcurrent: 6, maxRetries: 2 },
    browser: {
      enabled: false,
      bin: null,
      headless: true,
      testCommand: null,
      launchTimeout: 30_000,
      testTimeout: 60_000,
      defaultViewport: { width: 1280, height: 720 },
    },
    agentRegistry: {
      mode: "auto",
      source: "msitarzewski/agency-agents",
      cacheDir: "agents-cache",
      cacheTTL: 24 * 60 * 60 * 1000,
    },
    tdd: {
      enabled: false,
      testCommand: "bun test",
      strictTdd: false,
      testTimeout: 60_000,
    },
    devMode: false,
  };
}

/**
 * Create a temporary git repository with an initial commit.
 * Returns the absolute path to the repo root.
 * The directory name can be customized to test prefix collisions.
 */
function createTempGitRepo(dirName?: string): string {
  const parentDir = mkdtempSync(join(tmpdir(), "wombo-wt-test-"));
  const repoDir = dirName ? join(parentDir, dirName) : parentDir;

  if (dirName) {
    mkdirSync(repoDir, { recursive: true });
  }

  git("init -b main", repoDir);
  git("config user.email test@test.com", repoDir);
  git("config user.name Test", repoDir);
  writeFileSync(join(repoDir, "README.md"), "# Test\n");
  git("add .", repoDir);
  git('commit -m "initial"', repoDir);

  return repoDir;
}

/**
 * Clean up a temp directory tree.
 * Handles the case where git worktrees need pruning first.
 */
function cleanupTempDir(dir: string): void {
  try {
    // Prune worktrees first to avoid lock issues
    git("worktree prune", dir);
  } catch {
    // Repo might be gone already
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}

// ---------------------------------------------------------------------------
// listWomboWorktrees — real git repo integration tests
// ---------------------------------------------------------------------------

describe("listWomboWorktrees — real git integration", () => {
  let repoDir: string;
  let parentDir: string;

  afterEach(() => {
    if (repoDir) {
      // Clean up worktrees before removing the parent dir
      try {
        const worktrees = listWorktrees(repoDir);
        for (const wt of worktrees) {
          if (resolve(wt.path) !== resolve(repoDir)) {
            try {
              git(`worktree remove --force "${wt.path}"`, repoDir);
            } catch {
              // best effort
            }
          }
        }
      } catch {
        // repo may be gone
      }
      cleanupTempDir(resolve(repoDir, ".."));
    }
  });

  test("returns empty list for repo with no worktrees", () => {
    repoDir = createTempGitRepo("my-project");
    const config = makeConfig();
    const result = listWomboWorktrees(repoDir, config);
    expect(result).toHaveLength(0);
  });

  test("lists worktrees matching the prefix", () => {
    repoDir = createTempGitRepo("my-project");
    parentDir = resolve(repoDir, "..");
    const config = makeConfig();

    // Create a feature branch and worktree with matching prefix
    git("branch feature/auth main", repoDir);
    const wtPath = join(parentDir, "woco-auth");
    git(`worktree add "${wtPath}" feature/auth`, repoDir);

    const result = listWomboWorktrees(repoDir, config);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(wtPath);
    expect(result[0].branch).toBe("feature/auth");
  });

  test("excludes worktrees that don't match the branch prefix", () => {
    repoDir = createTempGitRepo("my-project");
    parentDir = resolve(repoDir, "..");
    const config = makeConfig();

    // Create worktrees: one with matching branch prefix, one without
    git("branch feature/auth main", repoDir);
    git("branch other/unrelated main", repoDir);
    const wocoPath = join(parentDir, "woco-auth");
    const otherPath = join(parentDir, "other-worktree");
    git(`worktree add "${wocoPath}" feature/auth`, repoDir);
    git(`worktree add "${otherPath}" other/unrelated`, repoDir);

    const result = listWomboWorktrees(repoDir, config);
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("feature/auth");
  });

  test("excludes project root even when its name contains the branch prefix pattern", () => {
    // Project root is excluded regardless of naming
    repoDir = createTempGitRepo("woco-something");
    parentDir = resolve(repoDir, "..");
    const config = makeConfig();

    // Create a legitimate worktree with a feature branch
    git("branch feature/auth main", repoDir);
    const wtPath = join(parentDir, "woco-auth");
    git(`worktree add "${wtPath}" feature/auth`, repoDir);

    const result = listWomboWorktrees(repoDir, config);

    // The project root must NOT be in the result
    const resultPaths = result.map((w) => resolve(w.path));
    expect(resultPaths).not.toContain(resolve(repoDir));

    // Only the legitimate worktree should be included
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(wtPath);
  });

  test("excludes project root named 'wombo-combo'", () => {
    // Classic case: project root is always excluded
    repoDir = createTempGitRepo("wombo-combo");
    parentDir = resolve(repoDir, "..");
    const config = makeConfig();

    // Create two legitimate worktrees
    git("branch feature/auth main", repoDir);
    git("branch feature/search main", repoDir);
    const wt1 = join(parentDir, "wombo-auth");
    const wt2 = join(parentDir, "wombo-search");
    git(`worktree add "${wt1}" feature/auth`, repoDir);
    git(`worktree add "${wt2}" feature/search`, repoDir);

    const result = listWomboWorktrees(repoDir, config);

    // Project root must NOT appear
    const resultPaths = result.map((w) => resolve(w.path));
    expect(resultPaths).not.toContain(resolve(repoDir));

    // Both legitimate worktrees should be present
    expect(result).toHaveLength(2);
    expect(resultPaths).toContain(resolve(wt1));
    expect(resultPaths).toContain(resolve(wt2));
  });

  test("handles multiple worktrees with mixed branch prefixes", () => {
    repoDir = createTempGitRepo("my-project");
    parentDir = resolve(repoDir, "..");
    const config = makeConfig();

    // Create branches: 2 with feature/ prefix, 1 without
    git("branch feature/a main", repoDir);
    git("branch feature/b main", repoDir);
    git("branch other/c main", repoDir);

    // Create worktrees
    const wt1 = join(parentDir, "woco-a");
    const wt2 = join(parentDir, "woco-b");
    const wt3 = join(parentDir, "other-c");
    git(`worktree add "${wt1}" feature/a`, repoDir);
    git(`worktree add "${wt2}" feature/b`, repoDir);
    git(`worktree add "${wt3}" other/c`, repoDir);

    const result = listWomboWorktrees(repoDir, config);
    expect(result).toHaveLength(2);
    const branches = result.map((w) => w.branch);
    expect(branches).toContain("feature/a");
    expect(branches).toContain("feature/b");
    expect(branches).not.toContain("other/c");
  });

  test("works with custom branch prefix", () => {
    repoDir = createTempGitRepo("my-project");
    parentDir = resolve(repoDir, "..");
    const config = makeConfig({ branchPrefix: "wt-" });

    git("branch wt-auth main", repoDir);
    git("branch feature/other main", repoDir);
    const wtMatch = join(parentDir, "wt-auth");
    const wtNoMatch = join(parentDir, "woco-other");
    git(`worktree add "${wtMatch}" wt-auth`, repoDir);
    git(`worktree add "${wtNoMatch}" feature/other`, repoDir);

    const result = listWomboWorktrees(repoDir, config);
    // wt-auth matches branchPrefix "wt-", feature/other does not
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("wt-auth");
  });
});

// ---------------------------------------------------------------------------
// removeWorktree — safety guard tests
// ---------------------------------------------------------------------------

describe("removeWorktree — safety guard (integration)", () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      cleanupTempDir(resolve(repoDir, ".."));
    }
  });

  test("throws when asked to remove project root (exact match)", () => {
    repoDir = createTempGitRepo("my-project");
    expect(() => removeWorktree(repoDir, repoDir)).toThrow(
      "SAFETY: refusing to remove project root"
    );
  });

  test("throws when asked to remove project root with resolved relative path", () => {
    repoDir = createTempGitRepo("my-project");
    const messyPath = join(repoDir, ".", "subdir", "..");
    expect(() => removeWorktree(repoDir, messyPath)).toThrow(
      "SAFETY: refusing to remove project root"
    );
  });

  test("throws when asked to remove project root with trailing slash", () => {
    repoDir = createTempGitRepo("my-project");
    expect(() => removeWorktree(repoDir, repoDir + "/")).toThrow(
      "SAFETY: refusing to remove project root"
    );
  });

  test("throws when project root name starts with prefix (woco-something)", () => {
    // The dangerous case: project dir IS named "woco-something"
    repoDir = createTempGitRepo("woco-my-project");
    expect(() => removeWorktree(repoDir, repoDir)).toThrow(
      "SAFETY: refusing to remove project root"
    );
  });

  test("successfully removes a legitimate worktree", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");

    // Create a worktree
    git("branch feature/temp main", repoDir);
    const wtPath = join(parentDir, "woco-temp");
    git(`worktree add "${wtPath}" feature/temp`, repoDir);

    // Verify worktree exists
    expect(existsSync(wtPath)).toBe(true);

    // Remove it
    removeWorktree(repoDir, wtPath, true);

    // Verify it's gone
    expect(existsSync(wtPath)).toBe(false);
  });

  test("removes worktree and deletes branch when deleteBranchToo=true", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");

    git("branch feature/delete-me main", repoDir);
    const wtPath = join(parentDir, "woco-delete-me");
    git(`worktree add "${wtPath}" feature/delete-me`, repoDir);

    removeWorktree(repoDir, wtPath, true);

    // Branch should be deleted
    const branches = git("branch --list feature/delete-me", repoDir);
    expect(branches).toBe("");
  });

  test("removes worktree but keeps branch when deleteBranchToo=false", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");

    git("branch feature/keep-branch main", repoDir);
    const wtPath = join(parentDir, "woco-keep-branch");
    git(`worktree add "${wtPath}" feature/keep-branch`, repoDir);

    removeWorktree(repoDir, wtPath, false);

    // Branch should still exist
    const branches = git("branch --list feature/keep-branch", repoDir);
    expect(branches.trim()).toContain("feature/keep-branch");
  });
});

// ---------------------------------------------------------------------------
// cleanupAllWorktrees — removes woco worktrees, skips non-woco ones
// ---------------------------------------------------------------------------

describe("cleanupAllWorktrees — selective cleanup", () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      // Clean up any remaining worktrees
      try {
        const worktrees = listWorktrees(repoDir);
        for (const wt of worktrees) {
          if (resolve(wt.path) !== resolve(repoDir)) {
            try {
              git(`worktree remove --force "${wt.path}"`, repoDir);
            } catch {
              // best effort
            }
          }
        }
      } catch {
        // repo may be gone
      }
      cleanupTempDir(resolve(repoDir, ".."));
    }
  });

  test("removes all worktrees matching the prefix", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");
    const config = makeConfig();

    // Create two woco worktrees
    git("branch feature/a main", repoDir);
    git("branch feature/b main", repoDir);
    const wt1 = join(parentDir, "woco-a");
    const wt2 = join(parentDir, "woco-b");
    git(`worktree add "${wt1}" feature/a`, repoDir);
    git(`worktree add "${wt2}" feature/b`, repoDir);

    const removed = cleanupAllWorktrees(repoDir, config);

    expect(removed).toBe(2);
    expect(existsSync(wt1)).toBe(false);
    expect(existsSync(wt2)).toBe(false);
  });

  test("skips worktrees that don't match the branch prefix", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");
    const config = makeConfig();

    // Create one feature branch and one non-feature branch worktree
    git("branch feature/woco main", repoDir);
    git("branch other/unrelated main", repoDir);
    const wocoWt = join(parentDir, "woco-feature");
    const otherWt = join(parentDir, "other-feature");
    git(`worktree add "${wocoWt}" feature/woco`, repoDir);
    git(`worktree add "${otherWt}" other/unrelated`, repoDir);

    const removed = cleanupAllWorktrees(repoDir, config);

    expect(removed).toBe(1);
    expect(existsSync(wocoWt)).toBe(false);
    // Non-matching worktree should still exist
    expect(existsSync(otherWt)).toBe(true);
  });

  test("never removes project root even when name starts with prefix", () => {
    // CRITICAL: project named "woco-dangerous" with prefix "woco-"
    repoDir = createTempGitRepo("woco-dangerous");
    const parentDir = resolve(repoDir, "..");
    const config = makeConfig();

    // Create a legitimate worktree
    git("branch feature/safe main", repoDir);
    const wtPath = join(parentDir, "woco-safe");
    git(`worktree add "${wtPath}" feature/safe`, repoDir);

    const removed = cleanupAllWorktrees(repoDir, config);

    // Should remove only the woco-safe worktree, NOT the project root
    expect(removed).toBe(1);
    expect(existsSync(wtPath)).toBe(false);
    expect(existsSync(repoDir)).toBe(true); // Project root must survive!
  });

  test("returns 0 when no worktrees exist", () => {
    repoDir = createTempGitRepo("my-project");
    const config = makeConfig();
    const removed = cleanupAllWorktrees(repoDir, config);
    expect(removed).toBe(0);
  });

  test("returns 0 when all worktrees have non-matching branch prefix", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");
    const config = makeConfig(); // branchPrefix is "feature/"

    // Create worktrees with non-matching branch prefix
    git("branch other/x main", repoDir);
    const wtPath = join(parentDir, "other-x");
    git(`worktree add "${wtPath}" other/x`, repoDir);

    const removed = cleanupAllWorktrees(repoDir, config);
    expect(removed).toBe(0);
    expect(existsSync(wtPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyConfigFiles — ensures config files are present in worktrees
// ---------------------------------------------------------------------------

describe("verifyConfigFiles — config file verification", () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try {
        const worktrees = listWorktrees(repoDir);
        for (const wt of worktrees) {
          if (resolve(wt.path) !== resolve(repoDir)) {
            try {
              git(`worktree remove --force "${wt.path}"`, repoDir);
            } catch {
              // best effort
            }
          }
        }
      } catch {
        // repo may be gone
      }
      cleanupTempDir(resolve(repoDir, ".."));
    }
  });

  test("no warnings when all config files are present", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");

    // Create config files in project root
    mkdirSync(join(repoDir, ".opencode", "agents"), { recursive: true });
    writeFileSync(join(repoDir, ".opencode", "agents", "agent.json"), "{}");
    writeFileSync(join(repoDir, "opencode.json"), "{}");
    writeFileSync(join(repoDir, "AGENTS.md"), "# Agents\n");

    // Commit them so they appear in the worktree
    git("add .", repoDir);
    git('commit -m "add config"', repoDir);

    // Create a worktree
    git("branch feature/test main", repoDir);
    const wtPath = join(parentDir, "woco-test");
    git(`worktree add "${wtPath}" feature/test`, repoDir);

    const config = makeConfig(
      {},
      { configFiles: [".opencode/", "opencode.json", "AGENTS.md"] }
    );

    // Capture console.log to check for warnings
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      verifyConfigFiles(repoDir, wtPath, "test", config);
    } finally {
      console.log = origLog;
    }

    // Since files are in git, they should be present in the worktree
    const warningLogs = logs.filter((l) => l.includes("WARNING"));
    expect(warningLogs).toHaveLength(0);
  });

  test("logs warning when config files are missing from worktree", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");

    // Create config files in project root (NOT committed to git)
    mkdirSync(join(repoDir, ".opencode"), { recursive: true });
    writeFileSync(join(repoDir, "opencode.json"), "{}");
    // Note: AGENTS.md exists in project root but NOT in worktree since not committed

    // Create a worktree
    git("branch feature/test main", repoDir);
    const wtPath = join(parentDir, "woco-test");
    git(`worktree add "${wtPath}" feature/test`, repoDir);

    const config = makeConfig(
      {},
      { configFiles: [".opencode/", "opencode.json", "AGENTS.md"] }
    );

    // The config files exist in projectRoot but NOT in the worktree
    // (because they weren't committed to git)
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      verifyConfigFiles(repoDir, wtPath, "test", config);
    } finally {
      console.log = origLog;
    }

    // Should warn about missing files
    const warningLogs = logs.filter((l) => l.includes("WARNING"));
    expect(warningLogs.length).toBeGreaterThan(0);
    // The warning should mention the missing config files
    const warningText = warningLogs.join(" ");
    expect(warningText).toContain("missing in worktree");
  });

  test("skips files that don't exist in source project", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");

    // Create a worktree
    git("branch feature/test main", repoDir);
    const wtPath = join(parentDir, "woco-test");
    git(`worktree add "${wtPath}" feature/test`, repoDir);

    // Config references files that don't exist in the source project
    const config = makeConfig(
      {},
      { configFiles: ["nonexistent-file.json", ".nonexistent-dir/"] }
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      verifyConfigFiles(repoDir, wtPath, "test", config);
    } finally {
      console.log = origLog;
    }

    // No warnings because the source files don't exist — nothing to verify
    const warningLogs = logs.filter((l) => l.includes("WARNING"));
    expect(warningLogs).toHaveLength(0);
  });

  test("correctly handles empty configFiles list", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");

    git("branch feature/test main", repoDir);
    const wtPath = join(parentDir, "woco-test");
    git(`worktree add "${wtPath}" feature/test`, repoDir);

    const config = makeConfig({}, { configFiles: [] });

    // Should not throw or warn with empty config list
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      verifyConfigFiles(repoDir, wtPath, "test", config);
    } finally {
      console.log = origLog;
    }

    const warningLogs = logs.filter((l) => l.includes("WARNING"));
    expect(warningLogs).toHaveLength(0);
  });

  test("detects missing directory config files", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");

    // Create a directory config in project root (not committed)
    mkdirSync(join(repoDir, ".opencode", "agents"), { recursive: true });
    writeFileSync(
      join(repoDir, ".opencode", "agents", "config.json"),
      '{"name":"test"}'
    );

    git("branch feature/test main", repoDir);
    const wtPath = join(parentDir, "woco-test");
    git(`worktree add "${wtPath}" feature/test`, repoDir);

    const config = makeConfig({}, { configFiles: [".opencode/"] });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      verifyConfigFiles(repoDir, wtPath, "test", config);
    } finally {
      console.log = origLog;
    }

    // The directory exists in source but not worktree (not committed)
    const warningLogs = logs.filter((l) => l.includes("WARNING"));
    expect(warningLogs.length).toBeGreaterThan(0);
    expect(warningLogs[0]).toContain(".opencode/");
  });
});

// ---------------------------------------------------------------------------
// createWorktree — integration test that config files are actually copied
// ---------------------------------------------------------------------------

describe("createWorktree — config file copying integration", () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try {
        const worktrees = listWorktrees(repoDir);
        for (const wt of worktrees) {
          if (resolve(wt.path) !== resolve(repoDir)) {
            try {
              git(`worktree remove --force "${wt.path}"`, repoDir);
            } catch {
              // best effort
            }
          }
        }
      } catch {
        // repo may be gone
      }
      cleanupTempDir(resolve(repoDir, ".."));
    }
  });

  test("copies config files into newly created worktree", async () => {
    repoDir = createTempGitRepo("my-project");

    // Create config files in project root (untracked)
    mkdirSync(join(repoDir, ".opencode", "agents"), { recursive: true });
    writeFileSync(
      join(repoDir, ".opencode", "agents", "agent.json"),
      '{"name":"test-agent"}'
    );
    writeFileSync(join(repoDir, "AGENTS.md"), "# Agent Instructions\n");

    const config = makeConfig(
      {},
      { configFiles: [".opencode/", "AGENTS.md"] }
    );

    const wtPath = await createWorktree(
      repoDir,
      "my-feat",
      "main",
      config
    );

    // Config files should have been copied into the worktree
    expect(existsSync(join(wtPath, ".opencode", "agents", "agent.json"))).toBe(
      true
    );
    expect(existsSync(join(wtPath, "AGENTS.md"))).toBe(true);

    // Verify content was copied correctly
    const agentJson = readFileSync(
      join(wtPath, ".opencode", "agents", "agent.json"),
      "utf-8"
    );
    expect(agentJson).toBe('{"name":"test-agent"}');

    const agentsMd = readFileSync(join(wtPath, "AGENTS.md"), "utf-8");
    expect(agentsMd).toBe("# Agent Instructions\n");
  });
});

// ---------------------------------------------------------------------------
// Edge case: prefix that is a substring of another prefix
// ---------------------------------------------------------------------------

describe("listWomboWorktrees — branch prefix edge cases", () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try {
        const worktrees = listWorktrees(repoDir);
        for (const wt of worktrees) {
          if (resolve(wt.path) !== resolve(repoDir)) {
            try {
              git(`worktree remove --force "${wt.path}"`, repoDir);
            } catch {
              // best effort
            }
          }
        }
      } catch {
        // repo may be gone
      }
      cleanupTempDir(resolve(repoDir, ".."));
    }
  });

  test("branch prefix 'feature/' does not match 'feat/something'", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");
    const config = makeConfig({ branchPrefix: "feature/" });

    git("branch feat/x main", repoDir);
    const wtPath = join(parentDir, "feat-something");
    git(`worktree add "${wtPath}" feat/x`, repoDir);

    const result = listWomboWorktrees(repoDir, config);
    expect(result).toHaveLength(0);
  });

  test("branch prefix 'feature/' matches feature branches", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");
    const config = makeConfig({ branchPrefix: "feature/" });

    git("branch feature/a main", repoDir);
    const wtPath = join(parentDir, "woco-a");
    git(`worktree add "${wtPath}" feature/a`, repoDir);

    const result = listWomboWorktrees(repoDir, config);
    expect(result).toHaveLength(1);
  });

  test("quest/ branches are always matched regardless of branchPrefix", () => {
    repoDir = createTempGitRepo("my-project");
    const parentDir = resolve(repoDir, "..");
    const config = makeConfig({ branchPrefix: "feature/" });

    git("branch quest/test main", repoDir);
    const wtPath = join(parentDir, "quest-test");
    git(`worktree add "${wtPath}" quest/test`, repoDir);

    const result = listWomboWorktrees(repoDir, config);

    // quest/ branches are always included
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(wtPath);
    expect(result.map((w) => resolve(w.path))).not.toContain(resolve(repoDir));
  });
});
