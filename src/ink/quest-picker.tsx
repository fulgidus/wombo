/**
 * quest-picker.tsx — Ink QuestPickerView component.
 *
 * Replaces the neo-blessed QuestPicker class with a declarative React
 * component. The parent manages data loading, quest operations, and
 * selected index; this component handles rendering and keybind dispatch.
 *
 * Layout:
 *   +-----------------------------------------------------------+
 *   | WOMBO-COMBO Quest Picker  | 4 quests                      |
 *   +---------------------------+-------------------------------+
 *   | > All Tasks (42)          | Quest: auth-overhaul           |
 *   |   auth-overhaul   ACTV    | Status: active                 |
 *   |   search-api      DRFT    | Priority: high                 |
 *   |   perf-optim      PAUS    | Tasks: 8 (3 done, 62%)         |
 *   |   ui-redesign     PLAN    | Goal: Replace basic auth...    |
 *   +---------------------------+-------------------------------+
 *   | Enter:select  C:create  Q:quit                            |
 *   +-----------------------------------------------------------+
 *
 * Keybinds are dispatched via callback props — the parent decides
 * what each action does (load data, navigate, etc.).
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import type { Quest } from "../lib/quest";
import type { UsageTotals } from "../lib/token-usage";
import { formatTokenCount } from "./usage-overlay";
import {
  QUEST_STATUS_COLORS,
  QUEST_STATUS_ABBREV,
  TASK_PRIORITY_COLORS,
  progressBar,
} from "./tui-constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuestSummary {
  quest: Quest;
  totalTasks: number;
  doneTasks: number;
  completionPct: number;
}

export interface QuestPickerViewProps {
  /** Quest summaries to display. */
  quests: QuestSummary[];
  /** Total number of tasks across all quests. */
  totalTaskCount: number;
  /** Currently selected index (0 = "All Tasks", 1+ = quest). */
  selectedIndex: number;
  /** Called when Enter/Space is pressed on the selected item. */
  onSelect: (questId: string | null) => void;
  /** Called when the user presses Q or Ctrl+C. */
  onQuit: () => void;
  /** Called when up/down navigation changes the selection. */
  onSelectionChange: (index: number) => void;
  /** Per-quest token usage data. */
  questUsage?: Map<string, UsageTotals>;
  /** Overall usage totals (for All Tasks detail). */
  overallUsage?: UsageTotals | null;
  /** Whether dev-mode key hints are shown. */
  devMode?: boolean;
  /** Called when 'c' is pressed (create quest). */
  onCreate?: () => void;
  /** Called when 'a' is pressed (activate/pause quest). */
  onToggleActive?: () => void;
  /** Called when 'p' is pressed (plan quest). */
  onPlan?: () => void;
  /** Called when 'g' is pressed (genesis). */
  onGenesis?: () => void;
  /** Called when 'e' is pressed (errand). */
  onErrand?: () => void;
  /** Called when 'w' is pressed (wishlist). */
  onWishlist?: () => void;
  /** Called when 'o' is pressed (onboarding). */
  onOnboarding?: () => void;
  /** Called when 'd' is pressed (delete quest). */
  onDelete?: () => void;
  /** Called when 'f' is pressed (seed fake tasks, devMode only). */
  onSeedFake?: () => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Header({
  questCount,
  activeCount,
  totalTaskCount,
}: {
  questCount: number;
  activeCount: number;
  totalTaskCount: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" height={3}>
      <Box>
        <Text bold>wombo-combo</Text>
        <Text> </Text>
        <Text color="magenta">Quest Picker</Text>
        <Text dimColor>  |  </Text>
        <Text>{questCount}</Text>
        <Text> quest{questCount !== 1 ? "s" : ""}</Text>
        {activeCount > 0 && (
          <>
            <Text dimColor>  |  </Text>
            <Text color="green">{activeCount}</Text>
            <Text> active</Text>
          </>
        )}
        <Text dimColor>  |  </Text>
        <Text>{totalTaskCount}</Text>
        <Text> total tasks</Text>
      </Box>
      <Text dimColor>
        Select a quest to filter tasks, or choose "All Tasks" for the full list
      </Text>
    </Box>
  );
}

