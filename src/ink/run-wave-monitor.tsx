/**
 * run-wave-monitor.tsx — Imperative Ink adapter for the WaveMonitorView.
 *
 * Provides the same API surface as the old blessed WomboTUI class so that
 * launch.ts and resume.ts can swap it in with minimal changes:
 *
 *   const tui = new InkWomboTUI({ state, monitor, ... });
 *   tui.start();
 *   // monitoring loop calls tui.updateState(state) every 5s
 *   // monitoring loop calls tui.setPendingQuestions(questions)
 *   tui.markWaveComplete();
 *   await tui.waitForQuit();
 *   tui.stop();
 *
 * Internally it mounts a React component tree via ink's render() and
 * bridges imperative state pushes to React state via a shared ref +
 * polling interval.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { render as inkRender, type Instance as InkInstance } from "ink";
import { WaveMonitorView, type AgentInfo, type AgentCounts } from "./wave-monitor";
import { QuestionPopupView } from "./question-popup";
import type { WaveState, AgentStatus } from "../lib/state";
import { agentCounts } from "../lib/state";
import type { ProcessMonitor, ActivityEntry } from "../lib/monitor";
import type { WomboConfig } from "../config";
import type { HitlQuestion } from "../lib/hitl-channel";
import { tmuxHasSession, tmuxAttach } from "../lib/tmux";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { enterAltScreen, exitAltScreen, isAltScreenActive, installAltScreenGuard } from "./alt-screen";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InkTUIOptions {
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
   * Callback invoked during stop() BEFORE the Ink instance is unmounted.
   * Use this to flush pending state writes to disk.
   */
  onBeforeDestroy?: () => void;
}

/**
 * Shared mutable store bridging imperative calls → React state.
 * The React component polls this at a fixed interval to pick up changes.
 */
interface SharedStore {
  state: WaveState;
  waveComplete: boolean;
  pendingQuestions: HitlQuestion[];
  /** Bumped on every external mutation to let React detect changes cheaply. */
  version: number;
}

// ---------------------------------------------------------------------------
// React adapter component
// ---------------------------------------------------------------------------

interface AdapterProps {
  store: SharedStore;
  monitor: ProcessMonitor;
  interactive: boolean;
  projectRoot: string;
  config: WomboConfig;
  onQuit: () => void;
  onRetry?: (featureId: string) => void;
  onAnswer?: (agentId: string, questionId: string, answerText: string) => void;
  /** Called when user presses Q after wave complete — resolves waitForQuit(). */
  onQuitAfterComplete: () => void;
  /**
   * Called when the user presses Enter to attach to a tmux session.
   * The adapter unmounts, attaches, then remounts.
   */
  onMuxAttach: (featureId: string) => void;
}

