/**
 * conflict-hunks.ts — Structured conflict hunk parsing, classification, and
 * programmatic resolution for the Tier 2.5 merge pipeline.
 *
 * This module sits between Tier 2 (trivial whitespace auto-resolve) and
 * Tier 3 (LLM resolver). It parses git conflict markers into structured
 * hunks, classifies each hunk by type, and resolves as many as possible
 * without an LLM call.
 *
 * Hunk classifications:
 *   - trivial:       Both sides identical after whitespace normalization → take ours
 *   - one-side-only: Only one side modified vs merge base → take the modified side
 *   - additive:      Both sides are purely additive (insertions only, no deletions) →
 *                    try ours-first concat, verify build; if fail → theirs-first; if both fail → unresolved
 *   - complex:       Both sides modify the same lines → unresolved, escalate to tier 3
 */

import { exec } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Classification of a single conflict hunk */
export type HunkClassification = "trivial" | "one-side-only" | "additive" | "complex";

/** Which side was modified in a one-side-only conflict */
export type ModifiedSide = "ours" | "theirs" | "both" | "neither";

/** A single parsed conflict hunk with classification metadata */
export interface ConflictHunk {
  /** Index of this hunk within the file (0-based) */
  index: number;
  /** The full match string from the conflict regex */
  rawMatch: string;
  /** "Ours" content (HEAD / feature side) */
  ours: string;
  /** "Theirs" content (base branch side) */
  theirs: string;
  /** Content from the merge base (common ancestor), null if unavailable */
  base: string | null;
  /** Classification of this hunk */
  classification: HunkClassification;
  /** Which side was modified (meaningful for one-side-only) */
  modifiedSide: ModifiedSide;
  /** The resolved content, if this hunk was resolved programmatically */
  resolution: string | null;
  /** Whether this hunk has been resolved */
  resolved: boolean;
  /** Start line (1-indexed) of this hunk in the conflicted file */
  startLine: number;
  /** End line (1-indexed) of this hunk in the conflicted file */
  endLine: number;
}

/** Result of classifying and resolving all hunks in a single file */
export interface FileHunkResult {
  /** Relative file path */
  filePath: string;
  /** All parsed hunks */
  hunks: ConflictHunk[];
  /** Whether ALL hunks were resolved programmatically */
  allResolved: boolean;
  /** Hunks that remain unresolved (need LLM) */
  unresolvedHunks: ConflictHunk[];
  /** Hunks that were resolved programmatically */
  resolvedHunks: ConflictHunk[];
  /** The fully resolved file content (if allResolved is true) */
  resolvedContent: string | null;
}

/** Result of the tier 2.5 pipeline across all conflicting files */
export interface Tier25Result {
  /** Whether ALL files were fully resolved */
  allResolved: boolean;
  /** Per-file results */
  fileResults: FileHunkResult[];
  /** Files that are fully resolved */
  resolvedFiles: string[];
  /** Files that still have unresolved hunks */
  unresolvedFiles: string[];
  /** Total number of hunks across all files */
  totalHunks: number;
  /** Number of hunks resolved programmatically */
  resolvedHunkCount: number;
  /** Number of hunks that need LLM */
  unresolvedHunkCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const errMsg = stderr?.trim() || stdout?.trim() || error.message;
        reject(new Error(errMsg));
      } else {
        resolve((stdout ?? "").trim());
      }
    });
  });
}

async function runSafe(cmd: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    return { ok: true, output: await run(cmd, cwd) };
  } catch (err: any) {
    return { ok: false, output: err.message || String(err) };
  }
}

/**
 * Normalize whitespace for comparison: collapse all runs of whitespace
 * into single spaces and trim.
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Conflict regex — same pattern as merger.ts
// ---------------------------------------------------------------------------

/**
 * Regex to match a single conflict block in a file.
 * Captures:
 *   group 1: "ours" content (HEAD / feature side)
 *   group 2: "theirs" content (base branch side)
 */
const CONFLICT_RE = /^<{7}\s+\S+\r?\n([\s\S]*?)^={7}\r?\n([\s\S]*?)^>{7}\s+\S+\r?\n?/gm;

// ---------------------------------------------------------------------------
// Merge base content retrieval
// ---------------------------------------------------------------------------

