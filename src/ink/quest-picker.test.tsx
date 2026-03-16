/**
 * quest-picker.test.tsx — Tests for the QuestPicker Ink component.
 *
 * Verifies:
 *   - Renders header with quest count
 *   - Renders "All Tasks" row
 *   - Renders quest list items with status badges and priority dots
 *   - Detail pane shows quest info for selected item
 *   - Status bar shows keybind hints
 *   - Empty state handling
 *   - Quest summary display (title, status, completion)
 *   - Token usage display
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { QuestPickerView, type QuestPickerViewProps } from "./quest-picker";
import type { Quest } from "../lib/quest";
import type { UsageTotals } from "../lib/token-usage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    id: "test-quest",
    title: "Test Quest",
    goal: "A test goal for the quest",
    status: "active",
    priority: "high",
    difficulty: "medium",
    depends_on: [],
    branch: "quest/test-quest",
    baseBranch: "main",
    hitlMode: "yolo",
    constraints: { add: [], ban: [], override: {} },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    started_at: "2024-01-01T12:00:00Z",
    ended_at: null,
    notes: [],
    ...overrides,
  };
}

interface QuestSummary {
  quest: Quest;
  totalTasks: number;
  doneTasks: number;
  completionPct: number;
}

function makeSummary(overrides: Partial<QuestSummary> = {}): QuestSummary {
  return {
    quest: makeQuest(),
    totalTasks: 5,
    doneTasks: 2,
    completionPct: 40,
    ...overrides,
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

function defaultProps(overrides: Partial<QuestPickerViewProps> = {}): QuestPickerViewProps {
  return {
    quests: [makeSummary()],
    totalTaskCount: 5,
    selectedIndex: 0,
    onSelect: () => {},
    onQuit: () => {},
    onSelectionChange: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Static render tests
// ---------------------------------------------------------------------------

describe("QuestPickerView (static rendering)", () => {
  test("renders header with quest count", () => {
    const output = renderToString(<QuestPickerView {...defaultProps()} />);
    expect(output).toContain("Quest Picker");
    expect(output).toContain("1");
  });

  test("renders 'All Tasks' row", () => {
    const output = renderToString(<QuestPickerView {...defaultProps()} />);
    expect(output).toContain("All Tasks");
  });

  test("renders quest title", () => {
    const output = renderToString(<QuestPickerView {...defaultProps()} />);
    expect(output).toContain("Test Quest");
  });

  test("renders status abbreviation for quest", () => {
    const output = renderToString(<QuestPickerView {...defaultProps()} />);
    expect(output).toContain("ACTV");
  });

  test("renders completion info", () => {
    const output = renderToString(<QuestPickerView {...defaultProps()} />);
    expect(output).toContain("2/5");
  });

  test("shows 'needs planning' for quests with no tasks", () => {
    const summary = makeSummary({
      quest: makeQuest({ status: "draft" }),
      totalTasks: 0,
      doneTasks: 0,
      completionPct: 0,
    });
    const output = renderToString(
      <QuestPickerView {...defaultProps({ quests: [summary] })} />
    );
    expect(output).toContain("needs planning");
  });

  test("renders status bar with key hints", () => {
    const output = renderToString(<QuestPickerView {...defaultProps()} />);
    expect(output).toContain("Enter");
    expect(output).toContain("quit");
  });

  test("renders empty state when no quests", () => {
    const output = renderToString(
      <QuestPickerView {...defaultProps({ quests: [] })} />
    );
    expect(output).toContain("All Tasks");
    // Should still render header
    expect(output).toContain("Quest Picker");
  });

  test("shows detail pane for All Tasks when selectedIndex is 0", () => {
    const output = renderToString(
      <QuestPickerView {...defaultProps({ selectedIndex: 0 })} />
    );
    expect(output).toContain("Browse all tasks");
  });

  test("shows quest detail when selectedIndex points to a quest", () => {
    const output = renderToString(
      <QuestPickerView {...defaultProps({ selectedIndex: 1 })} />
    );
    expect(output).toContain("Test Quest");
    expect(output).toContain("active");
    expect(output).toContain("high");
  });

  test("shows token usage when provided", () => {
    const usage = new Map<string, UsageTotals>();
    usage.set("test-quest", {
      ...EMPTY_USAGE,
      input_tokens: 15000,
      output_tokens: 5000,
      total_tokens: 20000,
      total_cost: 1.25,
      record_count: 3,
    });
    const output = renderToString(
      <QuestPickerView
        {...defaultProps({ selectedIndex: 1, questUsage: usage })}
      />
    );
    expect(output).toContain("Token Usage");
    expect(output).toContain("15.0k");
  });

  test("renders quest goal in detail pane", () => {
    const output = renderToString(
      <QuestPickerView {...defaultProps({ selectedIndex: 1 })} />
    );
    expect(output).toContain("A test goal");
  });

  test("renders branch info in detail pane", () => {
    const output = renderToString(
      <QuestPickerView {...defaultProps({ selectedIndex: 1 })} />
    );
    expect(output).toContain("quest/test-quest");
  });

  test("shows constraints in detail pane", () => {
    const summary = makeSummary({
      quest: makeQuest({
        constraints: {
          add: ["Must use TypeScript"],
          ban: ["No jQuery"],
          override: {},
        },
      }),
    });
    const output = renderToString(
      <QuestPickerView {...defaultProps({ quests: [summary], selectedIndex: 1 })} />
    );
    expect(output).toContain("Must use TypeScript");
    expect(output).toContain("No jQuery");
  });

  test("renders multiple quests", () => {
    const quests = [
      makeSummary({ quest: makeQuest({ id: "q1", title: "First Quest" }) }),
      makeSummary({ quest: makeQuest({ id: "q2", title: "Second Quest", status: "draft" }) }),
    ];
    const output = renderToString(
      <QuestPickerView {...defaultProps({ quests })} />
    );
    expect(output).toContain("First Quest");
    expect(output).toContain("Second Quest");
    expect(output).toContain("2"); // quest count
  });

  test("shows devMode key hint when devMode is true", () => {
    const output = renderToString(
      <QuestPickerView {...defaultProps({ devMode: true })} />
    );
    expect(output).toContain("seed-fake");
  });

  test("hides devMode key hint when devMode is false", () => {
    const output = renderToString(
      <QuestPickerView {...defaultProps({ devMode: false })} />
    );
    expect(output).not.toContain("seed-fake");
  });
});
