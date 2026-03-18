/**
 * run-daemon-monitor.tsx — Daemon-backed Ink adapter for WaveMonitorView.
 *
 * Drop-in replacement for InkWomboTUI (run-wave-monitor.tsx) that gets its
 * data from a DaemonClient WebSocket connection instead of a local
 * SharedStore + ProcessMonitor.
 *
 * The daemon pushes events (agent status changes, activity updates, build
 * results, HITL questions, token usage) and the adapter translates them into
 * WaveMonitorView props.
 *
 * Commands (retry, HITL answer, pin/skip) are sent to the daemon instead of
 * being handled locally.
 *
 * Usage:
 *   const tui = new InkDaemonTUI({ client, projectRoot, config, onQuit });
 *   tui.start();
 *   await tui.waitForQuit();
 *   tui.stop();
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { render as inkRender, type Instance as InkInstance } from "ink";
import { WaveMonitorView, type AgentInfo, type AgentCounts } from "./wave-monitor";
import { QuestionPopupView } from "./question-popup";
import type { AgentStatus } from "../lib/state";
import type { ActivityEntry } from "../lib/monitor";
import type { WomboConfig } from "../config";
import type { HitlQuestion } from "../lib/hitl-channel";
import type { DaemonClient } from "../daemon/client";
import type {
  EvtStateSnapshot,
  EvtAgentStatusChange,
  EvtAgentActivity,
  EvtHitlQuestion,
  EvtBuildResult,
  EvtMergeResult,
  EvtTokenUsage,
  EvtLog,
  EvtSchedulerStatus,
  DaemonAgentState,
  SchedulerState,
} from "../daemon/protocol";
import { enterAltScreen, exitAltScreen, isAltScreenActive, installAltScreenGuard } from "./alt-screen";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InkDaemonTUIOptions {
  /** Connected DaemonClient instance. */
  client: DaemonClient;
  /** Called when user presses Q to quit (detach from monitor). */
  onQuit: () => void;
  /** Project root path. */
  projectRoot: string;
  /** Config. */
  config: WomboConfig;
}

/**
 * Mutable store bridging daemon events → React state.
 * The React component polls this at a fixed interval.
 */
interface DaemonStore {
  scheduler: SchedulerState | null;
  agents: DaemonAgentState[];
  /** Activity logs per agent (featureId → entries). */
  activityLogs: Map<string, ActivityEntry[]>;
  /** System log messages from daemon. */
  systemMessages: ActivityEntry[];
  /** HITL questions pending from agents. */
  pendingQuestions: HitlQuestion[];
  /** Token usage per agent. */
  tokenUsage: Map<string, { inputTokens: number; outputTokens: number; totalCost: number }>;
  /** Whether all agents are in terminal states. */
  allComplete: boolean;
  /** Bumped on every mutation for React change detection. */
  version: number;
}

function createEmptyStore(): DaemonStore {
  return {
    scheduler: null,
    agents: [],
    activityLogs: new Map(),
    systemMessages: [],
    pendingQuestions: [],
    tokenUsage: new Map(),
    allComplete: false,
    version: 0,
  };
}

// ---------------------------------------------------------------------------
// React adapter component
// ---------------------------------------------------------------------------

interface DaemonAdapterProps {
  store: DaemonStore;
  client: DaemonClient;
  projectRoot: string;
  config: WomboConfig;
  onQuit: () => void;
  onQuitAfterComplete: () => void;
}

const TERMINAL_STATUSES: AgentStatus[] = ["completed", "verified", "failed", "merged"];