function WaveMonitorAdapter({
  store,
  monitor,
  interactive,
  projectRoot,
  config,
  onQuit,
  onRetry,
  onAnswer,
  onQuitAfterComplete,
  onMuxAttach,
}: AdapterProps): React.ReactElement {
  // Local state driven by polling the shared store
  const [state, setState] = useState<WaveState>(store.state);
  const [waveComplete, setWaveComplete] = useState(store.waveComplete);
  const [pendingQuestions, setPendingQuestions] = useState<HitlQuestion[]>(store.pendingQuestions);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showBuildLog, setShowBuildLog] = useState(false);
  const [logFileContent, setLogFileContent] = useState<string | null>(null);
  const [logFileAgentId, setLogFileAgentId] = useState<string | null>(null);
  const [showQuestionPopup, setShowQuestionPopup] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answerText, setAnswerText] = useState("");

  const lastVersionRef = useRef(store.version);

  // Poll the shared store for external updates (every 200ms)
  useEffect(() => {
    const timer = setInterval(() => {
      if (store.version !== lastVersionRef.current) {
        lastVersionRef.current = store.version;
        // Shallow-clone state so React sees a new reference and actually
        // re-renders.  The upstream code mutates the WaveState object in
        // place (Object.assign in updateAgent), so without cloning,
        // setState(sameRef) is a silent no-op.
        const s = store.state;
        setState({ ...s, agents: s.agents.map((a) => ({ ...a })) });
        setWaveComplete(store.waveComplete);
        setPendingQuestions([...store.pendingQuestions]);
      }
    }, 200);
    return () => clearInterval(timer);
  }, [store]);

  // Build agent info array from state
  const agents: AgentInfo[] = state.agents.map((a) => ({
    featureId: a.feature_id,
    status: a.status,
    activity: a.activity ?? null,
    startedAt: a.started_at ?? null,
    retries: a.retries,
    effortEstimateMs: a.effort_estimate_ms ?? null,
    buildPassed: a.build_passed ?? null,
    buildOutput: a.build_output ?? null,
  }));

  // Agent counts
  const counts = agentCounts(state);

  // Activity log for the selected agent
  const selectedAgent = state.agents[selectedIndex];
  const activityLog = selectedAgent
    ? monitor.getActivityLog(selectedAgent.feature_id)
    : [];

  // System messages relevant to the selected agent
  const systemMessages: ActivityEntry[] = selectedAgent
    ? (monitor as any)._systemMessages?.filter((m: ActivityEntry) =>
        m.text.includes(selectedAgent.feature_id)
      ) ?? []
    : [];

  // Token usage from the live TokenCollector
  const allRecords = monitor.tokenCollector.getAllRecords();
  const totalTokens = allRecords.reduce((sum, r) => sum + r.total_tokens, 0);
  const totalCost = allRecords.reduce((sum, r) => sum + r.cost, 0);
  const agentTokens = new Map<string, number>();
  for (const agent of state.agents) {
    const summary = monitor.tokenCollector.getSummary(agent.feature_id);
    if (summary) {
      agentTokens.set(agent.feature_id, summary.total_tokens);
    }
  }

  // Callbacks
  const handleQuit = useCallback(() => {
    if (waveComplete) {
      onQuitAfterComplete();
    } else {
      onQuit();
    }
  }, [waveComplete, onQuitAfterComplete, onQuit]);

  const handleRetry = useCallback(() => {
    if (!selectedAgent || !onRetry) return;
    const retryableStatuses: AgentStatus[] = ["failed", "retry"];
    if (!retryableStatuses.includes(selectedAgent.status)) {
      // Flash a message in the activity log
      const logs = monitor.activityLogs.get(selectedAgent.feature_id);
      if (logs) {
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `!! Cannot retry — agent status is "${selectedAgent.status}" (must be failed or retry)`,
        });
      }
      return;
    }
    onRetry(selectedAgent.feature_id);
    // Show feedback in activity log
    const logs = monitor.activityLogs.get(selectedAgent.feature_id);
    if (logs) {
      logs.push({
        timestamp: new Date().toISOString().slice(11, 19),
        text: `>> Retry requested — agent will be relaunched`,
      });
    }
  }, [selectedAgent, onRetry, monitor]);

  const handleAttach = useCallback(() => {
    if (!selectedAgent) return;

    if (!interactive) {
      // Headless mode — show the raw log file in an overlay
      if (logFileContent !== null) {
        // Toggle off
        setLogFileContent(null);
        setLogFileAgentId(null);
        return;
      }
      const logPath = resolve(
        projectRoot,
        ".wombo-combo",
        "logs",
        `${selectedAgent.feature_id}.log`
      );
      let content: string;
      try {
        content = readFileSync(logPath, "utf-8");
        if (!content.trim()) {
          content = "Log file is empty. Agent may not have started producing output yet.";
        }
      } catch {
        content = `No log file found at ${logPath}`;
      }
      // Truncate to last 200 lines to keep TUI responsive
      const lines = content.split("\n");
      const truncated = lines.length > 200 ? lines.slice(-200).join("\n") : content;
      setLogFileContent(truncated);
      setLogFileAgentId(selectedAgent.feature_id);
      return;
    }

    // Interactive mode — attach to tmux session
    onMuxAttach(selectedAgent.feature_id);
  }, [selectedAgent, interactive, logFileContent, projectRoot, onMuxAttach]);

  const handleToggleBuildLog = useCallback(() => {
    setShowBuildLog((prev) => !prev);
  }, []);

  const handleToggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => !prev);
  }, []);

  const handleOpenQuestions = useCallback(() => {
    if (pendingQuestions.length === 0) {
      // Flash a message
      if (selectedAgent) {
        const logs = monitor.activityLogs.get(selectedAgent.feature_id);
        if (logs) {
          logs.push({
            timestamp: new Date().toISOString().slice(11, 19),
            text: `-- No pending HITL questions`,
          });
        }
      }
      return;
    }
    setQuestionIndex(0);
    setAnswerText("");
    setShowQuestionPopup(true);
  }, [pendingQuestions, selectedAgent, monitor]);

  const handleEscape = useCallback(() => {
    if (showQuestionPopup) {
      setShowQuestionPopup(false);
    } else if (showBuildLog) {
      setShowBuildLog(false);
    } else if (logFileContent !== null) {
      setLogFileContent(null);
      setLogFileAgentId(null);
    }
  }, [showQuestionPopup, showBuildLog, logFileContent]);

  const handleQuestionAnswer = useCallback(
    (agentId: string, questionId: string, text: string) => {
      if (onAnswer) {
        onAnswer(agentId, questionId, text);
      }
      // Remove from local pending list
      setPendingQuestions((prev) =>
        prev.filter((q) => !(q.agentId === agentId && q.id === questionId))
      );
      // Also update the shared store so it stays in sync
      store.pendingQuestions = store.pendingQuestions.filter(
        (q) => !(q.agentId === agentId && q.id === questionId)
      );
      setAnswerText("");
      // Close popup if no more questions
      const remaining = pendingQuestions.filter(
        (q) => !(q.agentId === agentId && q.id === questionId)
      );
      if (remaining.length === 0) {
        setShowQuestionPopup(false);
      } else if (questionIndex >= remaining.length) {
        setQuestionIndex(Math.max(0, remaining.length - 1));
      }
    },
    [onAnswer, store, pendingQuestions, questionIndex]
  );

  const handleQuestionNavigate = useCallback(
    (direction: "next" | "prev") => {
      setPendingQuestions((qs) => {
        const maxIdx = qs.length - 1;
        if (direction === "next") {
          setQuestionIndex((i) => Math.min(i + 1, maxIdx));
        } else {
          setQuestionIndex((i) => Math.max(i - 1, 0));
        }
        return qs;
      });
    },
    []
  );

  return (
    <>
      <WaveMonitorView
        waveId={state.wave_id}
        baseBranch={state.base_branch}
        interactive={interactive}
        model={state.model ?? null}
        agents={agents}
        counts={counts}
        selectedIndex={selectedIndex}
        autoScroll={autoScroll}
        waveComplete={waveComplete}
        activityLog={activityLog}
        systemMessages={systemMessages}
        totalTokens={totalTokens > 0 ? totalTokens : undefined}
        totalCost={totalCost > 0 ? totalCost : undefined}
        agentTokens={agentTokens.size > 0 ? agentTokens : undefined}
        pendingQuestionCount={pendingQuestions.length}
        showBuildLog={showBuildLog}
        logFileContent={logFileContent}
        logFileAgentId={logFileAgentId}
        onSelectionChange={setSelectedIndex}
        onAttach={handleAttach}
        onRetry={handleRetry}
        onToggleBuildLog={handleToggleBuildLog}
        onToggleAutoScroll={handleToggleAutoScroll}
        onOpenQuestions={handleOpenQuestions}
        onQuit={handleQuit}
        onEscape={handleEscape}
      />
      {showQuestionPopup && pendingQuestions.length > 0 && (
        <QuestionPopupView
          questions={pendingQuestions}
          currentIndex={questionIndex}
          answerText={answerText}
          onClose={() => setShowQuestionPopup(false)}
          onAnswer={handleQuestionAnswer}
          onNavigate={handleQuestionNavigate}
          onAnswerChange={setAnswerText}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// InkWomboTUI — imperative wrapper class
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for the old blessed WomboTUI class.
 *
 * Usage:
 *   const tui = new InkWomboTUI({ state, monitor, ... });
 *   tui.start();
 *   // ... monitoring loop ...
 *   tui.updateState(state);
 *   tui.setPendingQuestions(questions);
 *   tui.markWaveComplete();
 *   await tui.waitForQuit();
 *   // tui.stop() is called automatically when quit resolves,
 *   // or call it manually for graceful shutdown.
 */
export class InkWomboTUI {
  private store: SharedStore;
  private monitor: ProcessMonitor;
  private interactive: boolean;
  private projectRoot: string;
  private config: WomboConfig;
  private onQuit: () => void;
  private onRetry?: (featureId: string) => void;
  private onAnswer?: (agentId: string, questionId: string, answerText: string) => void;
  private onBeforeDestroy?: () => void;

  private inkInstance: InkInstance | null = null;
  private waveCompleteResolve: (() => void) | null = null;

  /** Whether we entered the alt screen ourselves (so we know to exit it) */
  private ownsAltScreen = false;
  private removeAltScreenGuard: (() => void) | null = null;

  /** Saved originals for console interception */
  private origConsoleLog: typeof console.log = console.log;
  private origConsoleError: typeof console.error = console.error;
  private origConsoleWarn: typeof console.warn = console.warn;
  /** System messages captured while TUI is active */
  private systemMessages: ActivityEntry[] = [];

  constructor(opts: InkTUIOptions) {
    this.store = {
      state: opts.state,
      waveComplete: false,
      pendingQuestions: [],
      version: 0,
    };
    this.monitor = opts.monitor;
    this.interactive = opts.interactive ?? false;
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.onQuit = opts.onQuit;
    this.onRetry = opts.onRetry;
    this.onAnswer = opts.onAnswer;
    this.onBeforeDestroy = opts.onBeforeDestroy;
  }

  /**
   * Mount the Ink component tree and start console interception.
   * If the caller hasn't already entered the alternate screen buffer,
   * we enter it ourselves so the wave monitor is always fullscreen.
   */
  start(): void {
    if (!isAltScreenActive()) {
      enterAltScreen();
      this.ownsAltScreen = true;
      this.removeAltScreenGuard = installAltScreenGuard();
    }
    this.interceptConsole();
    this.mount();
  }

  /**
   * Unmount the Ink component tree and restore console.
   */
  stop(): void {
    // Flush pending state writes before unmounting.
    if (this.onBeforeDestroy) {
      try {
        this.onBeforeDestroy();
      } catch {
        // Best-effort
      }
    }
    this.restoreConsole();
    this.unmount();
    // Exit alt screen only if we entered it ourselves
    if (this.ownsAltScreen) {
      if (this.removeAltScreenGuard) {
        this.removeAltScreenGuard();
        this.removeAltScreenGuard = null;
      }
      exitAltScreen();
      this.ownsAltScreen = false;
    }
  }

  /**
   * Update the state reference (called from the monitoring loop).
   */
  updateState(state: WaveState): void {
    this.store.state = state;
    this.store.version++;
  }

  /**
   * Mark the wave as complete. The TUI stays open so the user can browse
   * agent logs, build output, etc.
   */
  markWaveComplete(): void {
    this.store.waveComplete = true;
    this.store.version++;
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
   */
  setPendingQuestions(questions: HitlQuestion[]): void {
    this.store.pendingQuestions = questions;
    this.store.version++;
  }

  // -----------------------------------------------------------------------
  // Console interception
  // -----------------------------------------------------------------------

  private interceptConsole(): void {
    this.origConsoleLog = console.log;
    this.origConsoleError = console.error;
    this.origConsoleWarn = console.warn;

    const capture = (...args: any[]) => {
      const text = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      // Strip ANSI codes for clean display
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

  private restoreConsole(): void {
    console.log = this.origConsoleLog;
    console.error = this.origConsoleError;
    console.warn = this.origConsoleWarn;
  }

  // -----------------------------------------------------------------------
  // Ink mount / unmount
  // -----------------------------------------------------------------------

  private mount(): void {
    // Inject system messages into the monitor so the React component can
    // access them via the same interface as agent activity logs.
    (this.monitor as any)._systemMessages = this.systemMessages;

    this.inkInstance = inkRender(
      <WaveMonitorAdapter
        store={this.store}
        monitor={this.monitor}
        interactive={this.interactive}
        projectRoot={this.projectRoot}
        config={this.config}
        onQuit={this.onQuit}
        onRetry={this.onRetry}
        onAnswer={this.onAnswer}
        onQuitAfterComplete={() => {
          this.stop();
          if (this.waveCompleteResolve) {
            this.waveCompleteResolve();
            this.waveCompleteResolve = null;
          }
        }}
        onMuxAttach={(featureId) => this.handleMuxAttach(featureId)}
      />
    );
  }

  private unmount(): void {
    if (this.inkInstance) {
      this.inkInstance.unmount();
      this.inkInstance = null;
    }
  }

  // -----------------------------------------------------------------------
  // Tmux attach
  // -----------------------------------------------------------------------

  private handleMuxAttach(featureId: string): void {
    const sessionName = `${this.config.agent.tmuxPrefix}-${featureId}`;

    // Check if tmux session exists
    if (!tmuxHasSession(sessionName)) {
      const logs = this.monitor.activityLogs.get(featureId);
      if (logs) {
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `!! No tmux session '${sessionName}' found`,
        });
      }
      this.store.version++;
      return;
    }

    // Unmount Ink, attach to tmux, remount after detach
    this.restoreConsole();
    this.unmount();
    try {
      tmuxAttach(sessionName);
    } catch {
      // User detached from session — resume TUI
    }
    this.interceptConsole();
    this.mount();
  }
}