function QuestListItem({
  summary,
  isSelected,
}: {
  summary: QuestSummary;
  isSelected: boolean;
}): React.ReactElement {
  const { quest, totalTasks, doneTasks, completionPct } = summary;
  const isEmpty = totalTasks === 0;

  // Status badge
  const sColor = isEmpty ? "gray" : (QUEST_STATUS_COLORS[quest.status] ?? "white");
  const sAbbr = QUEST_STATUS_ABBREV[quest.status] ?? quest.status.slice(0, 4).toUpperCase();

  // Priority dot
  const pColor = isEmpty ? "gray" : (TASK_PRIORITY_COLORS[quest.priority] ?? "white");

  // Task info
  const taskInfo = isEmpty ? "(needs planning)" : `${doneTasks}/${totalTasks}`;

  // Build a compact single-line string to avoid wrapping issues
  const prefix = isSelected ? "▸ " : "  ";
  const dot = "●";

  return (
    <Text>
      <Text color={isSelected ? "blue" : undefined} bold={isSelected}>{prefix}</Text>
      <Text color={pColor}>{dot}</Text>
      <Text> </Text>
      <Text color={sColor as any}>{sAbbr}</Text>
      <Text> </Text>
      <Text color={isEmpty ? "gray" : undefined}>{quest.title}</Text>
      <Text> </Text>
      <Text color={isEmpty ? "magenta" : "gray"}>{taskInfo}</Text>
    </Text>
  );
}

function AllTasksItem({
  totalTaskCount,
  isSelected,
}: {
  totalTaskCount: number;
  isSelected: boolean;
}): React.ReactElement {
  return (
    <Box>
      <Text color={isSelected ? "blue" : undefined} bold={isSelected}>
        {isSelected ? "▸ " : "  "}
      </Text>
      <Text color="cyan" bold>◆</Text>
      <Text bold> All Tasks</Text>
      <Text dimColor> ({totalTaskCount})</Text>
    </Box>
  );
}

function AllTasksDetail({
  totalTaskCount,
  overallUsage,
}: {
  totalTaskCount: number;
  overallUsage?: UsageTotals | null;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">All Tasks</Text>
      <Text />
      <Text>  Browse all tasks across all quests</Text>
      <Text>  and unassigned tasks.</Text>
      <Text />
      <Text>  Total: {totalTaskCount} tasks</Text>
      <Text />
      {overallUsage && (
        <Box flexDirection="column">
          <Text bold color="yellow">Overall Token Usage:</Text>
          <Text>  Input:      <Text color="cyan">{formatTokenCount(overallUsage.input_tokens)}</Text></Text>
          <Text>  Output:     <Text color="cyan">{formatTokenCount(overallUsage.output_tokens)}</Text></Text>
          {overallUsage.cache_read > 0 && (
            <Text>  Cache read: <Text dimColor>{formatTokenCount(overallUsage.cache_read)}</Text></Text>
          )}
          {overallUsage.reasoning_tokens > 0 && (
            <Text>  Reasoning:  <Text color="magenta">{formatTokenCount(overallUsage.reasoning_tokens)}</Text></Text>
          )}
          <Text>  Total:      {formatTokenCount(overallUsage.total_tokens)}</Text>
          {overallUsage.total_cost > 0 && (
            <Text>  Cost:       <Text color="yellow">{formatTokenCount(overallUsage.total_cost)}</Text></Text>
          )}
          <Text>  Steps:      {overallUsage.record_count}</Text>
          <Text />
        </Box>
      )}
      <Text>  Press <Text bold>Enter</Text> to open the full task browser.</Text>
    </Box>
  );
}

