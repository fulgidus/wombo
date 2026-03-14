/**
 * scout.ts — Lightweight codebase scout for context reduction.
 *
 * Builds a minimal codebase index (file paths + exported symbol signatures)
 * and queries it using keyword matching. Returns relevant file paths and
 * function signatures WITHOUT full source code — just enough for planners
 * and agents to understand what exists and where.
 *
 * Design goals:
 *   - Zero LLM cost — uses keyword overlap scoring, no AI calls
 *   - Fast — walks the file tree once, caches the index
 *   - Token-efficient — returns paths + signatures, not source
 *   - Language-aware — extracts exports from TS/JS files via regex
 *
 * Usage:
 *   const index = await buildScoutIndex("/path/to/project");
 *   const results = queryScoutIndex(index, "authentication middleware");
 *   // → [{ file: "src/auth/middleware.ts", symbols: [...], score: 0.85 }]
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, basename, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single exported symbol extracted from a source file. */
export interface ScoutSymbol {
  /** Symbol name (function, class, type, const, etc.) */
  name: string;
  /** Symbol kind */
  kind: "function" | "class" | "interface" | "type" | "const" | "enum" | "variable" | "method" | "unknown";
  /** The signature line (first line of the declaration) */
  signature: string;
  /** Line number in the source file (1-indexed) */
  line: number;
}

/** A file entry in the scout index. */
export interface ScoutFile {
  /** Relative path from project root */
  path: string;
  /** File extension (e.g. ".ts", ".js") */
  ext: string;
  /** File size in bytes */
  size: number;
  /** Extracted exported symbols */
  symbols: ScoutSymbol[];
  /** Lowercase keywords extracted from file path and symbol names */
  keywords: string[];
}

/** The full scout index for a project. */
export interface ScoutIndex {
  /** Project root path */
  projectRoot: string;
  /** All indexed files */
  files: ScoutFile[];
  /** Total number of symbols across all files */
  totalSymbols: number;
  /** Timestamp when index was built */
  builtAt: string;
}

/** A query result from the scout index. */
export interface ScoutResult {
  /** Relative file path */
  file: string;
  /** Matching symbols in this file */
  symbols: ScoutSymbol[];
  /** Relevance score (0-1) */
  score: number;
}

/** Options for building the scout index. */
export interface ScoutBuildOptions {
  /** Extra directories to ignore (in addition to defaults) */
  ignorePatterns?: string[];
  /** Max file size to index (bytes). Default: 512KB */
  maxFileSize?: number;
  /** Max depth for directory traversal. Default: 15 */
  maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default directories to ignore during indexing. */
const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".wombo-combo",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  "coverage",
  "__pycache__",
  ".tox",
  ".venv",
  "venv",
  "vendor",
  ".cache",
  ".turbo",
  ".vercel",
  ".netlify",
  "tmp",
  ".tmp",
]);

/** File extensions we can extract symbols from. */
const INDEXABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

/** File extensions to include in the file tree (but not symbol-extract). */
const TREE_EXTENSIONS = new Set([
  ...INDEXABLE_EXTENSIONS,
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".md",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".sql",
  ".sh",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
  ".astro",
]);

/** Default max file size for indexing (512KB). */
const DEFAULT_MAX_FILE_SIZE = 512 * 1024;

/** Default max depth for directory traversal. */
const DEFAULT_MAX_DEPTH = 15;

// ---------------------------------------------------------------------------
// Index Builder
// ---------------------------------------------------------------------------

/**
 * Build a lightweight codebase index by walking the project directory,
 * extracting file paths and exported symbol signatures.
 */
