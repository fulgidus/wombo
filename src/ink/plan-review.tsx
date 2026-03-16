/**
 * plan-review.tsx — Plan review adapter for the ReviewList component.
 *
 * Maps `ProposedTask` (from quest-planner.ts) to `ReviewItem` and
 * builds a `ReviewListConfig` that drives the shared ReviewList component.
 *
 * Differences from genesis-review:
 *   - Tasks have `description` (textarea), quests have `goal` (textarea)
 *   - Tasks have `effort` (display-only string)
 *   - Tasks have flat `constraints`, `forbidden`, `references` (string[])
 *   - Tasks have optional `agent` string
 *   - No `hitl_mode` field
 *   - Edit fields: title, priority, difficulty, depends_on, description
 */

import React from "react";
import type {
  ReviewItem,
  ReviewListConfig,
  EditFieldDef,
  ReviewValidationIssue,
} from "./review-list-types";
import { ReviewList } from "./review-list";
import type {
  ProposedTask,
  PlanResult,
  PlanValidationIssue,
} from "../lib/quest-planner";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRIORITIES = ["critical", "high", "medium", "low", "wishlist"];
const DIFFICULTIES = ["trivial", "easy", "medium", "hard", "very_hard"];

// ---------------------------------------------------------------------------
// Edit Field Definitions
// ---------------------------------------------------------------------------

/** Edit fields for plan review (task editing). */
export const PLAN_EDIT_FIELDS: EditFieldDef[] = [
  {
    key: "title",
    label: "Title",
    type: "text",
    hint: "Task title",
  },
  {
    key: "priority",
    label: "Priority",
    type: "select",
    options: PRIORITIES.map((p) => ({ label: p, value: p })),
    hint: "Select priority level",
  },
  {
    key: "difficulty",
    label: "Difficulty",
    type: "select",
    options: DIFFICULTIES.map((d) => ({ label: d, value: d })),
    hint: "Select difficulty level",
  },
  {
    key: "depends_on",
    label: "Dependencies",
    type: "text",
    hint: "Comma-separated task IDs",
  },
  {
    key: "description",
    label: "Description",
    type: "textarea",
    hint: "Task description",
  },
];

// ---------------------------------------------------------------------------
// Task ↔ ReviewItem mapping
// ---------------------------------------------------------------------------

/**
 * We store the original task data as a stashed property on the ReviewItem
 * so we can reconstruct the full ProposedTask on approve/edit.
 */
const taskStash = new WeakMap<ReviewItem, ProposedTask>();

/** Convert a ProposedTask to a ReviewItem for the shared component. */
export function taskToReviewItem(task: ProposedTask): ReviewItem {
  const item: ReviewItem = {
    id: task.id,
    title: task.title,
    priority: task.priority,
    difficulty: task.difficulty,
    dependsOn: [...task.depends_on],
    accepted: true,
    detailFields: [
      ...(task.effort
        ? [{ label: "Effort:", value: task.effort }]
        : []),
    ],
    detailSections: [
      {
        label: "Description",
        items: task.description ? [task.description] : [],
      },
      {
        label: "Constraints",
        items: [...task.constraints],
        prefix: "+",
      },
      {
        label: "Forbidden",
        items: [...task.forbidden],
        prefix: "-",
      },
      {
        label: "References",
        items: [...task.references],
      },
      {
        label: "Notes",
        items: [...task.notes],
      },
      {
        label: "Agent",
        items: task.agent ? [task.agent] : [],
      },
    ],
  };

  // Stash the original task for reverse mapping
  taskStash.set(item, { ...task });

  return item;
}

/**
 * Convert a ReviewItem back to a ProposedTask, applying any edits made
 * through the review UI. Uses the stashed task data for fields that
 * aren't directly represented on ReviewItem.
 */
export function reviewItemToTask(
  item: ReviewItem,
  originalTask: ProposedTask
): ProposedTask {
  const stashed = taskStash.get(item) ?? originalTask;

  return {
    ...stashed,
    id: item.id,
    title: item.title,
    priority: item.priority as ProposedTask["priority"],
    difficulty: item.difficulty as ProposedTask["difficulty"],
    depends_on: [...item.dependsOn],
  };
}

// ---------------------------------------------------------------------------
// Config Builder
// ---------------------------------------------------------------------------

