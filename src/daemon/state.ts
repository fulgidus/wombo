/**
 * state.ts — Daemon-side state management.
 *
 * Replaces the wave-based WaveState with a continuous pipeline model.
 * Agents flow through the system one at a time or concurrently — there's no
 * discrete "wave" concept. State is persisted to disk atomically and broadcast
 * to connected WebSocket clients on every mutation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { WOMBO_DIR } from "../config";
import type { AgentStatus } from "../lib/state";
import type {
  DaemonAgentState,
  SchedulerState,
  SchedulerStatus,
  EvtStateSnapshot,
  EvtAgentStatusChange,
  EvtSchedulerStatus,
  EventType,
  EventMap,
} from "./protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Listener for state change events. */
export type StateListener = <T extends EventType>(
  eventType: T,
  payload: EventMap[T]
) => void;

/** Internal agent state — superset of what we expose to clients. */
export interface InternalAgentState extends DaemonAgentState {
  /** Raw build output (not sent to clients unless requested) */
  buildOutput: string | null;
  /** Internal merge queue position (null = not queued for merge) */
  mergeQueuePosition: number | null;
}

/** Persisted daemon state (written to daemon-state.json). */
export interface PersistedDaemonState {
  version: number;
  scheduler: SchedulerState;
  agents: InternalAgentState[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILE = "daemon-state.json";
const STATE_VERSION = 1;

// Terminal statuses — agents in these states won't be scheduled
const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "completed",
  "verified",
  "failed",
  "merged",
]);

// Active statuses — agents currently consuming a concurrency slot
const ACTIVE_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "installing",
  "running",
  "resolving_conflict",
]);

// Dep-satisfied statuses — downstream agents can proceed
const DEP_SATISFIED_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "verified",
  "merged",
]);

// ---------------------------------------------------------------------------
// DaemonState class
// ---------------------------------------------------------------------------

export class DaemonState {
  private projectRoot: string;
  private scheduler: SchedulerState;
  private agents: Map<string, InternalAgentState> = new Map();
  private listeners: Set<StateListener> = new Set();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.scheduler = DaemonState.defaultSchedulerState();
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /** Load persisted state from disk, or start fresh. */
  load(): void {
    const p = this.statePath();
    if (!existsSync(p)) return;

    try {
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as PersistedDaemonState;
      if (parsed.version !== STATE_VERSION) return; // incompatible version, start fresh

      this.scheduler = parsed.scheduler;
      this.agents.clear();
      for (const agent of parsed.agents) {
        this.agents.set(agent.featureId, agent);
      }
    } catch {
      // Corrupted state file — start fresh
    }
  }

  /** Persist current state to disk atomically. */
  save(): void {
    const dir = resolve(this.projectRoot, WOMBO_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data: PersistedDaemonState = {
      version: STATE_VERSION,
      scheduler: { ...this.scheduler },
      agents: Array.from(this.agents.values()),
    };

    const p = this.statePath();
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmp, p);
    this.dirty = false;
  }

