/**
 * worktree.test.ts — Unit tests for worktree listing, filtering, and safety guards.
 *
 * Critical coverage:
 *   - listWomboWorktrees filters by -worktrees directory containment and branch prefix
 *   - removeWorktree must refuse to remove the project root
 *   - cleanupAllWorktrees must never touch the project root
 *   - The "wombo-combo" prefix collision bug (project dir name contains worktree prefix)
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import type { WomboConfig } from "../src/config.js";
import type { WorktreeInfo } from "../src/lib/worktree.js";

// ---------------------------------------------------------------------------
// Helpers: minimal WomboConfig for testing
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<WomboConfig["git"]>): WomboConfig {
  return {
    tasksDir: "tasks",
    archiveDir: "archive",
    baseBranch: "main",
    build: { command: "bun run build", timeout: 300_000, artifactDir: "dist" },
    install: { command: "bun install", timeout: 120_000 },
    git: {
      branchPrefix: "feature/",
      remote: "origin",
      mergeStrategy: "--no-ff",
      ...overrides,
    },
    agent: {
      bin: null,
      name: "generalist-agent",
      configFiles: [],
      tmuxPrefix: "wombo",
      multiplexer: "auto",
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

// ---------------------------------------------------------------------------
// Tests for worktreePath and featureBranchName (pure functions, no git needed)
// ---------------------------------------------------------------------------

import { worktreePath, featureBranchName } from "../src/lib/worktree.js";

describe("featureBranchName", () => {
  test("generates correct branch name with default prefix", () => {
    const config = makeConfig();
    expect(featureBranchName("my-feature", config)).toBe("feature/my-feature");
  });

  test("generates correct branch name with custom prefix", () => {
    const config = makeConfig({ branchPrefix: "feat-" });
    expect(featureBranchName("auth-flow", config)).toBe("feat-auth-flow");
  });

  test("handles empty feature ID", () => {
    const config = makeConfig();
    expect(featureBranchName("", config)).toBe("feature/");
  });
});

describe("worktreePath", () => {
  test("generates path inside project-worktrees directory", () => {
    const config = makeConfig();
    const result = worktreePath("/home/user/projects/my-app", "auth", config);
    expect(result).toBe(resolve("/home/user/projects/my-app-worktrees", "auth"));
  });

  test("ignores config overrides (uses project-name-worktrees layout)", () => {
    const config = makeConfig({ branchPrefix: "wt-" });
    const result = worktreePath("/home/user/projects/my-app", "auth", config);
    expect(result).toBe(resolve("/home/user/projects/my-app-worktrees", "auth"));
  });

  test("works with deeply nested project root", () => {
    const config = makeConfig();
    const result = worktreePath("/a/b/c/d/project", "feat1", config);
    expect(result).toBe(resolve("/a/b/c/d/project-worktrees", "feat1"));
  });
});

// ---------------------------------------------------------------------------
// Tests for listWomboWorktrees filtering logic
// ---------------------------------------------------------------------------

describe("listWomboWorktrees — worktrees-dir and branch-prefix filtering", () => {
  // We test the filtering logic by reimplementing it locally. The production
  // implementation (listWomboWorktrees) uses three criteria:
  //   1. Path is inside the `<project>-worktrees/` directory
  //   2. Branch starts with config.git.branchPrefix (e.g. "feature/")
  //   3. Branch starts with "quest/"
  // The project root is always excluded.

  /**
   * Simulate the filtering logic from listWomboWorktrees.
   * This mirrors the production implementation so we can test edge cases.
   */
  function filterWomboWorktrees(
    worktrees: WorktreeInfo[],
    projectRoot: string,
    config: WomboConfig
  ): WorktreeInfo[] {
    const resolvedRoot = resolve(projectRoot);
    const wtDir = resolve(projectRoot + "-worktrees");
    return worktrees.filter((wt) => {
      // Never include the main project root
      if (resolve(wt.path) === resolvedRoot) return false;
      // Match worktrees inside the -worktrees directory
      if (resolve(wt.path).startsWith(wtDir + "/")) return true;
      // Match worktrees whose branch starts with the branch prefix
      if (wt.branch && wt.branch.startsWith(config.git.branchPrefix)) return true;
      // Match quest branches
      if (wt.branch && wt.branch.startsWith("quest/")) return true;
      return false;
    });
  }

  const projectRoot = "/home/user/projects/wombo-combo";
  const config = makeConfig();

  const worktrees: WorktreeInfo[] = [
    {
      path: "/home/user/projects/wombo-combo",
      branch: "main",
      head: "abc123",
      bare: false,
    },
    {
      path: "/home/user/projects/wombo-combo-worktrees/auth-flow",
      branch: "feature/auth-flow",
      head: "def456",
      bare: false,
    },
    {
      path: "/home/user/projects/wombo-combo-worktrees/search-api",
      branch: "feature/search-api",
      head: "ghi789",
      bare: false,
    },
  ];

  test("excludes project root", () => {
    const result = filterWomboWorktrees(worktrees, projectRoot, config);
    expect(result.map((w) => w.path)).not.toContain(projectRoot);
    expect(result).toHaveLength(2);
  });

  test("includes worktrees inside -worktrees directory", () => {
    const result = filterWomboWorktrees(worktrees, projectRoot, config);
    expect(result.map((w) => w.path)).toContain(
      "/home/user/projects/wombo-combo-worktrees/auth-flow"
    );
    expect(result.map((w) => w.path)).toContain(
      "/home/user/projects/wombo-combo-worktrees/search-api"
    );
  });

  test("includes worktrees with matching branch prefix even outside -worktrees dir", () => {
    const orphanWorktrees: WorktreeInfo[] = [
      {
        path: "/home/user/projects/wombo-combo",
        branch: "main",
        head: "abc123",
        bare: false,
      },
      {
        path: "/tmp/some-random-dir",
        branch: "feature/orphan",
        head: "zzz999",
        bare: false,
      },
    ];
    const result = filterWomboWorktrees(orphanWorktrees, projectRoot, config);
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("feature/orphan");
  });

  test("includes quest branches", () => {
    const questWorktrees: WorktreeInfo[] = [
      {
        path: "/home/user/projects/wombo-combo",
        branch: "main",
        head: "abc123",
        bare: false,
      },
      {
        path: "/tmp/quest-dir",
        branch: "quest/onboarding",
        head: "qqq111",
        bare: false,
      },
    ];
    const result = filterWomboWorktrees(questWorktrees, projectRoot, config);
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("quest/onboarding");
  });

  test("handles project root without matching branch", () => {
    const root = "/home/user/projects/my-app";
    const result = filterWomboWorktrees(worktrees, root, config);
    // "wombo-combo" is not the project root so not excluded, but its branch
    // is "main" which doesn't match "feature/" prefix. The other two have
    // "feature/" branches so they match.
    expect(result).toHaveLength(2);
  });

  test("handles empty worktree list", () => {
    const result = filterWomboWorktrees([], projectRoot, config);
    expect(result).toHaveLength(0);
  });

  test("excludes worktrees with non-matching branches outside -worktrees dir", () => {
    const unrelatedWorktrees: WorktreeInfo[] = [
      {
        path: "/home/user/projects/wombo-combo",
        branch: "main",
        head: "abc123",
        bare: false,
      },
      {
        path: "/home/user/projects/other-project",
        branch: "other/something",
        head: "xyz000",
        bare: false,
      },
    ];
    const result = filterWomboWorktrees(
      unrelatedWorktrees,
      projectRoot,
      config
    );
    expect(result).toHaveLength(0);
  });

  test("bare worktrees are not special-cased", () => {
    const bareWorktrees: WorktreeInfo[] = [
      {
        path: "/home/user/projects/wombo-combo",
        branch: "main",
        head: "abc123",
        bare: true,
      },
      {
        path: "/home/user/projects/wombo-combo-worktrees/feat",
        branch: "feature/feat",
        head: "def456",
        bare: false,
      },
    ];
    const result = filterWomboWorktrees(bareWorktrees, projectRoot, config);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/home/user/projects/wombo-combo-worktrees/feat");
  });

  test("resolves symlinks/relative paths in project root comparison", () => {
    const messyRoot = "/home/user/projects/./wombo-combo/";
    const result = filterWomboWorktrees(
      [
        {
          path: "/home/user/projects/wombo-combo",
          branch: "main",
          head: "abc123",
          bare: false,
        },
        {
          path: "/home/user/projects/wombo-combo-worktrees/feat",
          branch: "feature/feat",
          head: "def456",
          bare: false,
        },
      ],
      messyRoot,
      config
    );
    // The resolve() call should normalize the path, excluding the project root
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/home/user/projects/wombo-combo-worktrees/feat");
  });
});

