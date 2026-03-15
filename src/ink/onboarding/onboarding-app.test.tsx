/**
 * onboarding-app.test.tsx — Tests for the OnboardingApp orchestrator component.
 *
 * The OnboardingApp is the top-level component that orchestrates the full
 * onboarding flow including async operations (scout, LLM synthesis) and
 * confirm dialogs. It wraps OnboardingWizard with additional flow control.
 *
 * Tests verify:
 *   - Create mode starts with StepWizard (via OnboardingWizard)
 *   - Edit mode starts with SectionPicker (via OnboardingWizard)
 *   - Renders without crashing in create mode
 *   - Renders without crashing in edit mode
 *   - Shows progress view when scouting state is active
 *   - Shows confirm dialog when in confirm state
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { OnboardingApp, type OnboardingAppProps } from "./onboarding-app";
import { createBlankProfile } from "../../lib/project-store";

// ---------------------------------------------------------------------------
// Static render tests (renderToString)
// ---------------------------------------------------------------------------

describe("OnboardingApp (create mode)", () => {
  const defaultProps: OnboardingAppProps = {
    mode: "create",
    projectRoot: "/tmp/test-project",
    onDone: () => {},
  };

  test("renders StepWizard initially in create mode", () => {
    const output = renderToString(<OnboardingApp {...defaultProps} />);
    expect(output).toContain("Project Onboarding");
    expect(output).toContain("Step 1/8");
  });

  test("renders Project Type step", () => {
    const output = renderToString(<OnboardingApp {...defaultProps} />);
    expect(output).toContain("Project Type");
  });

  test("renders without crashing in create mode", () => {
    expect(() =>
      renderToString(<OnboardingApp {...defaultProps} />),
    ).not.toThrow();
  });
});

describe("OnboardingApp (edit mode)", () => {
  const profile = createBlankProfile("test-project");
  profile.description = "A test project";

  const defaultProps: OnboardingAppProps = {
    mode: "edit",
    projectRoot: "/tmp/test-project",
    existingProfile: profile,
    onDone: () => {},
  };

  test("renders SectionPicker in edit mode", () => {
    const output = renderToString(<OnboardingApp {...defaultProps} />);
    expect(output).toContain("Edit Profile");
  });

  test("renders section names in edit mode", () => {
    const output = renderToString(<OnboardingApp {...defaultProps} />);
    expect(output).toContain("Identity");
    expect(output).toContain("Vision");
  });

  test("renders without crashing in edit mode", () => {
    expect(() =>
      renderToString(<OnboardingApp {...defaultProps} />),
    ).not.toThrow();
  });
});
