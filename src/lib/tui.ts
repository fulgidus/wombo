/**
 * tui.ts — Blessed-based TUI dashboard for wombo-combo.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────┐
 *   │ Header: Wave ID, base branch, mode, model   │
 *   ├──────────────────────────┬──────────────────┤
 *   │ Agent Table              │ Preview Pane     │
 *   │ (selectable rows with    │ (parsed activity │
 *   │  status, activity,       │  stream for the  │
 *   │  progress bars, elapsed) │  selected agent) │
 *   ├──────────────────────────┴──────────────────┤
 *   │ Status bar: keybinds + summary counts       │
 *   └─────────────────────────────────────────────┘
 *
 * Keybinds:
 *   Up/Down   — navigate agent list
 *   Enter     — attach to selected agent's multiplexer session (interactive mode)
 *   r         — retry a failed/stuck agent
 *   b         — show build log for selected agent
 *   p         — toggle auto-scroll (pause/resume)
 *   q / C-c   — quit
 */

import blessed from "neo-blessed";
import type { Widgets } from "neo-blessed";
import type { WaveState, AgentState, AgentStatus } from "./state.js";
import { agentCounts } from "./state.js";
import type { ProcessMonitor, ActivityEntry } from "./monitor.js";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WomboConfig } from "../config.js";
import {
  tmuxHasSession,
  tmuxAttach,
} from "./tmux.js";
import { QuestionPopup } from "./tui-question-popup.js";
import type { HitlQuestion } from "./hitl-channel.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TUIOptions {
  state: WaveState;
  monitor: ProcessMonitor;
  onQuit: () => void;
  /** Whether the wave is running in interactive (tmux) mode. */
  interactive?: boolean;
  /** Project root path (for locating log files). */
  projectRoot: string;
  /** Config (for tmux session prefix, log dir, etc.) */
  config: WomboConfig;
  /** Callback to retry a failed/stuck agent from the TUI. */
  onRetry?: (featureId: string) => void;
  /** Callback when the user answers an HITL question. */
  onAnswer?: (agentId: string, questionId: string, answerText: string) => void;
  /**
   * Callback invoked during stop() BEFORE the blessed screen is destroyed.
   * Use this to flush pending state writes to disk while the process is
   * still alive and I/O is still functional. This ensures state.json
   * integrity even if the process exits immediately after screen.destroy().
   */
  onBeforeDestroy?: () => void;
}

// ---------------------------------------------------------------------------
// Color Map
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<AgentStatus, string> = {
  queued: "gray",
  installing: "cyan",
  running: "blue",
  completed: "yellow",
  verified: "green",
  failed: "red",
  merged: "magenta",
  retry: "yellow",
  resolving_conflict: "cyan",
};

