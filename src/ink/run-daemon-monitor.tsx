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
 * The full React tree is routed through the TUI shell using ScreenRouter:
 *
 *   ThemeContext.Provider
 *     I18nContext.Provider
 *       DashboardStoreContext.Provider
 *         EscMenuProvider (onNavigate via navRef bridge)
 *           ChromeLayout
 *             ScreenRouter (splash → monitor → settings)
 *               NavWire (fills navRef — inside NavigationContext)
 *
 * Usage:
 *   const tui = new InkDaemonTUI({ client, projectRoot, config, onQuit });
 *   tui.start();
 *   await tui.waitForQuit();
 *   tui.stop();
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
import { TuiSession, getStdin } from "./tui-session";
import { ScreenRouter, useNavigation, type NavigationState } from "./router";
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

export interface InkDaemonTUIOptions {
  /** Connected DaemonClient instance. */
  client: DaemonClient;
  /** Called when user presses Q to quit (detach from monitor). */
  onQuit: () => void;
  /** Project root path. */
  projectRoot: string;
  /** Config. */
  config: WomboConfig;
  /**
   * When true, skip calling _session.start() and _session.stop().
   *
   * Use this when the caller already owns the alt-screen (e.g. tui.ts calls
   * enterAltScreen() before entering the main loop). Without this flag, the
   * TUI would re-enter alt-screen on start() and exit it on stop(), corrupting
   * the outer session.
   */
  skipAltScreen?: boolean;
}

/**
 * Mutable store bridging daemon events → React state.
 * notify() flushes state directly into React (no polling interval).
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
  };
}

const TERMINAL_STATUSES: AgentStatus[] = ["completed", "verified", "failed", "merged"];

// ---------------------------------------------------------------------------
// Helper: build DashboardStore from DaemonStore
// ---------------------------------------------------------------------------

function buildDashStore(store: DaemonStore): DashboardStore {
  const agents: DashboardAgent[] = store.agents.map((a) => ({
    id: a.featureId,
    status: a.status,
  }));
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const a of store.agents) {
    if (a.status === "running" || a.status === "installing") running++;
    else if (a.status === "completed" || a.status === "verified" || a.status === "merged") done++;
    else if (a.status === "failed") failed++;
  }
  return {
    agents,
    running,
    done,
    failed,
    total: agents.length,
  };
}

// ---------------------------------------------------------------------------
// NavWire — fills a navRef from inside NavigationContext
// ---------------------------------------------------------------------------

/**
 * Invisible component rendered as ScreenRouter child.
 * Wires the current useNavigation() handle into a mutable ref so that
 * components outside NavigationContext (like EscMenuProvider's onNavigate
 * callback) can call push/pop/replace.
 */
function NavWire({ navRef }: { navRef: MutableRefObject<NavigationState | null> }): null {
  const nav = useNavigation();
  navRef.current = nav;
  return null;
}

// ---------------------------------------------------------------------------
// DaemonMonitorScreen — router-compatible screen component
// ---------------------------------------------------------------------------

/**
 * Props for DaemonMonitorScreen when used as a ScreenRouter screen.
 * These are passed via `initialProps` or `push("monitor", props)`.
 */
export interface DaemonMonitorScreenProps {
  scheduler: SchedulerState | null;
  agents: DaemonAgentState[];
  pendingQuestions: HitlQuestion[];
  allComplete: boolean;
  activityLogs: Map<string, ActivityEntry[]>;
  systemMessages: ActivityEntry[];
  tokenUsage: Map<string, { inputTokens: number; outputTokens: number; totalCost: number }>;
  client: DaemonClient;
  projectRoot: string;
  config: WomboConfig;
  onQuit: () => void;
  onQuitAfterComplete: () => void;
  store: DaemonStore;
}

/**
 * DaemonMonitorScreen — a ScreenRouter-compatible screen component.
 *
 * Thin wrapper over DaemonMonitorAdapter, designed for use in a ScreenRouter
 * screen map. Receives all its data via props (passed through ScreenRouter's
 * initialProps or push()). Required props are given safe defaults so the
 * component is resilient when partially constructed (e.g. in tests).
 *
 * Exported for testing.
 */
