/**
 * agent-registry.ts — Fetch, cache, and resolve specialized agent definitions
 * from an external registry (e.g. github.com/msitarzewski/agency-agents).
 *
 * Flow:
 *   1. Task has `agent_type: "engineering/engineering-frontend-developer"`
 *   2. resolveAgentForTask() checks cache, fetches if missing, returns raw md
 *   3. At launch time, raw md is patched via patchImportedAgent() and written
 *      into the worktree's .opencode/agents/ directory
 *
 * Cache layout:
 *   .wombo-combo/agents-cache/engineering/engineering-frontend-developer.md
 *
 * Raw downloads are cached. Patching is done at launch time (not cached)
 * because patches depend on runtime config (portless, placeholders, etc.).
 */

import { resolve, dirname, relative } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { WOMBO_DIR, type WomboConfig, type AgentRegistryMode } from "../config.js";
import type { Task } from "./tasks.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of resolving an agent for a task */
export interface ResolvedAgent {
  /** Task ID this agent is resolved for */
  taskId: string;
  /**
   * Agent name (last path segment of agent_type).
   * e.g. "engineering-frontend-developer" from "engineering/engineering-frontend-developer"
   */
  name: string;
  /** Raw markdown content from the registry (before patching) */
  rawContent: string;
  /** Whether this was loaded from cache (true) or freshly fetched (false) */
  fromCache: boolean;
  /** The agent_type string from the task */
  agentType: string;
}

/** Generalist fallback — no specialized agent, use default */
export interface GeneralistFallback {
  taskId: string;
  name: null;
  rawContent: null;
  fromCache: false;
  agentType: null;
}

export type AgentResolution = ResolvedAgent | GeneralistFallback;

/** Summary info for a registry agent (used by listRegistryAgents / getCachedAgents) */
export interface RegistryAgentInfo {
  /** Agent type path, e.g. "engineering/engineering-frontend-developer" */
  agentType: string;
  /** Short name derived from the path, e.g. "engineering-frontend-developer" */
  name: string;
  /** Category (first path segment), e.g. "engineering" */
  category: string;
  /** Human-readable description extracted from frontmatter, or null if unavailable */
  description: string | null;
}

/** Entry returned by the GitHub Contents API */
interface GitHubContentEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size?: number;
  download_url?: string | null;
}

// ---------------------------------------------------------------------------
// Agent Name Derivation
// ---------------------------------------------------------------------------

/**
 * Derive the agent name from an agent_type string.
 * "engineering/engineering-frontend-developer" → "engineering-frontend-developer"
 */
export function agentNameFromType(agentType: string): string {
  const segments = agentType.split("/");
  return segments[segments.length - 1];
}

// ---------------------------------------------------------------------------
// Frontmatter Parsing
// ---------------------------------------------------------------------------

/**
 * Extract description from YAML frontmatter in a markdown string.
 * Expects `---` delimiters at the top of the file.
 * Returns null if no frontmatter or no description field found.
 */
function extractDescription(markdownContent: string): string | null {
  const trimmed = markdownContent.trimStart();
  if (!trimmed.startsWith("---")) return null;

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) return null;

  const frontmatter = trimmed.slice(3, endIndex);
  // Simple regex extraction — avoids pulling in a YAML parser for a single field
  const match = frontmatter.match(/^description:\s*(.+)$/m);
  if (!match) return null;

  // Strip surrounding quotes if present
  let desc = match[1].trim();
  if ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'"))) {
    desc = desc.slice(1, -1);
  }
  return desc || null;
}

// ---------------------------------------------------------------------------
// Cache Operations
// ---------------------------------------------------------------------------

/**
 * Resolve the cache directory root for agents.
 */
function cacheDir(projectRoot: string, config: WomboConfig): string {
  return resolve(projectRoot, WOMBO_DIR, config.agentRegistry.cacheDir);
}

