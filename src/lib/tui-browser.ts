/**
 * tui-browser.ts — Task browser view for the wombo-combo TUI.
 *
 * Shows all tasks organized by dependency streams with checkboxes for
 * selection. Users can evaluate tasks, order them, select/deselect
 * entire streams, and launch a wave with the selected tasks.
 *
 * Layout:
 *   ┌───────────────────────────────────────────────────────┐
 *   │ WOMBO-COMBO Task Browser  │ 42 tasks │ 5 selected    │
 *   ├──────────────────────────────┬────────────────────────┤
 *   │ ☑ json-features-check  done │ Title: ...             │
 *   │ ☑ json-features-arch   done │ Status: backlog        │
 *   │   ☐ json-ops-commands  back │ Priority: high         │
 *   │ ── stream 2 ──              │ Effort: PT6H           │
 *   │ ☐ tdd-test-detection   done │ Depends on:            │
 *   │ ...                         │   - json-ops-commands  │
 *   ├──────────────────────────────┴────────────────────────┤
 *   │ Space:toggle  S:stream  L:launch  Tab:sort  Q:quit   │
 *   └───────────────────────────────────────────────────────┘
 *
 * Keybinds:
 *   Space     — toggle selection of current task
 *   S         — toggle entire stream (select/deselect all tasks in the group)
 *   A         — select all / deselect all (toggle)
 *   L         — launch selected tasks as a new wave
 *   Tab       — cycle sort field (priority → status → name → effort → stream)
 *   +/-       — change priority of selected task
 *   Enter     — expand/collapse task detail inline
 *   D         — toggle show done tasks (filter)
 *   C         — cycle concurrency level
 *   Q / C-c   — quit (saves session)
 */