function DaemonMonitorAdapter({
  store,
  client,
  projectRoot,
  config,
  onQuit,
  onQuitAfterComplete,
}: DaemonAdapterProps): React.ReactElement {
  // Local state driven by polling the daemon store
  const [scheduler, setScheduler] = useState<SchedulerState | null>(store.scheduler);
  const [agents, setAgents] = useState<DaemonAgentState[]>(store.agents);
  const [pendingQuestions, setPendingQuestions] = useState<HitlQuestion[]>(store.pendingQuestions);
  const [allComplete, setAllComplete] = useState(store.allComplete);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showBuildLog, setShowBuildLog] = useState(false);
  const [logFileContent, setLogFileContent] = useState<string | null>(null);
  const [logFileAgentId, setLogFileAgentId] = useState<string | null>(null);
  const [showQuestionPopup, setShowQuestionPopup] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answerText, setAnswerText] = useState("");

  const lastVersionRef = useRef(store.version);

  // Poll the daemon store for event-driven updates (every 200ms)
  useEffect(() => {
    const timer = setInterval(() => {
      if (store.version !== lastVersionRef.current) {
        lastVersionRef.current = store.version;
        setScheduler(store.scheduler ? { ...store.scheduler } : null);
        setAgents([...store.agents]);
        setPendingQuestions([...store.pendingQuestions]);
        setAllComplete(store.allComplete);
      }
    }, 200);
    return () => clearInterval(timer);
  }, [store]);

  // Build AgentInfo array from daemon agent state
  const agentInfos: AgentInfo[] = agents.map((a) => ({
    featureId: a.featureId,
    status: a.status,
    activity: a.activity,
    startedAt: a.startedAt,
    retries: a.retries,
    effortEstimateMs: a.effortEstimateMs,
    buildPassed: a.buildPassed,
    buildOutput: a.error, // Use error field as build output fallback
  }));

  // Agent counts
  const counts: AgentCounts = {
    queued: 0,
    installing: 0,
    running: 0,
    completed: 0,
    verified: 0,
    failed: 0,
    merged: 0,
    retry: 0,
    resolving_conflict: 0,
  };
  for (const a of agents) {
    counts[a.status] = (counts[a.status] ?? 0) + 1;
  }

  // Activity log for selected agent
  const selectedAgent = agents[selectedIndex];
  const activityLog = selectedAgent
    ? store.activityLogs.get(selectedAgent.featureId) ?? []
    : [];

  // System messages
  const systemMessages = store.systemMessages;

  // Token usage totals
  let totalTokens = 0;
  let totalCost = 0;
  const agentTokens = new Map<string, number>();
  for (const [fid, usage] of store.tokenUsage) {
    totalTokens += usage.inputTokens + usage.outputTokens;
    totalCost += usage.totalCost;
    agentTokens.set(fid, usage.inputTokens + usage.outputTokens);
  }

  // Callbacks
  const handleQuit = useCallback(() => {
    if (allComplete) {
      onQuitAfterComplete();
    } else {
      onQuit();
    }
  }, [allComplete, onQuitAfterComplete, onQuit]);

  const handleRetry = useCallback(() => {
    if (!selectedAgent) return;
    const retryableStatuses: AgentStatus[] = ["failed", "retry"];
    if (!retryableStatuses.includes(selectedAgent.status)) {
      // Flash a message in the activity log
      const logs = store.activityLogs.get(selectedAgent.featureId);
      if (logs) {
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `!! Cannot retry — agent status is "${selectedAgent.status}" (must be failed or retry)`,
        });
        store.version++;
      }
      return;
    }
    try {
      client.retryAgent(selectedAgent.featureId);
      const logs = store.activityLogs.get(selectedAgent.featureId);
      if (logs) {
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `>> Retry requested — sent to daemon`,
        });
        store.version++;
      }
    } catch {
      // Client not connected — ignore
    }
  }, [selectedAgent, client, store]);

  const handleAttach = useCallback(() => {
    if (!selectedAgent) return;

    // In daemon mode, always show log overlay (no tmux support yet)
    if (logFileContent !== null) {
      // Toggle off
      setLogFileContent(null);
      setLogFileAgentId(null);
      return;
    }

    // Try to read the log file
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const logPath = resolve(
      projectRoot,
      ".wombo-combo",
      "logs",
      `${selectedAgent.featureId}.log`
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
    // Truncate to last 200 lines
    const lines = content.split("\n");
    const truncated = lines.length > 200 ? lines.slice(-200).join("\n") : content;
    setLogFileContent(truncated);
    setLogFileAgentId(selectedAgent.featureId);
  }, [selectedAgent, logFileContent, projectRoot]);

  const handleToggleBuildLog = useCallback(() => {
    setShowBuildLog((prev) => !prev);
  }, []);

  const handleToggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => !prev);
  }, []);

  const handleOpenQuestions = useCallback(() => {
    if (pendingQuestions.length === 0) {
      if (selectedAgent) {
        const logs = store.activityLogs.get(selectedAgent.featureId);
        if (logs) {
          logs.push({
            timestamp: new Date().toISOString().slice(11, 19),
            text: `-- No pending HITL questions`,
          });
          store.version++;
        }
      }
      return;
    }
    setQuestionIndex(0);
    setAnswerText("");
    setShowQuestionPopup(true);
  }, [pendingQuestions, selectedAgent, store]);

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
      try {
        client.answerHitl(agentId, questionId, text);
      } catch {
        // Client not connected
      }
      // Remove from local pending list
      setPendingQuestions((prev) =>
        prev.filter((q) => !(q.agentId === agentId && q.id === questionId))
      );
      store.pendingQuestions = store.pendingQuestions.filter(
        (q) => !(q.agentId === agentId && q.id === questionId)
      );
      store.version++;
      setAnswerText("");
      const remaining = pendingQuestions.filter(
        (q) => !(q.agentId === agentId && q.id === questionId)
      );
      if (remaining.length === 0) {
        setShowQuestionPopup(false);
      } else if (questionIndex >= remaining.length) {
        setQuestionIndex(Math.max(0, remaining.length - 1));
      }
    },
    [client, store, pendingQuestions, questionIndex]
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
        waveId={scheduler?.questId ?? "daemon"}
        baseBranch={scheduler?.baseBranch ?? "main"}
        interactive={false}
        model={scheduler?.model ?? null}
        agents={agentInfos}
        counts={counts}
        selectedIndex={selectedIndex}
        autoScroll={autoScroll}
        waveComplete={allComplete}
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
// InkDaemonTUI — imperative wrapper class
// ---------------------------------------------------------------------------

