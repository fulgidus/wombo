/**
 * run-quest-picker.tsx — Standalone launcher for the QuestPickerView.
 *
 * Creates and destroys its own Ink render instance, returning a Promise
 * that resolves with the user's action (select quest, plan, genesis, etc.).
 *
 * Manages all data loading (quests, tasks, usage) and state (selection index,
 * toggle active, delete, create) internally — the QuestPickerView is a
 * pure view component that receives everything via props.
 */

import React, { useState, useCallback, useEffect, useRef } from "react";
import { render } from "ink";
import { QuestPickerView, type QuestSummary } from "./quest-picker";
import type { Quest } from "../lib/quest";
import { QUEST_STATUS_ORDER, getQuestTaskIds } from "../lib/quest";
import { loadAllQuests, saveQuest, deleteQuest } from "../lib/quest-store";
import { loadTasks, getDoneTaskIds, loadArchive } from "../lib/tasks";
import { loadUsageRecords, totalUsage, groupBy as groupUsageBy } from "../lib/token-usage";
import type { UsageTotals } from "../lib/token-usage";
import type { WomboConfig } from "../config";
import type { ErrandSpec } from "../lib/errand-planner";

// ---------------------------------------------------------------------------
// Action Type (matches the old QuestPickerAction)
// ---------------------------------------------------------------------------

export type QuestPickerAction =
  | { type: "select"; questId: string | null }
  | { type: "plan"; questId: string }
  | { type: "genesis"; vision: string }
  | { type: "errand"; spec: ErrandSpec }
  | { type: "wishlist" }
  | { type: "onboarding" }
  | { type: "quit" };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunQuestPickerOptions {
  projectRoot: string;
  config: WomboConfig;
}

// ---------------------------------------------------------------------------
// Stateful Wrapper Component
// ---------------------------------------------------------------------------

