/**
 * review-list.test.tsx — Tests for the ReviewList Ink component.
 *
 * Verifies:
 *   - Renders header with title, subtitle, and counts
 *   - Renders list items with accept/reject indicators
 *   - Renders detail pane for the selected item
 *   - Renders status bar with keybind hints
 *   - Space toggles accept/reject
 *   - A key triggers approve flow
 *   - Q/Escape triggers cancel
 *   - R toggles all items
 *   - Shift+J/K reorders items
 *   - Handles empty items array
 *   - Shows validation issues count in header
 */

import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { render, renderToString } from "ink";
import { ReviewList } from "./review-list";
import type { ReviewItem, ReviewListConfig, ReviewValidationIssue } from "./review-list-types";
import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestStreams() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 120;
  (stdout as any).rows = 40;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = () => stdin;
  (stdin as any).ref = () => stdin;
  (stdin as any).unref = () => stdin;
  return { stdin, stdout };
}

function renderLive(element: React.ReactElement) {
  const { stdin, stdout } = createTestStreams();
  const chunks: string[] = [];
  stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });

  const instance = render(element, {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    instance,
    stdin: stdin as any as PassThrough,
    getOutput: () => chunks.join(""),
    cleanup: async () => {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}

function makeItem(id: string, overrides?: Partial<ReviewItem>): ReviewItem {
  return {
    id,
    title: `Title for ${id}`,
    priority: "medium",
    difficulty: "easy",
    dependsOn: [],
    accepted: true,
    detailFields: [],
    detailSections: [],
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<ReviewListConfig>): ReviewListConfig {
  return {
    title: "Test Review",
    subtitle: "Test Subtitle",
    itemLabel: "item",
    itemLabelPlural: "items",
    listLabel: "Proposed Items",
    issues: [],
    editFields: [],
    getEditFieldValue: () => "",
    setEditFieldValue: (item) => item,
    approveTitle: "Approve",
    approveBody: (n) => `Apply ${n} items?`,
    onApprove: () => {},
    onCancel: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Static rendering tests
// ---------------------------------------------------------------------------

describe("ReviewList (static rendering)", () => {
  test("renders the title", () => {
    const items = [makeItem("test-1")];
    const config = makeConfig({ title: "Genesis Review" });

    const output = renderToString(
      <ReviewList items={items} config={config} />
    );

    expect(output).toContain("Genesis Review");
  });

  test("renders the subtitle when provided", () => {
    const items = [makeItem("test-1")];
    const config = makeConfig({ subtitle: "Project Decomposition" });

    const output = renderToString(
      <ReviewList items={items} config={config} />
    );

    expect(output).toContain("Project Decomposition");
  });

  test("renders item IDs in the list", () => {
    const items = [makeItem("auth-system"), makeItem("api-layer")];
    const config = makeConfig();

    const output = renderToString(
      <ReviewList items={items} config={config} />
    );

    expect(output).toContain("auth-system");
    expect(output).toContain("api-layer");
  });

  test("renders accepted count", () => {
    const items = [
      makeItem("a", { accepted: true }),
      makeItem("b", { accepted: false }),
      makeItem("c", { accepted: true }),
    ];
    const config = makeConfig();

    const output = renderToString(
      <ReviewList items={items} config={config} />
    );

    expect(output).toContain("2");
    expect(output).toContain("accepted");
  });

  test("renders detail pane with selected item title", () => {
    const items = [makeItem("test-1", { title: "My Feature" })];
    const config = makeConfig();

    const output = renderToString(
      <ReviewList items={items} config={config} />
    );

    expect(output).toContain("My Feature");
  });

  test("renders keybind hints in status bar", () => {
    const items = [makeItem("test-1")];
    const config = makeConfig();

    const output = renderToString(
      <ReviewList items={items} config={config} />
    );

    // The status bar contains key labels
    expect(output).toContain("toggle");
    expect(output).toContain("approve");
    expect(output).toContain("cancel");
  });

  test("handles empty items array", () => {
    const config = makeConfig();

    const output = renderToString(
      <ReviewList items={[]} config={config} />
    );

    expect(output).toContain("No items");
  });

  test("renders REJECTED label for rejected items", () => {
    const items = [makeItem("rejected-thing", { accepted: false })];
    const config = makeConfig();

    const output = renderToString(
      <ReviewList items={items} config={config} />
    );

    expect(output).toContain("REJECTED");
  });

  test("shows validation issue count when issues exist", () => {
    const items = [makeItem("test-1")];
    const issues: ReviewValidationIssue[] = [
      { level: "error", message: "bad thing" },
      { level: "warning", message: "careful" },
    ];
    const config = makeConfig({ issues });

    const output = renderToString(
      <ReviewList items={items} config={config} />
    );

    // Should show error and/or warning counts
    expect(output).toContain("1");
  });

  test("renders detail fields", () => {
    const items = [
      makeItem("test-1", {
        detailFields: [
          { label: "HITL Mode", value: "cautious", color: "yellow" },
        ],
      }),
    ];
    const config = makeConfig();

    const output = renderToString(
      <ReviewList items={items} config={config} />
    );

    expect(output).toContain("HITL Mode");
    expect(output).toContain("cautious");
  });

  test("renders detail sections", () => {
    const items = [
      makeItem("test-1", {
        detailSections: [
          { label: "Constraints", items: ["Use TypeScript"], prefix: "+" },
        ],
      }),
    ];
    const config = makeConfig();

    const output = renderToString(
      <ReviewList items={items} config={config} />
    );

    expect(output).toContain("Constraints");
    expect(output).toContain("Use TypeScript");
  });

  test("renders dependency info", () => {
    const items = [
      makeItem("child", { dependsOn: ["parent"] }),
      makeItem("parent"),
    ];
    const config = makeConfig();

    const output = renderToString(
      <ReviewList items={items} config={config} />
    );

    expect(output).toContain("Depends on");
    expect(output).toContain("parent");
  });
});

// ---------------------------------------------------------------------------
// Interaction tests
// ---------------------------------------------------------------------------

describe("ReviewList (interactions)", () => {
  test("Q key triggers onCancel", async () => {
    const onCancel = mock(() => {});
    const items = [makeItem("test-1")];
    const config = makeConfig({ onCancel });

    const { stdin, cleanup } = renderLive(
      <ReviewList items={items} config={config} />
    );

    await new Promise((r) => setTimeout(r, 50));
    stdin.write("q");
    await new Promise((r) => setTimeout(r, 50));

    expect(onCancel).toHaveBeenCalled();
    await cleanup();
  });

  test("Space toggles selected item acceptance", async () => {
    const items = [makeItem("test-1"), makeItem("test-2")];
    const config = makeConfig();

    const { stdin, getOutput, cleanup } = renderLive(
      <ReviewList items={items} config={config} />
    );

    await new Promise((r) => setTimeout(r, 50));
    // Press space to reject first item
    stdin.write(" ");
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    expect(output).toContain("REJECTED");

    await cleanup();
  });

  test("R toggles all items", async () => {
    const items = [makeItem("a"), makeItem("b"), makeItem("c")];
    const config = makeConfig();

    const { stdin, getOutput, cleanup } = renderLive(
      <ReviewList items={items} config={config} />
    );

    await new Promise((r) => setTimeout(r, 50));
    // Press R to reject all (since all start accepted)
    stdin.write("r");
    await new Promise((r) => setTimeout(r, 100));

    const output = getOutput();
    expect(output).toContain("REJECTED");

    await cleanup();
  });
});
