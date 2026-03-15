/**
 * init-detect.test.ts — Tests for init auto-detection utility functions.
 *
 * Verifies:
 *   - detectProjectName returns folder name from path
 *   - detectBaseBranch detects git default branch
 *   - detectBuildCommand reads from package.json scripts
 *   - detectInstallCommand detects package manager
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
});
