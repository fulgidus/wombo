/**
 * toon-spec.ts — Token-Optimized Output Notation (TOON) format specification.
 *
 * TOON is a compact, pipe-delimited encoding designed for AI agent consumption.
 * It minimizes token usage while remaining fully parseable. Agents call
 * `woco describe --output toon` once per session to learn the format, then
 * parse all subsequent TOON output without further context.
 *
 * Format rules:
 *   - Delimiter: pipe character (|)
 *   - Fields are positional (fixed order per command, no field names in output)
 *   - Header line: optional #FIELDS comment listing field order
 *   - Status codes: BL=backlog, PL=planned, IP=in_progress, BK=blocked, IR=in_review, DN=done, CN=cancelled
 *   - Priority codes: C=critical, H=high, M=medium, L=low, W=wishlist
 *   - Difficulty codes: T=trivial, E=easy, M=medium, H=hard, V=very_hard
 *   - Duration: compact format (30m, 2h, 1d4h) instead of ISO 8601
 *   - Boolean: 1/0 instead of true/false
 *   - Null/missing: empty field (||)
 *   - Arrays: comma-separated within a single field (no pipes)
 */

import type { TaskStatus, Priority, Difficulty } from "./tasks.js";

// ---------------------------------------------------------------------------
// Status Code Mappings
// ---------------------------------------------------------------------------

export const TOON_STATUS_ENCODE: Readonly<Record<TaskStatus, string>> = {
  backlog: "BL",
  planned: "PL",
  in_progress: "IP",
  blocked: "BK",
  in_review: "IR",
  done: "DN",
  cancelled: "CN",
};

export const TOON_STATUS_DECODE: Readonly<Record<string, TaskStatus>> = {
  BL: "backlog",
  PL: "planned",
  IP: "in_progress",
  BK: "blocked",
  IR: "in_review",
  DN: "done",
  CN: "cancelled",
};

// ---------------------------------------------------------------------------
// Priority Code Mappings
// ---------------------------------------------------------------------------

export const TOON_PRIORITY_ENCODE: Readonly<Record<Priority, string>> = {
  critical: "C",
  high: "H",
  medium: "M",
  low: "L",
  wishlist: "W",
};

export const TOON_PRIORITY_DECODE: Readonly<Record<string, Priority>> = {
  C: "critical",
  H: "high",
  M: "medium",
  L: "low",
  W: "wishlist",
};

// ---------------------------------------------------------------------------
// Difficulty Code Mappings
// ---------------------------------------------------------------------------

export const TOON_DIFFICULTY_ENCODE: Readonly<Record<Difficulty, string>> = {
  trivial: "T",
  easy: "E",
  medium: "M",
  hard: "H",
  very_hard: "V",
};

export const TOON_DIFFICULTY_DECODE: Readonly<Record<string, Difficulty>> = {
  T: "trivial",
  E: "easy",
  M: "medium",
  H: "hard",
  V: "very_hard",
};

// ---------------------------------------------------------------------------
// Duration Encoding/Decoding
// ---------------------------------------------------------------------------

/**
 * Convert an ISO 8601 duration to compact TOON format.
 *
 * Examples:
 *   PT30M     -> 30m
 *   PT2H      -> 2h
 *   PT1H30M   -> 1h30m
 *   P1D       -> 1d
 *   P1DT4H    -> 1d4h
 *   P2DT4H30M -> 2d4h30m
 */
export function encodeDuration(iso: string): string {
  if (!iso) return "";

  const match = iso.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
  );
  if (!match) return iso; // return raw if unparseable

  const years = parseInt(match[1] || "0", 10);
  const months = parseInt(match[2] || "0", 10);
  const days = parseInt(match[3] || "0", 10) + years * 365 + months * 30;
  const hours = parseInt(match[4] || "0", 10);
  const minutes = parseInt(match[5] || "0", 10);
  const seconds = parseInt(match[6] || "0", 10);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);

  return parts.length > 0 ? parts.join("") : "0m";
}

/**
 * Convert compact TOON duration back to ISO 8601.
 *
 * Examples:
 *   30m    -> PT30M
 *   2h     -> PT2H
 *   1h30m  -> PT1H30M
 *   1d     -> P1D
 *   1d4h   -> P1DT4H
 */
