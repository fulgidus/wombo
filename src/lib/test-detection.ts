/**
 * test-detection.ts — Detect test files and coverage for new/modified code.
 *
 * Responsibilities:
 *   - Parse `git diff --name-status` to find added/modified .ts files in src/
 *   - For each source file, check if corresponding test files exist
 *   - Use configurable test file patterns (default: tests/**\/*.test.ts, src/**\/*.test.ts)
 *   - Exclude non-testable files: *.d.ts, index.ts (re-export barrels), types-only files
 *   - Report: source files missing tests, source files with tests, coverage ratio
 *   - Output as structured data compatible with outputMessage() for --output json
 *
 * Exported for use by tdd-verification-step and other consumers.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename, dirname, relative, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of a file in git diff --name-status */
export type DiffStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X";

/** A source file detected from git diff */
export interface DiffFile {
  /** Git diff status: A=added, M=modified, D=deleted, etc. */
  status: DiffStatus;
  /** File path relative to repo root */
  path: string;
}

/** Result of test detection for a single source file */
export interface SourceFileTestInfo {
  /** Source file path relative to repo root */
  sourcePath: string;
  /** Whether a corresponding test file was found */
  hasTest: boolean;
  /** Path(s) of matching test file(s), empty if none found */
  testFiles: string[];
  /** Whether the file was excluded from test requirements */
  excluded: boolean;
  /** Reason for exclusion, if applicable */
  excludeReason?: string;
}

/** Overall test detection report */
export interface TestDetectionReport {
  /** All source files analyzed (excludes deleted files) */
  sourceFiles: SourceFileTestInfo[];
  /** Source files that have corresponding tests */
  withTests: string[];
  /** Source files missing tests (excluding excluded files) */
  missingTests: string[];
  /** Source files excluded from test requirements */
  excludedFiles: string[];
  /** Number of testable source files (total - excluded) */
  testableCount: number;
  /** Number of testable source files that have tests */
  coveredCount: number;
  /** Coverage ratio (0-1), NaN if no testable files */
  coverageRatio: number;
  /** Human-readable coverage percentage string */
  coveragePercent: string;
  /** Git ref used for comparison */
  comparedTo: string;
}