export async function buildScoutIndex(
  projectRoot: string,
  options?: ScoutBuildOptions
): Promise<ScoutIndex> {
  const maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const extraIgnore = new Set(options?.ignorePatterns ?? []);

  const files: ScoutFile[] = [];

  function shouldIgnoreDir(name: string): boolean {
    return DEFAULT_IGNORE_DIRS.has(name) || extraIgnore.has(name) || name.startsWith(".");
  }

  function walkDir(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // Permission denied or broken symlink
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue; // Broken symlink
      }

      if (stat.isDirectory()) {
        if (!shouldIgnoreDir(entry)) {
          walkDir(fullPath, depth + 1);
        }
        continue;
      }

      if (!stat.isFile()) continue;

      const ext = extname(entry).toLowerCase();
      if (!TREE_EXTENSIONS.has(ext)) continue;
      if (stat.size > maxFileSize) continue;

      const relPath = relative(projectRoot, fullPath);
      const symbols: ScoutSymbol[] = [];

      // Extract symbols from indexable files
      if (INDEXABLE_EXTENSIONS.has(ext)) {
        try {
          const content = readFileSync(fullPath, "utf-8");
          const extracted = extractSymbols(content);
          symbols.push(...extracted);
        } catch {
          // Can't read file — still include in tree
        }
      }

      // Build keyword set from path segments and symbol names
      const keywords = buildKeywords(relPath, symbols);

      files.push({
        path: relPath,
        ext,
        size: stat.size,
        symbols,
        keywords,
      });
    }
  }

  walkDir(projectRoot, 0);

  // Sort files by path for deterministic output
  files.sort((a, b) => a.path.localeCompare(b.path));

  const totalSymbols = files.reduce((sum, f) => sum + f.symbols.length, 0);

  return {
    projectRoot,
    files,
    totalSymbols,
    builtAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Symbol Extraction (regex-based, no AST parser dependency)
// ---------------------------------------------------------------------------

/**
 * Extract exported symbol signatures from TypeScript/JavaScript source code.
 * Uses regex patterns — not a full parser, but good enough for function names,
 * class names, type/interface names, and const exports.
 */
export function extractSymbols(source: string): ScoutSymbol[] {
  const symbols: ScoutSymbol[] = [];
  const lines = source.split("\n");

  // Patterns for exported declarations
  const patterns: Array<{
    regex: RegExp;
    kind: ScoutSymbol["kind"];
    nameGroup: number;
  }> = [
    // export function foo(...) or export async function foo(...)
    { regex: /^export\s+(?:async\s+)?function\s+(\w+)/, kind: "function", nameGroup: 1 },
    // export class Foo
    { regex: /^export\s+class\s+(\w+)/, kind: "class", nameGroup: 1 },
    // export interface Foo
    { regex: /^export\s+interface\s+(\w+)/, kind: "interface", nameGroup: 1 },
    // export type Foo =
    { regex: /^export\s+type\s+(\w+)/, kind: "type", nameGroup: 1 },
    // export const FOO = or export let foo =
    { regex: /^export\s+(?:const|let|var)\s+(\w+)/, kind: "const", nameGroup: 1 },
    // export enum Foo
    { regex: /^export\s+enum\s+(\w+)/, kind: "enum", nameGroup: 1 },
    // export default function foo
    { regex: /^export\s+default\s+(?:async\s+)?function\s+(\w+)/, kind: "function", nameGroup: 1 },
    // export default class Foo
    { regex: /^export\s+default\s+class\s+(\w+)/, kind: "class", nameGroup: 1 },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    for (const { regex, kind, nameGroup } of patterns) {
      const match = line.match(regex);
      if (match) {
        const name = match[nameGroup];
        // Build a signature: take the line up to the opening brace or end
        let signature = line;
        // For multi-line signatures, try to include up to the opening brace
        if (!line.includes("{") && !line.includes("=") && i + 1 < lines.length) {
          // Collect continuation lines (up to 3 more lines or until we see { or =)
          let fullSig = line;
          for (let j = 1; j <= 3 && i + j < lines.length; j++) {
            const nextLine = lines[i + j].trim();
            fullSig += " " + nextLine;
            if (nextLine.includes("{") || nextLine.includes("=") || nextLine.includes(";")) {
              break;
            }
          }
          // Trim at the opening brace
          const braceIdx = fullSig.indexOf("{");
          if (braceIdx > 0) {
            signature = fullSig.substring(0, braceIdx).trim();
          } else {
            signature = fullSig;
          }
        } else {
          const braceIdx = signature.indexOf("{");
          if (braceIdx > 0 && kind !== "const") {
            signature = signature.substring(0, braceIdx).trim();
          }
        }

        // Truncate overly long signatures
        if (signature.length > 200) {
          signature = signature.substring(0, 197) + "...";
        }

        symbols.push({
          name,
          kind,
          signature,
          line: i + 1,
        });
        break; // Only match one pattern per line
      }
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Keyword Extraction
// ---------------------------------------------------------------------------

/**
 * Extract lowercase keywords from a file path and its symbols.
 * Used for scoring relevance during queries.
 */
function buildKeywords(filePath: string, symbols: ScoutSymbol[]): string[] {
  const keywords = new Set<string>();

  // Split path into segments and add each
  const segments = filePath.replace(/\\/g, "/").split("/");
  for (const seg of segments) {
    // Split on common separators: -, _, .
    const parts = seg.replace(/\.[^.]+$/, "").split(/[-_./]/);
    for (const part of parts) {
      if (part.length >= 2) {
        keywords.add(part.toLowerCase());
      }
    }

    // Also split camelCase/PascalCase
    const camelParts = splitCamelCase(seg.replace(/\.[^.]+$/, ""));
    for (const part of camelParts) {
      if (part.length >= 2) {
        keywords.add(part.toLowerCase());
      }
    }
  }

  // Add symbol names and their camelCase parts
  for (const sym of symbols) {
    keywords.add(sym.name.toLowerCase());
    const parts = splitCamelCase(sym.name);
    for (const part of parts) {
      if (part.length >= 2) {
        keywords.add(part.toLowerCase());
      }
    }
  }

  return Array.from(keywords);
}

/**
 * Split a camelCase or PascalCase string into its component words.
 */
function splitCamelCase(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Query Engine
// ---------------------------------------------------------------------------

/**
 * Query the scout index with a natural language question or keyword set.
 * Returns files ranked by relevance score.
 *
 * Scoring is based on keyword overlap between the query and the file's
 * keywords (from path segments and symbol names). Higher scores mean more
 * keyword matches.
 */
export function queryScoutIndex(
  index: ScoutIndex,
  query: string,
  options?: {
    /** Max results to return. Default: 20 */
    maxResults?: number;
    /** Min score threshold (0-1). Default: 0.1 */
    minScore?: number;
    /** Only include files with these extensions */
    extensions?: string[];
    /** Only include files matching this path pattern (substring match) */
    pathPattern?: string;
  }
): ScoutResult[] {
  const maxResults = options?.maxResults ?? 20;
  const minScore = options?.minScore ?? 0.1;

  // Tokenize the query into keywords
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) return [];

  const results: ScoutResult[] = [];

  for (const file of index.files) {
    // Apply filters
    if (options?.extensions && !options.extensions.includes(file.ext)) continue;
    if (options?.pathPattern && !file.path.includes(options.pathPattern)) continue;

    // Score based on keyword overlap
    const score = scoreFile(file, queryTokens);
    if (score < minScore) continue;

    // Include symbols that match any query token
    const matchingSymbols = file.symbols.filter((sym) => {
      const symKeywords = [
        sym.name.toLowerCase(),
        ...splitCamelCase(sym.name).map((s) => s.toLowerCase()),
      ];
      return queryTokens.some((qt) =>
        symKeywords.some((sk) => sk.includes(qt) || qt.includes(sk))
      );
    });

    results.push({
      file: file.path,
      symbols: matchingSymbols,
      score,
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, maxResults);
}

/**
 * Tokenize a query string into lowercase keyword tokens.
 */
function tokenizeQuery(query: string): string[] {
  const tokens = new Set<string>();

  // Split on whitespace and common punctuation
  const words = query.toLowerCase().split(/[\s,;:!?()[\]{}'"]+/);
  for (const word of words) {
    // Skip very short words and common stop words
    if (word.length < 2) continue;
    if (STOP_WORDS.has(word)) continue;
    tokens.add(word);

    // Also split on hyphens and underscores
    const parts = word.split(/[-_]/);
    for (const part of parts) {
      if (part.length >= 2 && !STOP_WORDS.has(part)) {
        tokens.add(part);
      }
    }

    // Split camelCase if present
    const camelParts = splitCamelCase(word);
    for (const part of camelParts) {
      if (part.length >= 2 && !STOP_WORDS.has(part.toLowerCase())) {
        tokens.add(part.toLowerCase());
      }
    }
  }

  return Array.from(tokens);
}

/**
 * Score a file against query tokens using keyword overlap.
 * Returns a value between 0 and 1.
 */
function scoreFile(file: ScoutFile, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;

  let matches = 0;
  let exactMatches = 0;

  for (const qt of queryTokens) {
    // Check if any file keyword contains or matches the query token
    let found = false;
    let exact = false;

    for (const kw of file.keywords) {
      if (kw === qt) {
        found = true;
        exact = true;
        break;
      }
      if (kw.includes(qt) || qt.includes(kw)) {
        found = true;
      }
    }

    if (found) matches++;
    if (exact) exactMatches++;
  }

  // Base score: fraction of query tokens matched
  const coverage = matches / queryTokens.length;

  // Bonus for exact matches
  const exactBonus = exactMatches / queryTokens.length * 0.2;

  // Bonus for symbol density (files with more matching symbols are more relevant)
  const symbolCount = file.symbols.length;
  const symbolBonus = symbolCount > 0 ? Math.min(symbolCount / 20, 0.1) : 0;

  return Math.min(coverage + exactBonus + symbolBonus, 1.0);
}

// ---------------------------------------------------------------------------
// Formatting (for prompt injection)
// ---------------------------------------------------------------------------

/**
 * Format scout results into a compact string suitable for prompt injection.
 * Produces a minimal manifest: file paths with optional symbol signatures.
 *
 * Example output:
 *   src/auth/middleware.ts (3 symbols)
 *     - authenticateUser(req: Request, res: Response): Promise<void>
 *     - validateToken(token: string): TokenPayload
 *     - class AuthProvider
 *   src/auth/types.ts (2 symbols)
 *     - interface UserSession
 *     - type AuthToken = string
 */
export function formatScoutResults(
  results: ScoutResult[],
  options?: {
    /** Include symbol signatures. Default: true */
    includeSignatures?: boolean;
    /** Max symbols per file. Default: 10 */
    maxSymbolsPerFile?: number;
    /** Max total lines. Default: 100 */
    maxLines?: number;
  }
): string {
  const includeSignatures = options?.includeSignatures ?? true;
  const maxSymbolsPerFile = options?.maxSymbolsPerFile ?? 10;
  const maxLines = options?.maxLines ?? 100;

  const lines: string[] = [];

  for (const result of results) {
    if (lines.length >= maxLines) break;

    const symbolNote = result.symbols.length > 0
      ? ` (${result.symbols.length} symbol${result.symbols.length === 1 ? "" : "s"})`
      : "";
    lines.push(`${result.file}${symbolNote}`);

    if (includeSignatures && result.symbols.length > 0) {
      const symsToShow = result.symbols.slice(0, maxSymbolsPerFile);
      for (const sym of symsToShow) {
        if (lines.length >= maxLines) break;
        lines.push(`  - ${sym.signature}`);
      }
      if (result.symbols.length > maxSymbolsPerFile) {
        lines.push(`  ... and ${result.symbols.length - maxSymbolsPerFile} more`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Format the full scout index as a compact file tree suitable for prompt
 * injection. Groups files by directory and shows symbol counts.
 *
 * More compact than formatScoutResults — just the tree, no signatures.
 */
export function formatScoutTree(
  index: ScoutIndex,
  options?: {
    /** Max depth for the tree. Default: 4 */
    maxDepth?: number;
    /** Include symbol counts. Default: true */
    showSymbolCounts?: boolean;
    /** Max total lines. Default: 200 */
    maxLines?: number;
  }
): string {
  const maxDepth = options?.maxDepth ?? 4;
  const showSymbolCounts = options?.showSymbolCounts ?? true;
  const maxOutputLines = options?.maxLines ?? 200;

  // Build a tree structure from file paths
  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    files: Array<{ name: string; symbolCount: number }>;
  }

  const root: TreeNode = { name: "", children: new Map(), files: [] };

  for (const file of index.files) {
    const parts = file.path.split("/");
    let node = root;

    for (let i = 0; i < parts.length - 1 && i < maxDepth; i++) {
      const part = parts[i];
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, children: new Map(), files: [] });
      }
      node = node.children.get(part)!;
    }

    // If the file is deeper than maxDepth, we've already stopped at that level
    const fileName = parts.length > maxDepth
      ? parts.slice(maxDepth).join("/")
      : parts[parts.length - 1];

    node.files.push({ name: fileName, symbolCount: file.symbols.length });
  }

  // Render the tree
  const lines: string[] = [];

  function renderNode(node: TreeNode, indent: string, depth: number): void {
    // Sort children alphabetically
    const sortedChildren = Array.from(node.children.entries()).sort(
      ([a], [b]) => a.localeCompare(b)
    );

    for (const [, child] of sortedChildren) {
      if (lines.length >= maxOutputLines) return;

      const totalFiles = countFiles(child);
      lines.push(`${indent}${child.name}/ (${totalFiles} files)`);

      if (depth < maxDepth) {
        renderNode(child, indent + "  ", depth + 1);

        // Render files in this directory
        for (const file of child.files.sort((a, b) => a.name.localeCompare(b.name))) {
          if (lines.length >= maxOutputLines) return;
          const symNote = showSymbolCounts && file.symbolCount > 0
            ? ` [${file.symbolCount}]`
            : "";
          lines.push(`${indent}  ${file.name}${symNote}`);
        }
      }
    }

    // Render files at root level
    if (node === root) {
      for (const file of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
        if (lines.length >= maxOutputLines) return;
        const symNote = showSymbolCounts && file.symbolCount > 0
          ? ` [${file.symbolCount}]`
          : "";
        lines.push(`${indent}${file.name}${symNote}`);
      }
    }
  }

  function countFiles(node: TreeNode): number {
    let count = node.files.length;
    for (const [, child] of node.children) {
      count += countFiles(child);
    }
    return count;
  }

  renderNode(root, "", 0);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Stop words for English (minimal set — keeps domain terms)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "it", "in", "on", "of", "to", "for",
  "and", "or", "but", "not", "with", "this", "that", "from",
  "be", "are", "was", "were", "has", "have", "had", "do", "does",
  "did", "will", "would", "could", "should", "can", "may", "might",
  "i", "we", "you", "he", "she", "they", "me", "us", "my", "our",
  "your", "his", "her", "its", "their", "who", "what", "which",
  "when", "where", "how", "all", "each", "every", "both", "few",
  "more", "most", "some", "any", "no", "if", "then", "else",
  "so", "as", "at", "by", "up", "about", "into", "over",
]);
