/**
 * task-browser.test.tsx — Tests for the TaskBrowser Ink component.
 *
 * Verifies:
 *   - Renders header with task count and selected count
 *   - Renders task list items with checkboxes, status, priority
 *   - Detail pane shows task info for selected item
 *   - Status bar shows keybind hints
 *   - Empty state handling
 *   - Quest-filtered mode header
 *   - Dependency readiness indicators
 *   - Sort field display
 *   - Token usage display
 *   - Stream separator rendering
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { TaskBrowserView, type TaskBrowserViewProps, type TaskNode } from "./task-browser";
import type { Task } from "../lib/tasks";
import type { UsageTotals } from "../lib/token-usage";
import type { SortField } from "../lib/tui-session";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test-task",
    title: "Test Task Title",
    description: "A test description for the task",
    status: "backlog",
    completion: 0,
    difficulty: "medium",
    priority: "high",
    depends_on: [],
    effort: "PT2H",
    started_at: null,
    ended_at: null,
    constraints: [],
    forbidden: [],
    references: [],
    notes: [],
    subtasks: [],
    ...overrides,
  };
}

function makeNode(
  overrides: Omit<Partial<TaskNode>, "task"> & { task?: Partial<Task> } = {},
): TaskNode {
  const { task: taskOverrides, ...rest } = overrides;
  return {
    task: makeTask(taskOverrides),
    depth: 0,
    streamId: "stream-1",
    dependedOnBy: [],
    depsReady: true,
    ...rest,
  };
}

const EMPTY_USAGE: UsageTotals = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read: 0,
  cache_write: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
  total_cost: 0,
  record_count: 0,
};

function defaultProps(overrides: Partial<TaskBrowserViewProps> = {}): TaskBrowserViewProps {
  return {
    nodes: [makeNode()],
    selectedIndex: 0,
    selectedIds: new Set<string>(),
    sortBy: "priority" as SortField,
    maxConcurrent: 5,
    hideDone: false,
    totalTaskCount: 1,
    doneCount: 0,
    readyCount: 1,
    onSelectionChange: () => {},
    onToggle: () => {},
    onToggleStream: () => {},
    onToggleAll: () => {},
    onCycleSort: () => {},
    onChangePriority: () => {},
    onToggleDone: () => {},
    onCycleConcurrency: () => {},
    onQuit: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Static render tests
// ---------------------------------------------------------------------------

describe("TaskBrowserView (static rendering)", () => {
  test("renders header with task count", () => {
    const output = renderToString(<TaskBrowserView {...defaultProps()} />);
    expect(output).toContain("Task Browser");
    expect(output).toContain("1");
  });

  test("renders quest title in header when in quest mode", () => {
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ questTitle: "Auth Overhaul" })} />
    );
    expect(output).toContain("Auth Overhaul");
  });

  test("renders task title in list", () => {
    const output = renderToString(<TaskBrowserView {...defaultProps()} />);
    expect(output).toContain("test-task");
  });

  test("renders status abbreviation for task", () => {
    const output = renderToString(<TaskBrowserView {...defaultProps()} />);
    expect(output).toContain("BACK");
  });

  test("renders priority abbreviation", () => {
    const output = renderToString(<TaskBrowserView {...defaultProps()} />);
    expect(output).toContain("HIGH");
  });

  test("renders checkbox unchecked when not selected", () => {
    const output = renderToString(<TaskBrowserView {...defaultProps()} />);
    expect(output).toContain("☐");
  });

  test("renders checkbox checked when task is planned", () => {
    // Checkbox reflects task.status === "planned", not selectedIds
    const plannedNode = makeNode({ task: makeTask({ status: "planned" }) });
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ nodes: [plannedNode] })} />
    );
    expect(output).toContain("☑");
  });

  test("shows selected count in header", () => {
    const output = renderToString(
      <TaskBrowserView
        {...defaultProps({ selectedIds: new Set(["test-task"]) })}
      />
    );
    expect(output).toContain("selected");
  });

  test("renders status bar with key hints", () => {
    const output = renderToString(<TaskBrowserView {...defaultProps()} />);
    expect(output).toContain("Space");
    expect(output).toContain("plan/unplan");
    expect(output).toContain("quit");
  });

  test("renders empty state when no tasks", () => {
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ nodes: [], totalTaskCount: 0 })} />
    );
    expect(output).toContain("No tasks");
  });

  test("shows task detail pane", () => {
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ selectedIndex: 0 })} />
    );
    expect(output).toContain("Test Task Title");
    expect(output).toContain("backlog");
    expect(output).toContain("high");
  });

  test("shows description in detail pane", () => {
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ selectedIndex: 0 })} />
    );
    expect(output).toContain("test description");
  });

  test("shows dependencies in detail pane", () => {
    const node = makeNode({
      task: { id: "child-task", depends_on: ["parent-task"] },
    });
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ nodes: [node], selectedIndex: 0 })} />
    );
    expect(output).toContain("parent-task");
  });

  test("shows sort field in header", () => {
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ sortBy: "status" })} />
    );
    expect(output).toContain("status");
  });

  test("shows concurrency in header", () => {
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ maxConcurrent: 3 })} />
    );
    expect(output).toContain("3");
  });

  test("shows infinity symbol for unlimited concurrency", () => {
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ maxConcurrent: 0 })} />
    );
    expect(output).toContain("∞");
  });

  test("shows done count and ready count", () => {
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ doneCount: 3, readyCount: 2 })} />
    );
    expect(output).toContain("3");
    expect(output).toContain("2");
  });

  test("shows token usage when provided for selected task", () => {
    const usage = new Map<string, UsageTotals>();
    usage.set("test-task", {
      ...EMPTY_USAGE,
      input_tokens: 12000,
      output_tokens: 4000,
      total_tokens: 16000,
      total_cost: 0.85,
      record_count: 5,
    });
    const output = renderToString(
      <TaskBrowserView
        {...defaultProps({ selectedIndex: 0, taskUsage: usage })}
      />
    );
    expect(output).toContain("Token Usage");
    expect(output).toContain("12.0k");
  });

  test("does not show a LAUNCH button (planning is via Space key)", () => {
    // The old "select then L to launch" flow is gone.
    // Space directly toggles task.status between backlog and planned.
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ selectedIds: new Set(["test-task"]) })} />
    );
    expect(output).not.toContain("LAUNCH");
  });

  test("shows back hint when onBack is provided", () => {
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ onBack: () => {} })} />
    );
    expect(output).toContain("back");
  });

  test("shows wave running indicator when hasRunningWave", () => {
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ hasRunningWave: true })} />
    );
    expect(output).toContain("WAVE RUNNING");
  });

  test("renders multiple tasks in different streams", () => {
    const nodes = [
      makeNode({ task: { id: "task-1", title: "First" }, streamId: "s1" }),
      makeNode({ task: { id: "task-2", title: "Second" }, streamId: "s2" }),
    ];
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ nodes, totalTaskCount: 2 })} />
    );
    expect(output).toContain("task-1");
    expect(output).toContain("task-2");
  });

  test("shows ready indicator for task with met dependencies", () => {
    const node = makeNode({ depsReady: true, task: { status: "backlog" } });
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ nodes: [node] })} />
    );
    expect(output).toContain("●");
  });

  test("shows blocked indicator for task with unmet dependencies", () => {
    const node = makeNode({ depsReady: false, task: { status: "backlog" } });
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ nodes: [node] })} />
    );
    expect(output).toContain("○");
  });

  test("shows checkmark for done tasks", () => {
    const node = makeNode({ task: { status: "done" } });
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ nodes: [node] })} />
    );
    expect(output).toContain("✓");
  });

  test("shows constraints in detail pane", () => {
    const node = makeNode({
      task: { constraints: ["Must use TypeScript", "No external deps"] },
    });
    const output = renderToString(
      <TaskBrowserView {...defaultProps({ nodes: [node], selectedIndex: 0 })} />
    );
    expect(output).toContain("Must use TypeScript");
    expect(output).toContain("No external deps");
  });
});