/** Configuration for test detection */
export interface TestDetectionConfig {
  /** Glob patterns for test file locations (relative to repo root) */
  testFilePatterns: string[];
  /** Source directory prefixes to scan (e.g., ["src/"]) */
  sourceDirs: string[];
  /** File extensions to consider as source files */
  sourceExtensions: string[];
  /** Additional filename patterns to exclude (beyond built-in exclusions) */
  excludePatterns: string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_TEST_DETECTION_CONFIG: TestDetectionConfig = {
  testFilePatterns: [
    "tests/**/*.test.ts",
    "src/**/*.test.ts",
    "test/**/*.test.ts",
    "tests/**/*.spec.ts",
    "src/**/*.spec.ts",
    "test/**/*.spec.ts",
  ],
  sourceDirs: ["src/"],
  sourceExtensions: [".ts", ".tsx"],
  excludePatterns: [],
};

// ---------------------------------------------------------------------------
// Git Diff Parsing
// ---------------------------------------------------------------------------

/**
 * Parse `git diff --name-status` output to find added/modified files.
 *
 * Supports comparison against:
 *   - A specific ref (e.g., "HEAD~1", "main", "origin/main")
 *   - Default: HEAD~1
 *
 * Only returns Added (A) and Modified (M) files. Deleted files are excluded
 * since they no longer need tests.
 */
export function getChangedFiles(
  projectRoot: string,
  compareRef: string = "HEAD~1"
): DiffFile[] {
  let diffOutput: string;
  try {
    diffOutput = execSync(
      `git diff --name-status "${compareRef}"`,
      {
        cwd: projectRoot,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }
    ).trim();
  } catch (err: any) {
    // If the ref doesn't exist (e.g., first commit), try --name-status against empty tree
    try {
      diffOutput = execSync(
        `git diff --name-status $(git hash-object -t tree /dev/null)`,
        {
          cwd: projectRoot,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        }
      ).trim();
    } catch {
      // If all else fails, list tracked files as "Added"
      try {
        diffOutput = execSync(
          `git ls-files`,
          {
            cwd: projectRoot,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
            stdio: ["pipe", "pipe", "pipe"],
          }
        )
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((f) => `A\t${f}`)
          .join("\n");
      } catch {
        return [];
      }
    }
  }

  if (!diffOutput) return [];

  const files: DiffFile[] = [];
  for (const line of diffOutput.split("\n")) {
    if (!line.trim()) continue;

    // Format: STATUS\tFILENAME  or  STATUS\tOLDNAME\tNEWNAME (for renames)
    const parts = line.split("\t");
    if (parts.length < 2) continue;

    // Status may have a number suffix for renames/copies (e.g., R100)
    const statusChar = parts[0].charAt(0) as DiffStatus;
    // For renames/copies, use the new filename (last part)
    const filePath = parts[parts.length - 1];

    // Only include Added and Modified files
    if (statusChar === "A" || statusChar === "M") {
      files.push({ status: statusChar, path: filePath });
    }
  }

  return files;
}

/**
 * Filter diff files to only include source files matching the config.
 * Excludes test files themselves from the source file list.
 */
export function filterSourceFiles(
  files: DiffFile[],
  config: TestDetectionConfig = DEFAULT_TEST_DETECTION_CONFIG
): DiffFile[] {
  return files.filter((file) => {
    // Must be in one of the configured source directories
    const inSourceDir = config.sourceDirs.some((dir) =>
      file.path.startsWith(dir)
    );
    if (!inSourceDir) return false;

    // Must have a matching source extension
    const hasSourceExt = config.sourceExtensions.some((ext) =>
      file.path.endsWith(ext)
    );
    if (!hasSourceExt) return false;

    // Exclude test files from source file list
    if (isTestFile(file.path)) return false;

    return true;
  });
}

// ---------------------------------------------------------------------------
// Test File Detection
// ---------------------------------------------------------------------------

/**
 * Check if a file path looks like a test file.
 */
export function isTestFile(filePath: string): boolean {
  const name = basename(filePath);
  return (
    name.endsWith(".test.ts") ||
    name.endsWith(".test.tsx") ||
    name.endsWith(".spec.ts") ||
    name.endsWith(".spec.tsx") ||
    name.endsWith(".test.js") ||
    name.endsWith(".spec.js")
  );
}

/**
 * Check if a file should be excluded from test requirements.
 *
 * Excluded files:
 *   - *.d.ts (type declaration files)
 *   - index.ts that are re-export barrels (only exports, no logic)
 *   - Files that contain only type/interface/enum exports (types-only)
 *   - Files matching additional exclude patterns from config
 */
export function isExcludedFile(
  filePath: string,
  projectRoot: string,
  config: TestDetectionConfig = DEFAULT_TEST_DETECTION_CONFIG
): { excluded: boolean; reason?: string } {
  const name = basename(filePath);

  // Type declaration files
  if (name.endsWith(".d.ts")) {
    return { excluded: true, reason: "Type declaration file (*.d.ts)" };
  }

  // Check additional exclude patterns
  for (const pattern of config.excludePatterns) {
    if (filePath.includes(pattern) || name === pattern) {
      return { excluded: true, reason: `Matches exclude pattern: ${pattern}` };
    }
  }

  // For index.ts files, check if they're re-export barrels
  if (name === "index.ts" || name === "index.tsx") {
    const absPath = resolve(projectRoot, filePath);
    if (existsSync(absPath)) {
      if (isBarrelFile(absPath)) {
        return { excluded: true, reason: "Re-export barrel (index.ts)" };
      }
    }
  }

  // Check if file is types-only
  const absPath = resolve(projectRoot, filePath);
  if (existsSync(absPath)) {
    if (isTypesOnlyFile(absPath)) {
      return { excluded: true, reason: "Types-only file (no runtime logic)" };
    }
  }

  return { excluded: false };
}

/**
 * Check if a file is a re-export barrel (only contains export statements).
 *
 * A barrel file consists entirely of:
 *   - export { ... } from "..."
 *   - export * from "..."
 *   - export type { ... } from "..."
 *   - Comments
 *   - Empty lines
 */
export function isBarrelFile(absPath: string): boolean {
  try {
    const content = readFileSync(absPath, "utf-8");
    const lines = content.split("\n");

    let hasExport = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue; // empty line
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue; // comment
      if (trimmed.startsWith("export ") && trimmed.includes(" from ")) {
        hasExport = true;
        continue; // re-export
      }
      // Any other non-empty, non-comment line means it's not a barrel
      return false;
    }

    return hasExport; // Must have at least one export to be a barrel
  } catch {
    return false;
  }
}

