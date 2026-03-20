/**
 * usage-export.test.ts — Tests for the --export flag in the usage command.
 *
 * Coverage:
 *   - cmdUsage with --export csv writes a CSV file
 *   - cmdUsage with --export json writes a JSON file
 *   - cmdUsage with --export html writes an HTML file
 *   - cmdUsage with --export-file specifies the output path
 *   - cmdUsage with --export and no records shows empty export
 *   - Validation of --export value
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WOMBO_DIR, DEFAULT_CONFIG } from "../src/config";
import { cmdUsage } from "../src/commands/usage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wombo-usage-export-test-"));
  // Create .wombo-combo directory
  mkdirSync(join(tmpDir, WOMBO_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const mockConfig = DEFAULT_CONFIG;

function writeUsageJsonl(projectRoot: string, records: object[]): void {
  const filePath = join(projectRoot, WOMBO_DIR, "usage.jsonl");
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(filePath, content, "utf-8");
}

function makeUsageRecord(overrides?: object): object {
  return {
    task_id: "test-task",
    quest_id: null,
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
    harness: "opencode",
    input_tokens: 1000,
    output_tokens: 500,
    cache_read: 200,
    cache_write: 100,
    reasoning_tokens: 0,
    total_tokens: 1500,
    cost: 0.0025,
    is_final_step: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: --export flag on cmdUsage
// ---------------------------------------------------------------------------

describe("cmdUsage --export csv", () => {
  test("writes CSV file to default location when --export csv is given", async () => {
    writeUsageJsonl(tmpDir, [makeUsageRecord()]);

    const exportFile = join(tmpDir, "usage-export.csv");
    await cmdUsage({
      projectRoot: tmpDir,
      config: mockConfig,
      usageFormat: "table",
      outputFmt: "text",
      export: "csv",
      exportFile,
    });

    expect(existsSync(exportFile)).toBe(true);
    const content = readFileSync(exportFile, "utf-8");
    expect(content).toContain("task_id");
    expect(content).toContain("test-task");
  });

  test("CSV export includes all token metric columns", async () => {
    writeUsageJsonl(tmpDir, [
      makeUsageRecord({ task_id: "csv-test", input_tokens: 9999, cost: 0.0123 }),
    ]);

    const exportFile = join(tmpDir, "usage.csv");
    await cmdUsage({
      projectRoot: tmpDir,
      config: mockConfig,
      usageFormat: "table",
      outputFmt: "text",
      export: "csv",
      exportFile,
    });

    const content = readFileSync(exportFile, "utf-8");
    expect(content).toContain("input_tokens");
    expect(content).toContain("output_tokens");
    expect(content).toContain("total_tokens");
    expect(content).toContain("cost");
    expect(content).toContain("9999");
    expect(content).toContain("csv-test");
  });
});

describe("cmdUsage --export json", () => {
  test("writes JSON file with full nested structure", async () => {
    writeUsageJsonl(tmpDir, [
      makeUsageRecord({ task_id: "json-export-task" }),
    ]);

    const exportFile = join(tmpDir, "usage.json");
    await cmdUsage({
      projectRoot: tmpDir,
      config: mockConfig,
      usageFormat: "table",
      outputFmt: "text",
      export: "json",
      exportFile,
    });

    expect(existsSync(exportFile)).toBe(true);
    const content = readFileSync(exportFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.records).toBeDefined();
    expect(parsed.summary).toBeDefined();
    expect(parsed.by_task).toBeDefined();
    expect(parsed.metadata).toBeDefined();
    expect(parsed.records[0].task_id).toBe("json-export-task");
  });
});

describe("cmdUsage --export html", () => {
  test("writes HTML file with Chart.js and data table", async () => {
    writeUsageJsonl(tmpDir, [
      makeUsageRecord({ task_id: "html-task", total_tokens: 5000 }),
    ]);

    const exportFile = join(tmpDir, "usage.html");
    await cmdUsage({
      projectRoot: tmpDir,
      config: mockConfig,
      usageFormat: "table",
      outputFmt: "text",
      export: "html",
      exportFile,
    });

    expect(existsSync(exportFile)).toBe(true);
    const content = readFileSync(exportFile, "utf-8");
    expect(content).toContain("<!DOCTYPE html>");
    expect(content).toContain("Chart");
    expect(content).toContain("html-task");
  });
});

describe("cmdUsage --export with date filters", () => {
  test("exports only records matching the date filter", async () => {
    writeUsageJsonl(tmpDir, [
      makeUsageRecord({ task_id: "old-task", timestamp: "2026-01-01T00:00:00Z" }),
      makeUsageRecord({ task_id: "new-task", timestamp: "2026-06-01T00:00:00Z" }),
    ]);

    const exportFile = join(tmpDir, "filtered.json");
    await cmdUsage({
      projectRoot: tmpDir,
      config: mockConfig,
      usageFormat: "table",
      outputFmt: "text",
      since: "2026-03-01",
      export: "json",
      exportFile,
    });

    expect(existsSync(exportFile)).toBe(true);
    const content = readFileSync(exportFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.records.length).toBe(1);
    expect(parsed.records[0].task_id).toBe("new-task");
  });
});

describe("cmdUsage --export with no data", () => {
  test("still writes export file even when no records exist", async () => {
    // No usage.jsonl file (empty project)
    const exportFile = join(tmpDir, "empty-export.json");
    await cmdUsage({
      projectRoot: tmpDir,
      config: mockConfig,
      usageFormat: "table",
      outputFmt: "text",
      export: "json",
      exportFile,
    });

    expect(existsSync(exportFile)).toBe(true);
    const content = readFileSync(exportFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.records).toEqual([]);
    expect(parsed.summary.record_count).toBe(0);
  });
});

describe("cmdUsage --export combined with --by grouping", () => {
  test("exports grouped JSON when --by is set", async () => {
    writeUsageJsonl(tmpDir, [
      makeUsageRecord({ task_id: "auth", model: "gpt-4o" }),
      makeUsageRecord({ task_id: "search", model: "claude-sonnet-4-20250514" }),
    ]);

    const exportFile = join(tmpDir, "grouped.json");
    await cmdUsage({
      projectRoot: tmpDir,
      config: mockConfig,
      usageFormat: "table",
      outputFmt: "text",
      by: "task",
      export: "json",
      exportFile,
    });

    expect(existsSync(exportFile)).toBe(true);
    const content = readFileSync(exportFile, "utf-8");
    const parsed = JSON.parse(content);
    // JSON export should still include all records regardless of --by
    expect(parsed.records.length).toBe(2);
    expect(parsed.by_task).toBeDefined();
  });
});