/**
 * Daemon-backed replacement for InkWomboTUI.
 *
 * Usage:
 *   const client = new DaemonClient({ clientId: "tui" });
 *   await client.connect();
 *   const tui = new InkDaemonTUI({ client, projectRoot, config, onQuit });
 *   tui.start();
 *   await tui.waitForQuit();
 *   tui.stop();
 */
export class InkDaemonTUI {
  private client: DaemonClient;
  private store: DaemonStore;
  private projectRoot: string;
  private config: WomboConfig;
  private onQuitCallback: () => void;
  private inkInstance: InkInstance | null = null;
  private waveCompleteResolve: (() => void) | null = null;
  private unsubscribers: Array<() => void> = [];

  /** Whether we entered the alt screen ourselves */
  private ownsAltScreen = false;
  private removeAltScreenGuard: (() => void) | null = null;

  /** Saved originals for console interception */
  private origConsoleLog: typeof console.log = console.log;
  private origConsoleError: typeof console.error = console.error;
  private origConsoleWarn: typeof console.warn = console.warn;

  constructor(opts: InkDaemonTUIOptions) {
    this.client = opts.client;
    this.store = createEmptyStore();
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.onQuitCallback = opts.onQuit;
  }

  /**
   * Mount the Ink component tree, subscribe to daemon events, and
   * request an initial state snapshot.
   */
  start(): void {
    if (!isAltScreenActive()) {
      enterAltScreen();
      this.ownsAltScreen = true;
      this.removeAltScreenGuard = installAltScreenGuard();
    }
    this.interceptConsole();
    this.subscribeToDaemonEvents();
    this.mount();

    // Request initial state snapshot
    this.client.requestState().then((snapshot) => {
      this.applySnapshot(snapshot);
    }).catch(() => {
      // Connection may not be ready yet — events will catch us up
    });
  }

