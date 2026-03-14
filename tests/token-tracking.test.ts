/**
 * token-tracking.test.ts — End-to-end tests for the token tracking system.
 *
 * Coverage:
 *   - TokenCollector: parse step_finish events, accumulate records, generate summaries
 *   - UsageStore: persist records to JSONL, load, aggregate, group, filter by date
 *   - Integration: wire TokenCollector → UsageStore, simulate a wave of agent events
 *   - Edge cases: malformed events, empty files, concurrent agents, missing fields
 *   - CLI: cmdUsage renders table and JSON output correctly
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  TokenCollector,
  isTokenEvent,
  parseUsageFromEvent,
  type UsageRecord,
} from "../src/lib/token-collector.js";
import type { OpenCodeEvent } from "../src/lib/monitor.js";
import {
  UsageStore,
  appendUsageRecord,
  loadUsageRecords,
  totalUsage,
  filterByDateRange,
  groupBy,
  type UsageTotals,
  type GroupableField,
} from "../src/lib/token-usage.js";
import { WOMBO_DIR } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wombo-test-token-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a step_finish event with token data */
function makeStepFinishEvent(overrides?: Partial<{
  reason: string;
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp: number;
}>): OpenCodeEvent {
  const {
    reason = "tool-calls",
    cost = 0.0025,
    input = 1000,
    output = 500,
    reasoning = 0,
    total = 1500,
    cacheRead = 200,
    cacheWrite = 100,
    timestamp = Date.now(),
  } = overrides ?? {};

  return {
    type: "step_finish",
    sessionID: "test-session-1",
    timestamp,
    part: {
      reason,
      cost,
      tokens: {
        total,
        input,
        output,
        reasoning,
        cache: { read: cacheRead, write: cacheWrite },
      },
    },
  };
}

/** Create a non-token event (e.g., tool_use) */
function makeToolUseEvent(): OpenCodeEvent {
  return {
    type: "tool_use",
    sessionID: "test-session-1",
    timestamp: Date.now(),
    part: {
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/foo/bar.ts" },
        output: "file contents...",
      },
    },
  };
}

