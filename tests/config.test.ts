/**
 * config.test.ts — Unit tests for config.ts (loadConfig, validateConfig, deepMerge).
 *
 * Coverage:
 *   - loadConfig: returns defaults when no config file, merges partial config,
 *     deep-merges nested objects, handles legacy tasksFile/archiveFile migration,
 *     throws on invalid JSON
 *   - validateConfig: validates required fields, numeric constraints, enum values
 *   - DEFAULT_CONFIG: sensible defaults for all fields
 *   - generateDefaultConfig: returns valid JSON string
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  validateConfig,
  DEFAULT_CONFIG,
  CONFIG_FILE,
  WOMBO_DIR,
  generateDefaultConfig,
} from "../src/config.js";
import type { WomboConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wombo-test-config-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(dir: string, config: Record<string, unknown>): void {
  mkdirSync(join(dir, WOMBO_DIR), { recursive: true });
  writeFileSync(
    join(dir, CONFIG_FILE),
    JSON.stringify(config, null, 2)
  );
}

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG
// ---------------------------------------------------------------------------

describe("DEFAULT_CONFIG", () => {
  test("has all required top-level fields", () => {
    expect(DEFAULT_CONFIG.tasksDir).toBe("tasks");
    expect(DEFAULT_CONFIG.archiveDir).toBe("archive");
    expect(DEFAULT_CONFIG.baseBranch).toBeDefined();
    expect(DEFAULT_CONFIG.build).toBeDefined();
    expect(DEFAULT_CONFIG.install).toBeDefined();
    expect(DEFAULT_CONFIG.git).toBeDefined();
    expect(DEFAULT_CONFIG.agent).toBeDefined();
    expect(DEFAULT_CONFIG.portless).toBeDefined();
    expect(DEFAULT_CONFIG.backup).toBeDefined();
    expect(DEFAULT_CONFIG.defaults).toBeDefined();
    expect(DEFAULT_CONFIG.browser).toBeDefined();
    expect(DEFAULT_CONFIG.agentRegistry).toBeDefined();
    expect(DEFAULT_CONFIG.tdd).toBeDefined();
  });

  test("passes its own validateConfig", () => {
    expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
  });

  test("has sensible numeric defaults", () => {
    expect(DEFAULT_CONFIG.defaults.maxConcurrent).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_CONFIG.defaults.maxRetries).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CONFIG.backup.maxBackups).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CONFIG.build.timeout).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.install.timeout).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  test("returns defaults when no config file exists", () => {
    const config = loadConfig(tmpDir);
    expect(config.baseBranch).toBe(DEFAULT_CONFIG.baseBranch);
    expect(config.build.command).toBe(DEFAULT_CONFIG.build.command);
    expect(config.git.branchPrefix).toBe(DEFAULT_CONFIG.git.branchPrefix);
    expect(config.tdd.enabled).toBe(false);
  });

  test("merges partial config with defaults", () => {
    writeConfig(tmpDir, { baseBranch: "custom-main" });
    const config = loadConfig(tmpDir);
    // Custom value
    expect(config.baseBranch).toBe("custom-main");
    // Defaults preserved
    expect(config.build.command).toBe(DEFAULT_CONFIG.build.command);
    expect(config.git.branchPrefix).toBe(DEFAULT_CONFIG.git.branchPrefix);
  });

  test("deep-merges nested objects", () => {
    writeConfig(tmpDir, {
      build: { command: "npm run build" },
    });
    const config = loadConfig(tmpDir);
    // Custom nested value
    expect(config.build.command).toBe("npm run build");
    // Other nested defaults preserved
    expect(config.build.timeout).toBe(DEFAULT_CONFIG.build.timeout);
    expect(config.build.artifactDir).toBe(DEFAULT_CONFIG.build.artifactDir);
  });

  test("deep-merges git config partially", () => {
    writeConfig(tmpDir, {
      git: { worktreePrefix: "custom-" },
    });
    const config = loadConfig(tmpDir);
    expect(config.git.worktreePrefix).toBe("custom-");
    expect(config.git.branchPrefix).toBe(DEFAULT_CONFIG.git.branchPrefix);
    expect(config.git.remote).toBe(DEFAULT_CONFIG.git.remote);
  });

  test("replaces arrays instead of merging them", () => {
    writeConfig(tmpDir, {
      agent: { configFiles: [".custom-config"] },
    });
    const config = loadConfig(tmpDir);
    expect(config.agent.configFiles).toEqual([".custom-config"]);
  });

  test("throws on invalid JSON", () => {
    mkdirSync(join(tmpDir, WOMBO_DIR), { recursive: true });
    writeFileSync(join(tmpDir, CONFIG_FILE), "{{not valid json");
    expect(() => loadConfig(tmpDir)).toThrow();
  });

  test("migrates legacy tasksFile to tasksDir", () => {
    writeConfig(tmpDir, { tasksFile: "my-tasks.yml" });
    const config = loadConfig(tmpDir);
    expect(config.tasksDir).toBe("my-tasks");
  });

  test("migrates legacy archiveFile to archiveDir", () => {
    writeConfig(tmpDir, { archiveFile: "my-archive.yaml" });
    const config = loadConfig(tmpDir);
    expect(config.archiveDir).toBe("my-archive");
  });

  test("does not migrate tasksFile if tasksDir is already set", () => {
    writeConfig(tmpDir, { tasksFile: "old.yml", tasksDir: "new-dir" });
    const config = loadConfig(tmpDir);
    expect(config.tasksDir).toBe("new-dir");
  });

  test("deep-merges tdd config", () => {
    writeConfig(tmpDir, {
      tdd: { enabled: true },
    });
    const config = loadConfig(tmpDir);
    expect(config.tdd.enabled).toBe(true);
    expect(config.tdd.testCommand).toBe(DEFAULT_CONFIG.tdd.testCommand);
  });

  test("deep-merges agentRegistry config", () => {
    writeConfig(tmpDir, {
      agentRegistry: { mode: "disabled" },
    });
    const config = loadConfig(tmpDir);
    expect(config.agentRegistry.mode).toBe("disabled");
    expect(config.agentRegistry.source).toBe(DEFAULT_CONFIG.agentRegistry.source);
    expect(config.agentRegistry.cacheTTL).toBe(DEFAULT_CONFIG.agentRegistry.cacheTTL);
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe("validateConfig", () => {
  function validConfig(): WomboConfig {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as WomboConfig;
  }

  test("accepts the default config", () => {
    expect(() => validateConfig(validConfig())).not.toThrow();
  });

  test("throws on empty tasksDir", () => {
    const config = validConfig();
    config.tasksDir = "";
    expect(() => validateConfig(config)).toThrow("tasksDir");
  });

  test("throws on empty archiveDir", () => {
    const config = validConfig();
    config.archiveDir = "";
    expect(() => validateConfig(config)).toThrow("archiveDir");
  });

  test("throws on empty baseBranch", () => {
    const config = validConfig();
    config.baseBranch = "";
    expect(() => validateConfig(config)).toThrow("baseBranch");
  });

  test("throws on empty build command", () => {
    const config = validConfig();
    config.build.command = "";
    expect(() => validateConfig(config)).toThrow("build.command");
  });

  test("throws on empty install command", () => {
    const config = validConfig();
    config.install.command = "";
    expect(() => validateConfig(config)).toThrow("install.command");
  });

  test("throws on empty branchPrefix", () => {
    const config = validConfig();
    config.git.branchPrefix = "";
    expect(() => validateConfig(config)).toThrow("branchPrefix");
  });

  test("allows maxConcurrent = 0 (unlimited)", () => {
    const config = validConfig();
    config.defaults.maxConcurrent = 0;
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("throws on negative maxConcurrent", () => {
    const config = validConfig();
    config.defaults.maxConcurrent = -1;
    expect(() => validateConfig(config)).toThrow("maxConcurrent");
  });

  test("throws on negative maxRetries", () => {
    const config = validConfig();
    config.defaults.maxRetries = -1;
    expect(() => validateConfig(config)).toThrow("maxRetries");
  });

  test("throws on negative maxBackups", () => {
    const config = validConfig();
    config.backup.maxBackups = -1;
    expect(() => validateConfig(config)).toThrow("maxBackups");
  });

  test("throws on invalid agentRegistry.mode", () => {
    const config = validConfig();
    (config.agentRegistry as any).mode = "invalid-mode";
    expect(() => validateConfig(config)).toThrow("mode");
  });

  test("accepts all valid agentRegistry modes", () => {
    for (const mode of ["auto", "monitored", "disabled"] as const) {
      const config = validConfig();
      config.agentRegistry.mode = mode;
      expect(() => validateConfig(config)).not.toThrow();
    }
  });

  test("throws on empty agentRegistry.source", () => {
    const config = validConfig();
    config.agentRegistry.source = "";
    expect(() => validateConfig(config)).toThrow("source");
  });

  test("throws on empty agentRegistry.cacheDir", () => {
    const config = validConfig();
    config.agentRegistry.cacheDir = "";
    expect(() => validateConfig(config)).toThrow("cacheDir");
  });

  test("throws when tdd.enabled is true but testCommand is empty", () => {
    const config = validConfig();
    config.tdd.enabled = true;
    config.tdd.testCommand = "";
    expect(() => validateConfig(config)).toThrow("testCommand");
  });

  test("allows empty testCommand when tdd is disabled", () => {
    const config = validConfig();
    config.tdd.enabled = false;
    config.tdd.testCommand = "";
    expect(() => validateConfig(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// generateDefaultConfig
// ---------------------------------------------------------------------------

describe("generateDefaultConfig", () => {
  test("returns valid JSON string", () => {
    const jsonStr = generateDefaultConfig();
    expect(() => JSON.parse(jsonStr)).not.toThrow();
  });

  test("returned JSON matches DEFAULT_CONFIG", () => {
    const parsed = JSON.parse(generateDefaultConfig());
    expect(parsed.baseBranch).toBe(DEFAULT_CONFIG.baseBranch);
    expect(parsed.build.command).toBe(DEFAULT_CONFIG.build.command);
    expect(parsed.tdd.enabled).toBe(DEFAULT_CONFIG.tdd.enabled);
  });

  test("ends with newline", () => {
    const jsonStr = generateDefaultConfig();
    expect(jsonStr.endsWith("\n")).toBe(true);
  });
});
