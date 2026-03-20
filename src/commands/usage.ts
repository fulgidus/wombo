/**
 * usage.ts — Show token usage statistics.
 *
 * Usage:
 *   woco usage                                          Show total usage
 *   woco usage --by task                                Group by task
 *   woco usage --by model                               Group by model
 *   woco usage --by provider                            Group by provider
 *   woco usage --by quest                               Group by quest
 *   woco usage --by harness                             Group by harness
 *   woco usage --since 2026-01-01                       Filter by start date
 *   woco usage --until 2026-03-01                       Filter by end date
 *   woco usage --format json                            Output as JSON
 *   woco usage --format table                           Output as aligned table (default)
 *
 * Reads from .wombo-combo/usage.jsonl and aggregates token counts.
 */

import type { WomboConfig } from "../config";
import {
  loadUsageRecords,
  filterByDateRange,
  groupBy,
  totalUsage,
  type UsageTotals,
  type GroupableField,
} from "../lib/token-usage";
import { output, outputError, type OutputFormat } from "../lib/output";
import {
  writeExport,
  type ExportFormat,
} from "../lib/analytics-export";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** CLI-facing grouping key names (mapped to internal GroupableField) */
export type UsageGroupBy = "task" | "quest" | "model" | "provider" | "harness";

/** Valid --by values for validation */
export const VALID_USAGE_GROUP_BY: readonly string[] = [
  "task",
  "quest",
  "model",
  "provider",
  "harness",
];

/** Valid --export format values */
export const VALID_EXPORT_FORMATS: readonly string[] = ["csv", "json", "html"];

export interface UsageCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  /** Grouping key (default: total — no grouping) */
  by?: UsageGroupBy;
  /** Start of date range filter (ISO 8601) */
  since?: string;
  /** End of date range filter (ISO 8601) */
  until?: string;
  /** Output format: table or json (maps from the CLI's --format flag) */
  usageFormat: "table" | "json";
  /** Global output format (--output text|json|toon) */
  outputFmt: OutputFormat;
  /** Export format: csv, json, or html (omit to skip export) */
  export?: ExportFormat;
  /** File path for the export output (required when --export is set) */
  exportFile?: string;
}

// ---------------------------------------------------------------------------
// Helpers — CLI group name → internal GroupableField
// ---------------------------------------------------------------------------

function toGroupableField(by: UsageGroupBy): GroupableField {
  switch (by) {
    case "task":
      return "task_id";
    case "quest":
      return "quest_id";
    case "model":
      return "model";
    case "provider":
      return "provider";
    case "harness":
      return "harness";
  }
}

// ---------------------------------------------------------------------------
// Formatting — Table Output
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const FG = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCost(cost: number): string {
  if (cost === 0) return "-";
  return `$${cost.toFixed(4)}`;
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return " ".repeat(width - text.length) + text;
}

/**
 * Render total usage as a summary block.
 */
function renderTotalUsage(totals: UsageTotals): void {
  console.log("");
  console.log(`${BOLD}Token Usage — Total${RESET}`);
  console.log("");
  console.log(`  Input tokens:     ${FG.cyan}${formatNumber(totals.input_tokens)}${RESET}`);
  console.log(`  Output tokens:    ${FG.green}${formatNumber(totals.output_tokens)}${RESET}`);
  console.log(`  Cache read:       ${FG.gray}${formatNumber(totals.cache_read)}${RESET}`);
  console.log(`  Cache write:      ${FG.gray}${formatNumber(totals.cache_write)}${RESET}`);
  console.log(`  Reasoning:        ${FG.yellow}${formatNumber(totals.reasoning_tokens)}${RESET}`);
  console.log(`  ${BOLD}Total tokens:     ${formatNumber(totals.total_tokens)}${RESET}`);
  console.log(`  Total cost:       ${formatCost(totals.total_cost)}`);
  console.log(`  Steps recorded:   ${totals.record_count}`);
  console.log("");
}

/**
 * Render grouped usage as an aligned table.
 */
