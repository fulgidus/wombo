/**
 * prompt-compress.ts — Prompt compression utilities for context reduction.
 *
 * Reduces token count in agent prompts without losing semantic content:
 *   - Strip comments from injected source code
 *   - Collapse excessive whitespace
 *   - Abbreviate constraint format
 *   - Compact file manifests
 *
 * These utilities are applied to prompt sections before injection,
 * measurably reducing token usage for large prompts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for source code compression. */
export interface CompressSourceOptions {
  /** Remove single-line comments (// ...). Default: true */
  stripLineComments?: boolean;
  /** Remove block comments. Default: true */
  stripBlockComments?: boolean;
  /** Remove JSDoc/TSDoc comments. Default: false (they carry semantic info) */
  stripDocComments?: boolean;
  /** Collapse blank lines (3+ blank lines → 1). Default: true */
  collapseBlankLines?: boolean;
  /** Remove trailing whitespace from lines. Default: true */
  trimTrailingWhitespace?: boolean;
  /** Remove import statements (if you're only showing logic). Default: false */
  stripImports?: boolean;
}

/** Options for prompt text compression. */
export interface CompressPromptOptions {
  /** Abbreviate common constraint patterns. Default: true */
  abbreviateConstraints?: boolean;
  /** Collapse repeated whitespace within lines. Default: true */
  collapseInlineWhitespace?: boolean;
  /** Remove empty lines between sections. Default: false */
  removeEmptyLines?: boolean;
  /** Max line length before wrapping. Default: 0 (no limit) */
  maxLineLength?: number;
}

// ---------------------------------------------------------------------------
// Source Code Compression
// ---------------------------------------------------------------------------

/**
 * Compress source code for prompt injection by stripping comments and
 * collapsing whitespace. Preserves code structure and indentation.
 */
export function compressSource(
  source: string,
  options?: CompressSourceOptions
): string {
  const opts: Required<CompressSourceOptions> = {
    stripLineComments: options?.stripLineComments ?? true,
    stripBlockComments: options?.stripBlockComments ?? true,
    stripDocComments: options?.stripDocComments ?? false,
    collapseBlankLines: options?.collapseBlankLines ?? true,
    trimTrailingWhitespace: options?.trimTrailingWhitespace ?? true,
    stripImports: options?.stripImports ?? false,
  };

  let result = source;

  // Strip block comments (/* ... */ and /** ... */)
  if (opts.stripBlockComments) {
    if (opts.stripDocComments) {
      // Strip ALL block comments including JSDoc
      result = result.replace(/\/\*[\s\S]*?\*\//g, "");
    } else {
      // Strip only non-JSDoc block comments (/* but not /**)
      result = result.replace(/\/\*(?!\*)[\s\S]*?\*\//g, "");
    }
  }

  // Process line by line for line-level operations
  let lines = result.split("\n");

  if (opts.stripLineComments) {
    lines = lines.map((line) => stripLineComment(line));
  }

  if (opts.stripImports) {
    lines = lines.filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("import ") && !trimmed.startsWith("import{");
    });
  }

  if (opts.trimTrailingWhitespace) {
    lines = lines.map((line) => line.trimEnd());
  }

  if (opts.collapseBlankLines) {
    lines = collapseConsecutiveBlanks(lines, 1);
  }

  // Remove leading/trailing blank lines
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  return lines.join("\n");
}

/**
 * Strip a single-line comment from a line of code.
 * Handles string literals (won't strip // inside strings).
 */
function stripLineComment(line: string): string {
  let inString: string | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (inString) {
      if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === "/" && i + 1 < line.length && line[i + 1] === "/") {
      // Found a line comment — strip from here
      const result = line.substring(0, i).trimEnd();
      return result;
    }
  }

  return line;
}

/**
 * Collapse consecutive blank lines in an array of lines.
 * Keeps at most `maxConsecutive` blank lines in a row.
 */
