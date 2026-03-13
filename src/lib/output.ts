/**
 * output.ts — Shared output helpers for agent-ready CLI.
 *
 * Provides a centralized way for commands to emit structured data that
 * renders as human-readable text on TTY, as JSON when --output json
 * is specified, or as compact TOON notation when --output toon is used.
 *
 * Usage in commands:
 *   import { output, OutputFormat } from "../lib/output.js";
 *
 *   // At the end of a command:
 *   output(format, data, textRenderer, toonRenderer);  // emits JSON, text, or TOON
 *   outputError(format, message);                      // emits error in the right format
 */

import { renderGeneric } from "./toon.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutputFormat = "text" | "json" | "toon";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the output format. Priority:
 *   1. Explicit --output flag value
 *   2. WOMBO_OUTPUT env var (for agent pipelines)
 *   3. Default to "text"
 *
 * Note: We intentionally do NOT auto-detect based on TTY. Many legitimate
 * use cases (bun dev, piped to less/grep, CI) have non-TTY stdout but still
 * want human output. Agents should explicitly pass --output json or set
 * WOMBO_OUTPUT=json.
 */
export function resolveOutputFormat(explicit?: string): OutputFormat {
  if (explicit === "json") return "json";
  if (explicit === "toon") return "toon";
  if (explicit === "text") return "text";
  // Check env var for agent pipelines
  const env = process.env.WOMBO_OUTPUT;
  if (env === "json") return "json";
  if (env === "toon") return "toon";
  return "text";
}

/**
 * Emit structured data.
 *   - JSON mode: outputs a single JSON line to stdout
 *   - TOON mode: calls toonRenderer if provided, otherwise uses generic TOON formatter
 *   - Text mode: calls textRenderer
 */
export function output(
  format: OutputFormat,
  data: unknown,
  textRenderer: () => void,
  toonRenderer?: () => void
): void {
  if (format === "json") {
    console.log(JSON.stringify(data));
  } else if (format === "toon") {
    if (toonRenderer) {
      toonRenderer();
    } else {
      // Generic fallback: convert structured data to TOON
      console.log(renderGeneric(data));
    }
  } else {
    textRenderer();
  }
}

/**
 * Emit an error. In JSON mode, outputs {"error": message} to stderr.
 * In TOON mode, outputs "#ERROR message" to stderr.
 * In text mode, outputs the message to stderr normally.
 */
export function outputError(format: OutputFormat, message: string, exitCode: number = 1): never {
  if (format === "json") {
    console.error(JSON.stringify({ error: message }));
  } else if (format === "toon") {
    console.error(`#ERROR ${message}`);
  } else {
    console.error(message);
  }
  process.exit(exitCode);
}

/**
 * Emit a success/info message. In JSON mode, outputs {"message": msg, ...extra}.
 * In TOON mode, outputs "#MSG message" to stdout.
 * In text mode, outputs the message to stdout normally.
 */
export function outputMessage(
  format: OutputFormat,
  message: string,
  extra?: Record<string, unknown>
): void {
  if (format === "json") {
    console.log(JSON.stringify({ message, ...extra }));
  } else if (format === "toon") {
    console.log(`#MSG ${message}`);
  } else {
    console.log(message);
  }
}

// ---------------------------------------------------------------------------
// Field filtering for compact output (--fields)
// ---------------------------------------------------------------------------

/**
 * Filter an object to only include the specified fields.
 * If fields is undefined/empty, returns the object unchanged.
 */
export function filterFields<T extends Record<string, unknown>>(
  obj: T,
  fields?: string[]
): Partial<T> {
  if (!fields || fields.length === 0) return obj;
  const result: Partial<T> = {};
  for (const field of fields) {
    if (field in obj) {
      (result as any)[field] = (obj as any)[field];
    }
  }
  return result;
}

/**
 * Filter an array of objects to only include specified fields per object.
 * If fields is undefined/empty, returns the array unchanged.
 */
export function filterFieldsArray<T extends Record<string, unknown>>(
  arr: T[],
  fields?: string[]
): Partial<T>[] {
  if (!fields || fields.length === 0) return arr;
  return arr.map((obj) => filterFields(obj, fields));
}

/**
 * Render a compact text table from an array of objects with selected fields.
 * Used for text-mode --fields output.
 */
export function renderCompactTable(
  items: Record<string, unknown>[],
  fields: string[]
): void {
  if (items.length === 0) return;

  // Calculate column widths
  const widths: Record<string, number> = {};
  for (const field of fields) {
    widths[field] = field.length;
    for (const item of items) {
      const val = String(item[field] ?? "");
      widths[field] = Math.max(widths[field], val.length);
    }
  }

  // Header
  const header = fields.map((f) => f.padEnd(widths[f])).join("  ");
  console.log(header);
  console.log(fields.map((f) => "─".repeat(widths[f])).join("  "));

  // Rows
  for (const item of items) {
    const row = fields.map((f) => String(item[f] ?? "").padEnd(widths[f])).join("  ");
    console.log(row);
  }
}