export function decodeDuration(compact: string): string {
  if (!compact) return "";

  const dMatch = compact.match(/(\d+)d/);
  const hMatch = compact.match(/(\d+)h/);
  const mMatch = compact.match(/(\d+)m/);
  const sMatch = compact.match(/(\d+)s/);

  const days = dMatch ? parseInt(dMatch[1], 10) : 0;
  const hours = hMatch ? parseInt(hMatch[1], 10) : 0;
  const minutes = mMatch ? parseInt(mMatch[1], 10) : 0;
  const seconds = sMatch ? parseInt(sMatch[1], 10) : 0;

  let result = "P";
  if (days > 0) result += `${days}D`;

  const hasTime = hours > 0 || minutes > 0 || seconds > 0;
  if (hasTime) {
    result += "T";
    if (hours > 0) result += `${hours}H`;
    if (minutes > 0) result += `${minutes}M`;
    if (seconds > 0) result += `${seconds}S`;
  }

  // If nothing was added, it's zero duration
  if (result === "P") return "PT0S";

  return result;
}

// ---------------------------------------------------------------------------
// Boolean Encoding
// ---------------------------------------------------------------------------

export function encodeBool(value: boolean): string {
  return value ? "1" : "0";
}

export function decodeBool(value: string): boolean {
  return value === "1";
}

// ---------------------------------------------------------------------------
// Null/Missing Encoding
// ---------------------------------------------------------------------------

export function encodeNullable(value: string | null | undefined): string {
  return value ?? "";
}

// ---------------------------------------------------------------------------
// Array Encoding (comma-separated within a single pipe-delimited field)
// ---------------------------------------------------------------------------

export function encodeArray(arr: string[] | null | undefined): string {
  if (!arr || arr.length === 0) return "";
  return arr.join(",");
}

export function decodeArray(value: string): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Field Definitions per Command
// ---------------------------------------------------------------------------

/**
 * Describes a single field in a TOON record.
 */
export interface ToonFieldDef {
  /** Field name (for the #FIELDS header) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Data type (for documentation) */
  type: "string" | "status" | "priority" | "difficulty" | "duration" | "bool" | "number" | "array" | "datetime";
}

/**
 * Describes the TOON output format for a specific command.
 */
export interface ToonCommandSpec {
  /** Command name (e.g. "tasks list", "tasks show") */
  command: string;
  /** Fields in positional order */
  fields: ToonFieldDef[];
  /** Optional example line */
  example?: string;
}

// ---------------------------------------------------------------------------
// Per-command field specs
// ---------------------------------------------------------------------------

