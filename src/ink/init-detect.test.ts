/**
 * init-detect.test.ts — Tests for init auto-detection utility functions.
 *
 * Verifies:
 *   - detectProjectName returns folder name from path
 *   - detectBaseBranch detects git default branch
 *   - detectBuildCommand reads from package.json scripts
 *   - detectInstallCommand detects package manager
 *   - Edge cases: invalid JSON, pnpm, bun.lockb, packed-refs, feature branches
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectProjectName,
  detectBaseBranch,
  detectBuildCommand,
  detectInstallCommand,
} from "./init-detect";

describe("detectProjectName", () => {
  test("returns last segment of path", () => {
    expect(detectProjectName("/home/user/my-project")).toBe("my-project");
  });

  test("returns 'project' for empty path", () => {
    expect(detectProjectName("")).toBe("project");
  });

  test("returns 'project' for root path", () => {
    expect(detectProjectName("/")).toBe("project");
  });

  test("handles paths with trailing slash", () => {
    expect(detectProjectName("/home/user/my-app/")).toBe("my-app");
  });

  test("handles paths with multiple trailing slashes", () => {
    expect(detectProjectName("/home/user/my-app///")).toBe("my-app");
  });

  test("handles single segment path", () => {
    expect(detectProjectName("my-project")).toBe("my-project");
  });
});

describe("detectBaseBranch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "woco-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns 'main' when git HEAD points to main", () => {
    // Create a fake git repo pointing to main
    mkdirSync(join(tmpDir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(tmpDir, ".git", "refs", "heads", "main"), "abc123\n");

    expect(detectBaseBranch(tmpDir)).toBe("main");
  });

  test("returns 'develop' as default when no git repo", () => {
    expect(detectBaseBranch(tmpDir)).toBe("develop");
  });

  test("detects 'master' branch", () => {
    mkdirSync(join(tmpDir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/master\n");
    writeFileSync(join(tmpDir, ".git", "refs", "heads", "master"), "abc123\n");

    expect(detectBaseBranch(tmpDir)).toBe("master");
  });

  test("detects 'develop' branch when HEAD is on develop", () => {
    mkdirSync(join(tmpDir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/develop\n");
    writeFileSync(join(tmpDir, ".git", "refs", "heads", "develop"), "abc123\n");

    expect(detectBaseBranch(tmpDir)).toBe("develop");
  });

  test("falls back to well-known branch when on a feature branch", () => {
    mkdirSync(join(tmpDir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/feature/foo\n");
    writeFileSync(join(tmpDir, ".git", "refs", "heads", "main"), "abc123\n");

    expect(detectBaseBranch(tmpDir)).toBe("main");
  });

  test("detects branch from packed-refs", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/feature/bar\n");
    writeFileSync(
      join(tmpDir, ".git", "packed-refs"),
      "# pack-refs with: peeled fully-peeled\nabc123 refs/heads/main\n"
    );

    expect(detectBaseBranch(tmpDir)).toBe("main");
  });
});

describe("detectBuildCommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "woco-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads build script from package.json", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc && vite build" } })
    );
    expect(detectBuildCommand(tmpDir)).toBe("bun run build");
  });

  test("returns default when no package.json", () => {
    expect(detectBuildCommand(tmpDir)).toBe("bun run build");
  });

  test("returns default when no build script in package.json", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { start: "node index.js" } })
    );
    expect(detectBuildCommand(tmpDir)).toBe("bun run build");
  });

  test("detects npm from package-lock.json", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } })
    );
    writeFileSync(join(tmpDir, "package-lock.json"), "{}");
    expect(detectBuildCommand(tmpDir)).toBe("npm run build");
  });

  test("detects yarn from yarn.lock", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } })
    );
    writeFileSync(join(tmpDir, "yarn.lock"), "");
    expect(detectBuildCommand(tmpDir)).toBe("yarn run build");
  });

  test("detects pnpm from pnpm-lock.yaml", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } })
    );
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectBuildCommand(tmpDir)).toBe("pnpm run build");
  });

  test("handles invalid JSON in package.json gracefully", () => {
    writeFileSync(join(tmpDir, "package.json"), "not json");
    expect(detectBuildCommand(tmpDir)).toBe("bun run build");
  });

  test("handles package.json without scripts key", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    expect(detectBuildCommand(tmpDir)).toBe("bun run build");
  });
});

describe("detectInstallCommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "woco-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns 'bun install' when bun.lock exists", () => {
    writeFileSync(join(tmpDir, "bun.lock"), "");
    expect(detectInstallCommand(tmpDir)).toBe("bun install");
  });

  test("returns 'npm install' when package-lock.json exists", () => {
    writeFileSync(join(tmpDir, "package-lock.json"), "{}");
    expect(detectInstallCommand(tmpDir)).toBe("npm install");
  });

  test("returns 'yarn install' when yarn.lock exists", () => {
    writeFileSync(join(tmpDir, "yarn.lock"), "");
    expect(detectInstallCommand(tmpDir)).toBe("yarn install");
  });

  test("returns 'bun install' as default", () => {
    expect(detectInstallCommand(tmpDir)).toBe("bun install");
  });

  test("returns 'pnpm install' when pnpm-lock.yaml exists", () => {
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectInstallCommand(tmpDir)).toBe("pnpm install");
  });

  test("returns 'bun install' when bun.lockb exists", () => {
    writeFileSync(join(tmpDir, "bun.lockb"), "");
    expect(detectInstallCommand(tmpDir)).toBe("bun install");
  });
});