/** Build a ReviewListConfig from a PlanResult. */
export function buildPlanConfig(
  questId: string,
  questTitle: string,
  planResult: PlanResult,
  onApprove: (tasks: ProposedTask[], knowledge: string | null) => void,
  onCancel: () => void
): ReviewListConfig {
  // Map plan validation issues to generic review issues
  const issues: ReviewValidationIssue[] = planResult.issues.map(
    (issue: PlanValidationIssue) => ({
      level: issue.level,
      itemId: issue.taskId,
      message: issue.message,
    })
  );

  // Build a lookup of original tasks by ID for reverse mapping
  const originalTasks = new Map<string, ProposedTask>();
  for (const t of planResult.tasks) {
    originalTasks.set(t.id, t);
  }

  return {
    title: "Plan Review",
    subtitle: `quest: ${questId} — ${questTitle}`,
    itemLabel: "task",
    itemLabelPlural: "tasks",
    listLabel: "Proposed Tasks",
    issues,
    editFields: PLAN_EDIT_FIELDS,
    knowledge: planResult.knowledge,

    getEditFieldValue: (item: ReviewItem, fieldKey: string): string => {
      const task = taskStash.get(item) ?? originalTasks.get(item.id);
      if (!task) return "";

      switch (fieldKey) {
        case "title":
          return item.title;
        case "priority":
          return item.priority;
        case "difficulty":
          return item.difficulty;
        case "depends_on":
          return item.dependsOn.join(", ");
        case "description":
          return task.description;
        default:
          return "";
      }
    },

    setEditFieldValue: (
      item: ReviewItem,
      fieldKey: string,
      value: string
    ): ReviewItem => {
      const task = taskStash.get(item) ?? originalTasks.get(item.id);
      const updatedTask = task ? { ...task } : undefined;

      const updatedItem = { ...item };

      switch (fieldKey) {
        case "title":
          updatedItem.title = value;
          if (updatedTask) updatedTask.title = value;
          break;
        case "priority":
          updatedItem.priority = value;
          if (updatedTask) updatedTask.priority = value as ProposedTask["priority"];
          break;
        case "difficulty":
          updatedItem.difficulty = value;
          if (updatedTask) updatedTask.difficulty = value as ProposedTask["difficulty"];
          break;
        case "depends_on":
          updatedItem.dependsOn = value
            ? value.split(",").map((s) => s.trim()).filter(Boolean)
            : [];
          if (updatedTask) updatedTask.depends_on = [...updatedItem.dependsOn];
          break;
        case "description":
          if (updatedTask) updatedTask.description = value;
          // Update description section
          updatedItem.detailSections = updatedItem.detailSections.map((s) =>
            s.label === "Description"
              ? { ...s, items: value ? [value] : [] }
              : s
          );
          break;
      }

      // Re-stash the updated task
      if (updatedTask) {
        taskStash.set(updatedItem, updatedTask);
      }

      return updatedItem;
    },

    approveTitle: "Approve Plan",
    approveBody: (acceptedCount: number) =>
      `Apply ${acceptedCount} task${acceptedCount !== 1 ? "s" : ""} to quest "${questId}"?\n\n` +
      "This will:\n" +
      "  - Create task files in the task store\n" +
      "  - Associate tasks with the quest\n" +
      "  - Save any planner knowledge\n\n" +
      "Tasks will be set to 'pending' status.",

    onApprove: (items: ReviewItem[]) => {
      const tasks = items.map((item) => {
        const original = originalTasks.get(item.id);
        return reviewItemToTask(item, original ?? ({} as ProposedTask));
      });
      onApprove(tasks, planResult.knowledge);
    },

    onCancel,
  };
}

// ---------------------------------------------------------------------------
// PlanReviewApp — React component wrapper
// ---------------------------------------------------------------------------

export interface PlanReviewAppProps {
  /** The quest ID being planned. */
  questId: string;
  /** The quest title. */
  questTitle: string;
  /** The planner result to review. */
  planResult: PlanResult;
  /** Called when user approves the plan. */
  onApprove: (tasks: ProposedTask[], knowledge: string | null) => void;
  /** Called when user cancels/discards the plan. */
  onCancel: () => void;
}

/**
 * PlanReviewApp — Ink component for reviewing quest planner output.
 *
 * Wraps the shared ReviewList component with plan-specific configuration.
 */
export function PlanReviewApp({
  questId,
  questTitle,
  planResult,
  onApprove,
  onCancel,
}: PlanReviewAppProps): React.ReactElement {
  const items = planResult.tasks.map(taskToReviewItem);
  const config = buildPlanConfig(questId, questTitle, planResult, onApprove, onCancel);

  return <ReviewList items={items} config={config} />;
}
