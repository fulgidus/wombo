/**
 * token-usage.ts — Persist and aggregate token usage data.
 *
 * Responsibilities:
 *   - Append UsageRecords to .wombo-combo/usage.jsonl (one JSON object per line)
 *   - Load all records from the JSONL file
 *   - Aggregate: groupBy(field), filterByDateRange(since, until), totalUsage()
 *   - Create a UsageStore that wires into TokenCollector's onUsage callback
 *
 * The JSONL format is append-only and human-readable. Each line is a complete
 * JSON object representing one UsageRecord (one step_finish event). This makes
 * it safe for concurrent writes (append is atomic on most filesystems for
 * small writes) and easy to process with standard unix tools (grep, jq, etc.).
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { WOMBO_DIR } from "../config.js";
import type { UsageRecord } from "./token-collector.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the usage JSONL file relative to project root */
const USAGE_FILE = `${WOMBO_DIR}/usage.jsonl`;

// ---------------------------------------------------------------------------
// Persistence — Append
// ---------------------------------------------------------------------------

/**
 * Append a single UsageRecord to the usage.jsonl file.
 *
 * Creates the .wombo-combo/ directory and the file if they don't exist.
 * Each record is written as a single JSON line terminated by a newline.
 *
 * @param projectRoot  The project root directory
 * @param record       The UsageRecord to persist
 */
export function appendUsageRecord(
  projectRoot: string,
  record: UsageRecord
): void {
  const filePath = resolve(projectRoot, USAGE_FILE);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify(record) + "\n";
  appendFileSync(filePath, line, "utf-8");
}

// ---------------------------------------------------------------------------
// Persistence — Load
// ---------------------------------------------------------------------------

/**
 * Load all UsageRecords from the usage.jsonl file.
 *
 * Skips malformed lines silently (defensive against partial writes or
 * corruption). Returns an empty array if the file doesn't exist.
 *
 * @param projectRoot  The project root directory
 * @returns Array of UsageRecords in chronological order
 */
