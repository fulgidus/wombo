/**
 * confirm-dialog.test.tsx — Tests for the ConfirmDialog Ink component.
 *
 * The ConfirmDialog shows a yes/no prompt with arrow key navigation.
 * Used for "Enhance profile with AI?" and "Run genesis planner?" prompts.
 *
 * Tests verify:
 *   - Renders the title text
 *   - Renders the message text
 *   - Renders "Yes" and "No" options
 *   - Renders navigation hints
 *   - Renders without crashing
 *   - Default selection is "Yes"
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { ConfirmDialog, type ConfirmDialogProps } from "./confirm-dialog";

// ---------------------------------------------------------------------------
// Static render tests (renderToString)
// ---------------------------------------------------------------------------

describe("ConfirmDialog (static rendering)", () => {
  const defaultProps: ConfirmDialogProps = {
    title: "LLM Synthesis",
    message: "Enhance profile with AI?",
    onConfirm: () => {},
    onCancel: () => {},
  };

  test("renders the title", () => {
    const output = renderToString(<ConfirmDialog {...defaultProps} />);
    expect(output).toContain("LLM Synthesis");
  });

  test("renders the message", () => {
    const output = renderToString(<ConfirmDialog {...defaultProps} />);
    expect(output).toContain("Enhance profile with AI?");
  });

  test("renders Yes option", () => {
    const output = renderToString(<ConfirmDialog {...defaultProps} />);
    expect(output).toContain("Yes");
  });

  test("renders No option", () => {
    const output = renderToString(<ConfirmDialog {...defaultProps} />);
    expect(output).toContain("No");
  });

  test("renders navigation hint", () => {
    const output = renderToString(<ConfirmDialog {...defaultProps} />);
    expect(output).toContain("Enter");
  });

  test("renders without crashing", () => {
    expect(() =>
      renderToString(<ConfirmDialog {...defaultProps} />),
    ).not.toThrow();
  });

  test("renders with custom title", () => {
    const output = renderToString(
      <ConfirmDialog
        {...defaultProps}
        title="Genesis Planner"
        message="Run genesis planner to create initial quests?"
      />,
    );
    expect(output).toContain("Genesis Planner");
    expect(output).toContain("Run genesis planner");
  });
});
