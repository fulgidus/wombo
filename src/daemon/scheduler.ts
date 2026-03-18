/**
 * scheduler.ts — Continuous DAG scheduler for the daemon.
 *
 * Replaces the wave-based batch model with a continuous pipeline.
 * The scheduler:
 * 1. Watches for ready tasks (backlog + deps met + not skipped)
 * 2. Respects pinning (pinned tasks jump to front of queue)
 * 3. Picks highest-priority ready tasks up to max concurrency
 * 4. Delegates to AgentRunner for lifecycle management
 * 5. Loops until stopped or all tasks are done
 *
 * The tick loop runs on a configurable interval (default 3s).
 */

import type { WomboConfig } from "../config";
import { loadFeatures, selectFeatures, sortByPriorityThenEffort } from "../lib/tasks";
import type { Task, FeaturesFile } from "../lib/tasks";
import { buildDepGraph, validateDepGraph, buildSchedulePlan } from "../lib/dependency-graph";
import type { DepGraph, SchedulePlan } from "../lib/dependency-graph";
import type { DaemonState, InternalAgentState } from "./state";
import type { AgentRunner } from "./agent-runner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchedulerConfig {
  /** Project root directory */
  projectRoot: string;
  /** Loaded wombo config */
  config: WomboConfig;
  /** Tick interval in ms (how often to check for work) */
  tickIntervalMs?: number;
  /** Specific task IDs to process (empty = auto-pick all ready) */
  taskIds?: string[];
  /** Quest ID to scope task selection */
  questId?: string | null;
  /** Override max concurrency */
  maxConcurrent?: number;
  /** Override model */
  model?: string | null;
}

export interface SchedulerDeps {
  state: DaemonState;
  runner: AgentRunner;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private config: SchedulerConfig;
  private deps: SchedulerDeps;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private depGraph: DepGraph | null = null;
  private schedulePlan: SchedulePlan | null = null;

  /** Set of task IDs already submitted to the runner (prevent double-launch). */
  private submittedTasks = new Set<string>();

