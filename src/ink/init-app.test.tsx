/**
 * init-app.test.tsx — Tests for the init app wrapper (InitApp).
 *
 * Verifies:
 *   - InitApp renders the InitForm component with auto-detected values
 *   - The app mounts and renders project information
 *   - The component tree renders without crashing
 *   - Auto-detected project name is derived from projectRoot
 *   - InitApp starts in "form" phase and shows editable fields
 *   - renderInitApp export is a function
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { InitApp, renderInitApp, type InitAppProps } from "./init-app";

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

  test("auto-detects project name from path", () => {
    const props: InitAppProps = {
      projectRoot: "/home/user/workspace/awesome-app",
      force: false,
    };
    const output = renderToString(<InitApp {...props} />);
    expect(output).toContain("awesome-app");
  });

  test("shows auto-detected label for project name", () => {
    const props: InitAppProps = {
      projectRoot: "/tmp/test-project",
      force: false,
    };
    const output = renderToString(<InitApp {...props} />);
    expect(output).toContain("auto-detected");
  });

  test("renders in form phase on initial mount", () => {
    const props: InitAppProps = {
      projectRoot: "/tmp/test-project",
      force: false,
    };
    const output = renderToString(<InitApp {...props} />);
    // In form phase, we should see the navigation key hints
    expect(output).toContain("Ctrl+S");
  });

  test("accepts force flag", () => {
    const propsNoForce: InitAppProps = {
      projectRoot: "/tmp/test-project",
      force: false,
    };
    const propsForce: InitAppProps = {
      projectRoot: "/tmp/test-project",
      force: true,
    };
    // Both should render without crashing
    expect(() => renderToString(<InitApp {...propsNoForce} />)).not.toThrow();
    expect(() => renderToString(<InitApp {...propsForce} />)).not.toThrow();
  });
});

describe("renderInitApp", () => {
  test("is an async function", () => {
    expect(typeof renderInitApp).toBe("function");
  });
});
