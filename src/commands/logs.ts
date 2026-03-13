/**
 * logs.ts — Pretty-print agent logs from .wombo-combo/logs/<feature-id>.log.
 *
 * Usage:
 *   woco logs <feature-id>
 *   woco logs <feature-id> --tail 50
 *   woco logs <feature-id> --follow
 *   woco logs <feature-id> --output json
 *
 * Reads the log file written by ProcessMonitor during headless agent runs
 * and displays it with timestamps and activity annotations. Supports
 * --tail N to show last N lines and --follow to stream new output.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { output, outputError, type OutputFormat } from "../lib/output.js";
import { renderLogs } from "../lib/toon.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_DIR_NAME = ".wombo-combo/logs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogsCommandOptions {
  projectRoot: string;
  featureId: string;
  /** Show only the last N lines */
  tail?: number;
  /** Stream new output as it arrives (like tail -f) */
  follow?: boolean;
  /** Output format */
  outputFmt: OutputFormat;
}

interface LogLine {
  lineNumber: number;
  content: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read all lines from a log file, optionally returning only the last N.
 */
function readLogLines(logPath: string, tail?: number): LogLine[] {
  const raw = readFileSync(logPath, "utf-8");
  const allLines = raw.split("\n");

  // Remove trailing empty line from split (if file ends with \n)
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  let lines: LogLine[] = allLines.map((content, idx) => ({
    lineNumber: idx + 1,
    content,
  }));

  if (tail !== undefined && tail > 0 && lines.length > tail) {
    lines = lines.slice(-tail);
  }

  return lines;
}

/**
 * Colorize a log line for terminal output.
 * Detects common patterns: timestamps, errors, warnings, tool calls, etc.
 */
function colorize(line: string): string {
  // Error lines
  if (/\b(error|fatal|fail(ed)?|exception)\b/i.test(line)) {
    return `\x1b[31m${line}\x1b[0m`;
  }
  // Warning lines
  if (/\b(warn(ing)?|deprecated)\b/i.test(line)) {
    return `\x1b[33m${line}\x1b[0m`;
  }
  // Success / done lines
  if (/\b(success|done|passed|completed|merged)\b/i.test(line)) {
    return `\x1b[32m${line}\x1b[0m`;
  }
  // Activity annotations from ProcessMonitor (timestamps like HH:MM:SS)
  if (/^\d{2}:\d{2}:\d{2}\s/.test(line)) {
    const tsEnd = 8;
    return `\x1b[36m${line.slice(0, tsEnd)}\x1b[0m${line.slice(tsEnd)}`;
  }
  return line;
}

/**
 * Render log lines in text mode with pretty-printing.
 */
function renderText(lines: LogLine[], featureId: string, logPath: string): void {
  if (lines.length === 0) {
    console.log(`\x1b[33mLog file is empty: ${logPath}\x1b[0m`);
    return;
  }

  console.log(`\x1b[1m--- Logs for ${featureId} ---\x1b[0m`);
  console.log(`\x1b[2mFile: ${logPath}\x1b[0m`);
  console.log(`\x1b[2mLines: ${lines[0].lineNumber}–${lines[lines.length - 1].lineNumber}\x1b[0m`);
  console.log();

  for (const line of lines) {
    console.log(colorize(line.content));
  }
}

/**
 * Render log lines in JSON mode.
 */
function renderJson(lines: LogLine[], featureId: string, logPath: string): void {
  const data = {
    feature_id: featureId,
    log_file: logPath,
    line_count: lines.length,
    first_line: lines.length > 0 ? lines[0].lineNumber : null,
    last_line: lines.length > 0 ? lines[lines.length - 1].lineNumber : null,
    lines: lines.map((l) => l.content),
  };
  console.log(JSON.stringify(data));
}

/**
 * Follow a log file, printing new content as it appears (like tail -f).
 * Runs until the process is interrupted.
 */
async function followLog(
  logPath: string,
  featureId: string,
  outputFmt: OutputFormat,
  tail?: number
): Promise<void> {
  // First, print existing content (or tail)
  if (existsSync(logPath)) {
    const lines = readLogLines(logPath, tail);
    if (outputFmt === "json") {
      // In follow + json mode, emit each new batch as a JSON line
      for (const line of lines) {
        console.log(JSON.stringify({ feature_id: featureId, line: line.content, line_number: line.lineNumber }));
      }
    } else if (outputFmt === "toon") {
      // In follow + toon mode, emit a header then raw lines
      console.log(`#FOLLOW fid:${featureId}`);
      for (const line of lines) {
        console.log(line.content);
      }
    } else {
      console.log(`\x1b[1m--- Following logs for ${featureId} (Ctrl+C to stop) ---\x1b[0m`);
      console.log(`\x1b[2mFile: ${logPath}\x1b[0m`);
      console.log();
      for (const line of lines) {
        console.log(colorize(line.content));
      }
    }
  } else {
    if (outputFmt === "text") {
      console.log(`\x1b[1m--- Following logs for ${featureId} (Ctrl+C to stop) ---\x1b[0m`);
      console.log(`\x1b[33mWaiting for log file to appear...\x1b[0m`);
    } else if (outputFmt === "toon") {
      console.log(`#FOLLOW fid:${featureId}|waiting:1`);
    }
  }

  // Now poll for new content
  let offset = 0;
  try {
    if (existsSync(logPath)) {
      const stat = statSync(logPath);
      offset = stat.size;
    }
  } catch {
    // File may not exist yet — we'll start from 0
  }

  const POLL_INTERVAL = 250; // ms
  let lineNumber = 0;
  if (existsSync(logPath)) {
    const raw = readFileSync(logPath, "utf-8");
    lineNumber = raw.split("\n").length - 1;
  }

  let buffer = "";

  // Keep running until SIGINT
  const running = { value: true };
  const cleanup = () => {
    running.value = false;
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    while (running.value) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));