/**
 * Check if a file contains only type definitions (interfaces, types, enums)
 * with no runtime code.
 *
 * Heuristic: A types-only file has no lines that produce runtime code.
 * Lines that are types-only:
 *   - export type / export interface / export enum
 *   - type / interface / enum declarations
 *   - import statements (import type or regular — removed at compile time if only types used)
 *   - Comments, empty lines
 *   - Opening/closing braces for type bodies
 */
export function isTypesOnlyFile(absPath: string): boolean {
  try {
    const content = readFileSync(absPath, "utf-8");
    const lines = content.split("\n");

    let hasTypeDecl = false;
    let inBlockComment = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Track block comments
      if (inBlockComment) {
        if (trimmed.includes("*/")) {
          inBlockComment = false;
        }
        continue;
      }
      if (trimmed.startsWith("/*")) {
        inBlockComment = true;
        if (trimmed.includes("*/")) {
          inBlockComment = false;
        }
        continue;
      }

      if (!trimmed) continue; // empty line
      if (trimmed.startsWith("//")) continue; // line comment

      // Import statements (removed at compile time for type-only usage)
      if (trimmed.startsWith("import ")) continue;

      // Type-only declarations
      if (
        trimmed.startsWith("export type ") ||
        trimmed.startsWith("export interface ") ||
        trimmed.startsWith("export enum ") ||
        trimmed.startsWith("type ") ||
        trimmed.startsWith("interface ") ||
        trimmed.startsWith("enum ") ||
        trimmed.startsWith("export declare ") ||
        trimmed.startsWith("declare ")
      ) {
        hasTypeDecl = true;
        continue;
      }

      // Allow lines that are part of type/interface/enum bodies
      // (property declarations, closing braces, semicolons, pipes for union types)
      if (
        trimmed === "}" ||
        trimmed === "};" ||
        trimmed === "{" ||
        trimmed.startsWith("|") ||
        trimmed.startsWith("&") ||
        // Property-like lines in interfaces/types (e.g., "  name: string;")
        /^[a-zA-Z_$][\w$?]*\s*[?]?\s*:\s*.+[;,]?\s*$/.test(trimmed) ||
        /^\[[\w\s:]+\]\s*:\s*.+[;,]?\s*$/.test(trimmed) || // index signatures
        // Readonly modifier
        trimmed.startsWith("readonly ")
      ) {
        continue;
      }

      // Any other line is runtime code
      return false;
    }

    return hasTypeDecl; // Must have at least one type declaration
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test File Matching
// ---------------------------------------------------------------------------

/**
 * Find existing test files that correspond to a given source file.
 *
 * Strategy: For a source file like `src/lib/foo.ts`, look for:
 *   1. tests/foo.test.ts (flat test dir)
 *   2. tests/lib/foo.test.ts (mirrored structure)
 *   3. src/lib/foo.test.ts (co-located)
 *   4. tests/foo.spec.ts (spec variant)
 *   5. tests/lib/foo.spec.ts (mirrored spec)
 *   6. src/lib/foo.spec.ts (co-located spec)
 *   7. test/foo.test.ts, test/lib/foo.test.ts (singular test dir)
 *
 * Also scans existing test directories for any test file that matches
 * the basename pattern.
 */
export function findTestFiles(
  sourcePath: string,
  projectRoot: string,
  _config: TestDetectionConfig = DEFAULT_TEST_DETECTION_CONFIG
): string[] {
  const name = basename(sourcePath);
  const ext = name.endsWith(".tsx") ? ".tsx" : ".ts";
  const nameWithoutExt = name.replace(/\.(tsx?|jsx?)$/, "");
  const sourceDir = dirname(sourcePath);

  // Build candidate test file paths
  const candidates: string[] = [];

  // Remove the first source directory prefix for mirrored paths
  // e.g., "src/lib/foo.ts" → "lib/foo.ts"
  const relativeFromSrc = sourceDir.startsWith("src/")
    ? sourceDir.slice(4)
    : sourceDir.startsWith("src")
      ? sourceDir.slice(3)
      : sourceDir;

  const testSuffixes = [".test", ".spec"];
  const testDirs = ["tests", "test", "__tests__"];

  for (const suffix of testSuffixes) {
    // Flat test directory: tests/foo.test.ts
    for (const testDir of testDirs) {
      candidates.push(`${testDir}/${nameWithoutExt}${suffix}${ext}`);
    }

    // Mirrored structure: tests/lib/foo.test.ts
    if (relativeFromSrc) {
      for (const testDir of testDirs) {
        candidates.push(
          `${testDir}/${relativeFromSrc}/${nameWithoutExt}${suffix}${ext}`
        );
      }
    }

    // Co-located: src/lib/foo.test.ts
    candidates.push(`${sourceDir}/${nameWithoutExt}${suffix}${ext}`);
  }

  // Deduplicate and check existence
  const found: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // Normalize path (remove double slashes, etc.)
    const normalized = candidate.replace(/\/+/g, "/");
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const absPath = resolve(projectRoot, normalized);
    if (existsSync(absPath)) {
      found.push(normalized);
    }
  }

  // Additionally, scan test directories for any matching test file
  // This catches cases where tests are organized differently
  for (const testDir of testDirs) {
    const absDirPath = resolve(projectRoot, testDir);
    if (!existsSync(absDirPath)) continue;
    try {
      scanForMatchingTests(absDirPath, testDir, nameWithoutExt, found, seen);
    } catch {
      // Best effort — directory may not be readable
    }
  }

  return found;
}