/**
 * Resolve the cache file path for an agent type.
 * e.g. "engineering/engineering-frontend-developer"
 *   → ".wombo-combo/agents-cache/engineering/engineering-frontend-developer.md"
 */
function cachePath(projectRoot: string, config: WomboConfig, agentType: string): string {
  return resolve(cacheDir(projectRoot, config), `${agentType}.md`);
}

/**
 * Check whether a cached agent file is still valid (within TTL).
 * Returns true if the file exists and its mtime is within cacheTTL ms of now.
 */
function isCacheValid(
  projectRoot: string,
  config: WomboConfig,
  agentType: string
): boolean {
  const path = cachePath(projectRoot, config, agentType);
  if (!existsSync(path)) return false;
  try {
    const stat = statSync(path);
    const age = Date.now() - stat.mtimeMs;
    return age < config.agentRegistry.cacheTTL;
  } catch {
    return false;
  }
}

/**
 * Read a cached agent definition. Returns null if not cached.
 * Does NOT check TTL — callers should use isCacheValid() for freshness checks.
 */
export function getCachedAgent(
  projectRoot: string,
  config: WomboConfig,
  agentType: string
): string | null {
  const path = cachePath(projectRoot, config, agentType);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write an agent definition to the cache.
 */
export function cacheAgent(
  projectRoot: string,
  config: WomboConfig,
  agentType: string,
  content: string
): void {
  const path = cachePath(projectRoot, config, agentType);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/**
 * List all locally cached agents from .wombo-combo/agents-cache/.
 * Recursively scans the cache directory for .md files and extracts
 * metadata from their frontmatter.
 */
export function getCachedAgents(
  projectRoot: string,
  config: WomboConfig
): RegistryAgentInfo[] {
  const root = cacheDir(projectRoot, config);
  if (!existsSync(root)) return [];

  const results: RegistryAgentInfo[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = resolve(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile() && entry.endsWith(".md")) {
        // Derive agentType from relative path minus .md extension
        const rel = relative(root, fullPath);
        const agentType = rel.replace(/\.md$/, "").replace(/\\/g, "/");
        const name = agentNameFromType(agentType);
        const segments = agentType.split("/");
        const category = segments.length > 1 ? segments[0] : "";

        let description: string | null = null;
        try {
          const content = readFileSync(fullPath, "utf-8");
          description = extractDescription(content);
        } catch {
          // ignore read errors — description stays null
        }

        results.push({ agentType, name, category, description });
      }
    }
  }

  walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// Fetch from Registry
// ---------------------------------------------------------------------------

/**
 * Build the raw GitHub URL for an agent definition.
 * Source: "msitarzewski/agency-agents"
 * Agent type: "engineering/engineering-frontend-developer"
 * → "https://raw.githubusercontent.com/msitarzewski/agency-agents/main/engineering/engineering-frontend-developer.md"
 */
function rawUrl(source: string, agentType: string): string {
  return `https://raw.githubusercontent.com/${source}/main/${agentType}.md`;
}

/**
 * Build the GitHub API URL for listing directory contents.
 * Source: "msitarzewski/agency-agents"
 * Path: "engineering" (or "" for root)
 * → "https://api.github.com/repos/msitarzewski/agency-agents/contents/engineering"
 */
function contentsApiUrl(source: string, path?: string): string {
  const base = `https://api.github.com/repos/${source}/contents`;
  return path ? `${base}/${path}` : base;
}

/**
 * Fetch an agent definition from the registry by agent type.
 * Returns the raw markdown content or throws on failure.
 *
 * @param agentType — e.g. "engineering/engineering-frontend-developer"
 * @param source    — GitHub repo in "owner/repo" format
 */
export async function fetchAgent(
  agentType: string,
  source: string
): Promise<string> {
  const url = rawUrl(source, agentType);
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Agent "${agentType}" not found in registry "${source}". ` +
        `Looked at: ${url}`
      );
    }
    throw new Error(
      `Failed to fetch agent "${agentType}" from registry: ` +
      `HTTP ${response.status} ${response.statusText}`
    );
  }

  return await response.text();
}

/**
 * Fetch the list of available agents from the registry.
 *
 * Uses the GitHub Contents API to recursively walk the repo and find all .md
 * agent definitions. For each found agent, fetches the raw content to extract
 * the description from the YAML frontmatter.
 *
 * Categories excluded from listing: files in the repo root, and directories
 * that are not agent categories (e.g. "scripts", "examples", ".github").
 *
 * @param source — GitHub repo in "owner/repo" format (e.g. "msitarzewski/agency-agents")
 * @returns Array of agent info objects with name, category, and description
 */
export async function listRegistryAgents(
  source: string
): Promise<RegistryAgentInfo[]> {
  // Directories that are NOT agent categories — skip them
  const EXCLUDED_DIRS = new Set([
    ".github",
    "scripts",
    "examples",
  ]);

  // Step 1: Fetch root listing to discover categories
  const rootUrl = contentsApiUrl(source);
  const rootResponse = await fetch(rootUrl, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });

  if (!rootResponse.ok) {
    throw new Error(
      `Failed to list registry "${source}": HTTP ${rootResponse.status} ${rootResponse.statusText}`
    );
  }

  const rootEntries = (await rootResponse.json()) as GitHubContentEntry[];
  const categoryDirs = rootEntries.filter(
    (e) => e.type === "dir" && !e.name.startsWith(".") && !EXCLUDED_DIRS.has(e.name)
  );

  // Step 2: Fetch each category directory in parallel
  const categoryResults = await Promise.allSettled(
    categoryDirs.map(async (catEntry) => {
      const catUrl = contentsApiUrl(source, catEntry.path);
      const catResponse = await fetch(catUrl, {
        headers: { Accept: "application/vnd.github.v3+json" },
      });

      if (!catResponse.ok) {
        throw new Error(
          `Failed to list category "${catEntry.path}": HTTP ${catResponse.status}`
        );
      }

      const files = (await catResponse.json()) as GitHubContentEntry[];
      return { category: catEntry.name, files };
    })
  );

  // Step 3: For each .md file, extract agent info.
  // We fetch the raw content in parallel (batched per category) to get descriptions.
  const agents: RegistryAgentInfo[] = [];

  for (const result of categoryResults) {
    if (result.status !== "fulfilled") continue;
    const { category, files } = result.value;

    const mdFiles = files.filter(
      (f) => f.type === "file" && f.name.endsWith(".md")
    );

    // Fetch raw contents in parallel to extract descriptions
    const fileResults = await Promise.allSettled(
      mdFiles.map(async (mdFile) => {
        const agentType = mdFile.path.replace(/\.md$/, "");
        const name = agentNameFromType(agentType);

        let description: string | null = null;
        if (mdFile.download_url) {
          try {
            const raw = await fetch(mdFile.download_url);
            if (raw.ok) {
              const content = await raw.text();
              description = extractDescription(content);
            }
          } catch {
            // Couldn't fetch content — description stays null
          }
        }

        return { agentType, name, category, description } as RegistryAgentInfo;
      })
    );

    for (const fileResult of fileResults) {
      if (fileResult.status === "fulfilled") {
        agents.push(fileResult.value);
      }
    }
  }

  return agents;
}

// ---------------------------------------------------------------------------
// Resolution (with TTL + offline fallback)
// ---------------------------------------------------------------------------

/**
 * Resolve the agent definition for a single task.
 *
 * If the task has no agent_type or registry mode is disabled, returns a
 * generalist fallback. Otherwise checks cache (with TTL) then fetches
 * from the registry. If the fetch fails, falls back to stale cache
 * silently with a warning (offline support).
 */
export async function resolveAgentForTask(
  task: Task,
  config: WomboConfig,
  projectRoot: string
): Promise<AgentResolution> {
  // No agent_type specified or registry disabled → generalist
  if (!task.agent_type || config.agentRegistry.mode === "disabled") {
    return {
      taskId: task.id,
      name: null,
      rawContent: null,
      fromCache: false,
      agentType: null,
    };
  }

  const agentType = task.agent_type;
  const name = agentNameFromType(agentType);

  // Check cache first — only use if within TTL
  if (isCacheValid(projectRoot, config, agentType)) {
    const cached = getCachedAgent(projectRoot, config, agentType);
    if (cached !== null) {
      return {
        taskId: task.id,
        name,
        rawContent: cached,
        fromCache: true,
        agentType,
      };
    }
  }

  // Attempt to fetch from registry
  try {
    const rawContent = await fetchAgent(agentType, config.agentRegistry.source);

    // Cache the raw download
    cacheAgent(projectRoot, config, agentType, rawContent);

    return {
      taskId: task.id,
      name,
      rawContent,
      fromCache: false,
      agentType,
    };
  } catch (fetchError: any) {
    // Offline fallback: try stale cache (ignore TTL)
    const staleCache = getCachedAgent(projectRoot, config, agentType);
    if (staleCache !== null) {
      console.warn(
        `\x1b[33m[WARNING]\x1b[0m Failed to fetch agent "${agentType}" from registry: ${fetchError?.message ?? fetchError}`
      );
      console.warn(
        `  Using stale cached version (offline fallback).\n`
      );
      return {
        taskId: task.id,
        name,
        rawContent: staleCache,
        fromCache: true,
        agentType,
      };
    }

    // No cache available — re-throw the original error
    throw fetchError;
  }
}

/**
 * Resolve agent definitions for all tasks in a launch wave.
 *
 * Returns a Map from task ID to agent resolution. Fetches are parallelized.
 * Individual fetch failures are caught and logged — the task falls back to
 * the generalist agent rather than blocking the entire wave.
 */
export async function prepareAgentDefinitions(
  tasks: Task[],
  config: WomboConfig,
  projectRoot: string
): Promise<Map<string, AgentResolution>> {
  const results = new Map<string, AgentResolution>();

  // Resolve all tasks in parallel
  const resolutions = await Promise.allSettled(
    tasks.map(async (task) => {
      const resolution = await resolveAgentForTask(task, config, projectRoot);
      return { taskId: task.id, resolution };
    })
  );

  for (const result of resolutions) {
    if (result.status === "fulfilled") {
      results.set(result.value.taskId, result.value.resolution);
    } else {
      // Extract task ID from the error context — find the task that failed
      // by checking which tasks don't have results yet
      const resolvedIds = new Set(results.keys());
      const failedTask = tasks.find((t) => !resolvedIds.has(t.id));
      if (failedTask) {
        console.warn(
          `\x1b[33m[WARNING]\x1b[0m Failed to resolve agent for task "${failedTask.id}": ${result.reason?.message ?? result.reason}`
        );
        console.warn(`  Falling back to generalist agent.\n`);
        results.set(failedTask.id, {
          taskId: failedTask.id,
          name: null,
          rawContent: null,
          fromCache: false,
          agentType: null,
        });
      }
    }
  }

  return results;
}

/**
 * Write a patched agent definition into a worktree's agent/ directory.
 *
 * @param worktreePath — absolute path to the worktree root
 * @param agentName    — derived name (e.g. "engineering-frontend-developer")
 * @param patchedContent — fully patched markdown content
 */
export function writeAgentToWorktree(
  worktreePath: string,
  agentName: string,
  patchedContent: string
): void {
  const agentDir = resolve(worktreePath, ".opencode", "agents");
  mkdirSync(agentDir, { recursive: true });
  const agentPath = resolve(agentDir, `${agentName}.md`);
  writeFileSync(agentPath, patchedContent, "utf-8");
}

/**
 * Check if a resolution is a specialized agent (not generalist fallback).
 */
export function isSpecializedAgent(resolution: AgentResolution): resolution is ResolvedAgent {
  return resolution.name !== null && resolution.rawContent !== null;
}
