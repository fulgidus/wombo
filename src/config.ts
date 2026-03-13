/**
 * config.ts — Load .wombo-combo/config.json, merge with defaults, validate, expose typed config.
 *
 * The config file lives at .wombo-combo/config.json inside the target project root.
 * All values have sensible defaults so minimal config works out of the box.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { MultiplexerPreference } from "./lib/multiplexer.js";

// ---------------------------------------------------------------------------
// .wombo-combo directory constant
// ---------------------------------------------------------------------------

/** Name of the directory that holds all wombo-combo files */
export const WOMBO_DIR = ".wombo-combo";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Agent registry download mode */
export type AgentRegistryMode = "auto" | "monitored" | "disabled";

export interface WomboConfig {
  /** Directory name for task files relative to .wombo-combo/ (folder-based storage) */
  tasksDir: string;
  /** Directory name for archived task files relative to .wombo-combo/ */
  archiveDir: string;
  /** @deprecated Use tasksDir. Legacy single-file path relative to .wombo-combo/ */
  tasksFile?: string;
  /** @deprecated Use archiveDir. Legacy single-file path relative to .wombo-combo/ */
  archiveFile?: string;
  /** Base branch to create feature branches from */
  baseBranch: string;
  /** Build configuration */
  build: {
    /** Build command to run in worktrees */
    command: string;
    /** Build timeout in milliseconds */
    timeout: number;
    /** Build artifact directory (for quick "did it build?" checks) */
    artifactDir: string;
  };
  /** Install configuration */
  install: {
    /** Install command to run in worktrees */
    command: string;
    /** Install timeout in milliseconds */
    timeout: number;
  };
  /** Git configuration */
  git: {
    /** Branch name prefix for feature branches */
    branchPrefix: string;
    /** Worktree directory name prefix */
    worktreePrefix: string;
    /** Git remote name */
    remote: string;
    /** Merge strategy flag */
    mergeStrategy: string;
  };
  /** Agent configuration */
  agent: {
    /** Path to agent binary (null = auto-detect) */
    bin: string | null;
    /** Agent name to pass via --agent flag */
    name: string;
    /** Config files/dirs to copy into worktrees */
    configFiles: string[];
    /** Session name prefix for terminal multiplexer */
    tmuxPrefix: string;
    /** Terminal multiplexer preference: "auto" (prefer dmux), "dmux", or "tmux" */
    multiplexer: MultiplexerPreference;
  };
  /** Portless integration for localhost server testing */
  portless: {
    /** Whether portless is enabled for agent worktrees */
    enabled: boolean;
    /** Path to portless binary (null = auto-detect via PATH) */
    bin: string | null;
    /** Proxy port (portless default is 1355) */
    proxyPort: number;
    /** Whether to use HTTPS mode */
    https: boolean;
  };
  /** Backup configuration for tasks file */
  backup: {
    /** Maximum number of timestamped backups to keep */
    maxBackups: number;
  };
  /** Default runtime values */
  defaults: {
    /** Max concurrent agents */
    maxConcurrent: number;
    /** Max retries per agent */
    maxRetries: number;
  };
  /** Browser testing configuration */
  browser: BrowserConfig;
  /** Agent registry configuration for specialized agent downloads */
  agentRegistry: AgentRegistryConfig;
  /** Test-Driven Development configuration */
  tdd: TddConfig;
}

/** Configuration for browser-based verification and testing */
export interface BrowserConfig {
  /** Enable browser testing in the verify pipeline */
  enabled: boolean;
  /** Path to browser binary (null = auto-detect) */
  bin: string | null;
  /** Run browser in headless mode (required for CI) */
  headless: boolean;
  /** Custom test command to run browser tests (overrides script discovery) */
  testCommand: string | null;
  /** Timeout for launching a browser instance (ms) */
  launchTimeout: number;
  /** Timeout for each browser test script (ms) */
  testTimeout: number;
  /** Default viewport size */
  defaultViewport: {
    width: number;
    height: number;
  };
}

/** Configuration for the external agent registry (e.g. agency-agents) */
export interface AgentRegistryConfig {
  /**
   * Download mode:
   * - "auto"      — download agents without asking (default)
   * - "monitored" — user reviews/edits/rejects each agent before launch
   * - "disabled"  — always use the generalist agent
   */
  mode: AgentRegistryMode;
  /** GitHub repo in "owner/repo" format to pull agent definitions from */
  source: string;
  /** Cache directory name (relative to .wombo-combo/) */
  cacheDir: string;
  /** Cache TTL in milliseconds. Cached agents older than this are re-fetched. Default 24h. */
  cacheTTL: number;
}