function renderGroupedTable(
  groups: Map<string, UsageTotals>,
  groupLabel: string
): void {
  if (groups.size === 0) {
    console.log("\nNo usage data found.\n");
    return;
  }

  console.log("");
  console.log(`${BOLD}Token Usage — by ${groupLabel}${RESET}`);
  console.log("");

  // Build column widths
  const keyWidth = Math.max(
    groupLabel.length,
    ...Array.from(groups.keys()).map((k) => k.length),
    8
  );

  const header = [
    pad(groupLabel.charAt(0).toUpperCase() + groupLabel.slice(1), keyWidth),
    padLeft("Input", 12),
    padLeft("Output", 12),
    padLeft("Cache Read", 12),
    padLeft("Cache Write", 12),
    padLeft("Total", 14),
    padLeft("Cost", 10),
  ].join("  ");

  console.log(`${BOLD}${header}${RESET}`);
  console.log("-".repeat(header.length));

  // Sort by total tokens descending for readability
  const sorted = Array.from(groups.entries()).sort(
    (a, b) => b[1].total_tokens - a[1].total_tokens
  );

  for (const [key, totals] of sorted) {
    const row = [
      pad(key, keyWidth),
      padLeft(formatNumber(totals.input_tokens), 12),
      padLeft(formatNumber(totals.output_tokens), 12),
      padLeft(formatNumber(totals.cache_read), 12),
      padLeft(formatNumber(totals.cache_write), 12),
      padLeft(formatNumber(totals.total_tokens), 14),
      padLeft(formatCost(totals.total_cost), 10),
    ].join("  ");

    console.log(row);
  }

  // Grand total row
  const grandTotal: UsageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    total_cost: 0,
    record_count: 0,
  };
  for (const totals of groups.values()) {
    grandTotal.input_tokens += totals.input_tokens;
    grandTotal.output_tokens += totals.output_tokens;
    grandTotal.cache_read += totals.cache_read;
    grandTotal.cache_write += totals.cache_write;
    grandTotal.total_tokens += totals.total_tokens;
    grandTotal.total_cost += totals.total_cost;
    grandTotal.record_count += totals.record_count;
  }

  console.log("-".repeat(header.length));
  const totalRow = [
    pad(`${BOLD}TOTAL${RESET}`, keyWidth + BOLD.length + RESET.length),
    padLeft(formatNumber(grandTotal.input_tokens), 12),
    padLeft(formatNumber(grandTotal.output_tokens), 12),
    padLeft(formatNumber(grandTotal.cache_read), 12),
    padLeft(formatNumber(grandTotal.cache_write), 12),
    padLeft(formatNumber(grandTotal.total_tokens), 14),
    padLeft(formatCost(grandTotal.total_cost), 10),
  ].join("  ");
  console.log(totalRow);

  console.log("");
}

// ---------------------------------------------------------------------------
// JSON Output Helpers
// ---------------------------------------------------------------------------

function totalsToJSON(totals: UsageTotals): Record<string, unknown> {
  return {
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cache_read: totals.cache_read,
    cache_write: totals.cache_write,
    reasoning_tokens: totals.reasoning_tokens,
    total_tokens: totals.total_tokens,
    total_cost: totals.total_cost,
    record_count: totals.record_count,
  };
}

function groupedToJSON(
  groups: Map<string, UsageTotals>,
  groupLabel: string
): Record<string, unknown> {
  const entries: Record<string, unknown>[] = [];
  for (const [key, totals] of groups) {
    entries.push({
      [groupLabel]: key,
      ...totalsToJSON(totals),
    });
  }
  return { by: groupLabel, groups: entries };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdUsage(opts: UsageCommandOptions): Promise<void> {
  const { projectRoot, outputFmt, usageFormat } = opts;

  // Load all records
  let records = loadUsageRecords(projectRoot);

  // Apply date range filter
  if (opts.since || opts.until) {
    try {
      records = filterByDateRange(records, opts.since, opts.until);
    } catch (err: any) {
      outputError(outputFmt, err.message);
      return; // unreachable
    }
  }

  // Handle --export flag: write export file regardless of whether records exist
  if (opts.export) {
    const exportFmt = opts.export;
    const exportFile = opts.exportFile ?? `usage-export.${exportFmt}`;
    await writeExport(records, exportFmt, exportFile);
    if (outputFmt !== "json") {
      console.log(`\nExported ${records.length} records to: ${exportFile}\n`);
    } else {
      console.log(JSON.stringify({ exported: true, format: exportFmt, file: exportFile, record_count: records.length }));
    }
    // If there are no records, we can still return after export (skip table rendering)
    if (records.length === 0) return;
  }

  if (records.length === 0) {
    if (usageFormat === "json" || outputFmt === "json") {
      console.log(JSON.stringify({ message: "No usage data found.", groups: [] }));
    } else {
      console.log("\nNo usage data found.");
      console.log("Usage data is recorded when agents run via 'woco launch'.\n");
    }
    return;
  }

  // Grouped or total?
  if (opts.by) {
    const byLabel = opts.by;
    const field = toGroupableField(byLabel);
    const groups = groupBy(records, field);
    const jsonData = groupedToJSON(groups, byLabel);

    if (usageFormat === "json" || outputFmt === "json") {
      // JSON output
      output(outputFmt, jsonData, () => {
        console.log(JSON.stringify(jsonData, null, 2));
      });
    } else {
      // Table output
      output(outputFmt, jsonData, () => {
        renderGroupedTable(groups, byLabel);
      });
    }
  } else {
    // Total (no grouping)
    const totals = totalUsage(records);

    if (usageFormat === "json" || outputFmt === "json") {
      output(outputFmt, totalsToJSON(totals), () => {
        console.log(JSON.stringify(totalsToJSON(totals), null, 2));
      });
    } else {
      output(outputFmt, totalsToJSON(totals), () => {
        renderTotalUsage(totals);
      });
    }
  }
}