/**
 * Get the content of a file at the merge base between the current branch
 * and the branch being merged in.
 *
 * During an active merge, git stores the base version as stage 1 in the index.
 * We can retrieve it with `git show :1:<path>`.
 *
 * Stage meanings during merge:
 *   :1:<path> = common ancestor (merge base)
 *   :2:<path> = ours (HEAD / feature)
 *   :3:<path> = theirs (incoming / base branch)
 */
export async function getMergeBaseContent(
  worktreePath: string,
  filePath: string
): Promise<string | null> {
  const result = await runSafe(`git show ":1:${filePath}"`, worktreePath);
  return result.ok ? result.output : null;
}

/**
 * Get the "ours" version of a file from the git index during merge.
 */
export async function getOursContent(
  worktreePath: string,
  filePath: string
): Promise<string | null> {
  const result = await runSafe(`git show ":2:${filePath}"`, worktreePath);
  return result.ok ? result.output : null;
}

/**
 * Get the "theirs" version of a file from the git index during merge.
 */
export async function getTheirsContent(
  worktreePath: string,
  filePath: string
): Promise<string | null> {
  const result = await runSafe(`git show ":3:${filePath}"`, worktreePath);
  return result.ok ? result.output : null;
}

// ---------------------------------------------------------------------------
// Hunk parsing
// ---------------------------------------------------------------------------

/**
 * Parse all conflict hunks from a file's content.
 *
 * Returns structured ConflictHunk objects with line numbers, content,
 * and initial classification as "complex" (will be reclassified later).
 */
export function parseConflictHunks(content: string): Omit<ConflictHunk, "base" | "classification" | "modifiedSide" | "resolution" | "resolved">[] {
  const hunks: Omit<ConflictHunk, "base" | "classification" | "modifiedSide" | "resolution" | "resolved">[] = [];
  const lines = content.split("\n");

  // Reset regex state
  CONFLICT_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  let hunkIndex = 0;

  while ((match = CONFLICT_RE.exec(content)) !== null) {
    // Calculate start line from character offset
    const beforeMatch = content.substring(0, match.index);
    const startLine = beforeMatch.split("\n").length;
    const matchLines = match[0].split("\n").length;
    // Subtract 1 because the last "line" after split on a trailing newline is empty
    const endLine = startLine + matchLines - (match[0].endsWith("\n") ? 2 : 1);

    hunks.push({
      index: hunkIndex++,
      rawMatch: match[0],
      ours: match[1],
      theirs: match[2],
      startLine,
      endLine,
    });
  }

  // Reset regex state after use
  CONFLICT_RE.lastIndex = 0;

  return hunks;
}

// ---------------------------------------------------------------------------
// Hunk classification
// ---------------------------------------------------------------------------

/**
 * Extract the lines from the base content that correspond to a conflict hunk.
 *
 * This is approximate: we look at the ours/theirs content and try to find
 * the corresponding section in the base. For one-side-only detection,
 * we check if either side matches the base content.
 */
function classifyHunk(
  ours: string,
  theirs: string,
  base: string | null
): { classification: HunkClassification; modifiedSide: ModifiedSide } {
  const oursNorm = normalizeWhitespace(ours);
  const theirsNorm = normalizeWhitespace(theirs);

  // Trivial: both sides identical after whitespace normalization
  if (oursNorm === theirsNorm) {
    return { classification: "trivial", modifiedSide: "neither" };
  }

  // If we have base content, we can do one-side-only detection
  if (base !== null) {
    const baseNorm = normalizeWhitespace(base);

    const oursMatchesBase = oursNorm === baseNorm;
    const theirsMatchesBase = theirsNorm === baseNorm;

    if (oursMatchesBase && !theirsMatchesBase) {
      // Only theirs changed vs base → take theirs
      return { classification: "one-side-only", modifiedSide: "theirs" };
    }

    if (!oursMatchesBase && theirsMatchesBase) {
      // Only ours changed vs base → take ours
      return { classification: "one-side-only", modifiedSide: "ours" };
    }

    if (oursMatchesBase && theirsMatchesBase) {
      // Both match base — this is trivial
      return { classification: "trivial", modifiedSide: "neither" };
    }
  }

  // Check if both sides are purely additive (additions only, no deletions)
  // We detect this by checking if the base content is a subset of both sides
  if (base !== null) {
    const baseLines = base.split("\n").map((l) => l.trimEnd());
    const oursLines = ours.split("\n").map((l) => l.trimEnd());
    const theirsLines = theirs.split("\n").map((l) => l.trimEnd());

    const oursIsAdditive = isAdditiveChange(baseLines, oursLines);
    const theirsIsAdditive = isAdditiveChange(baseLines, theirsLines);

    if (oursIsAdditive && theirsIsAdditive) {
      return { classification: "additive", modifiedSide: "both" };
    }
  }

  // Complex: both sides modify overlapping content
  return { classification: "complex", modifiedSide: "both" };
}

