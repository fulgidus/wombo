/**
 * run-onboarding.ts — Bridge between tui.ts (imperative) and OnboardingApp (Ink/React).
 *
 * This module provides `runOnboardingInk()`, which is the drop-in replacement
 * for `runOnboardingAsync()` from `tui-onboarding.ts`. It renders the
 * OnboardingApp component via Ink's `render()` and returns a Promise that
 * resolves when the onboarding flow completes or is cancelled.
 *
 * The function automatically detects create vs edit mode based on whether
 * `project.yml` exists (same logic as the original).
 *
 * Snoozability: If the user cancels (profile is null), no `project.yml` is
 * written, so onboarding will reappear next launch.
 *
 * Genesis sentinel: Instead of `(profile as any)._genesisRequested = true`,
 * this module uses OnboardingResult.genesisRequested. The integration in
 * tui.ts checks this field.
 */

import React from "react";
import { render } from "ink";
import type { ProjectProfile } from "../../lib/project-store";
import type { WomboConfig } from "../../config";
import {
  projectExists,
  loadProject,
  saveProject,
} from "../../lib/project-store";
import {
  runBrownfieldScout,
  runLlmSynthesis,
} from "../../lib/onboarding-helpers";
import { OnboardingApp } from "./onboarding-app";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result returned by `runOnboardingInk()`.
 *
 * - `profile` is the final ProjectProfile, or `null` if the user cancelled.
 * - `genesisRequested` is `true` if the user wants to run genesis after
 *   onboarding completes (create mode only).
 */
export interface OnboardingResult {
  profile: ProjectProfile | null;
  genesisRequested: boolean;
}

/**
 * Options for `runOnboardingInk()`.
 * Matches the original `runOnboardingAsync()` signature.
 */
export interface RunOnboardingOptions {
  projectRoot: string;
  config: WomboConfig;
}

// ---------------------------------------------------------------------------
// runOnboardingInk
// ---------------------------------------------------------------------------

/**
 * Run the Ink onboarding wizard.
 *
 * This is the drop-in replacement for `runOnboardingAsync()`. It:
 *   1. Detects create vs edit mode (based on `project.yml` existence).
 *   2. Renders OnboardingApp via Ink's `render()`.
 *   3. Waits for the flow to complete (user approves or cancels).
 *   4. Unmounts the Ink app and returns the result.
 *
 * In create mode, async operations (brownfield scout, LLM synthesis) and
 * profile saving are wired in as callback props.
 *
 * In edit mode, the existing profile is loaded and passed to OnboardingApp.
 */
export async function runOnboardingInk(
  opts: RunOnboardingOptions,
): Promise<OnboardingResult> {
  const { projectRoot, config } = opts;

  // Determine mode
  const isEdit = projectExists(projectRoot);
  const mode = isEdit ? "edit" : "create";

  // Load existing profile for edit mode
  let existingProfile: ProjectProfile | undefined;
  if (isEdit) {
    const loaded = loadProject(projectRoot);
    if (!loaded) {
      // File exists but can't be loaded — return null
      return { profile: null, genesisRequested: false };
    }
    existingProfile = loaded;
  }

  // Create a promise that resolves when onboarding completes
  return new Promise<OnboardingResult>((resolve) => {
    const onDone = (
      profile: ProjectProfile | null,
      genesisRequested?: boolean,
    ) => {
      // Unmount the Ink app
      instance.unmount();

      resolve({
        profile,
        genesisRequested: genesisRequested ?? false,
      });
    };

    const element = React.createElement(OnboardingApp, {
      mode,
      projectRoot,
      existingProfile,
      config,
      onDone,
      scoutFn: runBrownfieldScout,
      synthesisFn: runLlmSynthesis,
      saveFn: saveProject,
    });

    process.stdin.resume(); // keep event loop alive between renders
    const instance = render(element, {
      // Don't exit on Ctrl+C — let the onboarding flow handle it
      exitOnCtrlC: false,
    });
  });
}
