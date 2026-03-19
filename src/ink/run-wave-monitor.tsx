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
 * Internally it mounts a React component tree via ink's render(). The tree
 * is now routed through the full TUI shell:
 *
 *   ThemeContext.Provider
 *     I18nContext.Provider
 *       DashboardStoreContext.Provider
 *         ScreenRouter (splash → wave-monitor)
 *           EscMenuProvider
 *             ChromeLayout
 *               WaveMonitorAdapter (content screen)
 *
 * The imperative SharedStore + polling pattern is replaced with a reactive
 * notifyRef pattern (same as InkDaemonTUI): callers push state changes by
 * mutating the store and calling notify(), which calls the React setState
 * flush function wired via notifyRef.
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  type MutableRefObject,
} from "react";
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
import { TuiSession, getStdin } from "./tui-session";
import { ScreenRouter, type ScreenMap } from "./router";
import { ChromeLayout } from "./chrome";
import { EscMenuProvider } from "./esc-menu";
import { SplashScreen } from "./splash-screen";
import { SettingsScreen, type SettingsScreenConfig } from "./settings-screen";
import { ThemeContext, getTheme } from "./theme";
import { I18nContext, getLocaleT } from "./i18n";
import {
  DashboardStoreContext,
  type DashboardStore,
  type DashboardAgent,
} from "./dashboard";

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
 * notify() (via notifyRef) flushes pending state directly into React
 * without a polling interval.
 */
interface SharedStore {
  state: WaveState;
  waveComplete: boolean;
  pendingQuestions: HitlQuestion[];
}

// ---------------------------------------------------------------------------
// WaveMonitorShell — full TUI shell component
// ---------------------------------------------------------------------------

export interface WaveMonitorShellProps {
  /** Current wave state. */
  state: WaveState;
  /** Whether the wave has completed. */
  waveComplete?: boolean;
  /** Pending HITL questions. */
  pendingQuestions?: HitlQuestion[];
  /**
   * Internal shared store reference — used by InkWomboTUI to push mutations.
   * If omitted, the component operates in read-only mode from the `state` prop.
   * @internal
   */
  _store?: SharedStore;
  monitor: ProcessMonitor;
  interactive: boolean;
  projectRoot: string;
  config: WomboConfig;
  onQuit: () => void;
  onRetry?: (featureId: string) => void;
  onAnswer?: (agentId: string, questionId: string, answerText: string) => void;
  onQuitAfterComplete: () => void;
  onMuxAttach: (featureId: string) => void;
  /** Ref filled with a flush function by WaveMonitorAdapter. */
  notifyRef: MutableRefObject<(() => void) | null>;
  /** Duration for splash screen (ms). Default 1500. Pass 0 to test without timer. */
  splashDurationMs?: number;
  /** If true, skip splash and show monitor directly. Useful for tests. */
  skipSplash?: boolean;
}

/**
 * WaveMonitorShell — the full TUI tree for the wave monitor.
 *
 * Exported for testing; InkWomboTUI uses this via inkRender().
 */
