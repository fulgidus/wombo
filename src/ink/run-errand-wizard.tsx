/**
 * run-errand-wizard.tsx — Standalone launcher for the ErrandWizard.
 *
 * Creates and destroys its own Ink render instance, returning a Promise
 * that resolves with the completed ErrandSpec or null if cancelled.
 */

import React from "react";
import { render } from "ink";
import { ErrandWizard } from "./errand-wizard";
import type { ErrandSpec } from "../lib/errand-planner";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunErrandWizardOptions {
  // Currently no options needed, but interface is here for future extensibility
}

// ---------------------------------------------------------------------------
// Standalone Launcher
// ---------------------------------------------------------------------------

/**
 * Run the errand wizard as a standalone Ink instance.
 * Returns the ErrandSpec if the user completes the wizard, or null if cancelled.
 */
export function runErrandWizardInk(
  _opts?: RunErrandWizardOptions
): Promise<ErrandSpec | null> {
  return new Promise<ErrandSpec | null>((resolve) => {
    let instance: ReturnType<typeof render>;

    process.stdin.resume(); // keep event loop alive between renders
    instance = render(
      <ErrandWizard
        onSubmit={(spec) => {
          instance.unmount();
          resolve(spec);
        }}
        onCancel={() => {
          instance.unmount();
          resolve(null);
        }}
      />,
      { exitOnCtrlC: false }
    );
  });
}