export const TOON_COMMAND_SPECS: readonly ToonCommandSpec[] = [
  {
    command: "tasks list",
    fields: [
      { name: "id", description: "Task identifier", type: "string" },
      { name: "status", description: "Task status (BL/PL/IP/BK/IR/DN/CN)", type: "status" },
      { name: "priority", description: "Priority level (C/H/M/L/W)", type: "priority" },
      { name: "difficulty", description: "Difficulty level (T/E/M/H/V)", type: "difficulty" },
      { name: "effort", description: "Effort estimate (compact: 30m, 2h, 1d4h)", type: "duration" },
      { name: "completion", description: "Completion percentage (0-100)", type: "number" },
      { name: "deps_met", description: "All dependencies satisfied (1/0)", type: "bool" },
      { name: "depends_on", description: "Dependency IDs (comma-separated)", type: "array" },
      { name: "title", description: "Task title", type: "string" },
    ],
    example: "#FIELDS id|status|priority|difficulty|effort|completion|deps_met|depends_on|title\nauth-flow|BL|H|E|2h|0|1||Add authentication flow\nsearch-api|IP|C|M|4h|35|0|auth-flow|Implement search API",
  },
  {
    command: "tasks show",
    fields: [
      { name: "id", description: "Task identifier", type: "string" },
      { name: "status", description: "Task status (BL/PL/IP/BK/IR/DN/CN)", type: "status" },
      { name: "priority", description: "Priority level (C/H/M/L/W)", type: "priority" },
      { name: "difficulty", description: "Difficulty level (T/E/M/H/V)", type: "difficulty" },
      { name: "effort", description: "Effort estimate (compact)", type: "duration" },
      { name: "completion", description: "Completion percentage (0-100)", type: "number" },
      { name: "deps_met", description: "All dependencies satisfied (1/0)", type: "bool" },
      { name: "depends_on", description: "Dependency IDs (comma-separated)", type: "array" },
      { name: "started_at", description: "Start timestamp (ISO 8601 or empty)", type: "datetime" },
      { name: "ended_at", description: "End timestamp (ISO 8601 or empty)", type: "datetime" },
      { name: "title", description: "Task title", type: "string" },
    ],
    example: "#FIELDS id|status|priority|difficulty|effort|completion|deps_met|depends_on|started_at|ended_at|title\nauth-flow|IP|H|E|2h|35|1||2026-03-10T08:00:00Z||Add authentication flow",
  },
  {
    command: "status",
    fields: [
      { name: "feature_id", description: "Feature/task identifier", type: "string" },
      { name: "agent_status", description: "Agent status (queued/running/done/failed/verified/merged)", type: "string" },
      { name: "exit_code", description: "Process exit code (empty if still running)", type: "number" },
      { name: "retries", description: "Number of retries so far", type: "number" },
      { name: "started_at", description: "Agent start timestamp", type: "datetime" },
    ],
    example: "#FIELDS feature_id|agent_status|exit_code|retries|started_at\nauth-flow|running||0|2026-03-10T08:00:00Z\nsearch-api|done|0|1|2026-03-10T08:05:00Z",
  },
  {
    command: "history",
    fields: [
      { name: "wave_id", description: "Wave identifier", type: "string" },
      { name: "started_at", description: "Wave start timestamp", type: "datetime" },
      { name: "ended_at", description: "Wave end timestamp", type: "datetime" },
      { name: "total_agents", description: "Number of agents in the wave", type: "number" },
      { name: "succeeded", description: "Number of agents that succeeded", type: "number" },
      { name: "failed", description: "Number of agents that failed", type: "number" },
    ],
    example: "#FIELDS wave_id|started_at|ended_at|total_agents|succeeded|failed\nwave-2026-03-10-001|2026-03-10T08:00:00Z|2026-03-10T09:30:00Z|5|4|1",
  },
  {
    command: "verify",
    fields: [
      { name: "feature_id", description: "Feature/task identifier", type: "string" },
      { name: "branch", description: "Git branch name", type: "string" },
      { name: "status", description: "Post-verification status (verified/failed)", type: "string" },
      { name: "build_passed", description: "Build passed (1/0 or empty if not run)", type: "bool" },
      { name: "error", description: "Error message (empty if none)", type: "string" },
    ],
    example: "#VERIFY wave:wave-001|verified:2|failed:0\n#FIELDS feature_id|branch|status|build_passed|error\nauth-flow|feature/auth-flow|verified|1|",
  },
  {
    command: "abort",
    fields: [
      { name: "fid", description: "Feature ID that was aborted", type: "string" },
      { name: "prev", description: "Previous agent status", type: "string" },
      { name: "new", description: "New agent status (failed or queued)", type: "string" },
      { name: "mux", description: "Multiplexer session killed (1/0)", type: "bool" },
      { name: "proc", description: "Process killed (1/0)", type: "bool" },
      { name: "rq", description: "Requeued (1/0)", type: "bool" },
    ],
    example: "fid:auth-flow\nprev:running\nnew:failed\nmux:1\nproc:1\nrq:0",
  },
  {
    command: "cleanup",
    fields: [
      { name: "mux", description: "Number of multiplexer sessions killed (or count for dry-run)", type: "number" },
      { name: "wt", description: "Number of worktrees removed (or count for dry-run)", type: "number" },
      { name: "st", description: "State file removed (1/0)", type: "bool" },
      { name: "logs", description: "Logs directory removed (1/0)", type: "bool" },
      { name: "hist", description: "History preserved (1/0)", type: "bool" },
    ],
    example: "mux:2\nwt:3\nst:1\nlogs:1\nhist:1",
  },
  {
    command: "merge",
    fields: [
      { name: "feature_id", description: "Feature/task identifier", type: "string" },
      { name: "branch", description: "Git branch name", type: "string" },
      { name: "status", description: "Post-merge status (merged/failed)", type: "string" },
      { name: "error", description: "Error message (empty if none)", type: "string" },
    ],
    example: "#MERGE wave:wave-001|base:main|merged:2|failed:0\n#FIELDS feature_id|branch|status|error\nauth-flow|feature/auth-flow|merged|",
  },
  {
    command: "retry",
    fields: [
      { name: "fid", description: "Feature ID being retried", type: "string" },
      { name: "mode", description: "Launch mode (interactive/headless)", type: "string" },
      { name: "st", description: "Agent status after retry", type: "string" },
    ],
    example: "fid:auth-flow\nmode:headless\nst:running",
  },
  {
    command: "logs",
    fields: [
      { name: "feature_id", description: "Feature ID whose logs are shown", type: "string" },
      { name: "line_count", description: "Number of log lines", type: "number" },
      { name: "first_line", description: "First line number shown", type: "number" },
      { name: "last_line", description: "Last line number shown", type: "number" },
    ],
    example: "#LOGS fid:auth-flow|count:150|first:1|last:150\n[log lines follow]",
  },
  {
    command: "tasks graph",
    fields: [
      { name: "nodes", description: "Number of graph nodes", type: "number" },
      { name: "edges", description: "Number of graph edges", type: "number" },
      { name: "orphans", description: "Number of orphan tasks", type: "number" },
    ],
    example: "#GRAPH nodes:5|edges:3|orphans:2\n#MERMAID\nflowchart LR\n...\n#END",
  },
  {
    command: "launch",
    fields: [
      { name: "id", description: "Feature/task identifier", type: "string" },
      { name: "priority", description: "Priority level (C/H/M/L/W)", type: "priority" },
      { name: "difficulty", description: "Difficulty level (T/E/M/H/V)", type: "difficulty" },
      { name: "effort", description: "Effort estimate (compact)", type: "duration" },
      { name: "title", description: "Task title", type: "string" },
    ],
    example: "#LAUNCH dry:1|base:main|max:3|model:|interactive:0\n#FIELDS id|priority|difficulty|effort|title\nauth-flow|H|E|2h|Add authentication flow",
  },
] as const;

