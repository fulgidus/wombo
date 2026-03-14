/**
 * monitor.ts — Parse JSON events from agent and detect completion/failure.
 *
 * Responsibilities:
 *   - Parse newline-delimited JSON events from agent stdout
 *   - Detect session completion (agent finished)
 *   - Detect session ID from events
 *   - Detect errors and failures
 *   - Write per-agent raw log files for diagnostics
 *   - Maintain per-agent parsed activity log for TUI preview
 */

import type { ChildProcess } from "node:child_process";
import { isProcessRunning } from "./launcher.js";
import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { TokenCollector, type UsageRecord } from "./token-collector.js";

// ---------------------------------------------------------------------------
// Log directory name (configurable would be overkill here)
// ---------------------------------------------------------------------------

const LOG_DIR_NAME = ".wombo-combo/logs";

// ---------------------------------------------------------------------------
// Types — OpenCode JSON Events
// ---------------------------------------------------------------------------

export interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  timestamp?: number;
  part?: {
    type?: string;
    tool?: string;
    callID?: string;
    text?: string;
    reason?: string;
    cost?: number;
    tokens?: {
      total: number;
      input: number;
      output: number;
      reasoning: number;
      cache?: {
        read: number;
        write: number;
      };
    };
    state?: {
      status?: string;
      input?: Record<string, any>;
      output?: string;
      error?: string;
    };
  };
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Event Parser
// ---------------------------------------------------------------------------

export interface ParsedOutput {
  sessionId: string | null;
  completed: boolean;
  errored: boolean;
  lastError: string | null;
  events: OpenCodeEvent[];
}

