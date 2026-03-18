/**
 * run-task-browser.tsx — Standalone launcher for the TaskBrowserView.
 *
 * Creates and destroys its own Ink render instance, returning a Promise
 * that resolves with the user's action (launch, quit, back, errand, etc.).
 *
 * Manages all data loading (tasks, archive, graph, session, usage) and
 * state (selection, sort, concurrency, hide-done) internally — the
 * TaskBrowserView is a pure view component.
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { render } from "ink";
import { TaskBrowserView, type TaskNode } from "./task-browser";
import { buildTaskGraph, sortStreams, flattenStreams, type Stream } from "./task-graph";
import { loadTasks, getDoneTaskIds, loadArchive, areDependenciesMet } from "../lib/tasks";
import { PRIORITY_ORDER } from "../lib/task-schema";
import { loadTUISession, saveTUISession, type SortField, type TUISession } from "../lib/tui-session";
import { saveTaskToStore, saveTaskToArchive, removeTaskFromStore } from "../lib/task-store";
import { loadUsageRecords, totalUsage, groupBy as groupUsageBy } from "../lib/token-usage";
import type { UsageTotals } from "../lib/token-usage";
import type { WomboConfig } from "../config";
import type { ErrandSpec } from "../lib/errand-planner";

// ---------------------------------------------------------------------------
// Sort field cycle order
// ---------------------------------------------------------------------------

const SORT_FIELDS: SortField[] = ["priority", "status", "name", "effort", "stream"];

// Concurrency levels for cycling
const CONCURRENCY_LEVELS = [0, 1, 2, 3, 5, 8, 10, 15, 20];

// Priority cycle array
const PRIORITIES = ["critical", "high", "medium", "low", "wishlist"] as const;

// ---------------------------------------------------------------------------
// Action Type
// ---------------------------------------------------------------------------

export type TaskBrowserAction =
  | { type: "errand"; spec: ErrandSpec }
  | { type: "back" }
  | { type: "switchToMonitor" }
  | { type: "wishlist" }
  | { type: "quit" };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunTaskBrowserOptions {
  projectRoot: string;
  config: WomboConfig;
  /** If set, filter to only tasks belonging to this quest */
  questId?: string | null;
  /** Human-readable quest title for header display */
  questTitle?: string;
  /** Task IDs belonging to the selected quest (for filtering) */
  questTaskIds?: string[];
  /** Whether a wave is currently running (affects Tab behavior) */
  hasRunningWave?: boolean;
  /** Whether to show the Back action (Escape) */
  showBack?: boolean;
}

// ---------------------------------------------------------------------------
// Stateful Wrapper Component
// ---------------------------------------------------------------------------

