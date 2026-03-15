/**
 * init-detect.ts — Auto-detection utilities for `woco init`.
 *
 * Detects project settings from the filesystem and git state:
 *   - Project name from folder name
 *   - Base branch from git HEAD or well-known branches
 *   - Build command from package.json scripts + lockfile detection
 *   - Install command from lockfile detection
 *
 * These functions are pure (no side effects) and safe to call without a
 * .wombo-combo config. They return sensible defaults when detection fails.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Project Name
// ---------------------------------------------------------------------------

/**
 * Detect the project name from the directory path.
 * Returns the last segment of the path, or "project" if empty.
 */
export function detectProjectName(projectRoot: string): string {
  if (!projectRoot) return "project";
  // Remove trailing slashes
  const cleaned = projectRoot.replace(/\/+$/, "");
  const name = basename(cleaned);
  return name || "project";
}

// ---------------------------------------------------------------------------
// Package Manager Detection
// ---------------------------------------------------------------------------

type PackageManager = "bun" | "npm" | "yarn" | "pnpm";

/**
 * Detect the package manager from lockfile presence.
 * Priority: bun.lock > yarn.lock > pnpm-lock.yaml > package-lock.json > default (bun)
 */
function detectPackageManager(projectRoot: string): PackageManager {
  if (existsSync(join(projectRoot, "bun.lock")) || existsSync(join(projectRoot, "bun.lockb"))) {
    return "bun";
  }
  if (existsSync(join(projectRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(projectRoot, "package-lock.json"))) {
    return "npm";
  }
  return "bun"; // default
}

// ---------------------------------------------------------------------------
// Base Branch
// ---------------------------------------------------------------------------

/**
 * Detect the base branch for the project.
 *
 * Strategy:
 *   1. Read git HEAD to find the current branch
 *   2. Check for well-known default branches (main, master, develop)
 *   3. Fall back to "develop" (the wombo-combo default)
 */
export function detectBaseBranch(projectRoot: string): string {
  try {
    // Try reading .git/HEAD to find the current branch
    const headPath = join(projectRoot, ".git", "HEAD");
    if (existsSync(headPath)) {
      const head = readFileSync(headPath, "utf-8").trim();
      const match = head.match(/^ref: refs\/heads\/(.+)$/);
      if (match) {
        const currentBranch = match[1];
        // If on a well-known default branch, use it
        if (["main", "master", "develop"].includes(currentBranch)) {
          return currentBranch;
        }
      }

      // Check for well-known branches in order
      for (const branch of ["main", "master", "develop"]) {
        if (existsSync(join(projectRoot, ".git", "refs", "heads", branch))) {
          return branch;
        }
      }

      // Try packed-refs
      const packedRefsPath = join(projectRoot, ".git", "packed-refs");
      if (existsSync(packedRefsPath)) {
        const packedRefs = readFileSync(packedRefsPath, "utf-8");
        for (const branch of ["main", "master", "develop"]) {
          if (packedRefs.includes(`refs/heads/${branch}`)) {
            return branch;
          }
        }
      }
    }
  } catch {
    // Not a git repo or can't read — fall through
  }

  return "develop"; // default
}

// ---------------------------------------------------------------------------
// Build Command
// ---------------------------------------------------------------------------

/**
 * Detect the build command from package.json scripts.
 *
 * If `package.json` has a `build` script, returns `<pm> run build` using
 * the detected package manager. Otherwise returns the default "bun run build".
 */
export function detectBuildCommand(projectRoot: string): string {
  const pkgPath = join(projectRoot, "package.json");

  try {
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.build) {
        const pm = detectPackageManager(projectRoot);
        return `${pm} run build`;
      }
    }
  } catch {
    // Can't read or parse — fall through
  }

  return "bun run build"; // default
}

// ---------------------------------------------------------------------------
// Install Command
// ---------------------------------------------------------------------------

/**
 * Detect the install command from lockfile presence.
 * Returns `<pm> install` using the detected package manager.
 */
export function detectInstallCommand(projectRoot: string): string {
  const pm = detectPackageManager(projectRoot);
  return `${pm} install`;
}