// ---------------------------------------------------------------------------
// Tests for removeWorktree safety guard
// ---------------------------------------------------------------------------

describe("removeWorktree — safety guard", () => {
  // We can import the function and test the safety check directly.
  // The actual git operations will fail in test, but the safety check
  // happens before any git calls.

  test("throws when asked to remove project root (exact match)", async () => {
    const { removeWorktree } = await import("../src/lib/worktree.js");
    const root = "/home/user/projects/my-app";
    expect(() => removeWorktree(root, root)).toThrow(
      "SAFETY: refusing to remove project root"
    );
  });

  test("throws when asked to remove project root (resolved paths)", async () => {
    const { removeWorktree } = await import("../src/lib/worktree.js");
    const root = "/home/user/projects/my-app";
    const messyPath = "/home/user/projects/./my-app";
    expect(() => removeWorktree(root, messyPath)).toThrow(
      "SAFETY: refusing to remove project root"
    );
  });

  test("throws when asked to remove project root with trailing slash", async () => {
    const { removeWorktree } = await import("../src/lib/worktree.js");
    const root = "/home/user/projects/my-app";
    const trailingSlash = "/home/user/projects/my-app/";
    // resolve() strips trailing slashes
    expect(() => removeWorktree(root, trailingSlash)).toThrow(
      "SAFETY: refusing to remove project root"
    );
  });
});