/**
 * Recursively scan a directory for test files matching a source file name.
 */
function scanForMatchingTests(
  dirPath: string,
  relativeDirPath: string,
  nameWithoutExt: string,
  found: string[],
  seen: Set<string>
): void {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(dirPath, entry);
    const relPath = `${relativeDirPath}/${entry}`;

    // Check if this is a matching test file
    if (
      entry === `${nameWithoutExt}.test.ts` ||
      entry === `${nameWithoutExt}.test.tsx` ||
      entry === `${nameWithoutExt}.spec.ts` ||
      entry === `${nameWithoutExt}.spec.tsx`
    ) {
      const normalized = relPath.replace(/\/+/g, "/");
      if (!seen.has(normalized)) {
        seen.add(normalized);
        found.push(normalized);
      }
    }

    // Recurse into subdirectories (limit depth to 5 to prevent runaway)
    try {
      const entryStat = statSync(entryPath);
      if (entryStat.isDirectory() && relativeDirPath.split("/").length < 6) {
        scanForMatchingTests(entryPath, relPath, nameWithoutExt, found, seen);
      }
    } catch {
      // Skip unreadable entries
    }
  }
}

// ---------------------------------------------------------------------------
// Main Detection Logic
// ---------------------------------------------------------------------------

/**
 * Run test detection analysis on a project.
 *
 * @param projectRoot - Absolute path to the project root
 * @param compareRef - Git ref to compare against (default: "HEAD~1")
 * @param config - Test detection configuration (uses defaults if omitted)
 * @returns Structured test detection report
 */
