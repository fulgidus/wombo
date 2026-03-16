/**
 * run-review.tsx — Standalone launchers for genesis and plan review screens.
 *
 * Creates and destroys their own Ink render instances, returning Promises
 * that resolve with the review action (approve/cancel).
 *
 * These are the Ink equivalents of:
 *   - `showGenesisReview()` from commands/genesis.ts & commands/tui.ts
 *   - `showPlanReview()` from commands/tui.ts
 *
 * Usage:
 *   const action = await runGenesisReviewInk({ genesisResult });
 *   if (action.type === "approve") {
 *     // action.quests, action.knowledge
 *   }
 *
 *   const action = await runPlanReviewInk({
 *     questId: "auth-quest",
 *     questTitle: "Auth Overhaul",
 *     planResult,
 *   });
 *   if (action.type === "approve") {
 *     // action.tasks, action.knowledge
 *   }
 */

import React from "react";
import { render } from "ink";
import { GenesisReviewApp } from "./genesis-review";
import { PlanReviewApp } from "./plan-review";
import type { ProposedQuest, GenesisResult } from "../lib/genesis-planner";
import type { ProposedTask, PlanResult } from "../lib/quest-planner";

// ---------------------------------------------------------------------------
// Action Types
// ---------------------------------------------------------------------------

/** Result of the genesis review screen. */
export type GenesisReviewAction =
  | { type: "approve"; quests: ProposedQuest[]; knowledge: string | null }
  | { type: "cancel" };

/** Result of the plan review screen. */
export type PlanReviewAction =
  | { type: "approve"; tasks: ProposedTask[]; knowledge: string | null }
  | { type: "cancel" };

// ---------------------------------------------------------------------------
// Genesis Review Launcher
// ---------------------------------------------------------------------------

export interface RunGenesisReviewOptions {
  /** The genesis planner result to review. */
  genesisResult: GenesisResult;
}

/**
 * Run the genesis review screen as a standalone Ink instance.
 *
 * Creates and destroys its own Ink render context. Returns a Promise
 * that resolves with the user's action (approve with quests, or cancel).
 */
export function runGenesisReviewInk(
  opts: RunGenesisReviewOptions
): Promise<GenesisReviewAction> {
  const { genesisResult } = opts;

  return new Promise<GenesisReviewAction>((resolve) => {
    let instance: ReturnType<typeof render>;

    const handleApprove = (quests: ProposedQuest[], knowledge: string | null) => {
      instance.unmount();
      resolve({ type: "approve", quests, knowledge });
    };

    const handleCancel = () => {
      instance.unmount();
      resolve({ type: "cancel" });
    };

    instance = render(
      <GenesisReviewApp
        genesisResult={genesisResult}
        onApprove={handleApprove}
        onCancel={handleCancel}
      />
    );
  });
}

// ---------------------------------------------------------------------------
// Plan Review Launcher
// ---------------------------------------------------------------------------

export interface RunPlanReviewOptions {
  /** The quest ID being planned. */
  questId: string;
  /** The quest title. */
  questTitle: string;
  /** The planner result to review. */
  planResult: PlanResult;
}

/**
 * Run the plan review screen as a standalone Ink instance.
 *
 * Creates and destroys its own Ink render context. Returns a Promise
 * that resolves with the user's action (approve with tasks, or cancel).
 */
export function runPlanReviewInk(
  opts: RunPlanReviewOptions
): Promise<PlanReviewAction> {
  const { questId, questTitle, planResult } = opts;

  return new Promise<PlanReviewAction>((resolve) => {
    let instance: ReturnType<typeof render>;

    const handleApprove = (tasks: ProposedTask[], knowledge: string | null) => {
      instance.unmount();
      resolve({ type: "approve", tasks, knowledge });
    };

    const handleCancel = () => {
      instance.unmount();
      resolve({ type: "cancel" });
    };

    instance = render(
      <PlanReviewApp
        questId={questId}
        questTitle={questTitle}
        planResult={planResult}
        onApprove={handleApprove}
        onCancel={handleCancel}
      />
    );
  });
}