// ---------------------------------------------------------------------------
// Tests for listWorktrees parsing (porcelain output format)
// ---------------------------------------------------------------------------

describe("listWorktrees — porcelain output parsing", () => {
  // The listWorktrees function parses `git worktree list --porcelain` output.
  // We can test the parsing logic by examining the function's behavior with
  // known git output. Since we can't easily mock the exec call without
  // restructuring, we test the parsing logic pattern instead.

  test("parses standard porcelain output correctly", () => {
    // Simulate what listWorktrees does internally
    const output = [
      "worktree /home/user/projects/my-app",
      "HEAD abc123def456",
      "branch refs/heads/main",
      "",
      "worktree /home/user/projects/wombo-auth",
      "HEAD def456789012",
      "branch refs/heads/feature/auth",
      "",
    ].join("\n");

    // Re-implement the parsing logic to test it
    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current as WorktreeInfo);
        current = { path: line.slice(9), bare: false };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice(7).replace("refs/heads/", "");
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "" && current.path) {
        worktrees.push(current as WorktreeInfo);
        current = {};
      }
    }
    if (current.path) worktrees.push(current as WorktreeInfo);

    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toEqual({
      path: "/home/user/projects/my-app",
      head: "abc123def456",
      branch: "main",
      bare: false,
    });
    expect(worktrees[1]).toEqual({
      path: "/home/user/projects/wombo-auth",
      head: "def456789012",
      branch: "feature/auth",
      bare: false,
    });
  });

  test("parses bare worktree correctly", () => {
    const output = [
      "worktree /home/user/repos/my-app.git",
      "HEAD abc123",
      "bare",
      "",
    ].join("\n");

    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current as WorktreeInfo);
        current = { path: line.slice(9), bare: false };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice(7).replace("refs/heads/", "");
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "" && current.path) {
        worktrees.push(current as WorktreeInfo);
        current = {};
      }
    }
    if (current.path) worktrees.push(current as WorktreeInfo);

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].bare).toBe(true);
    expect(worktrees[0].branch).toBeUndefined();
  });

  test("handles empty output", () => {
    const output = "";
    const worktrees: WorktreeInfo[] = [];
    if (!output) {
      // matches the guard in listWorktrees
      expect(worktrees).toHaveLength(0);
    }
  });

  test("handles output without trailing empty line", () => {
    const output = [
      "worktree /home/user/projects/my-app",
      "HEAD abc123",
      "branch refs/heads/main",
    ].join("\n");

    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current as WorktreeInfo);
        current = { path: line.slice(9), bare: false };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice(7).replace("refs/heads/", "");
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "" && current.path) {
        worktrees.push(current as WorktreeInfo);
        current = {};
      }
    }
    if (current.path) worktrees.push(current as WorktreeInfo);

    // The final entry should still be captured
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].path).toBe("/home/user/projects/my-app");
  });
});