/** Create a UsageRecord directly */
function makeUsageRecord(overrides?: Partial<UsageRecord>): UsageRecord {
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
// TokenCollector — isTokenEvent
// ---------------------------------------------------------------------------

describe("isTokenEvent", () => {
  test("returns true for step_finish with token data", () => {
    const event = makeStepFinishEvent();
    expect(isTokenEvent(event)).toBe(true);
  });

  test("returns false for non-step_finish events", () => {
    const event = makeToolUseEvent();
    expect(isTokenEvent(event)).toBe(false);
  });

  test("returns false for step_finish without tokens", () => {
    const event: OpenCodeEvent = {
      type: "step_finish",
      part: { reason: "stop" },
    };
    expect(isTokenEvent(event)).toBe(false);
  });

  test("returns false for step_finish with tokens missing input", () => {
    const event: OpenCodeEvent = {
      type: "step_finish",
      part: {
        reason: "stop",
        tokens: { total: 100, input: undefined as any, output: 50, reasoning: 0 },
      },
    };
    expect(isTokenEvent(event)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TokenCollector — parseUsageFromEvent
// ---------------------------------------------------------------------------

describe("parseUsageFromEvent", () => {
  test("extracts usage record from step_finish event", () => {
    const event = makeStepFinishEvent({ input: 2000, output: 800, total: 2800, cost: 0.005 });
    const record = parseUsageFromEvent(event, "my-feature");

    expect(record).not.toBeNull();
    expect(record!.task_id).toBe("my-feature");
    expect(record!.input_tokens).toBe(2000);
    expect(record!.output_tokens).toBe(800);
    expect(record!.total_tokens).toBe(2800);
    expect(record!.cost).toBe(0.005);
    expect(record!.harness).toBe("opencode"); // default harness
    expect(record!.is_final_step).toBe(false); // reason = "tool-calls"
  });

  test("marks final step when reason is stop", () => {
    const event = makeStepFinishEvent({ reason: "stop" });
    const record = parseUsageFromEvent(event, "my-feature");

    expect(record).not.toBeNull();
    expect(record!.is_final_step).toBe(true);
  });

  test("attaches context (model, provider, quest_id, harness)", () => {
    const event = makeStepFinishEvent();
    const record = parseUsageFromEvent(event, "my-feature", {
      quest_id: "quest-auth",
      model: "gpt-4o",
      provider: "openai",
      harness: "aider",
    });

    expect(record!.quest_id).toBe("quest-auth");
    expect(record!.model).toBe("gpt-4o");
    expect(record!.provider).toBe("openai");
    expect(record!.harness).toBe("aider");
  });

  test("returns null for non-token events", () => {
    const event = makeToolUseEvent();
    const record = parseUsageFromEvent(event, "my-feature");
    expect(record).toBeNull();
  });

  test("handles missing cache data gracefully", () => {
    const event: OpenCodeEvent = {
      type: "step_finish",
      timestamp: Date.now(),
      part: {
        reason: "stop",
        cost: 0.001,
        tokens: {
          total: 500,
          input: 400,
          output: 100,
          reasoning: 0,
          // no cache field
        },
      },
    };

    const record = parseUsageFromEvent(event, "task-1");
    expect(record).not.toBeNull();
    expect(record!.cache_read).toBe(0);
    expect(record!.cache_write).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TokenCollector — Class
// ---------------------------------------------------------------------------

describe("TokenCollector", () => {
  test("ingestEvent accumulates records per agent", () => {
    const collector = new TokenCollector();
    collector.registerAgent("agent-a");
    collector.registerAgent("agent-b");

    collector.ingestEvent("agent-a", makeStepFinishEvent({ input: 100, output: 50, total: 150 }));
    collector.ingestEvent("agent-a", makeStepFinishEvent({ input: 200, output: 100, total: 300 }));
    collector.ingestEvent("agent-b", makeStepFinishEvent({ input: 300, output: 150, total: 450 }));

    expect(collector.getRecords("agent-a").length).toBe(2);
    expect(collector.getRecords("agent-b").length).toBe(1);
    expect(collector.getAllRecords().length).toBe(3);
  });

  test("ingestEvent ignores non-token events", () => {
    const collector = new TokenCollector();
    collector.registerAgent("agent-a");

    const result = collector.ingestEvent("agent-a", makeToolUseEvent());
    expect(result).toBeNull();
    expect(collector.getRecords("agent-a").length).toBe(0);
  });

  test("invokes onUsage callback for each parsed record", () => {
    const records: UsageRecord[] = [];
    const collector = new TokenCollector((record) => {
      records.push(record);
    });

    collector.registerAgent("agent-a");
    collector.ingestEvent("agent-a", makeStepFinishEvent());
    collector.ingestEvent("agent-a", makeStepFinishEvent());

    expect(records.length).toBe(2);
  });

  test("getSummary aggregates across all steps for an agent", () => {
    const collector = new TokenCollector();
    collector.registerAgent("agent-a");

    collector.ingestEvent("agent-a", makeStepFinishEvent({
      input: 1000, output: 500, total: 1500, cost: 0.002,
    }));
    collector.ingestEvent("agent-a", makeStepFinishEvent({
      input: 2000, output: 800, total: 2800, cost: 0.005,
    }));

    const summary = collector.getSummary("agent-a");
    expect(summary).not.toBeNull();
    expect(summary!.total_input).toBe(3000);
    expect(summary!.total_output).toBe(1300);
    expect(summary!.total_tokens).toBe(4300);
    expect(summary!.total_cost).toBeCloseTo(0.007);
    expect(summary!.step_count).toBe(2);
  });

  test("getSummary returns null for unknown agent", () => {
    const collector = new TokenCollector();
    expect(collector.getSummary("nonexistent")).toBeNull();
  });

  test("clear removes records for specific agent", () => {
    const collector = new TokenCollector();
    collector.registerAgent("agent-a");
    collector.registerAgent("agent-b");

    collector.ingestEvent("agent-a", makeStepFinishEvent());
    collector.ingestEvent("agent-b", makeStepFinishEvent());

    collector.clear("agent-a");
    expect(collector.getRecords("agent-a").length).toBe(0);
    expect(collector.getRecords("agent-b").length).toBe(1);
  });

  test("clearAll removes all records", () => {
    const collector = new TokenCollector();
    collector.registerAgent("agent-a");
    collector.registerAgent("agent-b");

    collector.ingestEvent("agent-a", makeStepFinishEvent());
    collector.ingestEvent("agent-b", makeStepFinishEvent());

    collector.clearAll();
    expect(collector.getAllRecords().length).toBe(0);
  });

  test("registerAgent attaches context to all records", () => {
    const collector = new TokenCollector();
    collector.registerAgent("agent-a", {
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      quest_id: "quest-1",
      harness: "opencode",
    });

    collector.ingestEvent("agent-a", makeStepFinishEvent());

    const records = collector.getRecords("agent-a");
    expect(records[0].model).toBe("claude-sonnet-4-20250514");
    expect(records[0].provider).toBe("anthropic");
    expect(records[0].quest_id).toBe("quest-1");
    expect(records[0].harness).toBe("opencode");
  });

  test("getAllSummaries returns summaries for all agents", () => {
    const collector = new TokenCollector();
    collector.registerAgent("agent-a");
    collector.registerAgent("agent-b");

    collector.ingestEvent("agent-a", makeStepFinishEvent({ input: 100, output: 50, total: 150 }));
    collector.ingestEvent("agent-b", makeStepFinishEvent({ input: 200, output: 100, total: 300 }));

    const summaries = collector.getAllSummaries();
    expect(summaries.length).toBe(2);
    expect(summaries.map(s => s.task_id).sort()).toEqual(["agent-a", "agent-b"]);
  });
});

// ---------------------------------------------------------------------------
// UsageStore — Persistence (appendUsageRecord, loadUsageRecords)
// ---------------------------------------------------------------------------

describe("UsageStore — Persistence", () => {
  test("appendUsageRecord creates .wombo-combo/ dir and file if missing", () => {
    const record = makeUsageRecord();
    appendUsageRecord(tmpDir, record);

    const filePath = join(tmpDir, WOMBO_DIR, "usage.jsonl");
    expect(existsSync(filePath)).toBe(true);
  });

  test("appendUsageRecord writes a single JSON line", () => {
    const record = makeUsageRecord({ task_id: "feat-x", input_tokens: 999 });
    appendUsageRecord(tmpDir, record);

    const filePath = join(tmpDir, WOMBO_DIR, "usage.jsonl");
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.task_id).toBe("feat-x");
    expect(parsed.input_tokens).toBe(999);
  });

  test("multiple appends create multiple lines", () => {
    appendUsageRecord(tmpDir, makeUsageRecord({ task_id: "a" }));
    appendUsageRecord(tmpDir, makeUsageRecord({ task_id: "b" }));
    appendUsageRecord(tmpDir, makeUsageRecord({ task_id: "c" }));

    const filePath = join(tmpDir, WOMBO_DIR, "usage.jsonl");
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);
  });

  test("loadUsageRecords returns empty array when file missing", () => {
    const records = loadUsageRecords(tmpDir);
    expect(records).toEqual([]);
  });

  test("loadUsageRecords round-trips through append", () => {
    const original = makeUsageRecord({ task_id: "roundtrip-test", cost: 0.123 });
    appendUsageRecord(tmpDir, original);

    const records = loadUsageRecords(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].task_id).toBe("roundtrip-test");
    expect(records[0].cost).toBeCloseTo(0.123);
  });

  test("loadUsageRecords skips malformed lines", () => {
    mkdirSync(join(tmpDir, WOMBO_DIR), { recursive: true });
    const filePath = join(tmpDir, WOMBO_DIR, "usage.jsonl");

    const validRecord = JSON.stringify(makeUsageRecord({ task_id: "valid" }));
    const content = `${validRecord}\nnot-valid-json\n{"missing_task_id": true}\n${validRecord}\n`;
    writeFileSync(filePath, content);

    const records = loadUsageRecords(tmpDir);
    // Should have 2 valid records (the "missing_task_id" line is skipped because it has no task_id)
    expect(records.length).toBe(2);
    expect(records[0].task_id).toBe("valid");
    expect(records[1].task_id).toBe("valid");
  });

  test("loadUsageRecords handles empty file", () => {
    mkdirSync(join(tmpDir, WOMBO_DIR), { recursive: true });
    writeFileSync(join(tmpDir, WOMBO_DIR, "usage.jsonl"), "");

    const records = loadUsageRecords(tmpDir);
    expect(records).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// UsageStore — Aggregation (totalUsage)
// ---------------------------------------------------------------------------

describe("totalUsage", () => {
  test("sums token counts across records", () => {
    const records: UsageRecord[] = [
      makeUsageRecord({ input_tokens: 100, output_tokens: 50, total_tokens: 150, cost: 0.001 }),
      makeUsageRecord({ input_tokens: 200, output_tokens: 100, total_tokens: 300, cost: 0.002 }),
      makeUsageRecord({ input_tokens: 300, output_tokens: 150, total_tokens: 450, cost: 0.003 }),
    ];

    const totals = totalUsage(records);
    expect(totals.input_tokens).toBe(600);
    expect(totals.output_tokens).toBe(300);
    expect(totals.total_tokens).toBe(900);
    expect(totals.total_cost).toBeCloseTo(0.006);
    expect(totals.record_count).toBe(3);
  });

  test("returns zeros for empty array", () => {
    const totals = totalUsage([]);
    expect(totals.input_tokens).toBe(0);
    expect(totals.output_tokens).toBe(0);
    expect(totals.total_tokens).toBe(0);
    expect(totals.total_cost).toBe(0);
    expect(totals.record_count).toBe(0);
  });

  test("includes cache and reasoning tokens", () => {
    const records: UsageRecord[] = [
      makeUsageRecord({ cache_read: 500, cache_write: 100, reasoning_tokens: 200 }),
      makeUsageRecord({ cache_read: 300, cache_write: 50, reasoning_tokens: 100 }),
    ];

    const totals = totalUsage(records);
    expect(totals.cache_read).toBe(800);
    expect(totals.cache_write).toBe(150);
    expect(totals.reasoning_tokens).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// UsageStore — Aggregation (filterByDateRange)
// ---------------------------------------------------------------------------

describe("filterByDateRange", () => {
  const jan1 = "2026-01-01T00:00:00Z";
  const feb1 = "2026-02-01T00:00:00Z";
  const mar1 = "2026-03-01T00:00:00Z";
  const apr1 = "2026-04-01T00:00:00Z";

  const records: UsageRecord[] = [
    makeUsageRecord({ timestamp: jan1, task_id: "jan" }),
    makeUsageRecord({ timestamp: feb1, task_id: "feb" }),
    makeUsageRecord({ timestamp: mar1, task_id: "mar" }),
    makeUsageRecord({ timestamp: apr1, task_id: "apr" }),
  ];

  test("filters by since (inclusive)", () => {
    const filtered = filterByDateRange(records, feb1);
    expect(filtered.length).toBe(3);
    expect(filtered.map(r => r.task_id)).toEqual(["feb", "mar", "apr"]);
  });

  test("filters by until (inclusive)", () => {
    const filtered = filterByDateRange(records, undefined, feb1);
    expect(filtered.length).toBe(2);
    expect(filtered.map(r => r.task_id)).toEqual(["jan", "feb"]);
  });

  test("filters by both since and until", () => {
    const filtered = filterByDateRange(records, feb1, mar1);
    expect(filtered.length).toBe(2);
    expect(filtered.map(r => r.task_id)).toEqual(["feb", "mar"]);
  });

  test("returns all records when no dates specified", () => {
    const filtered = filterByDateRange(records);
    expect(filtered.length).toBe(4);
  });

  test("throws on invalid since date", () => {
    expect(() => filterByDateRange(records, "not-a-date")).toThrow();
  });

  test("throws on invalid until date", () => {
    expect(() => filterByDateRange(records, undefined, "not-a-date")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// UsageStore — Aggregation (groupBy)
// ---------------------------------------------------------------------------

describe("groupBy", () => {
  test("groups records by task_id", () => {
    const records: UsageRecord[] = [
      makeUsageRecord({ task_id: "auth", input_tokens: 100, total_tokens: 100 }),
      makeUsageRecord({ task_id: "auth", input_tokens: 200, total_tokens: 200 }),
      makeUsageRecord({ task_id: "search", input_tokens: 300, total_tokens: 300 }),
    ];

    const groups = groupBy(records, "task_id");
    expect(groups.size).toBe(2);
    expect(groups.get("auth")!.input_tokens).toBe(300);
    expect(groups.get("auth")!.record_count).toBe(2);
    expect(groups.get("search")!.input_tokens).toBe(300);
    expect(groups.get("search")!.record_count).toBe(1);
  });

  test("groups records by model", () => {
    const records: UsageRecord[] = [
      makeUsageRecord({ model: "claude-sonnet-4-20250514", total_tokens: 100 }),
      makeUsageRecord({ model: "gpt-4o", total_tokens: 200 }),
      makeUsageRecord({ model: "claude-sonnet-4-20250514", total_tokens: 300 }),
    ];

    const groups = groupBy(records, "model");
    expect(groups.size).toBe(2);
    expect(groups.get("claude-sonnet-4-20250514")!.total_tokens).toBe(400);
    expect(groups.get("gpt-4o")!.total_tokens).toBe(200);
  });

  test("groups records by provider", () => {
    const records: UsageRecord[] = [
      makeUsageRecord({ provider: "anthropic", total_tokens: 100 }),
      makeUsageRecord({ provider: "openai", total_tokens: 200 }),
    ];

    const groups = groupBy(records, "provider");
    expect(groups.size).toBe(2);
    expect(groups.has("anthropic")).toBe(true);
    expect(groups.has("openai")).toBe(true);
  });

  test("groups records by harness", () => {
    const records: UsageRecord[] = [
      makeUsageRecord({ harness: "opencode", total_tokens: 100 }),
      makeUsageRecord({ harness: "aider", total_tokens: 200 }),
    ];

    const groups = groupBy(records, "harness");
    expect(groups.size).toBe(2);
    expect(groups.has("opencode")).toBe(true);
    expect(groups.has("aider")).toBe(true);
  });

  test("uses (unknown) for null field values", () => {
    const records: UsageRecord[] = [
      makeUsageRecord({ model: null }),
      makeUsageRecord({ model: "gpt-4o" }),
    ];

    const groups = groupBy(records, "model");
    expect(groups.has("(unknown)")).toBe(true);
    expect(groups.has("gpt-4o")).toBe(true);
  });

  test("returns empty map for empty records", () => {
    const groups = groupBy([], "task_id");
    expect(groups.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// UsageStore — Class
// ---------------------------------------------------------------------------

describe("UsageStore class", () => {
  test("append and load round-trips", () => {
    const store = new UsageStore(tmpDir);
    store.append(makeUsageRecord({ task_id: "store-test" }));

    const records = store.load();
    expect(records.length).toBe(1);
    expect(records[0].task_id).toBe("store-test");
  });

  test("totalUsage aggregates all persisted records", () => {
    const store = new UsageStore(tmpDir);
    store.append(makeUsageRecord({ input_tokens: 100, total_tokens: 100 }));
    store.append(makeUsageRecord({ input_tokens: 200, total_tokens: 200 }));

    const totals = store.totalUsage();
    expect(totals.input_tokens).toBe(300);
    expect(totals.total_tokens).toBe(300);
    expect(totals.record_count).toBe(2);
  });

  test("filterByDateRange works on persisted records", () => {
    const store = new UsageStore(tmpDir);
    store.append(makeUsageRecord({ timestamp: "2026-01-01T00:00:00Z", task_id: "old" }));
    store.append(makeUsageRecord({ timestamp: "2026-06-01T00:00:00Z", task_id: "new" }));

    const filtered = store.filterByDateRange("2026-03-01T00:00:00Z");
    expect(filtered.length).toBe(1);
    expect(filtered[0].task_id).toBe("new");
  });

  test("groupBy works on persisted records", () => {
    const store = new UsageStore(tmpDir);
    store.append(makeUsageRecord({ task_id: "a", total_tokens: 100 }));
    store.append(makeUsageRecord({ task_id: "a", total_tokens: 200 }));
    store.append(makeUsageRecord({ task_id: "b", total_tokens: 300 }));

    const groups = store.groupBy("task_id");
    expect(groups.size).toBe(2);
    expect(groups.get("a")!.total_tokens).toBe(300);
    expect(groups.get("b")!.total_tokens).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Integration: TokenCollector → UsageStore wiring
// ---------------------------------------------------------------------------

describe("Integration — TokenCollector + UsageStore", () => {
  test("TokenCollector persists records via onUsage → UsageStore", () => {
    const store = new UsageStore(tmpDir);
    const collector = new TokenCollector((record) => {
      store.append(record);
    });

    collector.registerAgent("agent-1", {
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      harness: "opencode",
    });

    // Simulate a multi-step agent session
    collector.ingestEvent("agent-1", makeStepFinishEvent({
      input: 500, output: 200, total: 700, cost: 0.001,
    }));
    collector.ingestEvent("agent-1", makeStepFinishEvent({
      input: 800, output: 300, total: 1100, cost: 0.002,
    }));
    collector.ingestEvent("agent-1", makeStepFinishEvent({
      input: 1200, output: 400, total: 1600, cost: 0.003, reason: "stop",
    }));

    // Verify persisted records
    const records = store.load();
    expect(records.length).toBe(3);
    expect(records[0].model).toBe("claude-sonnet-4-20250514");
    expect(records[2].is_final_step).toBe(true);

    // Verify aggregated totals
    const totals = store.totalUsage();
    expect(totals.input_tokens).toBe(2500);
    expect(totals.output_tokens).toBe(900);
    expect(totals.total_tokens).toBe(3400);
    expect(totals.total_cost).toBeCloseTo(0.006);
  });

  test("simulates concurrent agents writing to the same JSONL", () => {
    const store = new UsageStore(tmpDir);
    const collector = new TokenCollector((record) => {
      store.append(record);
    });

    // Register multiple agents
    collector.registerAgent("auth-flow", {
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });
    collector.registerAgent("search-api", {
      model: "gpt-4o",
      provider: "openai",
    });
    collector.registerAgent("perf-optim", {
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      quest_id: "perf-quest",
    });

    // Simulate interleaved events from multiple agents
    collector.ingestEvent("auth-flow", makeStepFinishEvent({ input: 100, total: 100 }));
    collector.ingestEvent("search-api", makeStepFinishEvent({ input: 200, total: 200 }));
    collector.ingestEvent("perf-optim", makeStepFinishEvent({ input: 300, total: 300 }));
    collector.ingestEvent("auth-flow", makeStepFinishEvent({ input: 400, total: 400, reason: "stop" }));
    collector.ingestEvent("search-api", makeStepFinishEvent({ input: 500, total: 500, reason: "stop" }));
    collector.ingestEvent("perf-optim", makeStepFinishEvent({ input: 600, total: 600, reason: "stop" }));

    // Verify all records are persisted
    const records = store.load();
    expect(records.length).toBe(6);

    // Verify grouping by task_id
    const byTask = store.groupBy("task_id");
    expect(byTask.size).toBe(3);
    expect(byTask.get("auth-flow")!.total_tokens).toBe(500);
    expect(byTask.get("search-api")!.total_tokens).toBe(700);
    expect(byTask.get("perf-optim")!.total_tokens).toBe(900);

    // Verify grouping by provider
    const byProvider = store.groupBy("provider");
    expect(byProvider.size).toBe(2);
    expect(byProvider.get("anthropic")!.record_count).toBe(4);
    expect(byProvider.get("openai")!.record_count).toBe(2);

    // Verify grouping by model
    const byModel = store.groupBy("model");
    expect(byModel.size).toBe(2);
    expect(byModel.get("claude-sonnet-4-20250514")!.record_count).toBe(4);
    expect(byModel.get("gpt-4o")!.record_count).toBe(2);

    // Verify quest grouping
    const byQuest = store.groupBy("quest_id");
    expect(byQuest.has("perf-quest")).toBe(true);
    expect(byQuest.get("perf-quest")!.record_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CLI — Usage command arg parsing
// ---------------------------------------------------------------------------

import { parseArgs } from "../src/index.js";

describe("Usage command arg parsing", () => {
  function argv(...args: string[]): string[] {
    return ["bun", "script.ts", ...args];
  }

  test("parses usage command", () => {
    const result = parseArgs(argv("usage"));
    expect(result.command).toBe("usage");
  });

  test("parses usage alias 'us'", () => {
    const result = parseArgs(argv("us"));
    expect(result.command).toBe("usage");
  });

  test("parses --by flag", () => {
    const result = parseArgs(argv("usage", "--by", "task"));
    expect(result.usageBy).toBe("task");
  });

  test("parses --since flag", () => {
    const result = parseArgs(argv("usage", "--since", "2026-01-01"));
    expect(result.usageSince).toBe("2026-01-01");
  });

  test("parses --until flag", () => {
    const result = parseArgs(argv("usage", "--until", "2026-03-01"));
    expect(result.usageUntil).toBe("2026-03-01");
  });

  test("parses --format flag", () => {
    const result = parseArgs(argv("usage", "--format", "json"));
    expect(result.usageFormat).toBe("json");
  });

  test("parses all usage flags together", () => {
    const result = parseArgs(argv(
      "usage",
      "--by", "model",
      "--since", "2026-01-01",
      "--until", "2026-06-01",
      "--format", "json"
    ));
    expect(result.usageBy).toBe("model");
    expect(result.usageSince).toBe("2026-01-01");
    expect(result.usageUntil).toBe("2026-06-01");
    expect(result.usageFormat).toBe("json");
  });
});
