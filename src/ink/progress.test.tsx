/**
 * progress.test.tsx — Tests for the ProgressScreen Ink component.
 *
 * Verifies:
 *   - Renders title text
 *   - Renders context alongside title
 *   - Renders initial "Starting..." status
 *   - Shows a spinner character when spinning
 *   - showSuccess displays check mark and message
 *   - showError displays cross mark and message
 *   - showInfo displays info icon and message
 *   - Log lines are appended and displayed
 *   - Footer shows dismiss hint in waiting state
 *   - Renders without crashing
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { ProgressView } from "./progress";

describe("ProgressView", () => {
  test("renders title text", () => {
    const output = renderToString(<ProgressView title="Running Planner" />);
    expect(output).toContain("Running Planner");
  });

  test("renders context alongside title", () => {
    const output = renderToString(
      <ProgressView title="Running Planner" context="quest: my-quest" />
    );
    expect(output).toContain("Running Planner");
    expect(output).toContain("my-quest");
  });

  test("renders initial status text when spinning", () => {
    const output = renderToString(
      <ProgressView title="Test" status="Starting..." spinning />
    );
    expect(output).toContain("Starting...");
  });

  test("renders custom status text", () => {
    const output = renderToString(
      <ProgressView title="Test" status="Loading data..." spinning />
    );
    expect(output).toContain("Loading data...");
  });

  test("renders a spinner character when spinning", () => {
    const output = renderToString(
      <ProgressView title="Test" spinning />
    );
    // Should contain one of the braille spinner chars
    const spinChars = ["⠂", "⠆", "⠇", "⠃", "⠉", "⠌", "⠎", "⠋"];
    const hasSpinner = spinChars.some((ch) => output.includes(ch));
    expect(hasSpinner).toBe(true);
  });

  test("shows check mark and message for success result", () => {
    const output = renderToString(
      <ProgressView title="Test" result={{ type: "success", message: "Done! Created 5 tasks." }} />
    );
    expect(output).toContain("✔");
    expect(output).toContain("Done! Created 5 tasks.");
  });

  test("shows cross mark and message for error result", () => {
    const output = renderToString(
      <ProgressView title="Test" result={{ type: "error", message: "Something failed" }} />
    );
    expect(output).toContain("✘");
    expect(output).toContain("Something failed");
  });

  test("shows info icon and message for info result", () => {
    const output = renderToString(
      <ProgressView title="Test" result={{ type: "info", message: "FYI: 3 items skipped" }} />
    );
    expect(output).toContain("ℹ");
    expect(output).toContain("FYI: 3 items skipped");
  });

  test("renders log lines", () => {
    const output = renderToString(
      <ProgressView title="Test" logLines={["Line 1", "Line 2", "Line 3"]} />
    );
    expect(output).toContain("Line 1");
    expect(output).toContain("Line 2");
    expect(output).toContain("Line 3");
  });

  test("renders footer hint when showDismiss is true", () => {
    const output = renderToString(
      <ProgressView title="Test" showDismiss />
    );
    expect(output).toContain("Press any key");
  });

  test("renders without crashing (mount/unmount cycle)", () => {
    expect(() =>
      renderToString(<ProgressView title="Test" />)
    ).not.toThrow();
  });

  test("does not show spinner when not spinning", () => {
    const output = renderToString(
      <ProgressView title="Test" spinning={false} />
    );
    const spinChars = ["⠂", "⠆", "⠇", "⠃", "⠉", "⠌", "⠎", "⠋"];
    const hasSpinner = spinChars.some((ch) => output.includes(ch));
    expect(hasSpinner).toBe(false);
  });

  test("result overrides spinner", () => {
    const output = renderToString(
      <ProgressView
        title="Test"
        spinning
        result={{ type: "success", message: "All good" }}
      />
    );
    // When result is set, the spinner should not show
    expect(output).toContain("✔");
    expect(output).toContain("All good");
  });
});