import blessed from "neo-blessed";
import type { Widgets } from "neo-blessed";
import type { Task, TasksFile, Priority } from "./tasks.js";
import { loadTasks, loadArchive, parseDurationMinutes, formatDuration, areDependenciesMet, getDoneTaskIds } from "./tasks.js";
import { saveTaskToStore } from "./task-store.js";
import { PRIORITY_ORDER, DIFFICULTY_ORDER } from "./task-schema.js";
import type { TUISession, SortField } from "./tui-session.js";
import { saveTUISession } from "./tui-session.js";
import type { WomboConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskBrowserOptions {
  projectRoot: string;
  config: WomboConfig;
  session: TUISession;
  /** Called when user presses L to launch selected tasks */
  onLaunch: (selectedIds: string[]) => void;
  /** Called when user presses q to quit */
  onQuit: () => void;
  /** Called when user presses Tab to switch to wave monitor (if a wave is running) */
  onSwitchToMonitor?: () => void;
}

/**
 * A task node in the display tree with computed metadata.
 */
interface TaskNode {
  task: Task;
  /** Depth in the dependency chain (0 = leaf/no deps, higher = depends on more) */
  depth: number;
  /** ID of the stream (connected component) this task belongs to */
  streamId: string;
  /** Task IDs that depend on this task */
  dependedOnBy: string[];
}

/**
 * A stream is a group of related tasks connected by dependencies.
 */
interface Stream {
  id: string;
  nodes: TaskNode[];
}

// ---------------------------------------------------------------------------
// Status / Priority display helpers
// ---------------------------------------------------------------------------

const STATUS_ABBREV: Record<string, string> = {
  backlog: "BACK",
  planned: "PLAN",
  in_progress: "PROG",
  blocked: "BLKD",
  in_review: "REVW",
  done: "DONE",
  cancelled: "CANC",
};

const STATUS_COLORS: Record<string, string> = {
  backlog: "gray",
  planned: "blue",
  in_progress: "cyan",
  blocked: "red",
  in_review: "yellow",
  done: "green",
  cancelled: "gray",
};

const PRIORITY_ABBREV: Record<string, string> = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED ",
  low: "LOW ",
  wishlist: "WISH",
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "red",
  high: "yellow",
  medium: "white",
  low: "gray",
  wishlist: "gray",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeBlessedTags(text: string): string {
  return text.replace(/\{/g, "\uFF5B").replace(/\}/g, "\uFF5D");
}

const SORT_FIELDS: SortField[] = ["priority", "status", "name", "effort", "stream"];

// ---------------------------------------------------------------------------
// Task Graph Builder
// ---------------------------------------------------------------------------

/**
 * Build a dependency graph from all tasks and organize them into streams
 * (connected components). Within each stream, tasks are topologically sorted.
 */
function buildTaskGraph(tasks: Task[]): Stream[] {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  // Build reverse dependency map (who depends on me?)
  const dependedOnBy = new Map<string, string[]>();
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!dependedOnBy.has(dep)) dependedOnBy.set(dep, []);
      dependedOnBy.get(dep)!.push(t.id);
    }
  }

  // Find connected components using undirected graph traversal
  const visited = new Set<string>();
  const components: string[][] = [];

  function dfs(id: string, component: string[]): void {
    if (visited.has(id)) return;
    if (!taskMap.has(id)) return; // dep references a task not in our list
    visited.add(id);
    component.push(id);
    // Follow forward deps
    const task = taskMap.get(id)!;
    for (const dep of task.depends_on) dfs(dep, component);
    // Follow reverse deps
    for (const rev of (dependedOnBy.get(id) ?? [])) dfs(rev, component);
  }

  for (const t of tasks) {
    if (!visited.has(t.id)) {
      const comp: string[] = [];
      dfs(t.id, comp);
      components.push(comp);
    }
  }

  // For each component, compute depths and sort topologically
  const streams: Stream[] = [];
  for (const comp of components) {
    // Compute depth: longest path from any leaf (task with no deps in this component)
    const depthMap = new Map<string, number>();
    const compSet = new Set(comp);

    function computeDepth(id: string, visiting: Set<string>): number {
      if (depthMap.has(id)) return depthMap.get(id)!;
      if (visiting.has(id)) return 0; // cycle protection
      visiting.add(id);
      const task = taskMap.get(id);
      if (!task) return 0;
      let maxDepth = 0;
      for (const dep of task.depends_on) {
        if (compSet.has(dep)) {
          maxDepth = Math.max(maxDepth, 1 + computeDepth(dep, visiting));
        }
      }
      visiting.delete(id);
      depthMap.set(id, maxDepth);
      return maxDepth;
    }

    for (const id of comp) computeDepth(id, new Set());

    // Sort: by depth ascending (leaves first), then by priority
    const sorted = [...comp].sort((a, b) => {
      const dA = depthMap.get(a) ?? 0;
      const dB = depthMap.get(b) ?? 0;
      if (dA !== dB) return dA - dB;
      const tA = taskMap.get(a)!;
      const tB = taskMap.get(b)!;
      return PRIORITY_ORDER[tA.priority] - PRIORITY_ORDER[tB.priority];
    });

    // Use the deepest task's ID as the stream ID (it's the "root" task)
    const maxDepthId = sorted[sorted.length - 1];
    const streamId = maxDepthId;

    const nodes: TaskNode[] = sorted.map((id) => ({
      task: taskMap.get(id)!,
      depth: depthMap.get(id) ?? 0,
      streamId,
      dependedOnBy: (dependedOnBy.get(id) ?? []).filter((d) => compSet.has(d)),
    }));

    streams.push({ id: streamId, nodes });
  }

  // Sort streams by highest-priority task in each
  streams.sort((a, b) => {
    const bestA = Math.min(...a.nodes.map((n) => PRIORITY_ORDER[n.task.priority]));
    const bestB = Math.min(...b.nodes.map((n) => PRIORITY_ORDER[n.task.priority]));
    return bestA - bestB;
  });

  return streams;
}

// ---------------------------------------------------------------------------
// Task Browser Class
// ---------------------------------------------------------------------------

export class TaskBrowser {
  private screen: Widgets.Screen;
  private headerBox: Widgets.BoxElement;
  private taskList: Widgets.ListElement;
  private detailBox: Widgets.BoxElement;
  private statusBar: Widgets.BoxElement;