      if (!existsSync(logPath)) continue;

      let currentSize: number;
      try {
        const stat = statSync(logPath);
        currentSize = stat.size;
      } catch {
        continue;
      }

      if (currentSize <= offset) continue;

      // Read new bytes
      const bytesToRead = currentSize - offset;
      const buf = Buffer.alloc(bytesToRead);
      let fd: number | null = null;
      try {
        fd = openSync(logPath, "r");
        readSync(fd, buf, 0, bytesToRead, offset);
      } catch {
        continue;
      } finally {
        if (fd !== null) closeSync(fd);
      }

      offset = currentSize;
      buffer += buf.toString("utf-8");

      // Process complete lines
      const parts = buffer.split("\n");
      // Keep the last incomplete part in the buffer
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        lineNumber++;
        if (outputFmt === "json") {
          console.log(JSON.stringify({ feature_id: featureId, line: part, line_number: lineNumber }));
        } else if (outputFmt === "toon") {
          // In toon follow mode, emit raw lines (no wrapping)
          console.log(part);
        } else {
          console.log(colorize(part));
        }
      }
    }
  } finally {
    process.removeListener("SIGINT", cleanup);
    process.removeListener("SIGTERM", cleanup);
  }

  if (outputFmt === "text") {
    console.log(`\n\x1b[2m--- Stopped following ${featureId} ---\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdLogs(opts: LogsCommandOptions): Promise<void> {
  const { projectRoot, featureId, tail, follow, outputFmt } = opts;

  const logPath = resolve(projectRoot, LOG_DIR_NAME, `${featureId}.log`);

  // If following, we don't require the file to exist yet (it may be created)
  if (follow) {
    await followLog(logPath, featureId, outputFmt, tail);
    return;
  }

  // For non-follow mode, the file must exist
  if (!existsSync(logPath)) {
    outputError(
      outputFmt,
      `Log file not found: ${logPath}\n` +
        `No logs exist for feature "${featureId}". ` +
        `Logs are created when agents run in headless mode.\n` +
        `Hint: Check .wombo-combo/logs/ for available log files, or run 'woco launch' first.`
    );
  }

  const lines = readLogLines(logPath, tail);

  output(outputFmt, {
    feature_id: featureId,
    log_file: logPath,
    line_count: lines.length,
    first_line: lines.length > 0 ? lines[0].lineNumber : null,
    last_line: lines.length > 0 ? lines[lines.length - 1].lineNumber : null,
    lines: lines.map((l) => l.content),
  }, () => {
    renderText(lines, featureId, logPath);
  }, () => {
    console.log(renderLogs({
      feature_id: featureId,
      log_file: logPath,
      line_count: lines.length,
      first_line: lines.length > 0 ? lines[0].lineNumber : null,
      last_line: lines.length > 0 ? lines[lines.length - 1].lineNumber : null,
      lines: lines.map((l) => l.content),
    }));
  });
}
