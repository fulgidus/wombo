/**
 * step-wizard.test.tsx — Tests for the StepWizard Ink component.
 *
 * The StepWizard is a multi-step wizard that collects raw input fields
 * from the user. Each step shows a label, prompt, and either a text input,
 * textarea, or selection list.
 *
 * Tests verify:
 *   - Renders the first step with correct label/prompt
 *   - Shows step counter (e.g. "Step 1/8")
 *   - Renders selection list for the type step
 *   - Renders text input for non-selection steps
 *   - Shows navigation hints (Esc to go back)
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { StepWizard, type StepWizardProps } from "./step-wizard";

// ---------------------------------------------------------------------------
// Static render tests (renderToString)
// ---------------------------------------------------------------------------

describe("StepWizard (static rendering)", () => {
  const defaultProps: StepWizardProps = {
    onComplete: () => {},
    onCancel: () => {},
  };

  test("renders the first step label", () => {
    const output = renderToString(<StepWizard {...defaultProps} />);
    expect(output).toContain("Project Type");
  });

  test("renders step counter", () => {
    const output = renderToString(<StepWizard {...defaultProps} />);
    expect(output).toContain("Step 1/8");
  });

  test("renders the prompt text for first step", () => {
    const output = renderToString(<StepWizard {...defaultProps} />);
    expect(output).toContain("new project");
  });

  test("renders selection items for type step", () => {
    const output = renderToString(<StepWizard {...defaultProps} />);
    expect(output).toContain("brownfield");
    expect(output).toContain("greenfield");
  });

  test("renders navigation hint", () => {
    const output = renderToString(<StepWizard {...defaultProps} />);
    // First step shows "Esc to cancel" since there's no step to go back to
    expect(output).toContain("Esc");
  });

  test("renders Project Onboarding header", () => {
    const output = renderToString(<StepWizard {...defaultProps} />);
    expect(output).toContain("Project Onboarding");
  });

  test("renders without crashing", () => {
    expect(() =>
      renderToString(<StepWizard {...defaultProps} />),
    ).not.toThrow();
  });
});