const STATUS_ICONS: Record<AgentStatus, string> = {
  queued: "·",
  installing: "⟳",
  running: "●",
  completed: "○",
  verified: "✓",
  failed: "✗",
  merged: "◆",
  retry: "↻",
  resolving_conflict: "⚡",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape curly braces so blessed doesn't interpret them as formatting tags.
 * Blessed uses {color-fg}...{/color-fg} syntax; unmatched or malformed braces
 * in user-provided text (JSON, Python dicts, shell commands, etc.) crash the
 * renderer. We replace { and } with the Unicode fullwidth equivalents which
 * render visually similar but are not parsed by blessed.
 */
function escapeBlessedTags(text: string): string {
  return text.replace(/\{/g, "｛").replace(/\}/g, "｝");
}

/**
 * Format a token count with k/M suffixes for compact display.
 */
function formatTokenCount(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Format a cost value as a dollar string.
 */
function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function elapsed(startedAt: string | null): string {
  if (!startedAt) return "-";
  const start = new Date(startedAt).getTime();
  const diffMs = Date.now() - start;
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60}m`;
}

function progressBar(
  elapsedMs: number,
  estimateMs: number,
  width: number = 10
): string {
  if (estimateMs <= 0) return "░".repeat(width);
  const ratio = Math.min(elapsedMs / estimateMs, 1);
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// TUI Dashboard Class
// ---------------------------------------------------------------------------

export class WomboTUI {
  private screen: Widgets.Screen;
  private headerBox: Widgets.BoxElement;
  private agentList: Widgets.ListElement;
  private previewBox: Widgets.Log;
  private statusBar: Widgets.BoxElement;
  private buildLogBox: Widgets.Log;

  private state: WaveState;
  private monitor: ProcessMonitor;
  private onQuit: () => void;
  private onRetry?: (featureId: string) => void;
  private onAnswer?: (agentId: string, questionId: string, answerText: string) => void;
  private onBeforeDestroy?: () => void;
  private interactive: boolean;
  private projectRoot: string;
  private config: WomboConfig;

  private selectedIndex: number = 0;
  private autoScroll: boolean = true;
  private showingBuildLog: boolean = false;
  private showingLogFile: boolean = false;
  private logFileBox: Widgets.Log | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private waveComplete: boolean = false;
  private waveCompleteResolve: (() => void) | null = null;

  /** Pending HITL questions from agents */
  private pendingQuestions: HitlQuestion[] = [];
  /** Active question popup (null when closed) */
  private questionPopup: QuestionPopup | null = null;

  /** Saved originals for console interception */
  private origConsoleLog: typeof console.log = console.log;
  private origConsoleError: typeof console.error = console.error;
  private origConsoleWarn: typeof console.warn = console.warn;
  /** System messages captured while TUI is active */
  private systemMessages: ActivityEntry[] = [];

  constructor(opts: TUIOptions) {
    this.state = opts.state;
    this.monitor = opts.monitor;
    this.onQuit = opts.onQuit;
    this.onRetry = opts.onRetry;
    this.onAnswer = opts.onAnswer;
    this.onBeforeDestroy = opts.onBeforeDestroy;
    this.interactive = opts.interactive ?? false;
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: `wombo-combo — ${opts.state.wave_id}`,
      fullUnicode: true,
    });

    // Header
    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: {
        fg: "white",
        bg: "black",
      },
    });

    // Agent list (left pane)
    this.agentList = blessed.list({
      top: 3,
      left: 0,
      width: "55%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      keys: true,
      vi: true,
      border: {
        type: "line",
      },
      style: {
        border: { fg: "gray" },
        selected: {
          bg: "blue",
          fg: "white",
          bold: true,
        },
        item: {
          fg: "white",
        },
      },
      label: " Agents ",
    });

    // Preview pane (right pane)
    this.previewBox = blessed.log({
      top: 3,
      left: "55%",
      width: "45%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      keys: false,
      scrollbar: {
        ch: "│",
        style: { fg: "cyan" },
      },
      border: {
        type: "line",
      },
      style: {
        border: { fg: "gray" },
        fg: "white",
      },
      label: " Activity ",
    });

    // Build log overlay (hidden by default)
    this.buildLogBox = blessed.log({
      top: 3,
      left: "10%",
      width: "80%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      keys: true,
      scrollbar: {
        ch: "│",
        style: { fg: "yellow" },
      },
      border: {
        type: "line",
      },
      style: {
        border: { fg: "yellow" },
        fg: "white",
      },
      label: " Build Log ",
      hidden: true,
    });

    // Status bar
    this.statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: {
        fg: "white",
        bg: "black",
      },
    });

    // Assemble
    this.screen.append(this.headerBox);
    this.screen.append(this.agentList);
    this.screen.append(this.previewBox);
    this.screen.append(this.buildLogBox);
    this.screen.append(this.statusBar);

    // Focus the agent list
    this.agentList.focus();

    // Bind keys
    this.bindKeys();
  }

  // -------------------------------------------------------------------------
  // Key Bindings
  // -------------------------------------------------------------------------

  private bindKeys(): void {
    // Quit
    this.screen.key(["q", "C-c"], () => {
      this.stop();
      if (this.waveComplete && this.waveCompleteResolve) {
        // Wave is done — just close TUI and resolve the wait promise
        this.waveCompleteResolve();
      } else {
        // Wave still running — trigger the abort/interrupt handler
        this.onQuit();
      }
    });

    // Navigate agent list
    this.agentList.on("select item", (_item: any, index: number) => {
      this.selectedIndex = index;
      this.refreshPreview();
    });

    // Enter — multiplexer attach
    this.screen.key(["enter"], () => {
      this.muxAttach();
    });

    // b — toggle build log
    this.screen.key(["b"], () => {
      this.toggleBuildLog();
    });

    // p — toggle auto-scroll
    this.screen.key(["p"], () => {
      this.autoScroll = !this.autoScroll;
      this.refreshStatusBar();
    });

    // r — retry failed/stuck agent
    this.screen.key(["r"], () => {
      this.retrySelected();
    });

    // h — open HITL question popup
    this.screen.key(["h"], () => {
      this.openQuestionPopup();
    });

    // Escape — close build log, log file overlay, or question popup
    this.screen.key(["escape"], () => {
      if (this.questionPopup && !this.questionPopup.isDestroyed()) {
        this.questionPopup.close();
        this.questionPopup = null;
        this.agentList.focus();
        this.screen.render();
      } else if (this.showingBuildLog) {
        this.showingBuildLog = false;
        this.buildLogBox.hide();
        this.agentList.focus();
        this.screen.render();
      } else if (this.showingLogFile && this.logFileBox) {
        this.showingLogFile = false;
        this.logFileBox.destroy();
        this.logFileBox = null;
        this.agentList.focus();
        this.screen.render();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Start / Stop
  //
  // ## TUI Lifecycle and Agent Processes (audit: wave-detach-audit)
  //
  // `stop()` only tears down the TUI — it clears the refresh timer and
  // destroys the blessed screen. It does NOT kill agent processes.
  //
  // Agent process termination is handled by the `onQuit` callback, which
  // is set by launch.ts/resume.ts to call `monitor.killAll()` + state save.
  //
  // The separation is intentional:
  //   - `stop()` is also called before mux attach (muxAttach method) where
  //     the TUI is temporarily destroyed and recreated after detach.
  //   - `onQuit()` is only called when the user intends to exit the entire
  //     wave, triggering agent cleanup and process exit.
  //
  // `screen.destroy()` does NOT affect child processes because agents are
  // spawned by the ProcessMonitor (in the launch command), not by the TUI.
  // The TUI only reads from the monitor — it never owns agent processes.
  // -------------------------------------------------------------------------

  start(): void {
    this.interceptConsole();
    this.refresh();
    this.screen.render();

    // Auto-refresh every 2 seconds
    this.refreshTimer = setInterval(() => {
      this.refresh();
    }, 2000);
  }

  stop(): void {
    this.restoreConsole();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    // Flush pending state writes before destroying the screen.
    // This ensures state.json integrity even if process.exit() follows.
    if (this.onBeforeDestroy) {
      try {
        this.onBeforeDestroy();
      } catch {
        // Best-effort — don't let flush errors prevent screen cleanup
      }
    }
    this.screen.destroy();
    // Clean up stdin state left behind by blessed — prevents double-character
    // input when readline takes over stdin after the blessed screen is gone.
    process.stdin.removeAllListeners("keypress");
    process.stdin.removeAllListeners("data");
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
  }

  /**
   * Intercept console.log/error/warn so they don't corrupt the TUI.
   * Messages are captured into systemMessages and shown in the preview
   * when no specific agent is producing activity.
   */
  private interceptConsole(): void {
    this.origConsoleLog = console.log;
    this.origConsoleError = console.error;
    this.origConsoleWarn = console.warn;

    const capture = (...args: any[]) => {
      const text = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      // Strip ANSI codes for clean TUI display
      const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
      if (!clean.trim()) return;
      this.systemMessages.push({
        timestamp: new Date().toISOString().slice(11, 19),
        text: clean,
      });
      // Keep bounded
      if (this.systemMessages.length > 200) {
        this.systemMessages.splice(0, this.systemMessages.length - 200);
      }
    };

    console.log = capture;
    console.error = capture;
    console.warn = capture;
  }

  /**
   * Restore original console methods.
   */
  private restoreConsole(): void {
    console.log = this.origConsoleLog;
    console.error = this.origConsoleError;
    console.warn = this.origConsoleWarn;
  }

  /**
   * Update the state reference (called from the monitoring loop).
   */
  updateState(state: WaveState): void {
    this.state = state;
  }

  /**
   * Mark the wave as complete. The TUI stays open so the user can browse
   * agent logs, build output, etc. The header shows a WAVE COMPLETE banner
   * and the status bar tells the user to press q to exit.
   */
  markWaveComplete(): void {
    this.waveComplete = true;
    this.refresh();
  }

  /**
   * Returns a Promise that resolves when the user presses q to quit.
   * Used after wave completion so the TUI stays open for post-mortem browsing.
   */
  waitForQuit(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waveCompleteResolve = resolve;
    });
  }

  /**
   * Update pending HITL questions. Called from the monitoring loop.
   * If the question popup is open, it gets live-updated too.
   */
  setPendingQuestions(questions: HitlQuestion[]): void {
    this.pendingQuestions = questions;
    if (this.questionPopup && !this.questionPopup.isDestroyed()) {
      this.questionPopup.updateQuestions(questions);
    }
    // Status bar will pick up the badge on next refresh cycle
  }

  /**
   * Open the HITL question popup modal.
   */
  private openQuestionPopup(): void {
    // Don't open if already open
    if (this.questionPopup && !this.questionPopup.isDestroyed()) return;

    // Don't open if there are no pending questions
    if (this.pendingQuestions.length === 0) {
      // Flash a message in the preview
      const agent = this.state.agents[this.selectedIndex];
      if (agent) {
        const logs = this.monitor.activityLogs.get(agent.feature_id);
        if (logs) {
          logs.push({
            timestamp: new Date().toISOString().slice(11, 19),
            text: `-- No pending HITL questions`,
          });
        }
        this.refreshPreview();
        this.screen.render();
      }
      return;
    }

    this.questionPopup = new QuestionPopup(
      this.screen,
      [...this.pendingQuestions], // copy so popup can mutate internally
      {
        onAnswer: (agentId, questionId, answerText) => {
          // Forward to the external callback (which calls submitAnswer)
          if (this.onAnswer) {
            this.onAnswer(agentId, questionId, answerText);
          }
          // Remove from our pending list
          this.pendingQuestions = this.pendingQuestions.filter(
            (q) => !(q.agentId === agentId && q.id === questionId)
          );
        },
        onClose: () => {
          this.questionPopup = null;
          this.agentList.focus();
          this.refreshStatusBar();
          this.screen.render();
        },
      }
    );
  }

  // -------------------------------------------------------------------------
  // Refresh Logic
  // -------------------------------------------------------------------------

  private refresh(): void {
    this.refreshHeader();
    this.refreshAgentList();
    this.refreshPreview();
    this.refreshStatusBar();
    this.screen.render();
  }

  private refreshHeader(): void {
    const s = this.state;
    const counts = agentCounts(s);
    const total = s.agents.length;
    const done = counts.verified + counts.merged;

    let line1 = ` {bold}wombo-combo{/bold} {gray-fg}${s.wave_id}{/gray-fg}`;
    if (this.waveComplete) {
      line1 += `  {gray-fg}│{/gray-fg}  {bold}{green-fg}WAVE COMPLETE{/green-fg}{/bold}`;
    }
    line1 += `  {gray-fg}│{/gray-fg}  Base: {cyan-fg}${s.base_branch}{/cyan-fg}`;
    line1 += `  {gray-fg}│{/gray-fg}  Mode: ${s.interactive ? "{green-fg}interactive{/green-fg}" : "{blue-fg}headless{/blue-fg}"}`;
    if (s.model) {
      line1 += `  {gray-fg}│{/gray-fg}  Model: {yellow-fg}${s.model}{/yellow-fg}`;
    }

    // Token usage from the live TokenCollector
    const allRecords = this.monitor.tokenCollector.getAllRecords();
    if (allRecords.length > 0) {
      const totalTokens = allRecords.reduce((sum, r) => sum + r.total_tokens, 0);
      const totalCostVal = allRecords.reduce((sum, r) => sum + r.cost, 0);
      line1 += `  {gray-fg}│{/gray-fg}  {yellow-fg}${formatTokenCount(totalTokens)} tok{/yellow-fg}`;
      if (totalCostVal > 0) {
        line1 += ` {yellow-fg}${formatCost(totalCostVal)}{/yellow-fg}`;
      }
    }

    let line2 = ` Progress: {green-fg}${done}{/green-fg}/{white-fg}${total}{/white-fg}`;
    if (counts.running > 0)
      line2 += `  {blue-fg}${counts.running} running{/blue-fg}`;
    if (counts.failed > 0)
      line2 += `  {red-fg}${counts.failed} failed{/red-fg}`;
    if (counts.queued > 0)
      line2 += `  {gray-fg}${counts.queued} queued{/gray-fg}`;
    if (counts.retry > 0)
      line2 += `  {yellow-fg}${counts.retry} retrying{/yellow-fg}`;
    if (counts.resolving_conflict > 0)
      line2 += `  {cyan-fg}${counts.resolving_conflict} resolving{/cyan-fg}`;

    this.headerBox.setContent(`${line1}\n${line2}`);
  }

  private refreshAgentList(): void {
    const items: string[] = [];

    for (let i = 0; i < this.state.agents.length; i++) {
      const a = this.state.agents[i];
      const color = STATUS_COLORS[a.status];
      const icon = STATUS_ICONS[a.status];

      // Feature ID (padded)
      const fid =
        a.feature_id.length > 24
          ? a.feature_id.slice(0, 23) + "…"
          : a.feature_id.padEnd(24);

      // Status
      const st = `{${color}-fg}${icon} ${a.status.padEnd(10)}{/${color}-fg}`;

      // Progress bar
      let pbar = "";
      if ((a.status === "running" || a.status === "resolving_conflict") && a.started_at) {
        const elapsedMs = Date.now() - new Date(a.started_at).getTime();
        // Use actual effort estimate from feature data, fallback to 1h
        const estimateMs = a.effort_estimate_ms ?? 60 * 60 * 1000;
        pbar = ` {cyan-fg}${progressBar(elapsedMs, estimateMs, 8)}{/cyan-fg}`;
      } else if (a.status === "verified" || a.status === "merged") {
        pbar = ` {green-fg}${"█".repeat(8)}{/green-fg}`;
      } else if (a.status === "failed") {
        pbar = ` {red-fg}${"█".repeat(8)}{/red-fg}`;
      }

      // Activity (for running/resolving agents)
      let act = "";
      if ((a.status === "running" || a.status === "resolving_conflict") && a.activity) {
        const rawAct =
          a.activity.length > 25 ? a.activity.slice(0, 24) + "…" : a.activity;
        const actText = escapeBlessedTags(rawAct);
        act = ` {cyan-fg}${actText}{/cyan-fg}`;
      } else if (a.status === "installing") {
        act = " {cyan-fg}setting up…{/cyan-fg}";
      }

      // Elapsed
      const el = elapsed(a.started_at);

      // Retries
      const retries =
        a.retries > 0 ? ` {yellow-fg}↻${a.retries}{/yellow-fg}` : "";

      // Per-agent token usage (from live TokenCollector)
      const summary = this.monitor.tokenCollector.getSummary(a.feature_id);
      const tokenInfo = summary
        ? ` {yellow-fg}${formatTokenCount(summary.total_tokens)}{/yellow-fg}`
        : "";

      items.push(
        ` ${fid} ${st}${pbar}${act}${retries}${tokenInfo} {gray-fg}${el}{/gray-fg}`
      );
    }

    // Preserve selection
    const prevSelected = this.selectedIndex;
    this.agentList.setItems(items as any);
    if (prevSelected < items.length) {
      this.agentList.select(prevSelected);
    }
  }

  private refreshPreview(): void {
    const agent = this.state.agents[this.selectedIndex];
    if (!agent) {
      this.previewBox.setContent("{gray-fg}No agent selected{/gray-fg}");
      return;
    }

    // Update label
    this.previewBox.setLabel(` ${agent.feature_id} — Activity `);

    // Get activity log from monitor
    const log = this.monitor.getActivityLog(agent.feature_id);

    // Also include system messages (build verification, etc.)
    // that mention this agent's feature_id
    const relevantSys = this.systemMessages.filter((m) =>
      m.text.includes(agent.feature_id)
    );

    if (log.length === 0 && relevantSys.length === 0) {
      this.previewBox.setContent(
        "{gray-fg}No activity yet. Waiting for agent output…{/gray-fg}"
      );
      return;
    }

    // Format log entries
    const lines: string[] = [];
    for (const entry of log) {
      lines.push(this.formatActivityLine(entry));
    }

    // Append relevant system messages
    if (relevantSys.length > 0) {
      lines.push("");
      lines.push("{yellow-fg}-- system --{/yellow-fg}");
      for (const entry of relevantSys) {
        const ts = `{gray-fg}${entry.timestamp}{/gray-fg}`;
        lines.push(`${ts} {yellow-fg}${escapeBlessedTags(entry.text)}{/yellow-fg}`);
      }
    }

    this.previewBox.setContent(lines.join("\n"));

    // Auto-scroll to bottom
    if (this.autoScroll) {
      this.previewBox.setScrollPerc(100);
    }
  }

  private formatActivityLine(entry: ActivityEntry): string {
    const ts = `{gray-fg}${entry.timestamp}{/gray-fg}`;
    let text = escapeBlessedTags(entry.text);

    // Color-code different line types
    if (text.startsWith(">>")) {
      text = `{cyan-fg}${text}{/cyan-fg}`;
    } else if (text.startsWith("!!")) {
      text = `{red-fg}${text}{/red-fg}`;
    } else if (text.startsWith("--")) {
      text = `{green-fg}${text}{/green-fg}`;
    } else if (text.startsWith("[stderr]")) {
      text = `{red-fg}${text}{/red-fg}`;
    } else if (text.startsWith("[raw]")) {
      text = `{gray-fg}${text}{/gray-fg}`;
    } else if (text.startsWith("   ")) {
      text = `{white-fg}${text}{/white-fg}`;
    }

    return `${ts} ${text}`;
  }

  private refreshStatusBar(): void {
    const scrollStatus = this.autoScroll
      ? "{green-fg}auto-scroll{/green-fg}"
      : "{yellow-fg}paused{/yellow-fg}";

    const agent = this.state.agents[this.selectedIndex];
    const agentInfo = agent
      ? `{gray-fg}Selected: {white-fg}${agent.feature_id}{/white-fg}{/gray-fg}`
      : "";

    const enterHint = this.interactive
      ? "{gray-fg}Enter{/gray-fg} attach session"
      : "{gray-fg}Enter{/gray-fg} view log";

    // HITL badge — show only when there are pending questions
    const hitlBadge =
      this.pendingQuestions.length > 0
        ? `  {bold}{yellow-fg}? ${this.pendingQuestions.length} pending{/yellow-fg}{/bold}  {gray-fg}H{/gray-fg} answer`
        : "";

    let line1: string;
    if (this.waveComplete) {
      line1 = ` {bold}{green-fg}Wave complete.{/green-fg}{/bold}  ${enterHint}  {gray-fg}R{/gray-fg} retry  {gray-fg}B{/gray-fg} build log  {gray-fg}P{/gray-fg} ${scrollStatus}${hitlBadge}  {bold}{yellow-fg}Q{/yellow-fg} exit{/bold}`;
    } else {
      line1 = ` {bold}Keys:{/bold} {gray-fg}\u2191\u2193{/gray-fg} navigate  ${enterHint}  {gray-fg}R{/gray-fg} retry  {gray-fg}B{/gray-fg} build log  {gray-fg}P{/gray-fg} ${scrollStatus}${hitlBadge}  {gray-fg}Q{/gray-fg} quit`;
    }
    const line2 = ` ${agentInfo}`;

    this.statusBar.setContent(`${line1}\n${line2}`);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private muxAttach(): void {
    const agent = this.state.agents[this.selectedIndex];
    if (!agent) return;

    if (!this.interactive) {
      // Headless mode — show the raw log file in an overlay
      this.showLogFile(agent);
      return;
    }

    const sessionName = `${this.config.agent.tmuxPrefix}-${agent.feature_id}`;

    // Check if tmux session exists
    if (!tmuxHasSession(sessionName)) {
      // No session — show message in preview
      this.monitor.activityLogs.get(agent.feature_id)?.push({
        timestamp: new Date().toISOString().slice(11, 19),
        text: `!! No tmux session '${sessionName}' found`,
      });
      this.refreshPreview();
      this.screen.render();
      return;
    }

    // Detach from blessed, attach to tmux session
    this.restoreConsole();
    this.screen.destroy();
    try {
      tmuxAttach(sessionName);
    } catch {
      // User detached from session — resume TUI
    }

    // Re-create screen after returning from tmux
    this.recreateScreen();
  }

  /**
   * Retry the selected agent (only if failed or stuck in retry).
   * Resets it to "queued" so the polling loop picks it up for a fresh launch.
   */
  private retrySelected(): void {
    const agent = this.state.agents[this.selectedIndex];
    if (!agent) return;

    const retryableStatuses: AgentStatus[] = ["failed", "retry"];
    if (!retryableStatuses.includes(agent.status)) {
      // Flash a message in the preview — agent isn't in a retryable state
      const logs = this.monitor.activityLogs.get(agent.feature_id);
      if (logs) {
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `!! Cannot retry — agent status is "${agent.status}" (must be failed or retry)`,
        });
      }
      this.refreshPreview();
      this.screen.render();
      return;
    }

    if (this.onRetry) {
      this.onRetry(agent.feature_id);

      // Show feedback in preview
      const logs = this.monitor.activityLogs.get(agent.feature_id);
      if (logs) {
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `>> Retry requested — agent will be relaunched`,
        });
      }
      this.refresh();
      this.screen.render();
    }
  }

  /**
   * Show the raw log file for an agent in an overlay (headless mode).
   */
  private showLogFile(agent: AgentState): void {
    if (this.showingLogFile) {
      // Toggle off
      this.showingLogFile = false;
      if (this.logFileBox) {
        this.logFileBox.destroy();
        this.logFileBox = null;
      }
      this.agentList.focus();
      this.screen.render();
      return;
    }

    const logPath = resolve(
      this.projectRoot,
      ".wombo-combo",
      "logs",
      `${agent.feature_id}.log`
    );
    let content: string;
    try {
      content = readFileSync(logPath, "utf-8");
      if (!content.trim()) {
        content =
          "{gray-fg}Log file is empty. Agent may not have started producing output yet.{/gray-fg}";
      }
    } catch {
      content = "{gray-fg}No log file found at " + logPath + "{/gray-fg}";
    }

    // Create overlay
    this.logFileBox = blessed.log({
      top: 3,
      left: "5%",
      width: "90%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      keys: true,
      scrollbar: {
        ch: "│",
        style: { fg: "cyan" },
      },
      border: {
        type: "line",
      },
      style: {
        border: { fg: "cyan" },
        fg: "white",
      },
      label: ` Log — ${agent.feature_id} (Esc to close) `,
    });

    this.screen.append(this.logFileBox);

    // Truncate to last 200 lines to keep TUI responsive
    const lines = content.split("\n");
    const truncated =
      lines.length > 200 ? lines.slice(-200).join("\n") : content;
    this.logFileBox.setContent(escapeBlessedTags(truncated));
    this.logFileBox.setScrollPerc(100);
    this.logFileBox.focus();
    this.showingLogFile = true;
    this.screen.render();
  }

  private toggleBuildLog(): void {
    const agent = this.state.agents[this.selectedIndex];
    if (!agent) return;

    if (this.showingBuildLog) {
      this.showingBuildLog = false;
      this.buildLogBox.hide();
      this.agentList.focus();
    } else {
      this.showingBuildLog = true;
      this.buildLogBox.setLabel(` Build Log — ${agent.feature_id} `);

      if (agent.build_output) {
        this.buildLogBox.setContent(escapeBlessedTags(agent.build_output));
      } else if (agent.build_passed === true) {
        this.buildLogBox.setContent(
          "{green-fg}Build passed — no errors.{/green-fg}"
        );
      } else if (agent.build_passed === false) {
        this.buildLogBox.setContent(
          "{red-fg}Build failed — no output captured.{/red-fg}"
        );
      } else {
        this.buildLogBox.setContent(
          "{gray-fg}No build has been run yet.{/gray-fg}"
        );
      }

      this.buildLogBox.show();
      this.buildLogBox.focus();
    }
    this.screen.render();
  }

  /**
   * Re-create the screen after returning from multiplexer attach.
   * Blessed can't resume after destroy, so we rebuild everything.
   */
  private recreateScreen(): void {
    // Re-create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: `wombo-combo — ${this.state.wave_id}`,
      fullUnicode: true,
    });

    // Re-create all widgets
    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    this.agentList = blessed.list({
      top: 3,
      left: 0,
      width: "55%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      keys: true,
      vi: true,
      border: { type: "line" },
      style: {
        border: { fg: "gray" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" },
      },
      label: " Agents ",
    });

    this.previewBox = blessed.log({
      top: 3,
      left: "55%",
      width: "45%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      keys: false,
      scrollbar: { ch: "│", style: { fg: "cyan" } },
      border: { type: "line" },
      style: { border: { fg: "gray" }, fg: "white" },
      label: " Activity ",
    });

    this.buildLogBox = blessed.log({
      top: 3,
      left: "10%",
      width: "80%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      keys: true,
      scrollbar: { ch: "│", style: { fg: "yellow" } },
      border: { type: "line" },
      style: { border: { fg: "yellow" }, fg: "white" },
      label: " Build Log ",
      hidden: true,
    });

    this.statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    this.screen.append(this.headerBox);
    this.screen.append(this.agentList);
    this.screen.append(this.previewBox);
    this.screen.append(this.buildLogBox);
    this.screen.append(this.statusBar);

    this.agentList.focus();
    this.showingBuildLog = false;
    this.showingLogFile = false;
    this.logFileBox = null;
    this.questionPopup = null;
    this.interceptConsole();
    this.bindKeys();
    this.refresh();
  }
}