/**
 * Check if `modified` is purely additive relative to `original`.
 *
 * "Purely additive" means all original lines appear in the same order
 * in the modified version, with zero or more new lines interspersed.
 * No original lines were deleted or reordered.
 */
function isAdditiveChange(original: string[], modified: string[]): boolean {
  let origIdx = 0;
  for (let modIdx = 0; modIdx < modified.length && origIdx < original.length; modIdx++) {
    if (modified[modIdx] === original[origIdx]) {
      origIdx++;
    }
  }
  // All original lines were found in order
  return origIdx === original.length;
}

// ---------------------------------------------------------------------------
// Per-hunk base content extraction
// ---------------------------------------------------------------------------

/**
 * For a given conflict hunk, extract the corresponding base content.
 *
 * We use git's stage-based index to get the full base file, then try to
 * find the section that corresponds to this conflict. Since conflicts are
 * generated by git's 3-way merge, we can use the ours/theirs content to
 * bound our search.
 *
 * For simplicity and reliability, when we have the full base file, we
 * compare each hunk's ours/theirs against the base file to classify them.
 * The per-hunk base extraction uses a diff-based approach.
 */
export function extractHunkBase(
  fullBase: string,
  ours: string,
  theirs: string
): string | null {
  // Strategy: Find the longest common subsequence between the base and
  // ours/theirs to identify what section of the base corresponds to this hunk.
  //
  // Simple approach: Look for lines in the base that are shared with either
  // side of the conflict, and extract the region between the first and last
  // matching lines.

  const baseLines = fullBase.split("\n");
  const oursLines = ours.split("\n");
  const theirsLines = theirs.split("\n");

  // Find anchor lines — lines just before and after the conflict in ours/theirs
  // that also appear in the base. This is heuristic but works well for most cases.

  // Collect all unique lines from both sides
  const conflictLines = new Set([
    ...oursLines.map((l) => l.trimEnd()),
    ...theirsLines.map((l) => l.trimEnd()),
  ]);

  // Find base lines that appear in either conflict side
  const matchingBaseIndices: number[] = [];
  for (let i = 0; i < baseLines.length; i++) {
    if (conflictLines.has(baseLines[i].trimEnd())) {
      matchingBaseIndices.push(i);
    }
  }

  if (matchingBaseIndices.length === 0) {
    // No overlap — base section might be entirely different or empty
    // Return empty string (the base had nothing here)
    return "";
  }

  const firstIdx = matchingBaseIndices[0];
  const lastIdx = matchingBaseIndices[matchingBaseIndices.length - 1];

  return baseLines.slice(firstIdx, lastIdx + 1).join("\n");
}

// ---------------------------------------------------------------------------
// Additive merge resolution
// ---------------------------------------------------------------------------

/**
 * Merge two additive changes by concatenating: ours additions first,
 * then theirs additions (relative to base).
 */
export function mergeAdditive(
  base: string,
  ours: string,
  theirs: string,
  oursFirst: boolean
): string {
  const baseLines = base.split("\n");
  const oursLines = ours.split("\n");
  const theirsLines = theirs.split("\n");

  // Extract only the added lines from each side
  const oursAdded = extractAddedLines(baseLines, oursLines);
  const theirsAdded = extractAddedLines(baseLines, theirsLines);

  // Build merged result: base + additions from both sides
  // Insert additions at the positions they were added
  if (oursFirst) {
    return mergeAddedLines(baseLines, oursAdded, theirsAdded);
  } else {
    return mergeAddedLines(baseLines, theirsAdded, oursAdded);
  }
}

/**
 * Extract lines that were added (not present in base).
 * Returns { afterIndex, lines }[] indicating where new lines were inserted.
 */
interface InsertionPoint {
  /** Index in the base array after which these lines were inserted (-1 = before start) */
  afterBaseIndex: number;
  /** The added lines */
  lines: string[];
}