  private projectRoot: string;
  private config: WomboConfig;
  private session: TUISession;
  private onLaunch: (selectedIds: string[]) => void;
  private onQuit: () => void;
  private onSwitchToMonitor?: () => void;

  private allTasks: Task[] = [];
  private archiveTasks: Task[] = [];
  private doneIds: Set<string> = new Set();
  private streams: Stream[] = [];
  /** Flat ordered list of task nodes as displayed */
  private displayNodes: TaskNode[] = [];
  private selectedIndex: number = 0;
  private selected: Set<string>;
  private collapsed: Set<string>;
  private hideDone: boolean = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private hasRunningWave: boolean = false;

  constructor(opts: TaskBrowserOptions) {
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.session = opts.session;
    this.onLaunch = opts.onLaunch;
    this.onQuit = opts.onQuit;
    this.onSwitchToMonitor = opts.onSwitchToMonitor;
    this.selected = new Set(opts.session.selected);
    this.collapsed = new Set(opts.session.collapsed);

    // Load tasks
    this.reloadTasks();

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: "wombo-combo — Task Browser",
      fullUnicode: true,
    });

    // Header
    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Task list (left pane)
    this.taskList = blessed.list({
      top: 3,
      left: 0,
      width: "60%",
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
      label: " Tasks ",
    });

    // Detail pane (right pane)
    this.detailBox = blessed.box({
      top: 3,
      left: "60%",
      width: "40%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      mouse: true,
      border: { type: "line" },
      style: {
        border: { fg: "gray" },
        fg: "white",
      },
      label: " Details ",
    });

    // Status bar
    this.statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Assemble
    this.screen.append(this.headerBox);
    this.screen.append(this.taskList);
    this.screen.append(this.detailBox);
    this.screen.append(this.statusBar);
    this.taskList.focus();

    this.bindKeys();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(): void {
    this.buildDisplay();
    this.refresh();
    this.screen.render();
  }

  stop(): void {
    this.saveSession();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.screen.destroy();
  }

  /**
   * Destroy the browser screen without saving session (caller already saved).
   * Used by the TUI orchestrator after receiving onLaunch — the transition
   * message is already displayed, so we just tear down the blessed screen
   * and clear the terminal for the next view.
   */
  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.screen.destroy();
    // Clear terminal so the next view starts fresh
    process.stdout.write("\x1B[2J\x1B[H");
  }

  /** Let the orchestrator tell us a wave is running (enables Tab to switch) */
  setHasRunningWave(running: boolean): void {
    this.hasRunningWave = running;
    this.refreshStatusBar();
    this.screen.render();
  }

  // -------------------------------------------------------------------------
  // Task Loading
  // -------------------------------------------------------------------------

  private reloadTasks(): void {
    const tasksData = loadTasks(this.projectRoot, this.config);
    const archiveData = loadArchive(this.projectRoot, this.config);
    this.allTasks = tasksData.tasks;
    this.archiveTasks = archiveData.tasks;
    this.doneIds = getDoneTaskIds(tasksData, this.archiveTasks);
    this.streams = buildTaskGraph(this.allTasks);

    // Prune selected IDs that no longer exist
    const validIds = new Set(this.allTasks.map((t) => t.id));
    for (const id of this.selected) {
      if (!validIds.has(id)) this.selected.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Display Building
  // -------------------------------------------------------------------------

  private buildDisplay(): void {
    this.displayNodes = [];
    const sortedStreams = this.sortStreams(this.streams);

    for (const stream of sortedStreams) {
      const sortedNodes = this.sortNodesInStream(stream.nodes);
      for (const node of sortedNodes) {
        if (this.hideDone && node.task.status === "done") continue;
        this.displayNodes.push(node);
      }
    }
  }

  private sortStreams(streams: Stream[]): Stream[] {
    const field = this.session.sortBy;
    const order = this.session.sortOrder === "asc" ? 1 : -1;

    if (field === "stream") return streams; // natural grouping

    return [...streams].sort((a, b) => {
      const bestA = this.streamSortKey(a, field);
      const bestB = this.streamSortKey(b, field);
      return (bestA - bestB) * order;
    });
  }

  private streamSortKey(stream: Stream, field: SortField): number {
    switch (field) {
      case "priority":
        return Math.min(...stream.nodes.map((n) => PRIORITY_ORDER[n.task.priority]));
      case "effort":
        return Math.min(...stream.nodes.map((n) => parseDurationMinutes(n.task.effort)));
      case "status": {
        const STATUS_SORT: Record<string, number> = {
          in_progress: 0, backlog: 1, planned: 2, blocked: 3,
          in_review: 4, done: 5, cancelled: 6,
        };
        return Math.min(...stream.nodes.map((n) => STATUS_SORT[n.task.status] ?? 99));
      }
      case "name":
        return 0; // alpha sort handled differently
      default:
        return 0;
    }
  }

  private sortNodesInStream(nodes: TaskNode[]): TaskNode[] {
    // Always sort by depth within a stream (topological order)
    return [...nodes].sort((a, b) => a.depth - b.depth);
  }

  // -------------------------------------------------------------------------
  // Key Bindings
  // -------------------------------------------------------------------------

  private bindKeys(): void {
    // Quit
    this.screen.key(["q", "C-c"], () => {
      this.stop();
      this.onQuit();
    });

    // Navigate
    this.taskList.on("select item", (_item: any, index: number) => {
      this.selectedIndex = index;
      this.refreshDetail();
      this.screen.render();
    });

    // Space — toggle selection
    this.screen.key(["space"], () => {
      this.toggleCurrent();
    });

    // s — toggle stream
    this.screen.key(["s"], () => {
      this.toggleStream();
    });

    // a — select all / deselect all
    this.screen.key(["a"], () => {
      this.toggleAll();
    });

    // l — launch selected
    this.screen.key(["l"], () => {
      this.launchSelected();
    });

    // Tab — cycle sort / switch to monitor
    this.screen.key(["tab"], () => {
      if (this.hasRunningWave && this.onSwitchToMonitor) {
        this.saveSession();
        this.stop();
        this.onSwitchToMonitor();
      } else {
        this.cycleSort();
      }
    });

    // F5 — cycle sort (alternative when Tab is used for view switch)
    this.screen.key(["f5"], () => {
      this.cycleSort();
    });

    // +/- — change priority
    this.screen.key(["+", "="], () => {
      this.changePriority(-1); // higher priority (lower number)
    });
    this.screen.key(["-"], () => {
      this.changePriority(1); // lower priority (higher number)
    });

    // d — toggle hide done
    this.screen.key(["d"], () => {
      this.hideDone = !this.hideDone;
      this.buildDisplay();
      this.refreshTaskList();
      this.refreshHeader();
      this.refreshStatusBar();
      this.screen.render();
    });

    // c — change concurrency
    this.screen.key(["c"], () => {
      this.cycleConcurrency();
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private toggleCurrent(): void {
    const node = this.displayNodes[this.selectedIndex];
    if (!node) return;
    if (this.selected.has(node.task.id)) {
      this.selected.delete(node.task.id);
    } else {
      this.selected.add(node.task.id);
    }
    this.refreshTaskList();
    this.refreshHeader();
    this.refreshDetail();
    this.refreshStatusBar();
    this.screen.render();
  }

  private toggleStream(): void {
    const node = this.displayNodes[this.selectedIndex];
    if (!node) return;
    const streamId = node.streamId;
    const streamNodes = this.displayNodes.filter((n) => n.streamId === streamId);

    // If all in stream are selected, deselect all; otherwise select all
    const allSelected = streamNodes.every((n) => this.selected.has(n.task.id));
    for (const n of streamNodes) {
      if (allSelected) {
        this.selected.delete(n.task.id);
      } else {
        this.selected.add(n.task.id);
      }
    }

    this.refreshTaskList();
    this.refreshHeader();
    this.refreshDetail();
    this.refreshStatusBar();
    this.screen.render();
  }

  private toggleAll(): void {
    const allSelected = this.displayNodes.every((n) => this.selected.has(n.task.id));
    for (const n of this.displayNodes) {
      if (allSelected) {
        this.selected.delete(n.task.id);
      } else {
        this.selected.add(n.task.id);
      }
    }
    this.refreshTaskList();
    this.refreshHeader();
    this.refreshStatusBar();
    this.screen.render();
  }

  private launchSelected(): void {
    if (this.selected.size === 0) return;
    this.saveSession();
    const ids = [...this.selected];

    // Show a transition message on the existing screen before the caller
    // destroys it — avoids jarring flash of raw console output.
    try {
      this.taskList.setContent("");
      this.detailBox.setContent("");
      this.statusBar.setContent("");
      this.headerBox.setContent(
        ` {bold}{cyan-fg}Launching ${ids.length} task(s)...{/cyan-fg}{/bold}`
      );
      this.screen.render();
    } catch {
      // Screen may already be in a bad state — proceed regardless
    }

    this.onLaunch(ids);
  }

  private cycleSort(): void {
    const idx = SORT_FIELDS.indexOf(this.session.sortBy);
    this.session.sortBy = SORT_FIELDS[(idx + 1) % SORT_FIELDS.length];
    this.buildDisplay();
    this.selectedIndex = Math.min(this.selectedIndex, this.displayNodes.length - 1);
    this.refreshTaskList();
    this.refreshHeader();
    this.refreshStatusBar();
    this.screen.render();
  }

  private changePriority(delta: number): void {
    const node = this.displayNodes[this.selectedIndex];
    if (!node) return;
    const priorities: Priority[] = ["critical", "high", "medium", "low", "wishlist"];
    const currentIdx = priorities.indexOf(node.task.priority);
    const newIdx = Math.max(0, Math.min(priorities.length - 1, currentIdx + delta));
    if (newIdx === currentIdx) return;

    node.task.priority = priorities[newIdx];
    // Persist the change
    saveTaskToStore(this.projectRoot, this.config, node.task);
    this.refreshTaskList();
    this.refreshDetail();
    this.screen.render();
  }

  private cycleConcurrency(): void {
    const levels = [1, 2, 3, 5, 8, 10, 15, 20];
    const idx = levels.indexOf(this.session.maxConcurrent);
    this.session.maxConcurrent = levels[(idx + 1) % levels.length];
    this.refreshStatusBar();
    this.screen.render();
  }

  // -------------------------------------------------------------------------
  // Session Persistence
  // -------------------------------------------------------------------------

  private saveSession(): void {
    this.session.selected = [...this.selected];
    this.session.collapsed = [...this.collapsed];
    saveTUISession(this.projectRoot, this.session);
  }

  // -------------------------------------------------------------------------
  // Refresh Logic
  // -------------------------------------------------------------------------

  private refresh(): void {
    this.refreshHeader();
    this.refreshTaskList();
    this.refreshDetail();
    this.refreshStatusBar();
    this.screen.render();
  }

  private refreshHeader(): void {
    const total = this.allTasks.length;
    const displayed = this.displayNodes.length;
    const selectedCount = this.selected.size;
    const doneCount = this.allTasks.filter((t) => t.status === "done").length;
    const readyCount = this.allTasks.filter(
      (t) => t.status === "backlog" && areDependenciesMet(t, this.doneIds)
    ).length;

    let line1 = ` {bold}wombo-combo{/bold} {cyan-fg}Task Browser{/cyan-fg}`;
    line1 += `  {gray-fg}│{/gray-fg}  {white-fg}${total}{/white-fg} tasks`;
    if (this.hideDone) line1 += ` ({white-fg}${displayed}{/white-fg} shown)`;
    line1 += `  {gray-fg}│{/gray-fg}  {green-fg}${selectedCount}{/green-fg} selected`;

    let line2 = ` {green-fg}${doneCount}{/green-fg} done`;
    line2 += `  {cyan-fg}${readyCount}{/cyan-fg} ready`;
    line2 += `  {gray-fg}│{/gray-fg}  Sort: {yellow-fg}${this.session.sortBy}{/yellow-fg}`;
    line2 += `  {gray-fg}│{/gray-fg}  Concurrency: {yellow-fg}${this.session.maxConcurrent}{/yellow-fg}`;

    this.headerBox.setContent(`${line1}\n${line2}`);
  }

  private refreshTaskList(): void {
    const items: string[] = [];
    let lastStreamId = "";

    for (let i = 0; i < this.displayNodes.length; i++) {
      const node = this.displayNodes[i];
      const t = node.task;

      // Stream separator
      if (node.streamId !== lastStreamId && lastStreamId !== "") {
        // We use a visual separator row — but it's not selectable in blessed list,
        // so we just change the color/style
      }
      lastStreamId = node.streamId;

      // Checkbox
      const isSelected = this.selected.has(t.id);
      const checkbox = isSelected
        ? "{green-fg}\u2611{/green-fg}" // ☑
        : "{gray-fg}\u2610{/gray-fg}";  // ☐

      // Indent based on depth
      const indent = "  ".repeat(node.depth);

      // Dependency readiness indicator
      const depsReady = areDependenciesMet(t, this.doneIds);
      const readyIcon = t.status === "done"
        ? "{green-fg}\u2713{/green-fg}"   // ✓
        : depsReady
          ? "{cyan-fg}\u25CF{/cyan-fg}"   // ● ready
          : "{red-fg}\u25CB{/red-fg}";     // ○ blocked

      // Task ID (truncated)
      const maxIdLen = 26 - node.depth * 2;
      const fid = t.id.length > maxIdLen
        ? t.id.slice(0, maxIdLen - 1) + "\u2026"
        : t.id.padEnd(maxIdLen);

      // Priority
      const pColor = PRIORITY_COLORS[t.priority] ?? "white";
      const pAbbr = PRIORITY_ABBREV[t.priority] ?? t.priority.slice(0, 4).toUpperCase();
      const priority = `{${pColor}-fg}${pAbbr}{/${pColor}-fg}`;

      // Status
      const sColor = STATUS_COLORS[t.status] ?? "white";
      const sAbbr = STATUS_ABBREV[t.status] ?? t.status.slice(0, 4).toUpperCase();
      const status = `{${sColor}-fg}${sAbbr}{/${sColor}-fg}`;

      // Effort
      const effort = formatDuration(parseDurationMinutes(t.effort));

      items.push(
        ` ${checkbox} ${indent}${readyIcon} ${fid} ${priority} ${status} {gray-fg}${effort}{/gray-fg}`
      );
    }

    if (items.length === 0) {
      items.push(" {gray-fg}No tasks found{/gray-fg}");
    }

    const prevSelected = this.selectedIndex;
    this.taskList.setItems(items as any);
    if (prevSelected < items.length) {
      this.taskList.select(prevSelected);
    }
  }

  private refreshDetail(): void {
    const node = this.displayNodes[this.selectedIndex];
    if (!node) {
      this.detailBox.setContent("{gray-fg}No task selected{/gray-fg}");
      return;
    }

    const t = node.task;
    const lines: string[] = [];

    // Title
    lines.push(`{bold}{white-fg}${escapeBlessedTags(t.title)}{/white-fg}{/bold}`);
    lines.push("");

    // Status & Priority
    const sColor = STATUS_COLORS[t.status] ?? "white";
    lines.push(`  Status:     {${sColor}-fg}${t.status}{/${sColor}-fg}`);
    const pColor = PRIORITY_COLORS[t.priority] ?? "white";
    lines.push(`  Priority:   {${pColor}-fg}${t.priority}{/${pColor}-fg}  {gray-fg}(+/- to change){/gray-fg}`);
    lines.push(`  Difficulty:  ${t.difficulty}`);
    lines.push(`  Effort:      ${formatDuration(parseDurationMinutes(t.effort))}`);
    lines.push(`  Completion:  ${t.completion}%`);

    // Selection state
    const isSelected = this.selected.has(t.id);
    lines.push(`  Selected:   ${isSelected ? "{green-fg}yes{/green-fg}" : "{gray-fg}no{/gray-fg}"}`);

    // Dependency readiness
    const depsReady = areDependenciesMet(t, this.doneIds);
    lines.push(`  Deps ready: ${depsReady ? "{green-fg}yes{/green-fg}" : "{red-fg}no{/red-fg}"}`);

    // Stream info
    lines.push(`  Stream:      ${node.streamId}`);
    lines.push(`  Depth:       ${node.depth}`);
    lines.push("");

    // Dependencies
    if (t.depends_on.length > 0) {
      lines.push("{bold}Dependencies:{/bold}");
      for (const dep of t.depends_on) {
        const isDone = this.doneIds.has(dep);
        const icon = isDone ? "{green-fg}\u2713{/green-fg}" : "{red-fg}\u2717{/red-fg}";
        lines.push(`  ${icon} ${dep}`);
      }
      lines.push("");
    }

    // Depended on by
    if (node.dependedOnBy.length > 0) {
      lines.push("{bold}Depended on by:{/bold}");
      for (const id of node.dependedOnBy) {
        lines.push(`  \u2192 ${id}`);
      }
      lines.push("");
    }

    // Description
    if (t.description) {
      lines.push("{bold}Description:{/bold}");
      const desc = escapeBlessedTags(t.description.trim());
      // Word-wrap to roughly 38 chars
      const words = desc.split(/\s+/);
      let line = " ";
      for (const w of words) {
        if (line.length + w.length > 36) {
          lines.push(line);
          line = " " + w;
        } else {
          line += " " + w;
        }
      }
      if (line.trim()) lines.push(line);
      lines.push("");
    }

    // Agent type
    if (t.agent_type) {
      lines.push(`{bold}Agent:{/bold} ${escapeBlessedTags(t.agent_type)}`);
    }

    // Constraints
    if (t.constraints.length > 0) {
      lines.push("{bold}Constraints:{/bold}");
      for (const c of t.constraints) {
        lines.push(`  \u2022 ${escapeBlessedTags(c)}`);
      }
    }

    this.detailBox.setContent(lines.join("\n"));
    this.detailBox.setLabel(` ${t.id} `);
  }

  private refreshStatusBar(): void {
    const selCount = this.selected.size;
    const readyInSelection = [...this.selected].filter((id) => {
      const t = this.allTasks.find((tt) => tt.id === id);
      return t && (t.status === "backlog" || t.status === "planned") && areDependenciesMet(t, this.doneIds);
    }).length;

    let line1 = ` {bold}Keys:{/bold}`;
    line1 += `  {gray-fg}Space{/gray-fg} toggle`;
    line1 += `  {gray-fg}S{/gray-fg} stream`;
    line1 += `  {gray-fg}A{/gray-fg} all`;
    line1 += `  {gray-fg}+/-{/gray-fg} priority`;
    line1 += `  {gray-fg}D{/gray-fg} ${this.hideDone ? "show" : "hide"} done`;
    line1 += `  {gray-fg}C{/gray-fg} concurrency`;
    line1 += `  {gray-fg}F5{/gray-fg} sort`;

    if (selCount > 0) {
      line1 += `  {bold}{green-fg}L{/green-fg} LAUNCH (${selCount}){/bold}`;
    }
    if (this.hasRunningWave) {
      line1 += `  {gray-fg}Tab{/gray-fg} monitor`;
    }
    line1 += `  {gray-fg}Q{/gray-fg} quit`;

    let line2 = ` `;
    if (selCount > 0) {
      line2 += `{green-fg}${selCount}{/green-fg} selected`;
      line2 += `  {cyan-fg}${readyInSelection}{/cyan-fg} launchable now`;
      const doneInSel = [...this.selected].filter((id) => {
        const t = this.allTasks.find((tt) => tt.id === id);
        return t?.status === "done";
      }).length;
      if (doneInSel > 0) {
        line2 += `  {yellow-fg}${doneInSel} already done (will be skipped){/yellow-fg}`;
      }
    } else {
      line2 += `{gray-fg}Select tasks with Space, then press L to launch{/gray-fg}`;  
    }

    this.statusBar.setContent(`${line1}\n${line2}`);
  }
}
