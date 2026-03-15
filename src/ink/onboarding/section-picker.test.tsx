/**
 * section-picker.test.tsx — Tests for the SectionPicker Ink component.
 *
 * The SectionPicker shows a list of 6 profile sections plus a "Re-run LLM
 * synthesis" option. Each section shows its name and a one-line summary.
 * The user navigates with arrow keys and selects with Enter/Space.
 * Esc goes back.
 *
 * Tests verify:
 *   - Renders all 6 section names
 *   - Renders section summaries from the profile
 *   - Renders the "Re-run LLM synthesis" option
 *   - Renders header text
 *   - Renders navigation hints
 *   - Renders without crashing
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { SectionPicker, type SectionPickerProps } from "./section-picker";
import { createBlankProfile } from "../../lib/project-store";

// ---------------------------------------------------------------------------
// Static render tests (renderToString)
// ---------------------------------------------------------------------------

describe("SectionPicker (static rendering)", () => {
  const profile = createBlankProfile("test-project");

  const defaultProps: SectionPickerProps = {
    profile,
    onSelect: () => {},
    onResynthesize: () => {},
    onBack: () => {},
  };

  test("renders header text", () => {
    const output = renderToString(<SectionPicker {...defaultProps} />);
    expect(output).toContain("Edit Profile");
  });

  test("renders Identity section", () => {
    const output = renderToString(<SectionPicker {...defaultProps} />);
    expect(output).toContain("Identity");
  });

  test("renders Vision section", () => {
    const output = renderToString(<SectionPicker {...defaultProps} />);
    expect(output).toContain("Vision");
  });

  test("renders Objectives section", () => {
    const output = renderToString(<SectionPicker {...defaultProps} />);
    expect(output).toContain("Objectives");
  });

  test("renders Tech Stack section", () => {
    const output = renderToString(<SectionPicker {...defaultProps} />);
    expect(output).toContain("Tech Stack");
  });

  test("renders Conventions section", () => {
    const output = renderToString(<SectionPicker {...defaultProps} />);
    expect(output).toContain("Conventions");
  });

  test("renders Rules section", () => {
    const output = renderToString(<SectionPicker {...defaultProps} />);
    expect(output).toContain("Rules");
  });

  test("renders Re-run LLM synthesis option", () => {
    const output = renderToString(<SectionPicker {...defaultProps} />);
    expect(output).toContain("Re-run LLM synthesis");
  });

  test("renders section summary for identity", () => {
    const output = renderToString(<SectionPicker {...defaultProps} />);
    // The profile name is "test-project", which should appear in the summary
    expect(output).toContain("test-project");
  });

  test("renders navigation hint", () => {
    const output = renderToString(<SectionPicker {...defaultProps} />);
    expect(output).toContain("Esc");
  });

  test("renders without crashing", () => {
    expect(() =>
      renderToString(<SectionPicker {...defaultProps} />),
    ).not.toThrow();
  });
});