  constructor(config: SchedulerConfig, deps: SchedulerDeps) {
    this.config = config;
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the scheduler loop. */
  start(): void {
    const { state } = this.deps;
    const status = state.getSchedulerStatus();

    if (status === "running") return; // Already running

    // Apply config overrides
    if (this.config.maxConcurrent !== undefined) {
      state.setMaxConcurrent(this.config.maxConcurrent);
    }
    if (this.config.model !== undefined) {
      state.setModel(this.config.model);
    }
    if (this.config.questId !== undefined) {
      state.setQuestId(this.config.questId);
    }

    state.setBaseBranch(this.config.config.baseBranch);
    state.setSchedulerStatus("running", "Scheduler started");

    // Build initial dependency graph
    this.rebuildDepGraph();

    // Start the tick loop
    const interval = this.config.tickIntervalMs ?? 3000;
    this.tickTimer = setInterval(() => this.tick(), interval);

    // Immediate first tick
    this.tick();
  }

  /** Pause the scheduler (running agents continue, no new picks). */
  pause(): void {
    this.deps.state.setSchedulerStatus("paused", "User paused");
  }

  /** Resume a paused scheduler. */
  resume(): void {
    const status = this.deps.state.getSchedulerStatus();
    if (status === "paused") {
      this.deps.state.setSchedulerStatus("running", "User resumed");
      this.tick(); // Immediate tick
    }
  }

  /** Trigger an immediate tick (e.g. after new tasks become planned). */
  nudge(): void {
    if (this.deps.state.getSchedulerStatus() === "running") {
      this.tick();
    }
  }

  /** Stop gracefully: finish running agents, no new picks, then idle. */
  stop(): void {
    this.deps.state.setSchedulerStatus("stopping", "User stopping");
    // The tick loop will detect "stopping" and transition to "idle" when all agents finish
  }

  /** Force-kill all agents and stop immediately. */
  async kill(): Promise<void> {
    this.deps.state.setSchedulerStatus("stopping", "Force kill");
    await this.deps.runner.killAll();
    this.deps.state.setSchedulerStatus("idle", "Force killed");
  }

  /** Shutdown the scheduler entirely (stops the tick loop). */
  shutdown(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.deps.state.setSchedulerStatus("shutdown", "Scheduler shutdown");
  }

  // -------------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------------

  /** Single tick: check state, pick tasks, handle completions. */
  private tick(): void {
    const { state } = this.deps;
    const status = state.getSchedulerStatus();

    // Don't do anything if we're not running
    if (status !== "running" && status !== "stopping" && status !== "draining") {
      return;
    }

    // If stopping/draining and all agents are done, transition to idle
    if (status === "stopping" || status === "draining") {
      if (state.allComplete()) {
        state.setSchedulerStatus("idle", "All agents finished");
        this.shutdown();
      }
      return; // Don't pick new tasks while stopping
    }

    // Check for dead processes (zombie detection)
    this.deps.runner.reapDeadProcesses();

    // Refresh task data from disk (tasks may have been added/modified externally)
    this.rebuildDepGraph();

    // How many slots are available?
    const availableSlots = state.availableSlots();
    if (availableSlots <= 0) return;

    // Get ready agents (already submitted but queued)
    const readyQueued = state.getReadyAgents();

    // Get candidate tasks from disk that haven't been submitted yet
    const candidateTasks = this.getCandidateTasks();

    // Merge: pinned tasks first, then ready queued agents, then new candidates
    const toSubmit = this.prioritize(readyQueued, candidateTasks, availableSlots);

    // Submit each
    for (const item of toSubmit) {
      if (item.type === "queued-agent") {
        // Agent already in state, just tell runner to launch it
        this.deps.runner.launchAgent(item.featureId);
      } else {
        // New task: create agent state and submit
        this.submitNewTask(item.task);
      }
    }

    // Check if we're completely done (no running, no queued, no candidates)
    if (
      state.allComplete() &&
      candidateTasks.length === 0 &&
      readyQueued.length === 0
    ) {
      state.setSchedulerStatus("idle", "All tasks processed");
    }
  }

  // -------------------------------------------------------------------------
  // Task selection
  // -------------------------------------------------------------------------

  /** Load tasks from disk and get candidates (not yet submitted). */
  private getCandidateTasks(): Task[] {
    try {
      const data = loadFeatures(this.config.projectRoot, this.config.config);

      // If specific task IDs were requested, only consider those
      let tasks: Task[];
      if (this.config.taskIds?.length) {
        tasks = selectFeatures(data, { taskIds: this.config.taskIds, allReady: false });
      } else {
        tasks = selectFeatures(data, { allReady: true });
      }

      // Filter by quest if scoped
      const questId = this.deps.state.getQuestId();
      if (questId) {
        tasks = tasks.filter((t) => t.quest === questId);
      }

      // Remove already-submitted tasks
      tasks = tasks.filter((t) => !this.submittedTasks.has(t.id));

      // Remove skipped tasks
      tasks = tasks.filter((t) => !this.deps.state.isSkipped(t.id));

      return sortByPriorityThenEffort(tasks);
    } catch {
      return [];
    }
  }

  /** Rebuild the dependency graph from current task data. */
  private rebuildDepGraph(): void {
    try {
      const data = loadFeatures(this.config.projectRoot, this.config.config);
      this.depGraph = validateDepGraph(buildDepGraph(data.tasks, data.tasks));
      this.schedulePlan = buildSchedulePlan(this.depGraph);
    } catch {
      // If we can't build the graph, continue without one
      this.depGraph = null;
      this.schedulePlan = null;
    }
  }

  // -------------------------------------------------------------------------
  // Prioritization
  // -------------------------------------------------------------------------

  private prioritize(
    readyQueued: InternalAgentState[],
    candidateTasks: Task[],
    availableSlots: number
  ): Array<{ type: "queued-agent"; featureId: string } | { type: "new-task"; task: Task }> {
    const result: Array<
      { type: "queued-agent"; featureId: string } | { type: "new-task"; task: Task }
    > = [];

    const { state } = this.deps;
    let remaining = availableSlots;

    // 1. Pinned tasks first (from either pool)
    const pinnedTasks = state.getSchedulerState().pinnedTasks;

    for (const pinnedId of pinnedTasks) {
      if (remaining <= 0) break;

      // Check queued agents
      const queuedAgent = readyQueued.find((a) => a.featureId === pinnedId);
      if (queuedAgent) {
        result.push({ type: "queued-agent", featureId: pinnedId });
        readyQueued = readyQueued.filter((a) => a.featureId !== pinnedId);
        state.unpinTask(pinnedId); // Consume the pin
        remaining--;
        continue;
      }

      // Check candidate tasks
      const candidateTask = candidateTasks.find((t) => t.id === pinnedId);
      if (candidateTask) {
        result.push({ type: "new-task", task: candidateTask });
        candidateTasks = candidateTasks.filter((t) => t.id !== pinnedId);
        state.unpinTask(pinnedId);
        remaining--;
      }
    }

    // 2. Ready queued agents (already in the system, waiting for deps)
    for (const agent of readyQueued) {
      if (remaining <= 0) break;
      result.push({ type: "queued-agent", featureId: agent.featureId });
      remaining--;
    }

    // 3. New candidate tasks from disk
    for (const task of candidateTasks) {
      if (remaining <= 0) break;
      result.push({ type: "new-task", task });
      remaining--;
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Task submission
  // -------------------------------------------------------------------------

  /** Submit a new task to the agent runner pipeline. */
  private submitNewTask(task: Task): void {
    this.submittedTasks.add(task.id);
    this.deps.state.getSchedulerState().totalProcessed++;

    // Delegate to the runner to handle worktree creation, prompt gen, and launch
    this.deps.runner.submitTask(task);
  }

  // -------------------------------------------------------------------------
  // External signals
  // -------------------------------------------------------------------------

  /** Pin a task to run next. */
  pinTask(taskId: string): void {
    this.deps.state.pinTask(taskId);
    // Trigger an immediate tick to try to schedule it
    if (this.deps.state.getSchedulerStatus() === "running") {
      this.tick();
    }
  }

  /** Skip a task. If it has a queued agent, cancel it. */
  skipTask(taskId: string): void {
    this.deps.state.skipTask(taskId);
    // If there's a queued agent for this task, cancel it
    const agent = this.deps.state.getAgent(taskId);
    if (agent && agent.status === "queued") {
      this.deps.state.updateAgentStatus(taskId, "failed", "Skipped by user");
    }
  }

  /** Retry a failed agent. */
  retryAgent(featureId: string): void {
    if (this.deps.state.retryAgent(featureId)) {
      // Re-set to queued so the next tick picks it up
      this.deps.state.updateAgentStatus(featureId, "queued", "Retry requested");
      if (this.deps.state.getSchedulerStatus() === "running") {
        this.tick();
      }
    }
  }

  /** Update concurrency at runtime. */
  setConcurrency(n: number): void {
    this.deps.state.setMaxConcurrent(n);
    // Tick immediately in case we freed up slots
    if (this.deps.state.getSchedulerStatus() === "running") {
      this.tick();
    }
  }

  /** Cancel a specific agent. */
  cancelAgent(featureId: string): void {
    this.deps.runner.cancelAgent(featureId);
    this.deps.state.updateAgentStatus(featureId, "failed", "Cancelled by user");
    this.deps.state.cancelDownstream(featureId);
  }
}
