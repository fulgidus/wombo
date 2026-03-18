/**
 * run-quest-wizard.tsx — Standalone launcher for the QuestWizard Ink component.
 *
 * Creates and destroys its own Ink render instance, returning a Promise
 * that resolves with the created Quest or null if cancelled.
 *
 * This is the Ink equivalent of `runQuestWizardAsync()` from
 * tui-quest-wizard.ts, supporting the "standalone" render mode.
 *
 * Usage:
 *   const quest = await runQuestWizardInk({
 *     projectRoot: "/path/to/project",
 *     baseBranch: "main",
 *     prefill: { goal: "Migrate auth to OAuth2" },
 *   });
 *   if (quest) {
 *     console.log(`Created quest: ${quest.id}`);
 *   }
 */

import React from "react";
import { render } from "ink";
import { QuestWizard, type QuestWizardPrefill } from "./quest-wizard";
import { loadQuest, saveQuest } from "../lib/quest-store";
import type { Quest } from "../lib/quest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunQuestWizardOptions {
  /** Project root directory (for loadQuest duplicate checks, saveQuest). */
  projectRoot: string;
  /** Base branch for the new quest's branch. */
  baseBranch: string;
  /** Optional pre-filled values for wizard fields. */
  prefill?: QuestWizardPrefill;
}

// ---------------------------------------------------------------------------
// Standalone launcher
// ---------------------------------------------------------------------------

/**
 * Run the quest creation wizard as a standalone Ink instance.
 *
 * Creates and destroys its own Ink render context. Returns a Promise
 * that resolves with the created Quest or null if the user cancelled.
 *
 * This is the "standalone" render mode — for overlay mode, render
 * `<QuestWizard />` directly inside your existing Ink tree.
 */
export function runQuestWizardInk(
  opts: RunQuestWizardOptions
): Promise<Quest | null> {
  const { projectRoot, baseBranch, prefill } = opts;

  return new Promise<Quest | null>((resolve) => {
    const checkDuplicateId = (id: string): string | null => {
      const existing = loadQuest(projectRoot, id);
      return existing ? existing.status : null;
    };

    const saveQuestFn = (quest: Quest): void => {
      saveQuest(projectRoot, quest);
    };

    let instance: ReturnType<typeof render>;

    const handleCreated = (quest: Quest) => {
      // Brief delay for confirmation display, then unmount
      setTimeout(() => {
        instance.unmount();
        resolve(quest);
      }, 1200);
    };

    const handleCancelled = () => {
      instance.unmount();
      resolve(null);
    };

    process.stdin.resume(); // keep event loop alive between renders
    instance = render(
      <QuestWizard
        baseBranch={baseBranch}
        prefill={prefill}
        onCreated={handleCreated}
        onCancelled={handleCancelled}
        checkDuplicateId={checkDuplicateId}
        saveQuest={saveQuestFn}
      />,
      { exitOnCtrlC: false }
    );
  });
}