export function parseEvents(rawOutput: string): ParsedOutput {
  const result: ParsedOutput = {
    sessionId: null,
    completed: false,
    errored: false,
    lastError: null,
    events: [],
  };

  const lines = rawOutput.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as OpenCodeEvent;
      result.events.push(event);

      if (event.sessionID && !result.sessionId) {
        result.sessionId = event.sessionID;
      }

      if (
        event.type === "step_finish" &&
        event.part?.reason === "stop"
      ) {
        result.completed = true;
      }

      if (
        event.type === "tool_use" &&
        event.part?.state?.status === "error"
      ) {
        result.errored = true;
        result.lastError = event.part.state.error ?? "unknown tool error";
      }
    } catch {
      // Not valid JSON — skip
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Activity Extraction
// ---------------------------------------------------------------------------

function shortPath(fullPath: string | undefined, maxLen: number = 30): string {
  if (!fullPath) return "";
  const parts = fullPath.replace(/^\/+/, "").split("/");
  const short =
    parts.length > 1
      ? parts.slice(-2).join("/")
      : parts[parts.length - 1];
  if (short.length <= maxLen) return short;
  const fname = parts[parts.length - 1];
  return fname.length <= maxLen ? fname : fname.slice(0, maxLen - 1) + "\u2026";
}

function shortCmd(cmd: string | undefined, maxLen: number = 30): string {
  if (!cmd) return "";
  const first = cmd.split("\n")[0].trim();
  if (first.length <= maxLen) return first;
  return first.slice(0, maxLen - 1) + "\u2026";
}

/**
 * Map an event to a human-readable activity string.
 */
export function extractActivity(event: OpenCodeEvent): string | null {
  switch (event.type) {
    case "step_start":
      return "thinking\u2026";

    case "tool_use": {
      const toolName = (event.part?.tool ?? "").toLowerCase();
      const input = event.part?.state?.input ?? {};
      const status = event.part?.state?.status ?? "";

      if (status === "error") {
        return `${toolName}: error`;
      }

      switch (toolName) {
        case "read":
          return `reading ${shortPath(input.filePath ?? input.path)}`;
        case "write":
          return `writing ${shortPath(input.filePath ?? input.path)}`;
        case "edit":
          return `editing ${shortPath(input.filePath ?? input.path)}`;
        case "bash":
        case "command":
        case "terminal": {
          const cmd = input.command ?? input.cmd ?? "";
          // Detect HITL ask script invocation
          if (cmd.includes("hitl-ask")) {
            return "waiting for human…";
          }
          return `$ ${shortCmd(cmd)}`;
        }
        case "glob":
          return `finding: ${shortPath(input.pattern)}`;
        case "grep":
        case "search":
          return `searching: ${(input.pattern ?? "").slice(0, 25)}`;
        case "task":
          return "delegating task\u2026";
        case "webfetch":
        case "web_fetch":
          return "fetching URL\u2026";
        case "todowrite":
        case "todo_write":
          return "planning\u2026";
        case "question":
          return "asking question\u2026";
        case "jcodemunch_index_folder":
        case "jcodemunch_index_repo":
          return "indexing code\u2026";
        case "jcodemunch_search_symbols":
        case "jcodemunch_search_text":
          return "searching symbols\u2026";
        case "jcodemunch_get_file_outline":
          return `outlining ${shortPath(input.file_path)}`;
        case "jcodemunch_get_symbol":
        case "jcodemunch_get_symbols":
          return "reading symbol\u2026";
        default:
          return `tool: ${toolName}`;
      }
    }

    case "text":
      return "responding\u2026";

    case "step_finish":
      if (event.part?.reason === "stop") return "done";
      if (event.part?.reason === "tool-calls") return null;
      return null;

    default:
      return null;
  }
}

/**
 * Format an event into a human-readable log line for the activity stream.
 */
export function formatEventForLog(event: OpenCodeEvent): string | null {
  switch (event.type) {
    case "step_start":
      return "-- step started";

    case "tool_use": {
      const toolName = event.part?.tool ?? "unknown";
      const input = event.part?.state?.input ?? {};
      const status = event.part?.state?.status ?? "";
      const output = event.part?.state?.output ?? "";
      const error = event.part?.state?.error ?? "";

      let line = `>> ${toolName}`;
      switch (toolName.toLowerCase()) {
        case "read":
          line = `>> read ${shortPath(input.filePath ?? input.path, 50)}`;
          break;
        case "write":
          line = `>> write ${shortPath(input.filePath ?? input.path, 50)}`;
          break;
        case "edit":
          line = `>> edit ${shortPath(input.filePath ?? input.path, 50)}`;
          break;
        case "bash":
        case "command":
          line = `>> $ ${shortCmd(input.command ?? input.cmd, 60)}`;
          break;
        case "glob":
          line = `>> glob ${input.pattern ?? ""}`;
          break;
        case "grep":
          line = `>> grep "${(input.pattern ?? "").slice(0, 30)}"`;
          break;
        case "task":
          line = `>> task: ${(input.description ?? input.prompt ?? "").slice(0, 50)}`;
          break;
      }

      if (status === "completed" && output) {
        const preview = output.split("\n")[0].slice(0, 80);
        return `${line}\n   ${preview}${output.length > 80 ? "\u2026" : ""}`;
      }
      if (status === "error" && error) {
        return `${line}\n!! ${error.slice(0, 100)}`;
      }
      return line;
    }

    case "text": {
      const text = event.part?.text ?? "";
      if (!text.trim()) return null;
      const firstLine = text.split("\n").find((l: string) => l.trim())?.trim() ?? "";
      if (firstLine.length === 0) return null;
      return `   ${firstLine.slice(0, 120)}${firstLine.length > 120 ? "\u2026" : ""}`;
    }

    case "step_finish": {
      const reason = event.part?.reason ?? "";
      const tokens = event.part?.tokens;
      if (reason === "stop") {
        let tokStr = "";
        if (tokens) {
          const parts = [`${tokens.input}in`, `${tokens.output}out`];
          if (tokens.cache?.read) parts.push(`${tokens.cache.read}cache`);
          tokStr = ` (${parts.join("/")})`;
        }
        return `-- done${tokStr}`;
      }
      return null;
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Per-agent Activity Log (in-memory ring buffer for TUI)
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  timestamp: string;
  text: string;
}

const MAX_ACTIVITY_LINES = 500;

// ---------------------------------------------------------------------------
// Process Monitor
// ---------------------------------------------------------------------------

export interface MonitorCallbacks {
  onSessionId?: (featureId: string, sessionId: string) => void;
  onComplete?: (featureId: string) => void;
  onError?: (featureId: string, error: string) => void;
  onOutput?: (featureId: string, data: string) => void;
  onActivity?: (featureId: string, activity: string) => void;
  /** Called when an agent asks a human question via HITL */
  onQuestion?: (featureId: string, questionText: string) => void;
  /** Called when token usage data is parsed from a step_finish event */
  onUsage?: (featureId: string, record: UsageRecord) => void;
}

interface MonitoredProcess {
  featureId: string;
  process: ChildProcess;
  stdout: string;
  stderr: string;
  sessionId: string | null;
  done: boolean;
  lineBuffer: string;
  sawFinalStop: boolean;
}

/**
 * Monitor a set of headless agent processes.
 * Collects stdout, parses events, and calls callbacks on state changes.
 */
export class ProcessMonitor {
  private processes: Map<string, MonitoredProcess> = new Map();
  private callbacks: MonitorCallbacks;
  private logDir: string;
  /** Per-agent activity log for TUI preview pane */
  public activityLogs: Map<string, ActivityEntry[]> = new Map();
  /** Token usage collector — parses and accumulates usage from step_finish events */
  public tokenCollector: TokenCollector;

  constructor(projectRoot: string, callbacks: MonitorCallbacks = {}) {
    this.callbacks = callbacks;
    this.logDir = resolve(projectRoot, LOG_DIR_NAME);
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
    this.tokenCollector = new TokenCollector((record) => {
      this.callbacks.onUsage?.(record.task_id, record);
    });
  }

  private pushActivity(featureId: string, text: string): void {
    if (!this.activityLogs.has(featureId)) {
      this.activityLogs.set(featureId, []);
    }
    const log = this.activityLogs.get(featureId)!;
    for (const line of text.split("\n")) {
      log.push({ timestamp: new Date().toISOString().slice(11, 19), text: line });
    }
    if (log.length > MAX_ACTIVITY_LINES) {
      log.splice(0, log.length - MAX_ACTIVITY_LINES);
    }
  }

  private writeLog(featureId: string, data: string): void {
    try {
      const logFile = resolve(this.logDir, `${featureId}.log`);
      appendFileSync(logFile, data);
    } catch {
      // Non-critical
    }
  }

  getActivityLog(featureId: string): ActivityEntry[] {
    return this.activityLogs.get(featureId) ?? [];
  }

  addProcess(featureId: string, child: ChildProcess): void {
    const monitored: MonitoredProcess = {
      featureId,
      process: child,
      stdout: "",
      stderr: "",
      sessionId: null,
      done: false,
      lineBuffer: "",
      sawFinalStop: false,
    };

    this.pushActivity(featureId, "-- agent process started");
    this.writeLog(featureId, `[wombo] Process started at ${new Date().toISOString()}\n`);

    child.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      monitored.stdout += chunk;
      this.callbacks.onOutput?.(featureId, chunk);
      this.writeLog(featureId, chunk);

      monitored.lineBuffer += chunk;
      const lines = monitored.lineBuffer.split("\n");
      monitored.lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as OpenCodeEvent;

          if (!monitored.sessionId && event.sessionID) {
            monitored.sessionId = event.sessionID;
            this.callbacks.onSessionId?.(featureId, event.sessionID);
            this.pushActivity(featureId, `-- session: ${event.sessionID}`);
          }

          const activity = extractActivity(event);
          if (activity) {
            this.callbacks.onActivity?.(featureId, activity);
          }

          const logLine = formatEventForLog(event);
          if (logLine) {
            this.pushActivity(featureId, logLine);
          }

          // Extract token usage from step_finish events
          this.tokenCollector.ingestEvent(featureId, event);

          if (
            event.type === "step_finish" &&
            event.part?.reason === "stop"
          ) {
            monitored.sawFinalStop = true;
          }
        } catch {
          if (trimmed.length > 0 && trimmed.length < 500) {
            this.pushActivity(featureId, `[raw] ${trimmed.slice(0, 120)}`);
          }
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      monitored.stderr += chunk;
      this.writeLog(featureId, `[stderr] ${chunk}`);
      const lines = chunk.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        this.pushActivity(featureId, `[stderr] ${line.trim().slice(0, 120)}`);
      }
    });

    child.on("exit", (code) => {
      monitored.done = true;
      this.pushActivity(featureId, `-- process exited (code ${code})`);
      this.writeLog(featureId, `\n[wombo] Process exited with code ${code} at ${new Date().toISOString()}\n`);

      if (code === 0 || monitored.sawFinalStop) {
        this.callbacks.onComplete?.(featureId);
      } else {
        const error =
          monitored.stderr.slice(-2000) ||
          `Process exited with code ${code}`;
        this.callbacks.onError?.(featureId, error);
      }
    });

    child.on("error", (err) => {
      monitored.done = true;
      this.pushActivity(featureId, `!! process error: ${err.message}`);
      this.writeLog(featureId, `\n[wombo] Process error: ${err.message}\n`);
      this.callbacks.onError?.(featureId, err.message);
    });

    this.processes.set(featureId, monitored);
  }

  getSessionId(featureId: string): string | null {
    return this.processes.get(featureId)?.sessionId ?? null;
  }

  getOutput(featureId: string): string {
    return this.processes.get(featureId)?.stdout ?? "";
  }

  isRunning(featureId: string): boolean {
    const m = this.processes.get(featureId);
    if (!m) return false;
    if (m.done) return false;
    return isProcessRunning(m.process.pid!);
  }

  allDone(): boolean {
    for (const m of this.processes.values()) {
      if (!m.done) return false;
    }
    return true;
  }

  activeCount(): number {
    let count = 0;
    for (const m of this.processes.values()) {
      if (!m.done) count++;
    }
    return count;
  }

  remove(featureId: string): void {
    const m = this.processes.get(featureId);
    if (m && !m.done) {
      try {
        m.process.kill("SIGTERM");
      } catch {}
    }
    this.processes.delete(featureId);
  }

  killAll(): void {
    for (const id of this.processes.keys()) {
      this.remove(id);
    }
  }

  waitAll(pollIntervalMs: number = 1000): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.allDone()) {
          resolve();
        } else {
          setTimeout(check, pollIntervalMs);
        }
      };
      check();
    });
  }
}

// ---------------------------------------------------------------------------
// Re-exports from token-collector for convenience
// ---------------------------------------------------------------------------

export { TokenCollector, type UsageRecord } from "./token-collector.js";
export type { UsageSummary, UsageCallback } from "./token-collector.js";
