/**
 * toon.ts -- Token-Optimized Output Notation (TOON) formatter module.
 *
 * Converts structured command results into compact, pipe-delimited TOON
 * notation. Reduces token count by 60%+ vs JSON for equivalent data.
 *
 * Format:
 *   - Delimiter: pipe (|)
 *   - First line: #FIELDS header listing field names
 *   - One record per line, positional fields
 *   - Status codes: BL/PL/IP/BK/IR/DN/CN
 *   - Priority codes: C/H/M/L/W
 *   - Difficulty codes: T/E/M/H/V
 *   - Duration: compact (30m, 2h, 1d4h)
 *   - Boolean: 1/0
 *   - Null/missing: empty field (||)
 *   - Arrays: comma-separated within a field
 */

import type { Task, TaskStatus, Priority, Difficulty } from "./tasks.js";
import type { AgentState, WaveState } from "./state.js";
import type { AgentHistoryRecord, WaveHistoryRecord } from "./history.js";
import {
  TOON_STATUS_ENCODE,
  TOON_PRIORITY_ENCODE,
  TOON_DIFFICULTY_ENCODE,
  encodeDuration,
  encodeBool,
  encodeNullable,
  encodeArray,
} from "./toon-spec.js";

// ---------------------------------------------------------------------------
// Generic Helpers
// ---------------------------------------------------------------------------

/**
 * Join fields with pipe delimiter.
 */
function row(...fields: (string | number | null | undefined)[]): string {
  return fields.map((f) => (f === null || f === undefined ? "" : String(f))).join("|");
}

/**
 * Emit a #FIELDS header line.
 */
function fieldsHeader(names: string[]): string {
  return `#FIELDS ${names.join("|")}`;
}

/**
 * Encode a status code, falling back to raw value if unknown.
 */
function encodeStatus(status: TaskStatus | string): string {
  return (TOON_STATUS_ENCODE as Record<string, string>)[status] ?? status;
}

/**
 * Encode a priority code, falling back to raw value if unknown.
 */
function encodePriority(priority: Priority | string): string {
  return (TOON_PRIORITY_ENCODE as Record<string, string>)[priority] ?? priority;
}

/**
 * Encode a difficulty code, falling back to raw value if unknown.
 */
function encodeDifficulty(difficulty: Difficulty | string): string {
  return (TOON_DIFFICULTY_ENCODE as Record<string, string>)[difficulty] ?? difficulty;
}

// ---------------------------------------------------------------------------
// Tasks List Renderer
// ---------------------------------------------------------------------------

/**
 * Render a task list in TOON format.
 *
 * Fields: id|status|priority|difficulty|effort|completion|deps_met|depends_on|title
 *
 * Example:
 *   #FIELDS id|status|priority|difficulty|effort|completion|deps_met|depends_on|title
 *   auth-flow|BL|H|E|2h|0|1||Add authentication flow
 *   search-api|IP|C|M|4h|35|0|auth-flow|Implement search API
 */