// ---------------------------------------------------------------------------
// Full TOON Specification (emitted by `woco describe --output toon`)
// ---------------------------------------------------------------------------

export interface ToonSpec {
  format: "TOON";
  version: string;
  description: string;
  delimiter: string;
  rules: {
    status_codes: string;
    priority_codes: string;
    difficulty_codes: string;
    duration: string;
    boolean: string;
    null_missing: string;
    arrays: string;
    field_order: string;
    header_line: string;
  };
  commands: ToonCommandSpec[];
}

/**
 * Build the complete TOON specification object.
 * This is the payload emitted by `woco describe --output toon`.
 */
export function buildToonSpec(version: string): ToonSpec {
  return {
    format: "TOON",
    version,
    description:
      "Token-Optimized Output Notation — compact pipe-delimited format for AI agent consumption. " +
      "Call `woco describe --output toon` once per session to learn the format.",
    delimiter: "|",
    rules: {
      status_codes: "BL=backlog PL=planned IP=in_progress BK=blocked IR=in_review DN=done CN=cancelled",
      priority_codes: "C=critical H=high M=medium L=low W=wishlist",
      difficulty_codes: "T=trivial E=easy M=medium H=hard V=very_hard",
      duration: "Compact: 30m 2h 1d4h 2d4h30m (no spaces, no ISO prefix)",
      boolean: "1=true 0=false",
      null_missing: "Empty field between pipes (||)",
      arrays: "Comma-separated within a single field (no pipes inside arrays)",
      field_order: "Fixed positional per command. See 'commands' array for field order.",
      header_line: "#FIELDS comment as first line lists field names in pipe-delimited order",
    },
    commands: [...TOON_COMMAND_SPECS],
  };
}

/**
 * Emit the TOON legend as plain text — a compact, self-describing reference
 * that an agent can cache and reuse for the rest of the session.
 */
export function renderToonLegend(version: string): string {
  const lines: string[] = [];

  lines.push(`# TOON v${version} — Token-Optimized Output Notation`);
  lines.push(`# Delimiter: | (pipe)`);
  lines.push(`# Status: BL=backlog PL=planned IP=in_progress BK=blocked IR=in_review DN=done CN=cancelled`);
  lines.push(`# Priority: C=critical H=high M=medium L=low W=wishlist`);
  lines.push(`# Difficulty: T=trivial E=easy M=medium H=hard V=very_hard`);
  lines.push(`# Duration: compact (30m, 2h, 1d4h) — no ISO prefix`);
  lines.push(`# Bool: 1/0  Null: empty (||)  Arrays: comma-separated`);
  lines.push(`# First line per output: #FIELDS header with pipe-delimited field names`);
  lines.push(`#`);

  for (const spec of TOON_COMMAND_SPECS) {
    const fieldNames = spec.fields.map((f) => f.name).join("|");
    lines.push(`# ${spec.command}: ${fieldNames}`);
    if (spec.example) {
      // Show only the data lines from the example (skip the #FIELDS line)
      const exampleLines = spec.example.split("\n").filter((l) => !l.startsWith("#FIELDS"));
      if (exampleLines.length > 0) {
        lines.push(`#   e.g. ${exampleLines[0]}`);
      }
    }
  }

  return lines.join("\n");
}