function QuestPickerApp({
  projectRoot,
  config,
  onAction,
}: {
  projectRoot: string;
  config: WomboConfig;
  onAction: (action: QuestPickerAction) => void;
}) {
  const [quests, setQuests] = useState<QuestSummary[]>([]);
  const [totalTaskCount, setTotalTaskCount] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [questUsage, setQuestUsage] = useState<Map<string, UsageTotals>>(new Map());
  const [overallUsage, setOverallUsage] = useState<UsageTotals | null>(null);

  // Load data on mount
  const loadData = useCallback(() => {
    const allQuests = loadAllQuests(projectRoot);
    const tasksData = loadTasks(projectRoot, config);
    const archiveData = loadArchive(projectRoot, config);
    const doneIds = getDoneTaskIds(tasksData, archiveData.tasks);

    setTotalTaskCount(tasksData.tasks.length);

    // Sort quests: by status order (active first)
    const sorted = [...allQuests].sort((a, b) => {
      return (QUEST_STATUS_ORDER[a.status] ?? 99) - (QUEST_STATUS_ORDER[b.status] ?? 99);
    });

    // Build summaries
    const summaries: QuestSummary[] = sorted.map((quest) => {
      const questTids = getQuestTaskIds(quest.id, tasksData.tasks);
      const totalTasks = questTids.length;
      const doneTasks = questTids.filter((id) => doneIds.has(id)).length;
      const completionPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
      return { quest, totalTasks, doneTasks, completionPct };
    });

    setQuests(summaries);

    // Load token usage
    try {
      const records = loadUsageRecords(projectRoot);
      if (records.length > 0) {
        setQuestUsage(groupUsageBy(records, "quest_id"));
        setOverallUsage(totalUsage(records));
      }
    } catch {
      // Non-critical
    }
  }, [projectRoot, config]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handlers
  const handleSelect = useCallback(
    (questId: string | null) => {
      onAction({ type: "select", questId });
    },
    [onAction]
  );

  const handleQuit = useCallback(() => {
    onAction({ type: "quit" });
  }, [onAction]);

  const handlePlan = useCallback(() => {
    if (selectedIndex === 0 || !quests[selectedIndex - 1]) return;
    const summary = quests[selectedIndex - 1];
    onAction({ type: "plan", questId: summary.quest.id });
  }, [selectedIndex, quests, onAction]);

  const handleGenesis = useCallback(() => {
    // The old blessed version showed an input modal for vision text.
    // With Ink, we'll signal "genesis" and the parent (tui.ts) handles
    // prompting for vision text. For now, pass a placeholder action
    // that the parent can handle by launching a vision prompt flow.
    onAction({ type: "genesis", vision: "" });
  }, [onAction]);

  const handleErrand = useCallback(() => {
    // Signal the parent to show the errand wizard
    onAction({ type: "errand", spec: { description: "" } });
  }, [onAction]);

  const handleWishlist = useCallback(() => {
    onAction({ type: "wishlist" });
  }, [onAction]);

  const handleOnboarding = useCallback(() => {
    onAction({ type: "onboarding" });
  }, [onAction]);

  const handleToggleActive = useCallback(() => {
    if (selectedIndex === 0) return;
    const summary = quests[selectedIndex - 1];
    if (!summary) return;
    const quest = summary.quest;

    if (quest.status === "active") {
      quest.status = "paused";
    } else if (quest.status === "draft" || quest.status === "paused" || quest.status === "planning") {
      quest.status = "active";
      if (!quest.started_at) {
        quest.started_at = new Date().toISOString();
      }
    } else {
      return; // completed/abandoned can't toggle
    }

    saveQuest(projectRoot, quest);
    loadData();
  }, [selectedIndex, quests, projectRoot, loadData]);

  const handleDelete = useCallback(() => {
    if (selectedIndex === 0) return;
    const summary = quests[selectedIndex - 1];
    if (!summary) return;

    // Delete immediately (the old flow used a confirm dialog, but
    // since we're inside Ink, we'll just delete — the user pressed D
    // intentionally). For safety, we could add a ConfirmDialog overlay,
    // but keeping it simple for now matches the integration scope.
    deleteQuest(projectRoot, summary.quest.id);
    loadData();
    // Clamp selection
    const maxIdx = quests.length; // quests.length because "All Tasks" is index 0
    if (selectedIndex >= maxIdx) {
      setSelectedIndex(Math.max(0, maxIdx - 1));
    }
  }, [selectedIndex, quests, projectRoot, loadData]);

  const handleCreate = useCallback(() => {
    // Signal parent to run the quest wizard
    // The parent will call runQuestWizardInk and then come back
    onAction({ type: "select", questId: "__create__" });
  }, [onAction]);

  return (
    <QuestPickerView
      quests={quests}
      totalTaskCount={totalTaskCount}
      selectedIndex={selectedIndex}
      onSelect={handleSelect}
      onQuit={handleQuit}
      onSelectionChange={setSelectedIndex}
      questUsage={questUsage}
      overallUsage={overallUsage}
      devMode={config.devMode}
      onCreate={handleCreate}
      onToggleActive={handleToggleActive}
      onPlan={handlePlan}
      onGenesis={handleGenesis}
      onErrand={handleErrand}
      onWishlist={handleWishlist}
      onOnboarding={handleOnboarding}
      onDelete={handleDelete}
    />
  );
}

// ---------------------------------------------------------------------------
// Standalone Launcher
// ---------------------------------------------------------------------------

/**
 * Run the quest picker as a standalone Ink instance.
 * Returns the user's chosen action.
 */
export function runQuestPickerInk(
  opts: RunQuestPickerOptions
): Promise<QuestPickerAction> {
  const { projectRoot, config } = opts;

  return new Promise<QuestPickerAction>((resolve) => {
    let instance: ReturnType<typeof render>;

    const handleAction = (action: QuestPickerAction) => {
      instance.unmount();
      resolve(action);
    };

    process.stdin.resume(); // keep event loop alive between renders
    instance = render(
      <QuestPickerApp
        projectRoot={projectRoot}
        config={config}
        onAction={handleAction}
      />,
      { exitOnCtrlC: false }
    );
  });
}