export function WaveMonitorShell({
  state,
  waveComplete: waveCompleteProp = false,
  pendingQuestions: pendingQuestionsProp = [],
  _store,
  monitor,
  interactive,
  projectRoot,
  config,
  onQuit,
  onRetry,
  onAnswer,
  onQuitAfterComplete,
  onMuxAttach,
  notifyRef,
  splashDurationMs = 1500,
  skipSplash = false,
}: WaveMonitorShellProps): React.ReactElement {
  const theme = getTheme(config.tui?.theme ?? "default");
  const tFn = getLocaleT(config.tui?.locale ?? "en");

  // Derive DashboardStore from the wave state for the context
  const [dashStore, setDashStore] = useState<DashboardStore>(() =>
    buildDashStore(state)
  );

  // Wire notifyRef so the imperative class can push state into React
  const [waveState, setWaveState] = useState<WaveState>(state);
  const [waveComplete, setWaveComplete] = useState(waveCompleteProp);
  const [pendingQuestions, setPendingQuestions] = useState<HitlQuestion[]>(
    pendingQuestionsProp
  );

  useEffect(() => {
    if (!_store) return;
    notifyRef.current = () => {
      const s = _store.state;
      const cloned: WaveState = { ...s, agents: s.agents.map((a: any) => ({ ...a })) };
      setWaveState(cloned);
      setWaveComplete(_store.waveComplete);
      setPendingQuestions([..._store.pendingQuestions]);
      setDashStore(buildDashStore(cloned));
    };
    return () => {
      notifyRef.current = null;
    };
  }, [_store, notifyRef]);

  // Navigation state — start on splash (or skip to monitor)
  const [screen, setScreen] = useState<"splash" | "monitor" | "settings">(
    skipSplash ? "monitor" : "splash"
  );
  const [settingsConfig, setSettingsConfig] = useState<SettingsScreenConfig>({
    tui: config.tui,
    devMode: (config as any).devMode ?? false,
  });

  const handleSplashDone = useCallback(() => {
    setScreen("monitor");
  }, []);

  const handleEscNavigate = useCallback((action: "settings" | "quit") => {
    if (action === "settings") {
      setScreen("settings");
    } else if (action === "quit") {
      onQuit();
    }
  }, [onQuit]);

  const handleSettingsBack = useCallback(() => {
    setScreen("monitor");
  }, []);

  const handleSettingsSave = useCallback((patched: SettingsScreenConfig) => {
    setSettingsConfig(patched);
  }, []);

  // Wave summary for ChromeTopBar
  const counts = agentCounts(waveState);
  const waveSummary = {
    running: counts.running,
    done: counts.completed + counts.verified + counts.merged,
    failed: counts.failed,
  };

  // Screen name for chrome
  const screenName =
    screen === "splash" ? "Loading…" :
    screen === "settings" ? "Settings" :
    "Wave Monitor";

  return (
    <ThemeContext.Provider value={theme}>
      <I18nContext.Provider value={tFn}>
        <DashboardStoreContext.Provider value={dashStore}>
          <EscMenuProvider onNavigate={handleEscNavigate}>
            <ChromeLayout
              screenName={screenName}
              daemonConnected={false}
              waveSummary={screen === "monitor" ? waveSummary : undefined}
              locale={config.tui?.locale ?? "en"}
            >
              {screen === "splash" && (
                <SplashScreen
                  onDone={handleSplashDone}
                  durationMs={splashDurationMs}
                />
              )}
              {screen === "settings" && (
                <SettingsScreen
                  config={settingsConfig}
                  onSave={handleSettingsSave}
                  onBack={handleSettingsBack}
                />
              )}
              {screen === "monitor" && (
                <WaveMonitorAdapter
                  waveState={waveState}
                  waveComplete={waveComplete}
                  pendingQuestions={pendingQuestions}
                  monitor={monitor}
                  interactive={interactive}
                  projectRoot={projectRoot}
                  config={config}
                  onQuit={onQuit}
                  onRetry={onRetry}
                  onAnswer={onAnswer}
                  onQuitAfterComplete={onQuitAfterComplete}
                   onMuxAttach={onMuxAttach}
                  store={_store}
                />
              )}
            </ChromeLayout>
          </EscMenuProvider>
        </DashboardStoreContext.Provider>
      </I18nContext.Provider>
    </ThemeContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Helper: build DashboardStore from WaveState
// ---------------------------------------------------------------------------

function buildDashStore(state: WaveState): DashboardStore {
  const agents: DashboardAgent[] = state.agents.map((a) => ({
    id: a.feature_id,
    status: a.status,
  }));
  const counts = agentCounts(state);
  return {
    agents,
    running: counts.running,
    done: counts.completed + counts.verified + counts.merged,
    failed: counts.failed,
    total: agents.length,
  };
}

// ---------------------------------------------------------------------------
// WaveMonitorAdapter — content component (inner screen)
// ---------------------------------------------------------------------------

interface AdapterProps {
  waveState: WaveState;
  waveComplete: boolean;
  pendingQuestions: HitlQuestion[];
  monitor: ProcessMonitor;
  interactive: boolean;
  projectRoot: string;
  config: WomboConfig;
  onQuit: () => void;
  onRetry?: (featureId: string) => void;
  onAnswer?: (agentId: string, questionId: string, answerText: string) => void;
  onQuitAfterComplete: () => void;
  onMuxAttach: (featureId: string) => void;
  /** Reference to the outer shared store for mutation (HITL answer removal). Optional — only present when driven by InkWomboTUI. */
  store?: SharedStore;
}

function WaveMonitorAdapter({
  waveState,
  waveComplete,
  pendingQuestions: pendingQuestionsProp,
  monitor,
  interactive,
  projectRoot,
  config,
  onQuit,
  onRetry,
  onAnswer,
  onQuitAfterComplete,
  onMuxAttach,
  store,
}: AdapterProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showBuildLog, setShowBuildLog] = useState(false);
  const [logFileContent, setLogFileContent] = useState<string | null>(null);
  const [logFileAgentId, setLogFileAgentId] = useState<string | null>(null);
  const [showQuestionPopup, setShowQuestionPopup] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answerText, setAnswerText] = useState("");
  // Local copy of pending questions — synced from parent via useEffect
  const [pendingQuestions, setPendingQuestions] = useState<HitlQuestion[]>(pendingQuestionsProp);
  useEffect(() => {
    setPendingQuestions(pendingQuestionsProp);
  }, [pendingQuestionsProp]);

  // Build agent info array from state
  const agents: AgentInfo[] = waveState.agents.map((a) => ({
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
  const counts = agentCounts(waveState);

  // Activity log for the selected agent
  const selectedAgent = waveState.agents[selectedIndex];
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
  for (const agent of waveState.agents) {
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
      if (logFileContent !== null) {
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
      const lines = content.split("\n");
      const truncated = lines.length > 200 ? lines.slice(-200).join("\n") : content;
      setLogFileContent(truncated);
      setLogFileAgentId(selectedAgent.feature_id);
      return;
    }

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
      setPendingQuestions((prev) =>
        prev.filter((q) => !(q.agentId === agentId && q.id === questionId))
      );
      if (store) {
        store.pendingQuestions = store.pendingQuestions.filter(
          (q) => !(q.agentId === agentId && q.id === questionId)
        );
      }      setAnswerText("");
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
        waveId={waveState.wave_id}
        baseBranch={waveState.base_branch}
        interactive={interactive}
        model={waveState.model ?? null}
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
  private notifyRef: MutableRefObject<(() => void) | null> = { current: null };

  /** TuiSession owns alt-screen lifecycle (replaces direct enterAltScreen calls). */
  _session: TuiSession;

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
    };
    this.monitor = opts.monitor;
    this.interactive = opts.interactive ?? false;
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.onQuit = opts.onQuit;
    this.onRetry = opts.onRetry;
    this.onAnswer = opts.onAnswer;
    this.onBeforeDestroy = opts.onBeforeDestroy;
    this._session = new TuiSession();
  }

  /**
   * Mount the Ink component tree and start console interception.
   */
  start(): void {
    this._session.start();
    this.interceptConsole();
    this.mount();
  }

  /**
   * Unmount the Ink component tree and restore console.
   */
  stop(): void {
    if (this.onBeforeDestroy) {
      try {
        this.onBeforeDestroy();
      } catch {
        // Best-effort
      }
    }
    this.restoreConsole();
    this.unmount();
    this._session.stop();
  }

  /**
   * Update the state reference (called from the monitoring loop).
   */
  updateState(state: WaveState): void {
    this.store.state = state;
    this.notify();
  }

  /**
   * Mark the wave as complete.
   */
  markWaveComplete(): void {
    this.store.waveComplete = true;
    this.notify();
  }

  /**
   * Returns a Promise that resolves when the user presses q to quit.
   */
  waitForQuit(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waveCompleteResolve = resolve;
    });
  }

  /**
   * Update pending HITL questions.
   */
  setPendingQuestions(questions: HitlQuestion[]): void {
    this.store.pendingQuestions = questions;
    this.notify();
  }

  // -----------------------------------------------------------------------
  // Notify React
  // -----------------------------------------------------------------------

  private notify(): void {
    this.notifyRef.current?.();
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
      const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
      if (!clean.trim()) return;
      this.systemMessages.push({
        timestamp: new Date().toISOString().slice(11, 19),
        text: clean,
      });
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
      <WaveMonitorShell
        state={this.store.state}
        waveComplete={this.store.waveComplete}
        pendingQuestions={this.store.pendingQuestions}
        _store={this.store}
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
        notifyRef={this.notifyRef}
      />,
      { exitOnCtrlC: false, stdin: getStdin() }
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

    if (!tmuxHasSession(sessionName)) {
      const logs = this.monitor.activityLogs.get(featureId);
      if (logs) {
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `!! No tmux session '${sessionName}' found`,
        });
      }
      this.notify();
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
