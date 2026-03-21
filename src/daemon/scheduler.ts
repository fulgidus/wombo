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
import { loadFeatures, selectFeatures, sortByPriorityThenEffort, areDependenciesMet, getDoneTaskIds } from "../lib/tasks";
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
  /**
   * Carry-forward concurrency when rebuilding the Scheduler at runtime
   * (e.g. on cmd:start with a new questId). When set, start() treats this
   * value as already pinned — it is applied immediately and the config-default
   * path is skipped. This prevents scheduler reconstruction from resetting
   * a user-established concurrency value back to the config default.
   */
  initialMaxConcurrent?: number;
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

  /**
   * Whether concurrency has been explicitly set this daemon session.
   * Once true, automatic re-invocations of start() (e.g. from task-file
   * watchers) will not silently overwrite the runtime value with the config
   * default. Resets to false when the Scheduler instance is constructed
   * (i.e. on daemon restart or scheduler rebuild).
   */
  concurrencyPinned: boolean = false;

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

    // Guard against double-start only when the tick timer is already active.
    // We must NOT bail out based on persisted status alone — after a daemon
    // restart the persisted status may be "running" but the in-memory tick
    // timer is null (never started). Checking tickTimer covers this case.
    if (this.tickTimer !== null && status === "running") return; // Already running with active timer

    // Apply concurrency setting only on first start (or when the config
    // carries an explicit override via SchedulerConfig.maxConcurrent).
    // Once pinned, automatic re-triggers (task-file watcher, idle restart)
    // must NOT silently overwrite a runtime value set by the user.
    //
    // Special case: when the Scheduler is *reconstructed* at runtime (e.g. on
    // cmd:start with a new questId), the caller passes `initialMaxConcurrent`
    // carrying the previously active value. We apply it and pin immediately so
    // the config-default path below is skipped — preserving whatever concurrency
    // the user had established before the rebuild.
    if (this.config.initialMaxConcurrent !== undefined && !this.concurrencyPinned) {
      state.setMaxConcurrent(this.config.initialMaxConcurrent);
      this.concurrencyPinned = true;
    } else if (!this.concurrencyPinned) {
      const effectiveConcurrency =
        this.config.maxConcurrent ?? this.config.config.defaults?.maxConcurrent;
      if (effectiveConcurrency !== undefined) {
        state.setMaxConcurrent(effectiveConcurrency);
      }
      this.concurrencyPinned = true;
    } else if (this.config.maxConcurrent !== undefined) {
      // An explicit override in the SchedulerConfig (e.g. cmd:start with
      // maxConcurrent payload rebuilds the Scheduler with it set) always wins.
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

    // Start the tick loop — clear any stale timer first so re-activation
    // after going "idle" never leaks a duplicate interval.
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
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

    // Get ready agents (already submitted and queued with deps satisfied).
    // These are launched up to the concurrency limit.  We sort pinned ones
    // first so pins are honoured even among pre-queued agents.
    const readyQueued = state.getReadyAgents();
    const pinnedIds = new Set(state.getSchedulerState().pinnedTasks);
    const sortedReady = [
      ...readyQueued.filter((a) => pinnedIds.has(a.featureId)),
      ...readyQueued.filter((a) => !pinnedIds.has(a.featureId)),
    ];

    // Determine how many of the already-queued agents we can launch.
    // availableSlots() = maxConcurrent - active - readyQueued.
    // To get "capacity for launching queued", we need: maxConcurrent - active.
    const max = state.getMaxConcurrent();
    const activeCount = state.getActiveAgents().length;
    const launchCapacity = max === 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, max - activeCount);

    let launched = 0;
    for (const agent of sortedReady) {
      if (launched >= launchCapacity) break;
      this.deps.runner.launchAgent(agent.featureId);
      launched++;
    }

    // How many slots remain open for NEW task submissions after the above?
    // For finite concurrency: remaining capacity minus what we just claimed.
    // For infinite concurrency (max === 0): submit ALL candidates — the slot
    // arithmetic is meaningless and MAX_SAFE_INTEGER - launched can produce
    // large values with no semantic benefit. Using candidateTasks.length is
    // set below after getCandidateTasks() is called.
    const finiteSlots = max === 0 ? null : Math.max(0, launchCapacity - launched);

    // Get candidate tasks from disk that haven't been submitted yet
    const candidateTasks = this.getCandidateTasks();

    const slotsForNew = finiteSlots !== null ? finiteSlots : candidateTasks.length;

    if (slotsForNew > 0 && candidateTasks.length > 0) {
      // Merge: pinned tasks first, then new candidates
      const toSubmit = this.prioritize([], candidateTasks, slotsForNew);

      for (const item of toSubmit) {
        if (item.type === "queued-agent") {
          // Should not happen (readyQueued already launched above), but guard
          this.deps.runner.launchAgent(item.featureId);
        } else {
          // New task: create agent state and submit
          this.submitNewTask(item.task);
        }
      }
    }

    // Check if we're completely done (no running, no queued, no candidates)
    if (
      state.allComplete() &&
      candidateTasks.length === 0 &&
      readyQueued.length === 0
    ) {
      state.setSchedulerStatus("idle", "All tasks processed");
      // Stop the tick timer while idle — it will be restarted by start() when
      // new work arrives (e.g. via the tasks-directory watcher).
      if (this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Task selection
  // -------------------------------------------------------------------------

  /** Load tasks from disk and get candidates (not yet submitted). */
  private getCandidateTasks(): Task[] {
    try {
      const data = loadFeatures(this.config.projectRoot, this.config.config);

      // Build the set of "satisfied" dependency IDs.
      // This is the union of:
      //   (a) tasks marked done on disk (status === "done" or completion === 100), and
      //   (b) tasks whose agents are in verified or merged state in the daemon.
      //
      // The daemon sets a task file to "in_progress" when an agent starts, but only
      // marks it "done" after the merge completes.  Without augmenting with daemon
      // state, downstream tasks would be invisible to the scheduler during the entire
      // window between "agent completed" and "merge landed" — blocking concurrency.
      const diskDoneIds = getDoneTaskIds(data, data.archive);
      const daemonSatisfiedIds = new Set<string>();
      for (const agent of this.deps.state.getAllAgents()) {
        if (agent.status === "verified" || agent.status === "merged") {
          daemonSatisfiedIds.add(agent.featureId);
        }
      }
      // Merge: a dep is satisfied if it's done on disk OR verified/merged in daemon
      const satisfiedIds = new Set<string>([...diskDoneIds, ...daemonSatisfiedIds]);

      // If specific task IDs were requested, only consider those
      let tasks: Task[];
      if (this.config.taskIds?.length) {
        const idSet = new Set(this.config.taskIds);
        tasks = data.tasks.filter(
          (t) =>
            idSet.has(t.id) &&
            t.status === "planned" &&
            (t.completion === undefined || t.completion === 0) &&
            areDependenciesMet(t, satisfiedIds)
        );
      } else {
        // All planned tasks whose deps are satisfied (disk-done OR daemon-verified)
        tasks = data.tasks.filter(
          (t) =>
            t.status === "planned" &&
            (t.completion === undefined || t.completion === 0) &&
            areDependenciesMet(t, satisfiedIds)
        );
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

  /** Retry a failed agent. Resets retry count if exhausted (user-initiated). */
  retryAgent(featureId: string): void {
    // Always remove from submittedTasks so the file-scan path can re-pick the task
    // if the agent is no longer in state (zombie reaped, daemon restarted, etc.)
    this.submittedTasks.delete(featureId);

    const agent = this.deps.state.getAgent(featureId);
    if (!agent) {
      // Agent was removed from state — the task file was (or will be) set to "planned"
      // by handleRetry in the TUI. Removing from submittedTasks above is enough;
      // the next tick will re-pick it as a fresh task.
      if (this.deps.state.getSchedulerStatus() === "running") {
        this.tick();
      }
      return;
    }

    // Agent is still in state — reset and re-queue
    if (!this.deps.state.retryAgent(featureId)) {
      // Retries exhausted — force-reset so user-initiated retry always works
      agent.retries = 0;
      agent.error = null;
      agent.buildPassed = null;
      agent.completedAt = null;
    }
    // Re-set to queued so the next tick picks it up via launchAgent
    this.deps.state.updateAgentStatus(featureId, "queued", "Retry requested by user");
    if (this.deps.state.getSchedulerStatus() === "running") {
      this.tick();
    }
  }

  /** Update concurrency at runtime. */
  setConcurrency(n: number): void {
    this.deps.state.setMaxConcurrent(n);
    this.concurrencyPinned = true;
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
