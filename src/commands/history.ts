/**
 * history.ts — View wave history and summaries.
 *
 * Usage:
 *   woco history                    List all past waves
 *   woco history <wave-id>          Show details of a specific wave
 *   woco history --output json      Output as JSON
 *
 * Wave history is stored in .wombo-combo/history/<wave-id>.json and survives
 * `woco cleanup`. Records are auto-exported when a wave completes.
 */

import type { WomboConfig } from "../config.js";
import {
  listHistory,
  loadHistory,
  type WaveHistoryRecord,
} from "../lib/history.js";
import { output, outputError, type OutputFormat } from "../lib/output.js";
import { renderHistoryList, renderHistoryDetail } from "../lib/toon.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HistoryCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  /** Specific wave ID to show details for */
  waveId?: string;
  /** Output format */
  outputFmt: OutputFormat;
}

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const FG = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return " ".repeat(width - text.length) + text;
}

function formatDurationMs(ms: number | null): string {
  if (ms === null || ms === 0) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "merged":
      return FG.magenta;
    case "verified":
      return FG.green;
    case "failed":
      return FG.red;
    case "completed":
      return FG.yellow;
    default:
      return FG.gray;
  }
}

// ---------------------------------------------------------------------------
// List All Waves
// ---------------------------------------------------------------------------

function renderWaveList(records: WaveHistoryRecord[]): void {
  if (records.length === 0) {
    console.log("\nNo wave history found.");
    console.log("History is auto-exported when a wave completes.\n");
    return;
  }

  console.log("");
  console.log(`${BOLD}Wave History (${records.length} wave(s)):${RESET}`);
  console.log("");

  const header = [
    pad("Wave ID", 24),
    pad("Date", 22),
    padLeft("Total", 6),
    padLeft("OK", 4),
    padLeft("Fail", 5),
    padLeft("Merged", 7),
    padLeft("Retries", 8),
    padLeft("Duration", 10),
  ].join(" ");

  console.log(`${BOLD}${header}${RESET}`);
  console.log("-".repeat(90));

  for (const rec of records) {
    const s = rec.summary;
    const okColor = s.succeeded === s.total ? FG.green : FG.yellow;
    const failColor = s.failed > 0 ? FG.red : FG.gray;

    const row = [
      pad(rec.wave_id, 24),
      pad(formatDate(rec.started_at), 22),
      padLeft(String(s.total), 6),
      `${okColor}${padLeft(String(s.succeeded), 4)}${RESET}`,
      `${failColor}${padLeft(String(s.failed), 5)}${RESET}`,
      padLeft(String(s.merged), 7),
      padLeft(String(s.total_retries), 8),
      padLeft(formatDurationMs(s.total_duration_ms), 10),
    ].join(" ");

    console.log(row);
  }

  console.log("");
  console.log(`${DIM}Use 'woco history <wave-id>' for details.${RESET}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Show Single Wave Details
// ---------------------------------------------------------------------------

function renderWaveDetails(rec: WaveHistoryRecord): void {
  console.log("");
  console.log(`${BOLD}Wave: ${rec.wave_id}${RESET}`);
  console.log(`${DIM}Base: ${rec.base_branch} | Concurrency: ${rec.max_concurrent} | Mode: ${rec.interactive ? "interactive" : "headless"}${RESET}`);
  if (rec.model) {
    console.log(`${DIM}Model: ${rec.model}${RESET}`);
  }
  console.log(`${DIM}Started: ${formatDate(rec.started_at)} | Exported: ${formatDate(rec.exported_at)}${RESET}`);
  console.log("");

  // Summary
  const s = rec.summary;
  console.log(`${BOLD}Summary:${RESET}`);
  console.log(`  Total agents:    ${s.total}`);
  console.log(`  Succeeded:       ${FG.green}${s.succeeded}${RESET}`);
  console.log(`  Failed:          ${s.failed > 0 ? FG.red : FG.gray}${s.failed}${RESET}`);
  console.log(`  Merged:          ${FG.magenta}${s.merged}${RESET}`);
  console.log(`  Verified:        ${FG.green}${s.verified}${RESET}`);
  console.log(`  Total retries:   ${s.total_retries}`);
  console.log(`  Total duration:  ${formatDurationMs(s.total_duration_ms)}`);
  console.log("");

  // Agent table
  console.log(`${BOLD}Agents:${RESET}`);
  console.log("");

  const header = [
    pad("Feature", 30),
    pad("Status", 12),
    padLeft("Retries", 8),
    padLeft("Duration", 10),
    pad("Build", 6),
    pad("Conflict", 9),
    pad("Error", 30),
  ].join(" ");

  console.log(`${BOLD}${header}${RESET}`);
  console.log("-".repeat(109));

  for (const agent of rec.agents) {
    const color = statusColor(agent.status);
    const buildStr = agent.build_passed === true
      ? `${FG.green}pass${RESET}`
      : agent.build_passed === false
        ? `${FG.red}fail${RESET}`
        : `${FG.gray}-${RESET}`;
    const conflictStr = agent.had_merge_conflict
      ? `${FG.yellow}yes${RESET}`
      : `${FG.gray}no${RESET}`;
    const errorStr = agent.error
      ? agent.error.split("\n")[0].slice(0, 28)
      : "-";

    const row = [
      pad(agent.feature_id, 30),
      `${color}${pad(agent.status, 12)}${RESET}`,
      padLeft(
        agent.retries > 0 ? `${agent.retries}/${agent.max_retries}` : "-",
        8
      ),
      padLeft(formatDurationMs(agent.duration_ms), 10),
      pad(buildStr, 6),
      pad(conflictStr, 9),
      pad(errorStr, 30),
    ].join(" ");

    console.log(row);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdHistory(opts: HistoryCommandOptions): Promise<void> {
  const { projectRoot, outputFmt } = opts;

  if (opts.waveId) {
    // Show details for a specific wave
    const record = loadHistory(projectRoot, opts.waveId);
    if (!record) {
      outputError(
        outputFmt,
        `Wave history not found: ${opts.waveId}. Use 'woco history' to list available waves.`
      );
      return; // unreachable — helps TypeScript narrow
    }

    output(outputFmt, record, () => {
      renderWaveDetails(record);
    }, () => {
      // TOON renderer
      console.log(renderHistoryDetail(record));
    });
  } else {
    // List all waves
    const records = listHistory(projectRoot);

    output(outputFmt, records, () => {
      renderWaveList(records);
    }, () => {
      // TOON renderer
      console.log(renderHistoryList(records));
    });
  }
}
