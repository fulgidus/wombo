/**
 * modal.test.tsx — Tests for the Modal wrapper component.
 *
 * Verifies:
 *   - Modal renders children
 *   - Modal displays a title/label
 *   - Modal renders a border
 *   - Modal renders footer content
 *   - Modal renders without crashing
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString, Text } from "ink";
import { Modal } from "./modal";

describe("Modal", () => {
  test("renders children", () => {
    const output = renderToString(
      <Modal title="Test">
        <Text>child content</Text>
      </Modal>
    );
    expect(output).toContain("child content");
  });

  test("renders the title/label", () => {
    const output = renderToString(
      <Modal title="My Modal">
        <Text>body</Text>
      </Modal>
    );
    expect(output).toContain("My Modal");
  });

  test("renders footer content when provided", () => {
    const output = renderToString(
      <Modal title="Test" footer={<Text>footer hint</Text>}>
        <Text>body</Text>
      </Modal>
    );
    expect(output).toContain("footer hint");
  });

  test("renders border characters", () => {
    const output = renderToString(
      <Modal title="Test">
        <Text>body</Text>
      </Modal>
    );
    // Box border characters should appear
    expect(output).toContain("─");
  });

  test("renders without crashing (mount/unmount cycle)", () => {
    expect(() =>
      renderToString(
        <Modal title="Test">
          <Text>body</Text>
        </Modal>
      )
    ).not.toThrow();
  });

  test("renders with custom borderColor", () => {
    // Should not throw — borderColor is optional
    expect(() =>
      renderToString(
        <Modal title="Test" borderColor="cyan">
          <Text>body</Text>
        </Modal>
      )
    ).not.toThrow();
  });
});