function extractAddedLines(
  baseLines: string[],
  modifiedLines: string[]
): InsertionPoint[] {
  const insertions: InsertionPoint[] = [];
  let baseIdx = 0;
  let pendingLines: string[] = [];
  let lastBaseIdx = -1;

  for (const line of modifiedLines) {
    if (baseIdx < baseLines.length && line.trimEnd() === baseLines[baseIdx].trimEnd()) {
      // This line matches the next base line
      if (pendingLines.length > 0) {
        insertions.push({ afterBaseIndex: lastBaseIdx, lines: [...pendingLines] });
        pendingLines = [];
      }
      lastBaseIdx = baseIdx;
      baseIdx++;
    } else {
      // This is an added line
      pendingLines.push(line);
    }
  }

  // Remaining added lines go after the last matched base line
  if (pendingLines.length > 0) {
    insertions.push({ afterBaseIndex: lastBaseIdx, lines: [...pendingLines] });
  }

  return insertions;
}

/**
 * Merge two sets of insertions into the base lines.
 * `first` insertions are placed before `second` insertions at the same position.
 */
function mergeAddedLines(
  baseLines: string[],
  first: InsertionPoint[],
  second: InsertionPoint[]
): string {
  // Group insertions by position
  const byPosition = new Map<number, { first: string[]; second: string[] }>();

  for (const ins of first) {
    const existing = byPosition.get(ins.afterBaseIndex) ?? { first: [], second: [] };
    existing.first.push(...ins.lines);
    byPosition.set(ins.afterBaseIndex, existing);
  }

  for (const ins of second) {
    const existing = byPosition.get(ins.afterBaseIndex) ?? { first: [], second: [] };
    existing.second.push(...ins.lines);
    byPosition.set(ins.afterBaseIndex, existing);
  }

  // Build result
  const result: string[] = [];

  // Insert any lines that go before the first base line
  const beforeStart = byPosition.get(-1);
  if (beforeStart) {
    result.push(...beforeStart.first, ...beforeStart.second);
  }

  for (let i = 0; i < baseLines.length; i++) {
    result.push(baseLines[i]);

    const insertions = byPosition.get(i);
    if (insertions) {
      result.push(...insertions.first, ...insertions.second);
    }
  }

  return result.join("\n");
}

// ---------------------------------------------------------------------------
// Build check helper
// ---------------------------------------------------------------------------

/**
 * Run a quick build check to verify a resolution is valid.
 * Returns true if the build succeeds.
 */
export async function quickBuildCheck(
  worktreePath: string,
  buildCommand: string
): Promise<boolean> {
  const result = await runSafe(buildCommand, worktreePath);
  return result.ok;
}

// ---------------------------------------------------------------------------
// Full file hunk resolution
// ---------------------------------------------------------------------------

/**
 * Parse, classify, and resolve conflict hunks in a single file.
 *
 * For each hunk:
 *   1. Parse the conflict markers into structured data
 *   2. Retrieve base content from git index (stage 1)
 *   3. Classify the hunk
 *   4. Resolve if possible (trivial, one-side-only)
 *   5. Mark additive hunks for build-checked resolution
 *
 * Additive hunks require a build check, so they are resolved separately
 * by the caller (tryResolveAdditiveHunks).
 */
