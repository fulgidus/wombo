/**
 * init-writer.test.ts — Tests for init file-writing utilities.
 *
 * Verifies:
 *   - writeInitFiles creates config.json with correct content
 *   - writeInitFiles creates tasks/ directory with _meta.yml
 *   - writeInitFiles creates archive/ directory with _meta.yml
 *   - writeInitFiles does NOT create logs/ or history/ (runtime artifacts)
 *   - writeInitFiles respects force flag for existing files
 *   - writeInitFiles creates .wombo-combo/ directory if missing
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeInitFiles, type InitWriterConfig } from "./init-writer";
import { WOMBO_DIR, DEFAULT_CONFIG } from "../config";

describe("writeInitFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "woco-init-writer-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates .wombo-combo directory", () => {
    const config: InitWriterConfig = {
      baseBranch: "main",
      buildCommand: "bun run build",
      installCommand: "bun install",
    };

    writeInitFiles(tmpDir, config, false);

    expect(existsSync(join(tmpDir, WOMBO_DIR))).toBe(true);
  });

  test("creates config.json with provided values", () => {
    const config: InitWriterConfig = {
      baseBranch: "main",
      buildCommand: "npm run build",
      installCommand: "npm install",
    };

    writeInitFiles(tmpDir, config, false);

    const configPath = join(tmpDir, WOMBO_DIR, "config.json");
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.baseBranch).toBe("main");
    expect(written.build.command).toBe("npm run build");
    expect(written.install.command).toBe("npm install");
  });

  test("creates tasks/ directory with _meta.yml", () => {
    const config: InitWriterConfig = {
      baseBranch: "main",
      buildCommand: "bun run build",
      installCommand: "bun install",
    };

    writeInitFiles(tmpDir, config, false);

    const tasksDir = join(tmpDir, WOMBO_DIR, "tasks");
    expect(existsSync(tasksDir)).toBe(true);
    expect(existsSync(join(tasksDir, "_meta.yml"))).toBe(true);

    const meta = readFileSync(join(tasksDir, "_meta.yml"), "utf-8");
    expect(meta).toContain("generator: wombo-combo");
  });

  test("creates archive/ directory with _meta.yml", () => {
    const config: InitWriterConfig = {
      baseBranch: "main",
      buildCommand: "bun run build",
      installCommand: "bun install",
    };

    writeInitFiles(tmpDir, config, false);

    const archiveDir = join(tmpDir, WOMBO_DIR, "archive");
    expect(existsSync(archiveDir)).toBe(true);
    expect(existsSync(join(archiveDir, "_meta.yml"))).toBe(true);
  });

  test("does NOT create logs/ directory", () => {
    const config: InitWriterConfig = {
      baseBranch: "main",
      buildCommand: "bun run build",
      installCommand: "bun install",
    };

    writeInitFiles(tmpDir, config, false);

    expect(existsSync(join(tmpDir, WOMBO_DIR, "logs"))).toBe(false);
  });

  test("does NOT create history/ directory", () => {
    const config: InitWriterConfig = {
      baseBranch: "main",
      buildCommand: "bun run build",
      installCommand: "bun install",
    };

    writeInitFiles(tmpDir, config, false);

    expect(existsSync(join(tmpDir, WOMBO_DIR, "history"))).toBe(false);
  });

  test("does not overwrite existing config.json without force", () => {
    // Create existing config
    const womboDir = join(tmpDir, WOMBO_DIR);
    mkdirSync(womboDir, { recursive: true });
    writeFileSync(
      join(womboDir, "config.json"),
      JSON.stringify({ baseBranch: "original" })
    );

    const config: InitWriterConfig = {
      baseBranch: "replaced",
      buildCommand: "bun run build",
      installCommand: "bun install",
    };

    // Should throw when not forced
    expect(() => writeInitFiles(tmpDir, config, false)).toThrow();
  });

  test("overwrites existing config.json with force", () => {
    // Create existing config
    const womboDir = join(tmpDir, WOMBO_DIR);
    mkdirSync(womboDir, { recursive: true });
    writeFileSync(
      join(womboDir, "config.json"),
      JSON.stringify({ baseBranch: "original" })
    );

    const config: InitWriterConfig = {
      baseBranch: "replaced",
      buildCommand: "bun run build",
      installCommand: "bun install",
    };

    writeInitFiles(tmpDir, config, true);

    const written = JSON.parse(
      readFileSync(join(womboDir, "config.json"), "utf-8")
    );
    expect(written.baseBranch).toBe("replaced");
  });

  test("returns list of created files", () => {
    const config: InitWriterConfig = {
      baseBranch: "main",
      buildCommand: "bun run build",
      installCommand: "bun install",
    };

    const result = writeInitFiles(tmpDir, config, false);

    expect(result.createdFiles).toBeArray();
    expect(result.createdFiles.length).toBeGreaterThan(0);
    expect(result.createdFiles.some((f: string) => f.includes("config.json"))).toBe(true);
    expect(result.createdFiles.some((f: string) => f.includes("tasks"))).toBe(true);
    expect(result.createdFiles.some((f: string) => f.includes("archive"))).toBe(true);
  });

  test("config.json contains all DEFAULT_CONFIG fields", () => {
    const config: InitWriterConfig = {
      baseBranch: "main",
      buildCommand: "bun run build",
      installCommand: "bun install",
    };

    writeInitFiles(tmpDir, config, false);

    const written = JSON.parse(
      readFileSync(join(tmpDir, WOMBO_DIR, "config.json"), "utf-8")
    );

    // Should have all top-level keys from DEFAULT_CONFIG
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(written).toHaveProperty(key);
    }
  });
});
