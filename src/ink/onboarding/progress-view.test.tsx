/**
 * progress-view.test.tsx — Tests for the ProgressView Ink component.
 *
 * The ProgressView shows a spinner animation with title, status message,
 * and optional result (success/error/info). Used for brownfield scout
 * and LLM synthesis operations.
 *
 * Tests verify:
 *   - Renders the title
 *   - Renders the status message
 *   - Renders spinner frame characters
 *   - Renders success state
 *   - Renders error state
 *   - Renders info state
 *   - Renders without crashing
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { ProgressView, type ProgressViewProps } from "./progress-view";

// ---------------------------------------------------------------------------
// Static render tests (renderToString)
// ---------------------------------------------------------------------------

describe("ProgressView (static rendering)", () => {
  test("renders the title", () => {
    const output = renderToString(
      <ProgressView title="Codebase Scout" status="Scanning..." />,
    );
    expect(output).toContain("Codebase Scout");
  });

  test("renders the status message", () => {
    const output = renderToString(
      <ProgressView title="Scout" status="Scanning codebase structure..." />,
    );
    expect(output).toContain("Scanning codebase structure...");
  });

  test("renders a spinner character when active", () => {
    const output = renderToString(
      <ProgressView title="Working" status="Processing..." />,
    );
    // Should contain one of the spinner frames
    const hasSpinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split("").some((ch) => output.includes(ch));
    expect(hasSpinner).toBe(true);
  });

  test("renders success state", () => {
    const output = renderToString(
      <ProgressView
        title="Scout"
        status="Done"
        result={{ type: "success", message: "Scout complete — 42 lines." }}
      />,
    );
    expect(output).toContain("Scout complete");
    expect(output).toContain("42 lines");
  });

  test("renders error state", () => {
    const output = renderToString(
      <ProgressView
        title="Error"
        status=""
        result={{ type: "error", message: "Could not load profile." }}
      />,
    );
    expect(output).toContain("Could not load profile");
  });

  test("renders info state", () => {
    const output = renderToString(
      <ProgressView
        title="Scout"
        status=""
        result={{ type: "info", message: "No codebase structure found." }}
      />,
    );
    expect(output).toContain("No codebase structure found");
  });

  test("renders subtitle when provided", () => {
    const output = renderToString(
      <ProgressView
        title="LLM Synthesis"
        subtitle="my-project"
        status="Enhancing profile..."
      />,
    );
    expect(output).toContain("my-project");
  });

  test("renders without crashing", () => {
    expect(() =>
      renderToString(
        <ProgressView title="Test" status="Testing..." />,
      ),
    ).not.toThrow();
  });
});