  /** Schedule a debounced save (100ms). Prevents thrashing during rapid updates. */
  scheduleSave(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.save();
    }, 100);
  }

  /** Force immediate save if dirty. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) this.save();
  }

  // -------------------------------------------------------------------------
  // Listeners
  // -------------------------------------------------------------------------

  /** Register a state change listener. Returns an unsubscribe function. */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emit an event to all listeners (public so AgentRunner can broadcast). */
  emit<T extends EventType>(eventType: T, payload: EventMap[T]): void {
    for (const listener of this.listeners) {
      try {
        listener(eventType, payload);
      } catch {
        // Don't let a bad listener crash the daemon
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scheduler state
  // -------------------------------------------------------------------------

  getSchedulerState(): SchedulerState {
    return { ...this.scheduler };
  }

  getSchedulerStatus(): SchedulerStatus {
    return this.scheduler.status;
  }

  setSchedulerStatus(status: SchedulerStatus, reason?: string): void {
    const previous = this.scheduler.status;
    if (previous === status) return;

    this.scheduler.status = status;
    if (status === "running" && !this.scheduler.startedAt) {
      this.scheduler.startedAt = new Date().toISOString();
    }

    this.scheduleSave();
    this.emit("evt:scheduler-status", { status, reason });
  }

  setMaxConcurrent(n: number): void {
    // 0 means unlimited; negative values clamp to 0 (unlimited); positive values kept as-is
    this.scheduler.maxConcurrent = Math.max(0, n);
    this.scheduleSave();
  }

  getMaxConcurrent(): number {
    return this.scheduler.maxConcurrent;
  }

  setModel(model: string | null): void {
    this.scheduler.model = model;
    this.scheduleSave();
  }

  getModel(): string | null {
    return this.scheduler.model;
  }

  setBaseBranch(branch: string): void {
    this.scheduler.baseBranch = branch;
    this.scheduleSave();
  }

  getBaseBranch(): string {
    return this.scheduler.baseBranch;
  }

  setQuestId(questId: string | null): void {
    this.scheduler.questId = questId;
    this.scheduleSave();
  }

  getQuestId(): string | null {
    return this.scheduler.questId;
  }

  // -------------------------------------------------------------------------
  // Pinning / skipping
  // -------------------------------------------------------------------------

  pinTask(taskId: string): void {
    if (!this.scheduler.pinnedTasks.includes(taskId)) {
      this.scheduler.pinnedTasks.push(taskId);
      // Remove from skip list if it was there
      this.scheduler.skippedTasks = this.scheduler.skippedTasks.filter(
        (id) => id !== taskId
      );
      this.scheduleSave();
    }
  }

  unpinTask(taskId: string): void {
    this.scheduler.pinnedTasks = this.scheduler.pinnedTasks.filter(
      (id) => id !== taskId
    );
    this.scheduleSave();
  }

  skipTask(taskId: string): void {
    if (!this.scheduler.skippedTasks.includes(taskId)) {
      this.scheduler.skippedTasks.push(taskId);
      // Remove from pin list if it was there
      this.scheduler.pinnedTasks = this.scheduler.pinnedTasks.filter(
        (id) => id !== taskId
      );
      this.scheduleSave();
    }
  }

  unskipTask(taskId: string): void {
    this.scheduler.skippedTasks = this.scheduler.skippedTasks.filter(
      (id) => id !== taskId
    );
    this.scheduleSave();
  }

  isPinned(taskId: string): boolean {
    return this.scheduler.pinnedTasks.includes(taskId);
  }

  isSkipped(taskId: string): boolean {
    return this.scheduler.skippedTasks.includes(taskId);
  }

  // -------------------------------------------------------------------------
  // Agent CRUD
  // -------------------------------------------------------------------------

  /** Add a new agent to tracking. */
  addAgent(agent: InternalAgentState): void {
    this.agents.set(agent.featureId, agent);
    this.scheduleSave();
    this.emit("evt:agent-status-change", {
      featureId: agent.featureId,
      previousStatus: "queued",
      newStatus: agent.status,
      detail: "Agent added to daemon",
    });
  }

  /** Get an agent by feature ID. */
  getAgent(featureId: string): InternalAgentState | undefined {
    return this.agents.get(featureId);
  }

  /** Get all agents. */
  getAllAgents(): InternalAgentState[] {
    return Array.from(this.agents.values());
  }

  /** Get agents in a specific status. */
  getAgentsByStatus(...statuses: AgentStatus[]): InternalAgentState[] {
    const statusSet = new Set(statuses);
    return this.getAllAgents().filter((a) => statusSet.has(a.status));
  }

  /** Get agents actively consuming concurrency slots. */
  getActiveAgents(): InternalAgentState[] {
    return this.getAllAgents().filter((a) => ACTIVE_STATUSES.has(a.status));
  }

  /** Get agents ready to launch (queued + deps satisfied). */
  getReadyAgents(): InternalAgentState[] {
    return this.getAllAgents().filter(
      (a) => a.status === "queued" && this.areDepsReady(a)
    );
  }

  /** Number of available concurrency slots. 0 means unlimited. */
  availableSlots(): number {
    if (this.scheduler.maxConcurrent === 0) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, this.scheduler.maxConcurrent - this.getActiveAgents().length);
  }

  /** Check if all agents are in terminal states. */
  allComplete(): boolean {
    if (this.agents.size === 0) return true;
    return this.getAllAgents().every((a) => TERMINAL_STATUSES.has(a.status));
  }

  /** Update an agent's status with event emission. */
  updateAgentStatus(
    featureId: string,
    newStatus: AgentStatus,
    detail?: string
  ): void {
    const agent = this.agents.get(featureId);
    if (!agent) return;

    const previousStatus = agent.status;
    if (previousStatus === newStatus) return;

    agent.status = newStatus;

    // Track timestamps
    if (ACTIVE_STATUSES.has(newStatus) && !agent.startedAt) {
      agent.startedAt = new Date().toISOString();
    }
    if (TERMINAL_STATUSES.has(newStatus) && !agent.completedAt) {
      agent.completedAt = new Date().toISOString();
    }

    // Track stats
    if (newStatus === "merged" || newStatus === "verified") {
      this.scheduler.totalCompleted++;
    }
    if (newStatus === "failed") {
      this.scheduler.totalFailed++;
    }

    this.scheduleSave();
    this.emit("evt:agent-status-change", {
      featureId,
      previousStatus,
      newStatus,
      detail,
    });
  }

  /** Update arbitrary agent fields (does NOT emit status change — use updateAgentStatus for that). */
  updateAgent(featureId: string, updates: Partial<InternalAgentState>): void {
    const agent = this.agents.get(featureId);
    if (!agent) return;

    // Don't allow status change through this method
    const { status: _status, ...safeUpdates } = updates;
    Object.assign(agent, safeUpdates);
    this.scheduleSave();
  }

  /** Update agent activity and emit activity event. */
  updateAgentActivity(featureId: string, activity: string): void {
    const agent = this.agents.get(featureId);
    if (!agent) return;

    agent.activity = activity;
    agent.activityUpdatedAt = new Date().toISOString();
    // Don't schedule save for activity — too frequent. Just emit.
    this.emit("evt:agent-activity", { featureId, activity });
  }

  /** Remove an agent from tracking. */
  removeAgent(featureId: string): void {
    this.agents.delete(featureId);
    this.scheduleSave();
  }

  /** Cancel downstream agents when a dependency fails. Returns cancelled IDs. */
  cancelDownstream(failedFeatureId: string): string[] {
    const cancelled: string[] = [];
    const downstream = this.getDownstreamAgents(failedFeatureId);

    for (const agent of downstream) {
      if (!TERMINAL_STATUSES.has(agent.status)) {
        this.updateAgentStatus(
          agent.featureId,
          "failed",
          `Dependency "${failedFeatureId}" failed — downstream cancelled`
        );
        agent.error = `Dependency "${failedFeatureId}" failed — downstream cancelled`;
        cancelled.push(agent.featureId);
      }
    }

    return cancelled;
  }

  /** Increment retry count and set status to retry. */
  retryAgent(featureId: string): boolean {
    const agent = this.agents.get(featureId);
    if (!agent) return false;
    if (agent.retries >= agent.maxRetries) return false;

    agent.retries++;
    agent.error = null;
    agent.buildPassed = null;
    agent.completedAt = null;
    this.updateAgentStatus(featureId, "retry", `Retry ${agent.retries}/${agent.maxRetries}`);
    return true;
  }

  // -------------------------------------------------------------------------
  // Dependency resolution
  // -------------------------------------------------------------------------

  /** Check if all of an agent's dependencies are in satisfied states. */
  areDepsReady(agent: InternalAgentState): boolean {
    if (agent.dependsOn.length === 0) return true;

    for (const depId of agent.dependsOn) {
      const depAgent = this.agents.get(depId);
      if (depAgent && !DEP_SATISFIED_STATUSES.has(depAgent.status)) {
        return false;
      }
      // If dep agent doesn't exist in tracking, assume it was already completed externally
    }
    return true;
  }

  /** Get all transitive downstream agents for a given feature ID. */
  private getDownstreamAgents(featureId: string): InternalAgentState[] {
    const visited = new Set<string>();
    const result: InternalAgentState[] = [];

    const collect = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);

      for (const agent of this.agents.values()) {
        if (agent.dependsOn.includes(id)) {
          result.push(agent);
          collect(agent.featureId);
        }
      }
    };

    collect(featureId);
    return result;
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  /** Build a full state snapshot for sending to clients. */
  getSnapshot(): EvtStateSnapshot {
    return {
      scheduler: this.getSchedulerState(),
      agents: this.getAllAgents().map((a) => this.toClientAgent(a)),
      uptime: 0, // Daemon fills this in
    };
  }

  /** Convert internal agent state to client-facing state. */
  private toClientAgent(agent: InternalAgentState): DaemonAgentState {
    // Strip internal-only fields
    const {
      buildOutput: _buildOutput,
      mergeQueuePosition: _mergeQueuePosition,
      ...clientState
    } = agent;
    return clientState;
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Clear all completed/failed agents from tracking. */
  clearCompleted(): number {
    let cleared = 0;
    for (const [id, agent] of this.agents) {
      if (TERMINAL_STATUSES.has(agent.status)) {
        this.agents.delete(id);
        cleared++;
      }
    }
    if (cleared > 0) this.scheduleSave();
    return cleared;
  }

  /** Reset everything to initial state. */
  reset(): void {
    this.agents.clear();
    this.scheduler = DaemonState.defaultSchedulerState();
    this.scheduleSave();
    this.emit("evt:scheduler-status", {
      status: "idle",
      reason: "State reset",
    });
  }

  /** Stop the flush timer (call on daemon shutdown). */
  destroy(): void {
    this.flush();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private statePath(): string {
    return resolve(this.projectRoot, WOMBO_DIR, STATE_FILE);
  }

  private static defaultSchedulerState(): SchedulerState {
    return {
      status: "idle",
      maxConcurrent: 4,
      model: null,
      baseBranch: "main",
      questId: null,
      startedAt: null,
      pinnedTasks: [],
      skippedTasks: [],
      totalProcessed: 0,
      totalCompleted: 0,
      totalFailed: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory for creating InternalAgentState from task data
// ---------------------------------------------------------------------------

export function createDaemonAgentState(opts: {
  featureId: string;
  taskTitle: string;
  branch: string;
  baseBranch: string;
  worktree: string;
  maxRetries?: number;
  dependsOn?: string[];
  dependedOnBy?: string[];
  streamIndex?: number | null;
  agentName?: string | null;
  agentType?: string | null;
  effortEstimateMs?: number | null;
}): InternalAgentState {
  return {
    featureId: opts.featureId,
    taskTitle: opts.taskTitle,
    branch: opts.branch,
    baseBranch: opts.baseBranch,
    worktree: opts.worktree,
    status: "queued",
    pid: null,
    sessionId: null,
    activity: null,
    activityUpdatedAt: null,
    retries: 0,
    maxRetries: opts.maxRetries ?? 2,
    startedAt: null,
    completedAt: null,
    buildPassed: null,
    error: null,
    effortEstimateMs: opts.effortEstimateMs ?? null,
    streamIndex: opts.streamIndex ?? null,
    dependsOn: opts.dependsOn ?? [],
    dependedOnBy: opts.dependedOnBy ?? [],
    agentName: opts.agentName ?? null,
    agentType: opts.agentType ?? null,
    pendingQuestions: [],
    tokenUsage: null,
    // Internal fields
    buildOutput: null,
    mergeQueuePosition: null,
  };
}