export function loadUsageRecords(projectRoot: string): UsageRecord[] {
  const filePath = resolve(projectRoot, USAGE_FILE);

  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, "utf-8");
  const records: UsageRecord[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const record = JSON.parse(trimmed) as UsageRecord;
      // Basic validation: must have task_id and timestamp
      if (record.task_id && record.timestamp) {
        records.push(record);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Aggregation — Total Usage
// ---------------------------------------------------------------------------

/** Aggregated totals across a set of usage records */
export interface UsageTotals {
  /** Total input tokens */
  input_tokens: number;
  /** Total output tokens */
  output_tokens: number;
  /** Total cache read tokens */
  cache_read: number;
  /** Total cache write tokens */
  cache_write: number;
  /** Total reasoning tokens */
  reasoning_tokens: number;
  /** Grand total tokens */
  total_tokens: number;
  /** Total cost */
  total_cost: number;
  /** Number of records (steps) */
  record_count: number;
}

/**
 * Compute total usage across a set of records.
 *
 * @param records  The records to sum
 * @returns Aggregated totals
 */
export function totalUsage(records: UsageRecord[]): UsageTotals {
  return {
    input_tokens: records.reduce((sum, r) => sum + r.input_tokens, 0),
    output_tokens: records.reduce((sum, r) => sum + r.output_tokens, 0),
    cache_read: records.reduce((sum, r) => sum + r.cache_read, 0),
    cache_write: records.reduce((sum, r) => sum + r.cache_write, 0),
    reasoning_tokens: records.reduce((sum, r) => sum + r.reasoning_tokens, 0),
    total_tokens: records.reduce((sum, r) => sum + r.total_tokens, 0),
    total_cost: records.reduce((sum, r) => sum + r.cost, 0),
    record_count: records.length,
  };
}

// ---------------------------------------------------------------------------
// Aggregation — Filter by Date Range
// ---------------------------------------------------------------------------

/**
 * Filter records to those within a date range.
 *
 * Both `since` and `until` are inclusive. If either is omitted, that side
 * of the range is unbounded.
 *
 * @param records  The records to filter
 * @param since    Start of range (ISO 8601 string or Date). Inclusive.
 * @param until    End of range (ISO 8601 string or Date). Inclusive.
 * @returns Filtered records
 */
export function filterByDateRange(
  records: UsageRecord[],
  since?: string | Date,
  until?: string | Date
): UsageRecord[] {
  const sinceMs = since ? new Date(since).getTime() : -Infinity;
  const untilMs = until ? new Date(until).getTime() : Infinity;

  if (isNaN(sinceMs) && since) {
    throw new Error(`Invalid 'since' date: ${since}`);
  }
  if (isNaN(untilMs) && until) {
    throw new Error(`Invalid 'until' date: ${until}`);
  }

  return records.filter((r) => {
    const ts = new Date(r.timestamp).getTime();
    if (isNaN(ts)) return false;
    return ts >= sinceMs && ts <= untilMs;
  });
}

// ---------------------------------------------------------------------------
// Aggregation — Group By
// ---------------------------------------------------------------------------

/** Fields that can be used as groupBy keys */
export type GroupableField =
  | "task_id"
  | "quest_id"
  | "model"
  | "provider"
  | "harness";

/**
 * Group records by a specified field and compute totals for each group.
 *
 * The grouping key is the string value of the specified field. Null values
 * are grouped under the key "(unknown)".
 *
 * @param records  The records to group
 * @param field    The field to group by
 * @returns Map from group key to aggregated totals
 */
export function groupBy(
  records: UsageRecord[],
  field: GroupableField
): Map<string, UsageTotals> {
  const groups = new Map<string, UsageRecord[]>();

  for (const record of records) {
    const key = String(record[field] ?? "(unknown)");
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(record);
  }

  const result = new Map<string, UsageTotals>();
  for (const [key, groupRecords] of groups) {
    result.set(key, totalUsage(groupRecords));
  }

  return result;
}

// ---------------------------------------------------------------------------
// UsageStore — High-level persistence wrapper
// ---------------------------------------------------------------------------

/**
 * UsageStore provides a high-level interface for persisting token usage data.
 *
 * It is designed to be used as the onUsage callback for TokenCollector, so that
 * every parsed UsageRecord is immediately persisted to the JSONL file.
 *
 * Usage:
 *   const store = new UsageStore(projectRoot);
 *
 *   // Wire into TokenCollector
 *   const collector = new TokenCollector((record) => {
 *     store.append(record);
 *   });
 *
 *   // Or wire into ProcessMonitor callbacks
 *   const monitor = new ProcessMonitor(projectRoot, {
 *     onUsage: (_featureId, record) => store.append(record),
 *   });
 *
 *   // Query historical data
 *   const allRecords = store.load();
 *   const totals = store.totalUsage();
 *   const byModel = store.groupBy("model");
 *   const lastWeek = store.filterByDateRange(weekAgo, now);
 */
export class UsageStore {
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Append a single UsageRecord to the JSONL file.
   * This is the primary write method — designed to be called from
   * TokenCollector's onUsage callback.
   */
  append(record: UsageRecord): void {
    appendUsageRecord(this.projectRoot, record);
  }

  /**
   * Load all usage records from the JSONL file.
   */
  load(): UsageRecord[] {
    return loadUsageRecords(this.projectRoot);
  }

  /**
   * Compute total usage across all persisted records.
   */
  totalUsage(): UsageTotals {
    return totalUsage(this.load());
  }

  /**
   * Filter persisted records by date range and return totals.
   */
  filterByDateRange(
    since?: string | Date,
    until?: string | Date
  ): UsageRecord[] {
    return filterByDateRange(this.load(), since, until);
  }

  /**
   * Group persisted records by a field and compute per-group totals.
   */
  groupBy(field: GroupableField): Map<string, UsageTotals> {
    return groupBy(this.load(), field);
  }
}