export function detectTests(
  projectRoot: string,
  compareRef: string = "HEAD~1",
  config: TestDetectionConfig = DEFAULT_TEST_DETECTION_CONFIG
): TestDetectionReport {
  // Step 1: Get changed files from git diff
  const changedFiles = getChangedFiles(projectRoot, compareRef);

  // Step 2: Filter to source files only
  const sourceFiles = filterSourceFiles(changedFiles, config);

  // Step 3: Analyze each source file
  const results: SourceFileTestInfo[] = [];
  const withTests: string[] = [];
  const missingTests: string[] = [];
  const excludedFiles: string[] = [];

  for (const file of sourceFiles) {
    // Check exclusions
    const exclusion = isExcludedFile(file.path, projectRoot, config);

    if (exclusion.excluded) {
      results.push({
        sourcePath: file.path,
        hasTest: false,
        testFiles: [],
        excluded: true,
        excludeReason: exclusion.reason,
      });
      excludedFiles.push(file.path);
      continue;
    }

    // Find test files
    const testFiles = findTestFiles(file.path, projectRoot, config);
    const hasTest = testFiles.length > 0;

    results.push({
      sourcePath: file.path,
      hasTest,
      testFiles,
      excluded: false,
    });

    if (hasTest) {
      withTests.push(file.path);
    } else {
      missingTests.push(file.path);
    }
  }

  // Step 4: Calculate coverage
  const testableCount = results.filter((r) => !r.excluded).length;
  const coveredCount = withTests.length;
  const coverageRatio =
    testableCount > 0 ? coveredCount / testableCount : NaN;
  const coveragePercent = isNaN(coverageRatio)
    ? "N/A"
    : `${(coverageRatio * 100).toFixed(1)}%`;

  return {
    sourceFiles: results,
    withTests,
    missingTests,
    excludedFiles,
    testableCount,
    coveredCount,
    coverageRatio,
    coveragePercent,
    comparedTo: compareRef,
  };
}

// ---------------------------------------------------------------------------
// Text Rendering
// ---------------------------------------------------------------------------

/**
 * Render a test detection report as human-readable text to stdout.
 * Used by the output() helper in text mode.
 */
export function renderTestDetectionReport(report: TestDetectionReport): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Test Detection Report (compared to ${report.comparedTo})`);
  console.log(`${"─".repeat(60)}`);

  if (report.sourceFiles.length === 0) {
    console.log("  No source files changed.\n");
    return;
  }

  // Files with tests
  if (report.withTests.length > 0) {
    console.log(`\n  \x1b[32m✓ Files with tests (${report.withTests.length}):\x1b[0m`);
    for (const info of report.sourceFiles.filter((f) => f.hasTest)) {
      const tests = info.testFiles.join(", ");
      console.log(`    ${info.sourcePath} → ${tests}`);
    }
  }

  // Files missing tests
  if (report.missingTests.length > 0) {
    console.log(`\n  \x1b[31m✗ Files missing tests (${report.missingTests.length}):\x1b[0m`);
    for (const path of report.missingTests) {
      console.log(`    ${path}`);
    }
  }

  // Excluded files
  if (report.excludedFiles.length > 0) {
    console.log(`\n  \x1b[33m⊘ Excluded files (${report.excludedFiles.length}):\x1b[0m`);
    for (const info of report.sourceFiles.filter((f) => f.excluded)) {
      console.log(`    ${info.sourcePath} — ${info.excludeReason}`);
    }
  }

  // Summary
  console.log(`\n${"─".repeat(60)}`);
  console.log(
    `  Coverage: ${report.coveredCount}/${report.testableCount} testable files ` +
    `(${report.coveragePercent})`
  );
  console.log(`${"─".repeat(60)}\n`);
}