function QuestDetail({
  summary,
  usage,
}: {
  summary: QuestSummary;
  usage?: UsageTotals;
}): React.ReactElement {
  const { quest, totalTasks, doneTasks, completionPct } = summary;
  const sColor = QUEST_STATUS_COLORS[quest.status] ?? "white";
  const pColor = TASK_PRIORITY_COLORS[quest.priority] ?? "white";

  return (
    <Box flexDirection="column">
      {/* Title */}
      <Text bold>{quest.title}</Text>
      <Text />

      {/* Status & Priority */}
      <Text>  Status:     <Text color={sColor as any}>{quest.status}</Text></Text>
      <Text>  Priority:   <Text color={pColor as any}>{quest.priority}</Text></Text>
      <Text>  Difficulty: {quest.difficulty}</Text>
      <Text>  HITL:       {quest.hitlMode}</Text>
      <Text />

      {/* Progress */}
      <Text bold>Progress:</Text>
      {totalTasks > 0 ? (
        <>
          <Text>  Tasks: {doneTasks}/{totalTasks} done ({completionPct}%)</Text>
          <Text>  [{progressBar(completionPct, 100, 20)}]</Text>
        </>
      ) : (
        <Text dimColor>  No tasks assigned</Text>
      )}
      <Text />

      {/* Goal */}
      {quest.goal && (
        <>
          <Text bold>Goal:</Text>
          <Text>  {quest.goal}</Text>
          <Text />
        </>
      )}

      {/* Branch */}
      <Text bold>Branch:</Text>
      <Text>  {quest.branch}</Text>
      <Text>  Base: {quest.baseBranch}</Text>
      <Text />

      {/* Constraints */}
      {quest.constraints.add.length > 0 && (
        <>
          <Text bold>Added Constraints:</Text>
          {quest.constraints.add.map((c, i) => (
            <Text key={`add-${i}`}>  + {c}</Text>
          ))}
          <Text />
        </>
      )}
      {quest.constraints.ban.length > 0 && (
        <>
          <Text bold>Banned:</Text>
          {quest.constraints.ban.map((b, i) => (
            <Text key={`ban-${i}`}>  - {b}</Text>
          ))}
          <Text />
        </>
      )}

      {/* Dependencies */}
      {quest.depends_on.length > 0 && (
        <>
          <Text bold>Depends on:</Text>
          {quest.depends_on.map((d, i) => (
            <Text key={`dep-${i}`}>  → {d}</Text>
          ))}
          <Text />
        </>
      )}

      {/* Notes */}
      {quest.notes.length > 0 && (
        <>
          <Text bold>Notes:</Text>
          {quest.notes.map((n, i) => (
            <Text key={`note-${i}`}>  {n}</Text>
          ))}
          <Text />
        </>
      )}

      {/* Timeline */}
      <Text bold>Timeline:</Text>
      <Text>  Created: {quest.created_at.slice(0, 10)}</Text>
      {quest.started_at && <Text>  Started: {quest.started_at.slice(0, 10)}</Text>}
      {quest.ended_at && <Text>  Ended:   {quest.ended_at.slice(0, 10)}</Text>}
      <Text />

      {/* Token Usage */}
      {usage && (
        <>
          <Text bold color="yellow">Token Usage:</Text>
          <Text>  Input:      <Text color="cyan">{formatTokenCount(usage.input_tokens)}</Text></Text>
          <Text>  Output:     <Text color="cyan">{formatTokenCount(usage.output_tokens)}</Text></Text>
          {usage.cache_read > 0 && (
            <Text>  Cache read: <Text dimColor>{formatTokenCount(usage.cache_read)}</Text></Text>
          )}
          {usage.reasoning_tokens > 0 && (
            <Text>  Reasoning:  <Text color="magenta">{formatTokenCount(usage.reasoning_tokens)}</Text></Text>
          )}
          <Text>  Total:      {formatTokenCount(usage.total_tokens)}</Text>
          {usage.total_cost > 0 && (
            <Text>  Cost:       <Text color="yellow">{formatTokenCount(usage.total_cost)}</Text></Text>
          )}
          <Text>  Steps:      {usage.record_count}</Text>
        </>
      )}
    </Box>
  );
}

