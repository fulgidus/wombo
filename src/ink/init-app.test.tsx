/**
 * init-app.test.tsx — Tests for the init app runner (runInitApp).
 *
 * Verifies:
 *   - runInitApp renders the InitForm component
 *   - The app mounts and renders project information
 *   - The component tree renders without crashing
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { InitApp, type InitAppProps } from "./init-app";

describe("InitApp", () => {
  test("renders with auto-detected values", () => {
    const props: InitAppProps = {
      projectRoot: "/home/user/my-project",
      force: false,
    };
    const output = renderToString(<InitApp {...props} />);
    expect(output).toContain("my-project");
    expect(output).toContain("wombo-combo");
  });

  test("renders without crashing", () => {
    const props: InitAppProps = {
      projectRoot: "/tmp/test-project",
      force: false,
    };
    expect(() => renderToString(<InitApp {...props} />)).not.toThrow();
  });

  test("shows editable fields", () => {
    const props: InitAppProps = {
      projectRoot: "/tmp/test-project",
      force: false,
    };
    const output = renderToString(<InitApp {...props} />);
    expect(output).toContain("Base Branch");
    expect(output).toContain("Build Command");
    expect(output).toContain("Install Command");
  });
});
