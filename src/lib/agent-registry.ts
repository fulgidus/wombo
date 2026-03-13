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

import { resolve, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
// Cache Operations
// ---------------------------------------------------------------------------

/**
 * Resolve the cache file path for an agent type.
 * e.g. "engineering/engineering-frontend-developer"
 *   → ".wombo-combo/agents-cache/engineering/engineering-frontend-developer.md"
 */
function cachePath(projectRoot: string, config: WomboConfig, agentType: string): string {
  return resolve(projectRoot, WOMBO_DIR, config.agentRegistry.cacheDir, `${agentType}.md`);
}

/**
 * Read a cached agent definition. Returns null if not cached.
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
 * Fetch an agent definition from the registry.
 * Returns the raw markdown content or throws on failure.
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

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the agent definition for a single task.
 *
 * If the task has no agent_type or registry mode is disabled, returns a
 * generalist fallback. Otherwise fetches from cache or registry.
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

  // Check cache first
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

  // Fetch from registry
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