export function DaemonMonitorScreen(props: DaemonMonitorScreenProps): React.ReactElement {
  const {
    scheduler = null,
    agents = [],
    pendingQuestions = [],
    allComplete = false,
    activityLogs = new Map(),
    systemMessages = [],
    tokenUsage = new Map(),
    store = createEmptyStore(),
    ...rest
  } = props;
  return (
    <DaemonMonitorAdapter
      scheduler={scheduler}
      agents={agents}
      pendingQuestions={pendingQuestions}
      allComplete={allComplete}
      activityLogs={activityLogs}
      systemMessages={systemMessages}
      tokenUsage={tokenUsage}
      store={store}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// DaemonMonitorShell — full TUI shell component (uses ScreenRouter internally)
// ---------------------------------------------------------------------------

export interface DaemonMonitorShellProps {
  /**
   * Internal mutable store — used by InkDaemonTUI to push daemon events into React.
   * If omitted, the shell starts with an empty store (useful for tests/standalone rendering).
   * @internal
   */
  _store?: DaemonStore;
  client: DaemonClient;
  projectRoot: string;
  config: WomboConfig;
  onQuit: () => void;
  onQuitAfterComplete: () => void;
  /** Ref the class fills with a function to flush store → React state. */
  notifyRef: MutableRefObject<(() => void) | null>;
  /** Duration for splash screen (ms). Default 1500. Pass 0 to test without timer. */
  splashDurationMs?: number;
  /** If true, skip splash and show monitor directly. Useful for tests. */
  skipSplash?: boolean;
}

/**
 * DaemonMonitorShell — the full TUI tree for the daemon monitor.
 *
 * Uses ScreenRouter internally for screen navigation (splash → monitor → settings)
 * instead of hand-rolled useState switching. ChromeLayout wraps ScreenRouter
 * so chrome bars persist across screen transitions. A NavWire component inside
 * ScreenRouter.children bridges navigation calls from EscMenuProvider into
 * NavigationContext.
 *
 * Tree structure:
 *   ThemeContext.Provider
 *     I18nContext.Provider
 *       DashboardStoreContext.Provider
 *         EscMenuProvider (onNavigate uses navRef → nav.push/pop)
 *           ChromeLayout
 *             ScreenRouter (screens: splash, monitor, settings)
 *               NavWire (fills navRef — inside NavigationContext)
 *
 * Exported for testing; InkDaemonTUI uses this via inkRender().
 */
export function DaemonMonitorShell({
  _store: storeProp,
  client,
  projectRoot,
  config,
  onQuit,
  onQuitAfterComplete,
  notifyRef,
  splashDurationMs = 1500,
  skipSplash = false,
}: DaemonMonitorShellProps): React.ReactElement {
  const theme = getTheme(config.tui?.theme ?? "default");
  const tFn = getLocaleT(config.tui?.locale ?? "en");

  // Use provided store or create an empty one
  const store = storeProp ?? createEmptyStore();

  // Reactive state driven by notifyRef
  const [scheduler, setScheduler] = useState<SchedulerState | null>(store.scheduler);
  const [agents, setAgents] = useState<DaemonAgentState[]>(store.agents);
  const [pendingQuestions, setPendingQuestions] = useState<HitlQuestion[]>(store.pendingQuestions);
  const [allComplete, setAllComplete] = useState(store.allComplete);
  const [dashStore, setDashStore] = useState<DashboardStore>(() => buildDashStore(store));
  const [settingsConfig, setSettingsConfig] = useState<SettingsScreenConfig>({
    tui: config.tui,
    devMode: (config as any).devMode ?? false,
  });

  // navRef bridges EscMenuProvider's onNavigate callback to the inner ScreenRouter
  const navRef = useRef<NavigationState | null>(null);

  // Wire up the notify callback
  useEffect(() => {
    notifyRef.current = () => {
      setScheduler(store.scheduler ? { ...store.scheduler } : null);
      setAgents([...store.agents]);
      setPendingQuestions([...store.pendingQuestions]);
      setAllComplete(store.allComplete);
      setDashStore(buildDashStore(store));
    };
    return () => {
      notifyRef.current = null;
    };
  }, [store, notifyRef]);

  const handleEscNavigate = useCallback(
    (action: "settings" | "quit") => {
      if (action === "settings") {
        navRef.current?.push("settings", {
          config: settingsConfig as unknown,
          onSave: (patched: SettingsScreenConfig) => setSettingsConfig(patched),
          onBack: () => navRef.current?.pop(),
        } as Record<string, unknown>);
      } else if (action === "quit") {
        onQuit();
      }
    },
    [settingsConfig, onQuit]
  );

  // Wave summary for ChromeTopBar
  const waveSummary = {
    running: dashStore.running,
    done: dashStore.done,
    failed: dashStore.failed,
  };

  // Build the monitor screen props
  const monitorProps: DaemonMonitorScreenProps = {
    scheduler,
    agents,
    pendingQuestions,
    allComplete,
    activityLogs: store.activityLogs,
    systemMessages: store.systemMessages,
    tokenUsage: store.tokenUsage,
    client,
    projectRoot,
    config,
    onQuit,
    onQuitAfterComplete,
    store,
  };

  // Splash screen props (onDone navigates to monitor via ScreenRouter.replace)
  const splashProps: Record<string, unknown> = {
    onDone: () => navRef.current?.replace("monitor", monitorProps as unknown as Record<string, unknown>),
    durationMs: splashDurationMs,
  };

  const screens = {
    splash: SplashScreen,
    monitor: DaemonMonitorScreen,
    settings: SettingsScreen,
  };

  const initialScreen = skipSplash ? "monitor" : "splash";
  const initialProps: Record<string, unknown> = skipSplash
    ? (monitorProps as unknown as Record<string, unknown>)
    : splashProps;

  return (
    <ThemeContext.Provider value={theme}>
      <I18nContext.Provider value={tFn}>
        <DashboardStoreContext.Provider value={dashStore}>
          <EscMenuProvider onNavigate={handleEscNavigate}>
            <ChromeLayout
              screenName="Wave Monitor"
              daemonConnected={true}
              waveSummary={waveSummary}
              locale={config.tui?.locale ?? "en"}
            >
              <ScreenRouter
                screens={screens}
                initialScreen={initialScreen}
                initialProps={initialProps}
              >
                <NavWire navRef={navRef} />
              </ScreenRouter>
            </ChromeLayout>
          </EscMenuProvider>
        </DashboardStoreContext.Provider>
      </I18nContext.Provider>
    </ThemeContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// DaemonMonitorAdapter — content component (inner screen)
// ---------------------------------------------------------------------------

interface DaemonAdapterProps {
  scheduler: SchedulerState | null;
  agents: DaemonAgentState[];
  pendingQuestions: HitlQuestion[];
  allComplete: boolean;
  activityLogs: Map<string, ActivityEntry[]>;
  systemMessages: ActivityEntry[];
  tokenUsage: Map<string, { inputTokens: number; outputTokens: number; totalCost: number }>;
  client: DaemonClient;
  projectRoot: string;
  config: WomboConfig;
  onQuit: () => void;
  onQuitAfterComplete: () => void;
  store: DaemonStore;
}

function DaemonMonitorAdapter({
  scheduler,
  agents,
  pendingQuestions: pendingQuestionsProp,
  allComplete,
  activityLogs,
  systemMessages,
  tokenUsage,
  client,
  projectRoot,
  onQuit,
  onQuitAfterComplete,
  store,
}: DaemonAdapterProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showBuildLog, setShowBuildLog] = useState(false);
  const [logFileContent, setLogFileContent] = useState<string | null>(null);
  const [logFileAgentId, setLogFileAgentId] = useState<string | null>(null);
  const [showQuestionPopup, setShowQuestionPopup] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answerText, setAnswerText] = useState("");
  // Local copy of pending questions synced from parent
  const [pendingQuestions, setPendingQuestions] = useState<HitlQuestion[]>(pendingQuestionsProp);
  useEffect(() => {
    setPendingQuestions(pendingQuestionsProp);
  }, [pendingQuestionsProp]);

  // Build AgentInfo array from daemon agent state
  const agentInfos: AgentInfo[] = agents.map((a) => ({
    featureId: a.featureId,
    status: a.status,
    activity: a.activity,
    startedAt: a.startedAt,
    retries: a.retries,
    effortEstimateMs: a.effortEstimateMs,
    buildPassed: a.buildPassed,
    buildOutput: a.error,
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
    ? activityLogs.get(selectedAgent.featureId) ?? []
    : [];

  // Token usage totals
  let totalTokens = 0;
  let totalCost = 0;
  const agentTokens = new Map<string, number>();
  for (const [fid, usage] of tokenUsage) {
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
      const logs = activityLogs.get(selectedAgent.featureId);
      if (logs) {
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `!! Cannot retry — agent status is "${selectedAgent.status}" (must be failed or retry)`,
        });
      }
      return;
    }
    try {
      client.retryAgent(selectedAgent.featureId);
      const logs = activityLogs.get(selectedAgent.featureId);
      if (logs) {
        logs.push({
          timestamp: new Date().toISOString().slice(11, 19),
          text: `>> Retry requested — sent to daemon`,
        });
      }
    } catch {
      // Client not connected — ignore
    }
  }, [selectedAgent, client, activityLogs]);

  const handleAttach = useCallback(() => {
    if (!selectedAgent) return;

    if (logFileContent !== null) {
      setLogFileContent(null);
      setLogFileAgentId(null);
      return;
    }

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
        const logs = activityLogs.get(selectedAgent.featureId);
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
  }, [pendingQuestions, selectedAgent, activityLogs]);

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
      setPendingQuestions((prev) =>
        prev.filter((q) => !(q.agentId === agentId && q.id === questionId))
      );
      store.pendingQuestions = store.pendingQuestions.filter(
        (q) => !(q.agentId === agentId && q.id === questionId)
      );
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
  /** Resolves waitForQuit() — set by both Q-key quit and completion. */
  private quitResolve: (() => void) | null = null;
  private unsubscribers: Array<() => void> = [];
  /** Ref wired to the React component's flush function. */
  private notifyRef: MutableRefObject<(() => void) | null> = { current: null };
  /**
   * When true, _session.start() and _session.stop() are NOT called.
   * The outer caller (e.g. tui.ts) owns alt-screen lifecycle.
   */
  private skipAltScreen: boolean;

  /** TuiSession owns alt-screen lifecycle (replaces direct enterAltScreen calls). */
  _session: TuiSession;

  constructor(opts: InkDaemonTUIOptions) {
    this.client = opts.client;
    this.store = createEmptyStore();
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.skipAltScreen = opts.skipAltScreen ?? false;
    this._session = new TuiSession();
    // Wrap onQuit so pressing Q also resolves waitForQuit()
    this.onQuitCallback = () => {
      opts.onQuit();
      this.resolveQuit();
    };
  }

  /** Resolve the waitForQuit() promise and stop the TUI. */
  private resolveQuit(): void {
    if (this.quitResolve) {
      const r = this.quitResolve;
      this.quitResolve = null;
      r();
    }
  }

  /**
   * Mount the Ink component tree, subscribe to daemon events, and
   * request an initial state snapshot.
   */
  start(): void {
    if (!this.skipAltScreen) {
      this._session.start();
    }
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
    this.unsubscribeAll();
    this.unmount();
    if (!this.skipAltScreen) {
      this._session.stop();
    }
  }

  /**
   * Returns a Promise that resolves when the user presses Q to quit.
   */
  waitForQuit(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.quitResolve = resolve;
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
        this.notify();
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
        this.notify();
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
        this.notify();
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
        this.notify();
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
        this.notify();
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
        this.notify();
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
        this.notify();
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
        if (this.store.systemMessages.length > 200) {
          this.store.systemMessages.splice(0, this.store.systemMessages.length - 200);
        }
        this.notify();
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
        this.notify();
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
    this.notify();
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
    if (logs.length > 500) {
      logs.splice(0, logs.length - 500);
    }
    return logs;
  }

  // -------------------------------------------------------------------------
  // React notify
  // -------------------------------------------------------------------------

  /** Push current store state into React — triggers a re-render immediately. */
  private notify(): void {
    this.notifyRef.current?.();
  }

  // -------------------------------------------------------------------------
  // Ink mount / unmount
  // -------------------------------------------------------------------------

  private mount(): void {
    process.stdin.resume(); // keep event loop alive between renders
    this.inkInstance = inkRender(
      <DaemonMonitorShell
        _store={this.store}
        client={this.client}
        projectRoot={this.projectRoot}
        config={this.config}
        notifyRef={this.notifyRef}
        onQuit={this.onQuitCallback}
        onQuitAfterComplete={() => {
          this.stop();
          this.resolveQuit();
        }}
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
}