function TaskBrowserApp({
  projectRoot,
  config,
  questId,
  questTitle,
  questTaskIds,
  hasRunningWave,
  showBack,
  onAction,
}: RunTaskBrowserOptions & {
  onAction: (action: TaskBrowserAction) => void;
}) {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [displayNodes, setDisplayNodes] = useState<TaskNode[]>([]);
  const [allTasks, setAllTasks] = useState<any[]>([]);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hideDone, setHideDone] = useState(false);
  const [taskUsage, setTaskUsage] = useState<Map<string, UsageTotals>>(new Map());

  // Session state
  const sessionRef = useRef<TUISession>(loadTUISession(projectRoot));
  const [sortBy, setSortBy] = useState<SortField>(sessionRef.current.sortBy);
  const [maxConcurrent, setMaxConcurrent] = useState(sessionRef.current.maxConcurrent);

  // Quest filter set
  const questIdSet = useRef<Set<string> | null>(
    questTaskIds ? new Set(questTaskIds) : null
  );

  // Load data
  const loadData = useCallback(() => {
    const tasksData = loadTasks(projectRoot, config);
    const archiveData = loadArchive(projectRoot, config);
    const done = getDoneTaskIds(tasksData, archiveData.tasks);

    let tasks = tasksData.tasks;
    if (questIdSet.current) {
      tasks = tasks.filter((t) => questIdSet.current!.has(t.id));
    }

    setAllTasks(tasks);
    setDoneIds(done);

    const built = buildTaskGraph(tasks, done);
    setStreams(built);

    // Restore selection from session, pruning stale IDs
    const validIds = new Set(tasks.map((t) => t.id));
    const restored = new Set(
      sessionRef.current.selected.filter((id) => validIds.has(id))
    );
    setSelectedIds(restored);

    // Load token usage
    try {
      const records = loadUsageRecords(projectRoot);
      if (records.length > 0) {
        setTaskUsage(groupUsageBy(records, "task_id"));
      }
    } catch {
      // Non-critical
    }

    return { built, done };
  }, [projectRoot, config]);

  // Build display nodes whenever streams, sort, or hideDone change
  useEffect(() => {
    const sorted = sortStreams(streams, sortBy, sessionRef.current.sortOrder);
    setDisplayNodes(flattenStreams(sorted, hideDone));
  }, [streams, sortBy, hideDone]);

  // Initial load
  useEffect(() => {
    loadData();
  }, [loadData]);

  // Save session helper
  const saveSession = useCallback(() => {
    sessionRef.current = {
      ...sessionRef.current,
      selected: [...selectedIds],
      sortBy,
      maxConcurrent,
      lastView: "browser",
    };
    saveTUISession(projectRoot, sessionRef.current);
  }, [projectRoot, selectedIds, sortBy, maxConcurrent]);

  // Computed values
  const totalTaskCount = allTasks.length;
  const doneCount = allTasks.filter((t) => t.status === "done").length;
  // Count tasks that are queued for the daemon (status === "planned")
  const readyCount = allTasks.filter((t) => t.status === "planned").length;

  // --- Handlers ---

  /** Toggle a single task between backlog (parked) and planned (queued for daemon). */
  const handleToggle = useCallback(() => {
    const node = displayNodes[selectedIndex];
    if (!node) return;
    const task = node.task;
    // Only toggle tasks that can be queued (backlog or planned, not running/done)
    if (task.status !== "backlog" && task.status !== "planned") return;
    task.status = task.status === "planned" ? "backlog" : "planned";
    saveTaskToStore(projectRoot, config, task);
    loadData();
  }, [displayNodes, selectedIndex, projectRoot, config, loadData]);

  /** Toggle all visible tasks in the current stream between backlog and planned. */
  const handleToggleStream = useCallback(() => {
    if (!displayNodes[selectedIndex]) return;
    const streamId = displayNodes[selectedIndex].streamId;
    const streamNodes = displayNodes.filter(
      (n) => n.streamId === streamId && (n.task.status === "backlog" || n.task.status === "planned")
    );
    const allPlanned = streamNodes.every((n) => n.task.status === "planned");
    for (const n of streamNodes) {
      n.task.status = allPlanned ? "backlog" : "planned";
      saveTaskToStore(projectRoot, config, n.task);
    }
    loadData();
  }, [displayNodes, selectedIndex, projectRoot, config, loadData]);

  /** Toggle all visible backlog/planned tasks. */
  const handleToggleAll = useCallback(() => {
    const toggleable = displayNodes.filter(
      (n) => n.task.status === "backlog" || n.task.status === "planned"
    );
    const allPlanned = toggleable.every((n) => n.task.status === "planned");
    for (const n of toggleable) {
      n.task.status = allPlanned ? "backlog" : "planned";
      saveTaskToStore(projectRoot, config, n.task);
    }
    loadData();
  }, [displayNodes, projectRoot, config, loadData]);

  const handleCycleSort = useCallback(() => {
    setSortBy((prev) => {
      const idx = SORT_FIELDS.indexOf(prev);
      return SORT_FIELDS[(idx + 1) % SORT_FIELDS.length];
    });
  }, []);

  const handleChangePriority = useCallback(
    (delta: number) => {
      const node = displayNodes[selectedIndex];
      if (!node) return;
      const currentIdx = PRIORITIES.indexOf(node.task.priority as any);
      if (currentIdx < 0) return;
      const newIdx = Math.max(0, Math.min(PRIORITIES.length - 1, currentIdx + delta));
      if (newIdx === currentIdx) return;
      node.task.priority = PRIORITIES[newIdx];
      saveTaskToStore(projectRoot, config, node.task);
      // Force re-render by reloading
      loadData();
    },
    [displayNodes, selectedIndex, projectRoot, config, loadData]
  );

  const handleToggleDone = useCallback(() => {
    setHideDone((prev) => !prev);
  }, []);

  const handleCycleConcurrency = useCallback(() => {
    setMaxConcurrent((prev) => {
      const idx = CONCURRENCY_LEVELS.indexOf(prev);
      return CONCURRENCY_LEVELS[(idx + 1) % CONCURRENCY_LEVELS.length];
    });
  }, []);

  const handleQuit = useCallback(() => {
    saveSession();
    if (showBack && questId) {
      onAction({ type: "back" });
    } else {
      onAction({ type: "quit" });
    }
  }, [saveSession, showBack, questId, onAction]);

  const handleBack = useCallback(() => {
    if (showBack) {
      saveSession();
      onAction({ type: "back" });
    }
  }, [showBack, saveSession, onAction]);

  const handleSwitchToMonitor = useCallback(() => {
    if (hasRunningWave) {
      saveSession();
      onAction({ type: "switchToMonitor" });
    } else {
      // No wave running: Tab cycles sort
      handleCycleSort();
    }
  }, [hasRunningWave, saveSession, onAction, handleCycleSort]);

  const handleErrand = useCallback(() => {
    saveSession();
    onAction({ type: "errand", spec: { description: "" } });
  }, [saveSession, onAction]);

  const handleArchiveDone = useCallback(() => {
    // Archive done/cancelled tasks
    const candidates =
      selectedIds.size > 0
        ? allTasks.filter(
            (t) =>
              selectedIds.has(t.id) &&
              (t.status === "done" || t.status === "cancelled")
          )
        : allTasks.filter(
            (t) => t.status === "done" || t.status === "cancelled"
          );

    for (const task of candidates) {
      saveTaskToArchive(projectRoot, config, task);
      removeTaskFromStore(projectRoot, config, task.id);
    }

    loadData();
  }, [selectedIds, allTasks, projectRoot, config, loadData]);

  const handleWishlist = useCallback(() => {
    saveSession();
    onAction({ type: "wishlist" });
  }, [saveSession, onAction]);

  return (
    <TaskBrowserView
      nodes={displayNodes}
      selectedIndex={selectedIndex}
      selectedIds={selectedIds}
      sortBy={sortBy}
      maxConcurrent={maxConcurrent}
      hideDone={hideDone}
      totalTaskCount={totalTaskCount}
      doneCount={doneCount}
      readyCount={readyCount}
      taskUsage={taskUsage}
      questTitle={questTitle}
      hasRunningWave={hasRunningWave}
      onSelectionChange={setSelectedIndex}
      onToggle={handleToggle}
      onToggleStream={handleToggleStream}
      onToggleAll={handleToggleAll}
      onCycleSort={handleCycleSort}
      onChangePriority={handleChangePriority}
      onToggleDone={handleToggleDone}
      onCycleConcurrency={handleCycleConcurrency}
      onQuit={handleQuit}
      onBack={showBack ? handleBack : undefined}
      onSwitchToMonitor={hasRunningWave ? handleSwitchToMonitor : undefined}
      onErrand={handleErrand}
      onArchiveDone={handleArchiveDone}
      onWishlist={handleWishlist}
    />
  );
}

// ---------------------------------------------------------------------------
// Standalone Launcher
// ---------------------------------------------------------------------------

/**
 * Run the task browser as a standalone Ink instance.
 * Returns the user's chosen action.
 */
export function runTaskBrowserInk(
  opts: RunTaskBrowserOptions
): Promise<TaskBrowserAction> {
  return new Promise<TaskBrowserAction>((resolve) => {
    let instance: ReturnType<typeof render>;

    const handleAction = (action: TaskBrowserAction) => {
      instance.unmount();
      resolve(action);
    };

    process.stdin.resume(); // keep event loop alive between renders
    instance = render(
      <TaskBrowserApp
        {...opts}
        onAction={handleAction}
      />,
      { exitOnCtrlC: false }
    );
  });
}