function collapseConsecutiveBlanks(lines: string[], maxConsecutive: number): string[] {
  const result: string[] = [];
  let blankCount = 0;

  for (const line of lines) {
    if (line.trim() === "") {
      blankCount++;
      if (blankCount <= maxConsecutive) {
        result.push(line);
      }
    } else {
      blankCount = 0;
      result.push(line);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prompt Text Compression
// ---------------------------------------------------------------------------

/**
 * Compress a prompt text section by abbreviating common patterns and
 * collapsing whitespace.
 */
export function compressPromptText(
  text: string,
  options?: CompressPromptOptions
): string {
  const opts: Required<CompressPromptOptions> = {
    abbreviateConstraints: options?.abbreviateConstraints ?? true,
    collapseInlineWhitespace: options?.collapseInlineWhitespace ?? true,
    removeEmptyLines: options?.removeEmptyLines ?? false,
    maxLineLength: options?.maxLineLength ?? 0,
  };

  let lines = text.split("\n");

  if (opts.abbreviateConstraints) {
    lines = lines.map(abbreviateConstraintLine);
  }

  if (opts.collapseInlineWhitespace) {
    lines = lines.map((line) => {
      // Preserve leading indentation but collapse internal whitespace
      const match = line.match(/^(\s*)(.*)/);
      if (!match) return line;
      const [, indent, content] = match;
      return indent + content.replace(/\s{2,}/g, " ");
    });
  }

  if (opts.removeEmptyLines) {
    lines = lines.filter((line) => line.trim() !== "");
  }

  if (opts.maxLineLength > 0) {
    lines = lines.flatMap((line) => wrapLine(line, opts.maxLineLength));
  }

  return lines.join("\n");
}

/**
 * Abbreviate common constraint patterns to reduce token count.
 * E.g. "Do not modify any files outside of" → "Don't modify files outside"
 */
function abbreviateConstraintLine(line: string): string {
  const trimmed = line.trim();

  // Common verbose patterns → concise versions
  const abbreviations: Array<[RegExp, string]> = [
    [/\bDo not\b/gi, "Don't"],
    [/\bdo not\b/gi, "don't"],
    [/\bYou must\b/gi, "Must"],
    [/\byou must\b/gi, "must"],
    [/\bYou should\b/gi, "Should"],
    [/\byou should\b/gi, "should"],
    [/\bMake sure to\b/gi, "Ensure"],
    [/\bmake sure to\b/gi, "ensure"],
    [/\bMake sure that\b/gi, "Ensure"],
    [/\bmake sure that\b/gi, "ensure"],
    [/\bPlease ensure that\b/gi, "Ensure"],
    [/\bplease ensure that\b/gi, "ensure"],
    [/\bPlease make sure\b/gi, "Ensure"],
    [/\bIt is important that\b/gi, "Important:"],
    [/\bit is important that\b/gi, "Important:"],
    [/\bunder no circumstances\b/gi, "never"],
    [/\bUnder no circumstances\b/gi, "Never"],
    [/\bat all times\b/gi, "always"],
    [/\bAt all times\b/gi, "Always"],
    [/\bin order to\b/gi, "to"],
    [/\bIn order to\b/gi, "To"],
    [/\bas well as\b/gi, "and"],
    [/\bdue to the fact that\b/gi, "because"],
    [/\bDue to the fact that\b/gi, "Because"],
    [/\bin the event that\b/gi, "if"],
    [/\bIn the event that\b/gi, "If"],
    [/\bprior to\b/gi, "before"],
    [/\bPrior to\b/gi, "Before"],
    [/\bsubsequent to\b/gi, "after"],
    [/\bSubsequent to\b/gi, "After"],
    [/\bin the case of\b/gi, "for"],
    [/\bfor the purpose of\b/gi, "to"],
    [/\bwith regard to\b/gi, "about"],
    [/\bwith respect to\b/gi, "about"],
    [/\btake into account\b/gi, "consider"],
    [/\bTake into account\b/gi, "Consider"],
  ];

  if (!trimmed.startsWith("-") && !trimmed.startsWith("*") && !trimmed.startsWith("•")) {
    return line; // Only abbreviate list items (constraints/rules)
  }

  let result = line;
  for (const [pattern, replacement] of abbreviations) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Wrap a line at the specified max length, preserving indentation.
 */
function wrapLine(line: string, maxLength: number): string[] {
  if (line.length <= maxLength) return [line];

  const match = line.match(/^(\s*)/);
  const indent = match ? match[1] : "";
  const content = line.substring(indent.length);

  const words = content.split(/\s+/);
  const wrapped: string[] = [];
  let current = indent;

  for (const word of words) {
    if (current.length + word.length + 1 > maxLength && current.trim().length > 0) {
      wrapped.push(current);
      current = indent + "  " + word; // Continuation indent
    } else {
      current += (current.trim().length > 0 ? " " : "") + word;
    }
  }

  if (current.trim().length > 0) {
    wrapped.push(current);
  }

  return wrapped;
}

// ---------------------------------------------------------------------------
// Constraint List Compression
// ---------------------------------------------------------------------------

/**
 * Compress a list of constraint strings by removing redundancy and
 * abbreviating common patterns. Returns a deduplicated, abbreviated list.
 */
export function compressConstraints(constraints: string[]): string[] {
  if (constraints.length === 0) return [];

  // Deduplicate (case-insensitive)
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of constraints) {
    const key = c.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }

  // Abbreviate each constraint
  return unique.map((c) => {
    let result = c;
    // Apply the same abbreviations as prompt text
    result = abbreviateConstraintLine("- " + result).substring(2);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Measurement Utilities
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a string. Uses a simple heuristic:
 * ~4 characters per token for English text / code.
 * This is approximate — actual tokenizer counts may vary by ±15%.
 */
export function estimateTokens(text: string): number {
  // GPT/Claude tokenizers average ~4 chars per token for mixed code/text
  return Math.ceil(text.length / 4);
}

/**
 * Measure the compression ratio achieved.
 * Returns { original, compressed, saved, ratio }.
 */
export function measureCompression(
  original: string,
  compressed: string
): { originalTokens: number; compressedTokens: number; savedTokens: number; ratio: number } {
  const originalTokens = estimateTokens(original);
  const compressedTokens = estimateTokens(compressed);
  const savedTokens = originalTokens - compressedTokens;
  const ratio = originalTokens > 0 ? compressedTokens / originalTokens : 1;

  return { originalTokens, compressedTokens, savedTokens, ratio };
}
