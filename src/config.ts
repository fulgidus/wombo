/**
 * config.ts — Load wombo.json, merge with defaults, validate, expose typed config.
 *
 * The config file lives at the target project root (the repo being orchestrated).
 * All values have sensible defaults so minimal config works out of the box.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { MultiplexerPreference } from "./lib/multiplexer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WomboConfig {
  /** Path to the features YAML file relative to project root */
  featuresFile: string;
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
  /** Backup configuration for features file */
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
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: WomboConfig = {
  featuresFile: ".features.yml",
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
    name: "wave-worker",
    configFiles: [".opencode/", "opencode.json", "AGENTS.md", "agent/"],
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
};

// ---------------------------------------------------------------------------
// Config File Name
// ---------------------------------------------------------------------------

export const CONFIG_FILE = "wombo.json";

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
 * Load wombo.json from the given project root and merge with defaults.
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
  if (!config.featuresFile) {
    throw new Error("config.featuresFile must be a non-empty string");
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
}

/**
 * Generate the default wombo.json content string (for `wombo init`).
 */
export function generateDefaultConfig(): string {
  return JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
}
