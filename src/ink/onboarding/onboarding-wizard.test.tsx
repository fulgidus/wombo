/**
 * onboarding-wizard.test.tsx — Tests for the OnboardingWizard orchestrator.
 *
 * The OnboardingWizard is the top-level component that orchestrates the
 * full onboarding flow. It has two modes:
 *
 * **Create mode** (no existing profile):
 *   - Shows StepWizard to collect raw inputs
 *   - Structures inputs into a ProjectProfile
 *   - Shows ProfileReview for section-by-section approval
 *   - Calls onComplete with the approved profile
 *
 * **Edit mode** (existing profile):
 *   - Shows SectionPicker to select sections to edit
 *   - Shows FieldEditor for the selected section
 *   - Returns to SectionPicker after edit
 *   - Calls onComplete when done
 *
 * Tests verify:
 *   - Create mode renders StepWizard initially
 *   - Edit mode renders SectionPicker initially
 *   - Renders without crashing in both modes
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import {
  OnboardingWizard,
  type OnboardingWizardProps,
} from "./onboarding-wizard";
import { createBlankProfile } from "../../lib/project-store";

// ---------------------------------------------------------------------------
// Static render tests (renderToString)
// ---------------------------------------------------------------------------

describe("OnboardingWizard (create mode)", () => {
  const defaultProps: OnboardingWizardProps = {
    mode: "create",
    onComplete: () => {},
    onCancel: () => {},
  };

  test("renders StepWizard in create mode", () => {
    const output = renderToString(<OnboardingWizard {...defaultProps} />);
    // StepWizard shows "Project Onboarding" header and step counter
    expect(output).toContain("Project Onboarding");
    expect(output).toContain("Step 1/8");
  });

  test("renders Project Type step in create mode", () => {
    const output = renderToString(<OnboardingWizard {...defaultProps} />);
    expect(output).toContain("Project Type");
  });

  test("renders without crashing in create mode", () => {
    expect(() =>
      renderToString(<OnboardingWizard {...defaultProps} />),
    ).not.toThrow();
  });
});

describe("OnboardingWizard (edit mode)", () => {
  const profile = createBlankProfile("test-project");
  profile.description = "A test project";

  const defaultProps: OnboardingWizardProps = {
    mode: "edit",
    existingProfile: profile,
    onComplete: () => {},
    onCancel: () => {},
  };

  test("renders SectionPicker in edit mode", () => {
    const output = renderToString(<OnboardingWizard {...defaultProps} />);
    // SectionPicker shows "Edit Profile" header
    expect(output).toContain("Edit Profile");
  });

  test("renders section names in edit mode", () => {
    const output = renderToString(<OnboardingWizard {...defaultProps} />);
    expect(output).toContain("Identity");
    expect(output).toContain("Vision");
    expect(output).toContain("Objectives");
  });

  test("renders Re-run LLM synthesis in edit mode", () => {
    const output = renderToString(<OnboardingWizard {...defaultProps} />);
    expect(output).toContain("Re-run LLM synthesis");
  });

  test("renders without crashing in edit mode", () => {
    expect(() =>
      renderToString(<OnboardingWizard {...defaultProps} />),
    ).not.toThrow();
  });
});