export async function classifyFileHunks(
  worktreePath: string,
  filePath: string
): Promise<FileHunkResult> {
  const fullPath = `${worktreePath}/${filePath}`;
  const content = readFileSync(fullPath, "utf-8");
  const rawHunks = parseConflictHunks(content);

  if (rawHunks.length === 0) {
    return {
      filePath,
      hunks: [],
      allResolved: true,
      unresolvedHunks: [],
      resolvedHunks: [],
      resolvedContent: content,
    };
  }

  // Get full base file content from git index
  const fullBase = await getMergeBaseContent(worktreePath, filePath);

  // Get full ours/theirs from index for per-hunk base extraction
  const fullOurs = await getOursContent(worktreePath, filePath);
  const fullTheirs = await getTheirsContent(worktreePath, filePath);

  // Classify each hunk
  const hunks: ConflictHunk[] = rawHunks.map((raw) => {
    // Extract the base content for this specific hunk
    let hunkBase: string | null = null;
    if (fullBase !== null) {
      hunkBase = extractHunkBase(fullBase, raw.ours, raw.theirs);
    }

    const { classification, modifiedSide } = classifyHunk(
      raw.ours,
      raw.theirs,
      hunkBase
    );

    // Resolve trivial and one-side-only hunks immediately
    let resolution: string | null = null;
    let resolved = false;

    if (classification === "trivial") {
      resolution = raw.ours; // Keep ours (feature side)
      resolved = true;
    } else if (classification === "one-side-only") {
      resolution = modifiedSide === "ours" ? raw.ours : raw.theirs;
      resolved = true;
    }

    return {
      ...raw,
      base: hunkBase,
      classification,
      modifiedSide,
      resolution,
      resolved,
    };
  });

  const resolvedHunks = hunks.filter((h) => h.resolved);
  const unresolvedHunks = hunks.filter((h) => !h.resolved);

  // Build resolved content if all hunks are resolved
  let resolvedContent: string | null = null;
  if (unresolvedHunks.length === 0) {
    resolvedContent = applyResolutions(content, hunks);
  }

  return {
    filePath,
    hunks,
    allResolved: unresolvedHunks.length === 0,
    unresolvedHunks,
    resolvedHunks,
    resolvedContent,
  };
}

/**
 * Apply all hunk resolutions to the original conflicted content.
 * Replaces each conflict block with its resolution text.
 */
export function applyResolutions(content: string, hunks: ConflictHunk[]): string {
  let result = content;
  // Apply in reverse order to preserve offsets
  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = hunks[i];
    if (hunk.resolved && hunk.resolution !== null) {
      result = result.replace(hunk.rawMatch, hunk.resolution);
    }
  }
  return result;
}

/**
 * Try to resolve additive hunks by concatenating both sides and checking
 * if the result builds.
 *
 * For each additive hunk:
 *   1. Try ours-first concatenation → write file → build check
 *   2. If build fails → try theirs-first → write file → build check
 *   3. If both fail → mark as unresolved (escalate to tier 3)
 *
 * This function mutates the FileHunkResult in place.
 */
export async function tryResolveAdditiveHunks(
  worktreePath: string,
  fileResult: FileHunkResult,
  buildCommand: string
): Promise<void> {
  const fullPath = `${worktreePath}/${fileResult.filePath}`;
  const originalContent = readFileSync(fullPath, "utf-8");
  const additiveHunks = fileResult.hunks.filter(
    (h) => h.classification === "additive" && !h.resolved
  );

  if (additiveHunks.length === 0) return;

  for (const hunk of additiveHunks) {
    if (!hunk.base) {
      // Can't do additive merge without base — skip to complex
      continue;
    }

    // Try ours-first
    const oursFirstMerge = mergeAdditive(hunk.base, hunk.ours, hunk.theirs, true);
    hunk.resolution = oursFirstMerge;
    hunk.resolved = true;

    // Apply all current resolutions and test
    const testContent = applyResolutions(originalContent, fileResult.hunks);
    writeFileSync(fullPath, testContent);

    const oursFirstOk = await quickBuildCheck(worktreePath, buildCommand);
    if (oursFirstOk) {
      // ours-first works!
      continue;
    }

    // Try theirs-first
    const theirsFirstMerge = mergeAdditive(hunk.base, hunk.ours, hunk.theirs, false);
    hunk.resolution = theirsFirstMerge;

    const testContent2 = applyResolutions(originalContent, fileResult.hunks);
    writeFileSync(fullPath, testContent2);

    const theirsFirstOk = await quickBuildCheck(worktreePath, buildCommand);
    if (theirsFirstOk) {
      // theirs-first works!
      continue;
    }

    // Neither worked — mark as unresolved
    hunk.resolution = null;
    hunk.resolved = false;
    hunk.classification = "complex"; // Reclassify since additive merge failed
  }

  // Restore original file content (caller will apply final resolutions)
  writeFileSync(fullPath, originalContent);

  // Update file result aggregates
  fileResult.resolvedHunks = fileResult.hunks.filter((h) => h.resolved);
  fileResult.unresolvedHunks = fileResult.hunks.filter((h) => !h.resolved);
  fileResult.allResolved = fileResult.unresolvedHunks.length === 0;
  fileResult.resolvedContent = fileResult.allResolved
    ? applyResolutions(originalContent, fileResult.hunks)
    : null;
}