/** Configuration for Test-Driven Development workflow */
export interface TddConfig {
  /** Enable TDD red-green-refactor instructions in agent prompts */
  enabled: boolean;
  /** Test command to run (default: "bun test") */
  testCommand: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: WomboConfig = {
  tasksDir: "tasks",
  archiveDir: "archive",
  baseBranch: "develop",
  build: {
    command: "bun run build",
    timeout: 300_000,
    artifactDir: "dist",
  },
  install: {
    command: "bun install",
    timeout: 120_000,
  },
  git: {
    branchPrefix: "feature/",
    worktreePrefix: "wombo-",
    remote: "origin",
    mergeStrategy: "--no-ff",
  },
  agent: {
    bin: null,
    name: "generalist-agent",
    configFiles: [".opencode/", "opencode.json", "AGENTS.md"],
    tmuxPrefix: "wombo",
    multiplexer: "auto",
  },
  portless: {
    enabled: true,
    bin: null,
    proxyPort: 1355,
    https: false,
  },
  backup: {
    maxBackups: 5,
  },
  defaults: {
    maxConcurrent: 6,
    maxRetries: 2,
  },
  browser: {
    enabled: false,
    bin: null,
    headless: true,
    testCommand: null,
    launchTimeout: 30_000,
    testTimeout: 60_000,
    defaultViewport: {
      width: 1280,
      height: 720,
    },
  },
  agentRegistry: {
    mode: "auto",
    source: "msitarzewski/agency-agents",
    cacheDir: "agents-cache",
    cacheTTL: 24 * 60 * 60 * 1000, // 24 hours
  },
  tdd: {
    enabled: false,
    testCommand: "bun test",
  },
};

// ---------------------------------------------------------------------------
// Config File Name
// ---------------------------------------------------------------------------

export const CONFIG_FILE = `${WOMBO_DIR}/config.json`;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Deep-merge source into target. Only merges plain objects, not arrays.
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== undefined &&
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal) &&
      tgtVal !== null
    ) {
      result[key] = deepMerge(tgtVal as any, srcVal as any);
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[keyof T];
    }
  }
  return result;
}

/**
 * Load .wombo-combo/config.json from the given project root and merge with defaults.
 * Returns the full config. If no config file exists, returns defaults.
 */
export function loadConfig(projectRoot: string): WomboConfig {
  const configPath = resolve(projectRoot, CONFIG_FILE);

  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const partial = JSON.parse(raw) as Partial<WomboConfig>;

    // Migrate legacy single-file config keys to folder-based
    if ((partial as any).tasksFile && !partial.tasksDir) {
      // Legacy "tasks.yml" → strip extension for dir name, or use as-is
      const legacy = (partial as any).tasksFile as string;
      partial.tasksDir = legacy.replace(/\.ya?ml$/i, "") || "tasks";
      delete (partial as any).tasksFile;
    }
    if ((partial as any).archiveFile && !partial.archiveDir) {
      const legacy = (partial as any).archiveFile as string;
      partial.archiveDir = legacy.replace(/\.ya?ml$/i, "") || "archive";
      delete (partial as any).archiveFile;
    }

    return deepMerge(DEFAULT_CONFIG, partial);
  } catch (err: any) {
    throw new Error(`Failed to load ${CONFIG_FILE}: ${err.message}`);
  }
}

/**
 * Resolve the agent binary path. Priority:
 *   1. config.agent.bin (explicit)
 *   2. OPENCODE_BIN env var
 *   3. ~/.opencode/bin/opencode (default install location)
 */
export function resolveAgentBin(config: WomboConfig): string {
  if (config.agent.bin) return config.agent.bin;
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  return resolve(process.env.HOME || "~", ".opencode/bin/opencode");
}

/**
 * Validate the config for obvious issues. Throws on error.
 */
export function validateConfig(config: WomboConfig): void {
  if (!config.tasksDir) {
    throw new Error("config.tasksDir must be a non-empty string");
  }
  if (!config.archiveDir) {
    throw new Error("config.archiveDir must be a non-empty string");
  }
  if (!config.baseBranch) {
    throw new Error("config.baseBranch must be a non-empty string");
  }
  if (!config.build.command) {
    throw new Error("config.build.command must be a non-empty string");
  }
  if (!config.install.command) {
    throw new Error("config.install.command must be a non-empty string");
  }
  if (!config.git.branchPrefix) {
    throw new Error("config.git.branchPrefix must be a non-empty string");
  }
  if (!config.git.worktreePrefix) {
    throw new Error("config.git.worktreePrefix must be a non-empty string");
  }
  if (config.defaults.maxConcurrent < 1) {
    throw new Error("config.defaults.maxConcurrent must be >= 1");
  }
  if (config.defaults.maxRetries < 0) {
    throw new Error("config.defaults.maxRetries must be >= 0");
  }
  if (config.backup.maxBackups < 0) {
    throw new Error("config.backup.maxBackups must be >= 0");
  }
  const validModes: AgentRegistryMode[] = ["auto", "monitored", "disabled"];
  if (!validModes.includes(config.agentRegistry.mode)) {
    throw new Error(`config.agentRegistry.mode must be one of: ${validModes.join(", ")}`);
  }
  if (!config.agentRegistry.source) {
    throw new Error("config.agentRegistry.source must be a non-empty string");
  }
  if (!config.agentRegistry.cacheDir) {
    throw new Error("config.agentRegistry.cacheDir must be a non-empty string");
  }
  if (config.tdd.enabled && !config.tdd.testCommand) {
    throw new Error("config.tdd.testCommand must be a non-empty string when TDD is enabled");
  }
}

/**
 * Generate the default .wombo-combo/config.json content string (for `woco init`).
 */
export function generateDefaultConfig(): string {
  return JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
}