  /**
   * Unmount, unsubscribe, and restore terminal.
   */
  stop(): void {
    this.restoreConsole();
    this.unsubscribeAll();
    this.unmount();
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
   * Returns a Promise that resolves when the user presses Q to quit.
   */
  waitForQuit(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waveCompleteResolve = resolve;
    });
  }

  /**
   * Check whether all agents are in terminal states.
   */
  isComplete(): boolean {
    return this.store.allComplete;
  }

  // -------------------------------------------------------------------------
  // Daemon event subscriptions
  // -------------------------------------------------------------------------

  private subscribeToDaemonEvents(): void {
    // State snapshots (on connect and on request)
    this.unsubscribers.push(
      this.client.on("evt:state-snapshot", (payload) => {
        this.applySnapshot(payload as EvtStateSnapshot);
      })
    );

    // Agent status changes
    this.unsubscribers.push(
      this.client.on("evt:agent-status-change", (payload) => {
        const evt = payload as EvtAgentStatusChange;
        const agent = this.store.agents.find((a) => a.featureId === evt.featureId);
        if (agent) {
          agent.status = evt.newStatus;
          const logs = this.ensureActivityLog(evt.featureId);
          logs.push({
            timestamp: new Date().toISOString().slice(11, 19),
            text: `[status] ${evt.previousStatus} → ${evt.newStatus}${evt.detail ? ` (${evt.detail})` : ""}`,
          });
        }
        this.checkCompletion();
        this.store.version++;
      })
    );

    // Agent activity updates
    this.unsubscribers.push(
      this.client.on("evt:agent-activity", (payload) => {
        const evt = payload as EvtAgentActivity;
        const agent = this.store.agents.find((a) => a.featureId === evt.featureId);
        if (agent) {
          agent.activity = evt.activity;
          agent.activityUpdatedAt = new Date().toISOString();
        }
        const logs = this.ensureActivityLog(evt.featureId);
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: evt.activity,
        });
        this.store.version++;
      })
    );

    // HITL questions
    this.unsubscribers.push(
      this.client.on("evt:hitl-question", (payload) => {
        const evt = payload as EvtHitlQuestion;
        this.store.pendingQuestions.push({
          agentId: evt.featureId,
          id: evt.questionId,
          text: evt.questionText,
          timestamp: new Date().toISOString(),
        });
        this.store.version++;
      })
    );

    // Build results
    this.unsubscribers.push(
      this.client.on("evt:build-result", (payload) => {
        const evt = payload as EvtBuildResult;
        const agent = this.store.agents.find((a) => a.featureId === evt.featureId);
        if (agent) {
          agent.buildPassed = evt.passed;
        }
        const logs = this.ensureActivityLog(evt.featureId);
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `[build] ${evt.passed ? "PASSED" : "FAILED"}${evt.output ? ` — ${evt.output.slice(0, 100)}` : ""}`,
        });
        this.store.version++;
      })
    );

    // Merge results
    this.unsubscribers.push(
      this.client.on("evt:merge-result", (payload) => {
        const evt = payload as EvtMergeResult;
        const logs = this.ensureActivityLog(evt.featureId);
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `[merge] ${evt.success ? "SUCCESS" : `FAILED: ${evt.error ?? "unknown"}`}`,
        });
        this.store.version++;
      })
    );

    // Token usage
    this.unsubscribers.push(
      this.client.on("evt:token-usage", (payload) => {
        const evt = payload as EvtTokenUsage;
        const existing = this.store.tokenUsage.get(evt.featureId);
        this.store.tokenUsage.set(evt.featureId, {
          inputTokens: (existing?.inputTokens ?? 0) + evt.inputTokens,
          outputTokens: (existing?.outputTokens ?? 0) + evt.outputTokens,
          totalCost: (existing?.totalCost ?? 0) + (evt.cost ?? 0),
        });
        this.store.version++;
      })
    );

    // Scheduler status
    this.unsubscribers.push(
      this.client.on("evt:scheduler-status", (payload) => {
        const evt = payload as EvtSchedulerStatus;
        if (this.store.scheduler) {
          this.store.scheduler.status = evt.status;
        }
        this.store.systemMessages.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `[scheduler] ${evt.status}${evt.reason ? ` — ${evt.reason}` : ""}`,
        });
        this.checkCompletion();
        this.store.version++;
      })
    );

    // Daemon log messages
    this.unsubscribers.push(
      this.client.on("evt:log", (payload) => {
        const evt = payload as EvtLog;
        this.store.systemMessages.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `[${evt.level}] ${evt.message}`,
        });
        // Keep bounded
        if (this.store.systemMessages.length > 200) {
          this.store.systemMessages.splice(0, this.store.systemMessages.length - 200);
        }
        this.store.version++;
      })
    );

    // Daemon shutdown
    this.unsubscribers.push(
      this.client.on("evt:shutdown", () => {
        this.store.allComplete = true;
        this.store.systemMessages.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `[daemon] Daemon is shutting down`,
        });
        this.store.version++;
      })
    );
  }

  private unsubscribeAll(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  private applySnapshot(snapshot: EvtStateSnapshot): void {
    this.store.scheduler = snapshot.scheduler;
    this.store.agents = [...snapshot.agents];

    // Rebuild pending questions from agent state
    this.store.pendingQuestions = [];
    for (const agent of snapshot.agents) {
      for (const q of agent.pendingQuestions) {
        this.store.pendingQuestions.push({
          agentId: agent.featureId,
          id: q.questionId,
          text: q.questionText,
          timestamp: q.askedAt,
        });
      }
    }

    // Rebuild token usage from agent state
    this.store.tokenUsage.clear();
    for (const agent of snapshot.agents) {
      if (agent.tokenUsage) {
        this.store.tokenUsage.set(agent.featureId, {
          inputTokens: agent.tokenUsage.inputTokens,
          outputTokens: agent.tokenUsage.outputTokens,
          totalCost: agent.tokenUsage.totalCost,
        });
      }
    }

    this.checkCompletion();
    this.store.version++;
  }

  private checkCompletion(): void {
    if (this.store.agents.length === 0) {
      this.store.allComplete = false;
      return;
    }
    const allDone = this.store.agents.every((a) =>
      TERMINAL_STATUSES.includes(a.status)
    );
    const schedulerDone =
      this.store.scheduler?.status === "idle" ||
      this.store.scheduler?.status === "shutdown";
    this.store.allComplete = allDone && (schedulerDone || this.store.agents.length > 0 && allDone);
  }

  private ensureActivityLog(featureId: string): ActivityEntry[] {
    let logs = this.store.activityLogs.get(featureId);
    if (!logs) {
      logs = [];
      this.store.activityLogs.set(featureId, logs);
    }
    // Keep bounded
    if (logs.length > 500) {
      logs.splice(0, logs.length - 500);
    }
    return logs;
  }

  // -------------------------------------------------------------------------
  // Console interception
  // -------------------------------------------------------------------------

  private interceptConsole(): void {
    this.origConsoleLog = console.log;
    this.origConsoleError = console.error;
    this.origConsoleWarn = console.warn;

    const capture = (...args: any[]) => {
      const text = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
      if (!clean.trim()) return;
      this.store.systemMessages.push({
        timestamp: new Date().toISOString().slice(11, 19),
        text: clean,
      });
      if (this.store.systemMessages.length > 200) {
        this.store.systemMessages.splice(0, this.store.systemMessages.length - 200);
      }
      this.store.version++;
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

  // -------------------------------------------------------------------------
  // Ink mount / unmount
  // -------------------------------------------------------------------------

  private mount(): void {
    this.inkInstance = inkRender(
      <DaemonMonitorAdapter
        store={this.store}
        client={this.client}
        projectRoot={this.projectRoot}
        config={this.config}
        onQuit={this.onQuitCallback}
        onQuitAfterComplete={() => {
          this.stop();
          if (this.waveCompleteResolve) {
            this.waveCompleteResolve();
            this.waveCompleteResolve = null;
          }
        }}
      />
    );
  }

  private unmount(): void {
    if (this.inkInstance) {
      this.inkInstance.unmount();
      this.inkInstance = null;
    }
  }
}