export function renderTasksList(
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    difficulty: string;
    effort: string;
    completion: number;
    depends_on: string[];
  }>,
  depsMetMap?: Map<string, boolean>
): string {
  const header = fieldsHeader([
    "id", "status", "priority", "difficulty", "effort",
    "completion", "deps_met", "depends_on", "title",
  ]);

  const lines = [header];

  for (const t of tasks) {
    const depsMet = depsMetMap?.get(t.id) ?? true;
    lines.push(row(
      t.id,
      encodeStatus(t.status),
      encodePriority(t.priority),
      encodeDifficulty(t.difficulty),
      encodeDuration(t.effort),
      t.completion,
      encodeBool(depsMet),
      encodeArray(t.depends_on),
      t.title,
    ));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tasks Show Renderer
// ---------------------------------------------------------------------------

/**
 * Render a single task detail in TOON key:value format.
 *
 * Uses abbreviated keys, one per line.
 * Example:
 *   id:auth-flow
 *   st:BL
 *   pr:H
 *   df:E
 *   ef:2h
 *   cp:35
 *   dm:1
 *   dp:dep-a,dep-b
 *   sa:2026-03-10T08:00:00Z
 *   ea:
 *   ti:Add authentication flow
 *   ds:Description text here
 *   cn:Must use TypeScript
 *   fb:No external deps
 *   rf:https://example.com
 *   nt:Some note
 *   sc:3
 */
export function renderTaskShow(
  task: Task,
  depsMet: boolean
): string {
  const lines: string[] = [];

  lines.push(`id:${task.id}`);
  lines.push(`st:${encodeStatus(task.status)}`);
  lines.push(`pr:${encodePriority(task.priority)}`);
  lines.push(`df:${encodeDifficulty(task.difficulty)}`);
  lines.push(`ef:${encodeDuration(task.effort)}`);
  lines.push(`cp:${task.completion}`);
  lines.push(`dm:${encodeBool(depsMet)}`);
  lines.push(`dp:${encodeArray(task.depends_on)}`);
  lines.push(`sa:${encodeNullable(task.started_at)}`);
  lines.push(`ea:${encodeNullable(task.ended_at)}`);
  lines.push(`ti:${task.title}`);

  if (task.description) {
    // Collapse multi-line descriptions to single line with \n escape
    lines.push(`ds:${task.description.replace(/\n/g, "\\n")}`);
  }

  if (task.constraints.length > 0) {
    lines.push(`cn:${encodeArray(task.constraints)}`);
  }

  if (task.forbidden.length > 0) {
    lines.push(`fb:${encodeArray(task.forbidden)}`);
  }

  if (task.references.length > 0) {
    lines.push(`rf:${encodeArray(task.references)}`);
  }

  if (task.notes.length > 0) {
    lines.push(`nt:${encodeArray(task.notes)}`);
  }

  if (task.subtasks.length > 0) {
    lines.push(`sc:${task.subtasks.length}`);
    // Render subtasks as compact lines
    for (const st of task.subtasks) {
      lines.push(`  ${st.id}|${encodeStatus(st.status)}|${encodePriority(st.priority)}|${encodeDifficulty(st.difficulty)}|${encodeDuration(st.effort)}|${st.completion}|${st.title}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Status Renderer
// ---------------------------------------------------------------------------

/**
 * Render wave status in TOON format.
 *
 * Fields: feature_id|agent_status|exit_code|retries|started_at
 *
 * Also emits a summary header line:
 *   #WAVE wave_id|agent_count|active|completed|failed
 */
export function renderStatus(state: WaveState): string {
  const lines: string[] = [];

  // Summary line
  const counts: Record<string, number> = {};
  for (const a of state.agents) {
    counts[a.status] = (counts[a.status] ?? 0) + 1;
  }

  const active = (counts["running"] ?? 0) + (counts["installing"] ?? 0) + (counts["resolving_conflict"] ?? 0);
  const completed = (counts["completed"] ?? 0) + (counts["verified"] ?? 0) + (counts["merged"] ?? 0);
  const failed = counts["failed"] ?? 0;

  lines.push(`#WAVE ${row(
    state.wave_id,
    state.agents.length,
    active,
    completed,
    failed,
  )}`);

  // Agent detail lines
  lines.push(fieldsHeader([
    "feature_id", "agent_status", "exit_code", "retries", "started_at",
  ]));

  for (const a of state.agents) {
    // Determine exit code: build_passed === true -> 0, false -> 1, null -> empty
    const exitCode = a.build_passed === true ? "0" : a.build_passed === false ? "1" : "";
    lines.push(row(
      a.feature_id,
      a.status,
      exitCode,
      a.retries,
      encodeNullable(a.started_at),
    ));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Verify Renderer
// ---------------------------------------------------------------------------

/**
 * Render verification results in TOON format.
 *
 * Fields: feature_id|pass_fail|duration
 */
export function renderVerify(
  results: Array<{ feature_id: string; passed: boolean; durationMs: number }>
): string {
  const lines: string[] = [];

  lines.push(fieldsHeader(["feature_id", "pass_fail", "duration"]));

  for (const r of results) {
    const durationSec = Math.round(r.durationMs / 1000);
    const duration = durationSec >= 60
      ? `${Math.floor(durationSec / 60)}m${durationSec % 60}s`
      : `${durationSec}s`;
    lines.push(row(
      r.feature_id,
      r.passed ? "pass" : "fail",
      duration,
    ));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// History Renderer
// ---------------------------------------------------------------------------

/**
 * Render history list in TOON format.
 *
 * Fields: wave_id|started_at|ended_at|total_agents|succeeded|failed
 */
export function renderHistoryList(records: WaveHistoryRecord[]): string {
  const lines: string[] = [];

  lines.push(fieldsHeader([
    "wave_id", "started_at", "ended_at", "total_agents", "succeeded", "failed",
  ]));

  for (const rec of records) {
    lines.push(row(
      rec.wave_id,
      rec.started_at,
      rec.exported_at,
      rec.summary.total,
      rec.summary.succeeded,
      rec.summary.failed,
    ));
  }

  return lines.join("\n");
}

/**
 * Render a single history record detail in TOON format.
 *
 * Emits a summary header then per-agent lines.
 */
export function renderHistoryDetail(rec: WaveHistoryRecord): string {
  const lines: string[] = [];

  // Summary
  lines.push(`#WAVE ${row(
    rec.wave_id,
    rec.summary.total,
    rec.summary.succeeded,
    rec.summary.failed,
    rec.summary.merged,
  )}`);

  // Agent details
  lines.push(fieldsHeader([
    "feature_id", "status", "retries", "duration_ms", "build_passed", "error",
  ]));

  for (const a of rec.agents) {
    lines.push(row(
      a.feature_id,
      a.status,
      a.retries,
      a.duration_ms ?? "",
      a.build_passed === null ? "" : encodeBool(a.build_passed),
      encodeNullable(a.error?.split("\n")[0]?.slice(0, 60) ?? null),
    ));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tasks Check Renderer
// ---------------------------------------------------------------------------

/**
 * Render task check results in TOON format.
 *
 * Fields: level|message
 */
export function renderTasksCheck(result: {
  ok: boolean;
  issues: Array<{ level: string; message: string }>;
  items_checked: number;
}): string {
  const lines: string[] = [];

  lines.push(`#CHECK ${row(
    encodeBool(result.ok),
    result.items_checked,
    result.issues.length,
  )}`);

  if (result.issues.length > 0) {
    lines.push(fieldsHeader(["level", "message"]));
    for (const issue of result.issues) {
      lines.push(row(
        issue.level === "error" ? "E" : "W",
        issue.message,
      ));
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Generic Fallback Renderer
// ---------------------------------------------------------------------------

/**
 * Generic TOON renderer for data that doesn't have a specific formatter.
 * Renders objects as key:value pairs, arrays as pipe-delimited rows.
 */
export function renderGeneric(data: unknown): string {
  if (data === null || data === undefined) return "";

  if (Array.isArray(data)) {
    if (data.length === 0) return "";
    // If array of objects, use first item's keys as fields
    if (typeof data[0] === "object" && data[0] !== null) {
      const keys = Object.keys(data[0] as Record<string, unknown>);
      const lines = [fieldsHeader(keys)];
      for (const item of data) {
        const obj = item as Record<string, unknown>;
        lines.push(row(...keys.map((k) => {
          const v = obj[k];
          if (Array.isArray(v)) return encodeArray(v.map(String));
          if (typeof v === "boolean") return encodeBool(v);
          if (v === null || v === undefined) return "";
          return String(v);
        })));
      }
      return lines.join("\n");
    }
    // Array of primitives
    return data.map(String).join("\n");
  }

  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const lines: string[] = [];
    for (const [key, val] of Object.entries(obj)) {
      if (val === null || val === undefined) {
        lines.push(`${key}:`);
      } else if (Array.isArray(val)) {
        lines.push(`${key}:${encodeArray(val.map(String))}`);
      } else if (typeof val === "boolean") {
        lines.push(`${key}:${encodeBool(val)}`);
      } else if (typeof val === "object") {
        // Nested object — flatten to key.subkey:value
        for (const [sk, sv] of Object.entries(val as Record<string, unknown>)) {
          lines.push(`${key}.${sk}:${sv === null || sv === undefined ? "" : String(sv)}`);
        }
      } else {
        lines.push(`${key}:${String(val)}`);
      }
    }
    return lines.join("\n");
  }

  return String(data);
}