// ---------------------------------------------------------------------------
// Tier 2.5 orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the Tier 2.5 pipeline: parse, classify, and programmatically resolve
 * conflict hunks across all conflicting files.
 *
 * This should be called AFTER tier 2 (trivial auto-resolve) has run and
 * some files still have conflicts. The worktree should be in a state where
 * `git merge` has been run and conflict markers exist in the working tree.
 *
 * @param worktreePath  Path to the worktree with active merge conflicts
 * @param conflictFiles List of files that have non-trivial conflicts
 * @param buildCommand  Build command for additive hunk verification
 * @returns Tier25Result with per-file breakdown
 */
export async function runTier25(
  worktreePath: string,
  conflictFiles: string[],
  buildCommand: string
): Promise<Tier25Result> {
  const fileResults: FileHunkResult[] = [];

  // Phase 1: Parse and classify all hunks across all files
  for (const filePath of conflictFiles) {
    try {
      const result = await classifyFileHunks(worktreePath, filePath);
      fileResults.push(result);
    } catch (err: any) {
      // If we can't parse a file, treat it as having one complex unresolved hunk
      fileResults.push({
        filePath,
        hunks: [],
        allResolved: false,
        unresolvedHunks: [],
        resolvedHunks: [],
        resolvedContent: null,
      });
    }
  }

  // Phase 2: Try to resolve additive hunks (requires build checks)
  const hasAdditiveHunks = fileResults.some(
    (fr) => fr.hunks.some((h) => h.classification === "additive" && !h.resolved)
  );

  if (hasAdditiveHunks && buildCommand) {
    for (const fileResult of fileResults) {
      await tryResolveAdditiveHunks(worktreePath, fileResult, buildCommand);
    }
  }

  // Phase 3: Apply resolutions to fully resolved files
  const resolvedFiles: string[] = [];
  const unresolvedFiles: string[] = [];

  for (const fileResult of fileResults) {
    if (fileResult.allResolved && fileResult.resolvedContent !== null) {
      // Write resolved content and stage the file
      const fullPath = `${worktreePath}/${fileResult.filePath}`;
      writeFileSync(fullPath, fileResult.resolvedContent);
      await runSafe(`git add "${fileResult.filePath}"`, worktreePath);
      resolvedFiles.push(fileResult.filePath);
    } else {
      unresolvedFiles.push(fileResult.filePath);
    }
  }

  // Aggregate stats
  const totalHunks = fileResults.reduce((sum, fr) => sum + fr.hunks.length, 0);
  const resolvedHunkCount = fileResults.reduce((sum, fr) => sum + fr.resolvedHunks.length, 0);
  const unresolvedHunkCount = fileResults.reduce((sum, fr) => sum + fr.unresolvedHunks.length, 0);

  return {
    allResolved: unresolvedFiles.length === 0,
    fileResults,
    resolvedFiles,
    unresolvedFiles,
    totalHunks,
    resolvedHunkCount,
    unresolvedHunkCount,
  };
}

// ---------------------------------------------------------------------------
// Structured output for Tier 3 LLM prompt
// ---------------------------------------------------------------------------

/**
 * Format unresolved hunks into a structured text representation for the
 * Tier 3 LLM resolver prompt. This gives the LLM much better context
 * than raw conflict markers.
 */
export function formatHunksForLLM(fileResults: FileHunkResult[]): string {
  const sections: string[] = [];

  for (const fr of fileResults) {
    if (fr.unresolvedHunks.length === 0) continue;

    sections.push(`\n## File: ${fr.filePath}`);
    sections.push(`Total hunks: ${fr.hunks.length}, Resolved: ${fr.resolvedHunks.length}, Unresolved: ${fr.unresolvedHunks.length}`);

    for (const hunk of fr.unresolvedHunks) {
      sections.push(`\n### Hunk ${hunk.index + 1} (lines ${hunk.startLine}-${hunk.endLine}) — ${hunk.classification}`);

      if (hunk.base !== null) {
        sections.push(`\n**Base (common ancestor):**`);
        sections.push("```");
        sections.push(hunk.base);
        sections.push("```");
      }

      sections.push(`\n**Ours (feature branch — the code you wrote):**`);
      sections.push("```");
      sections.push(hunk.ours);
      sections.push("```");

      sections.push(`\n**Theirs (upstream changes — merged from base):**`);
      sections.push("```");
      sections.push(hunk.theirs);
      sections.push("```");
    }
  }

  return sections.join("\n");
}