function StatusBar({
  devMode,
}: {
  devMode?: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column" height={3}>
      <Box flexWrap="wrap">
        <Text bold>Keys:</Text>
        <Text>  </Text>
        <Text dimColor>Enter</Text>
        <Text> select</Text>
        <Text>  </Text>
        <Text dimColor>C</Text>
        <Text> create</Text>
        <Text>  </Text>
        <Text dimColor>E</Text>
        <Text> errand</Text>
        <Text>  </Text>
        <Text dimColor>P</Text>
        <Text> plan</Text>
        <Text>  </Text>
        <Text dimColor>G</Text>
        <Text> genesis</Text>
        <Text>  </Text>
        <Text dimColor>A</Text>
        <Text> activate/pause</Text>
        <Text>  </Text>
        <Text dimColor>D</Text>
        <Text> delete</Text>
        <Text>  </Text>
        <Text dimColor>W</Text>
        <Text> wishlist</Text>
        <Text>  </Text>
        <Text dimColor>O</Text>
        <Text> onboarding</Text>
        {devMode && (
          <>
            <Text>  </Text>
            <Text dimColor>F</Text>
            <Text> seed-fake</Text>
          </>
        )}
        <Text>  </Text>
        <Text dimColor>Q</Text>
        <Text> quit</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * QuestPickerView — a declarative quest picker component.
 *
 * Pure view: all data is passed in via props, all actions dispatched
 * via callbacks. The parent is responsible for loading quests,
 * computing summaries, and handling navigation.
 */
export function QuestPickerView(props: QuestPickerViewProps): React.ReactElement {
  const {
    quests,
    totalTaskCount,
    selectedIndex,
    onSelect,
    onQuit,
    onSelectionChange,
    questUsage,
    overallUsage,
    devMode,
    onCreate,
    onToggleActive,
    onPlan,
    onGenesis,
    onErrand,
    onWishlist,
    onOnboarding,
    onDelete,
    onSeedFake,
  } = props;

  // Total item count: "All Tasks" + quests
  const itemCount = 1 + quests.length;

  // Keyboard handling
  useInput((input, key) => {
    // Quit
    if (input === "q") {
      onQuit();
      return;
    }

    // Navigate
    if ((key.downArrow || input === "j") && itemCount > 0) {
      const next = Math.min(selectedIndex + 1, itemCount - 1);
      onSelectionChange(next);
      return;
    }
    if ((key.upArrow || input === "k") && itemCount > 0) {
      const prev = Math.max(selectedIndex - 1, 0);
      onSelectionChange(prev);
      return;
    }

    // Select
    if (key.return) {
      if (selectedIndex === 0) {
        onSelect(null); // All Tasks
      } else {
        const quest = quests[selectedIndex - 1];
        if (quest) onSelect(quest.quest.id);
      }
      return;
    }

    // Action keys
    if (input === "c") { onCreate?.(); return; }
    if (input === "a") { onToggleActive?.(); return; }
    if (input === "p") { onPlan?.(); return; }
    if (input === "g") { onGenesis?.(); return; }
    if (input === "e") { onErrand?.(); return; }
    if (input === "w") { onWishlist?.(); return; }
    if (input === "o") { onOnboarding?.(); return; }
    if (input === "d") { onDelete?.(); return; }
    if (input === "f" && devMode) { onSeedFake?.(); return; }
  });

  // Compute derived display data
  const questCount = quests.length;
  const activeCount = quests.filter((s) => s.quest.status === "active").length;

  // Determine what to show in the detail pane
  const selectedQuest =
    selectedIndex > 0 && selectedIndex <= quests.length
      ? quests[selectedIndex - 1]
      : null;

  const selectedQuestUsage =
    selectedQuest && questUsage
      ? questUsage.get(selectedQuest.quest.id)
      : undefined;

  return (
    <Box flexDirection="column" width="100%">
      {/* Header */}
      <Header
        questCount={questCount}
        activeCount={activeCount}
        totalTaskCount={totalTaskCount}
      />

      {/* Main body: list + detail */}
      <Box flexGrow={1}>
        {/* Quest list (left pane) */}
        <Box flexDirection="column" width="50%" borderStyle="single" borderColor="gray">
          <AllTasksItem
            totalTaskCount={totalTaskCount}
            isSelected={selectedIndex === 0}
          />
          {quests.map((summary, i) => (
            <QuestListItem
              key={summary.quest.id}
              summary={summary}
              isSelected={selectedIndex === i + 1}
            />
          ))}
          {quests.length === 0 && (
            <Text dimColor>  No quests found</Text>
          )}
        </Box>

        {/* Detail pane (right pane) */}
        <Box flexDirection="column" width="50%" borderStyle="single" borderColor="gray" paddingX={1}>
          {selectedIndex === 0 ? (
            <AllTasksDetail
              totalTaskCount={totalTaskCount}
              overallUsage={overallUsage}
            />
          ) : selectedQuest ? (
            <QuestDetail
              summary={selectedQuest}
              usage={selectedQuestUsage}
            />
          ) : (
            <Text dimColor>No item selected</Text>
          )}
        </Box>
      </Box>

      {/* Status bar */}
      <StatusBar devMode={devMode} />
    </Box>
  );
}
