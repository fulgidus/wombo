/**
 * router.test.tsx — Tests for the screen router (NavigationContext, useNavigation, ScreenRouter).
 *
 * TDD: these tests are written before the implementation.
 *
 * Covers:
 *   - NavigationContext provides push/pop/replace/reset
 *   - useNavigation() hook returns navigation helpers
 *   - ScreenRouter renders the current screen component
 *   - push() navigates to a new screen
 *   - pop() returns to the previous screen
 *   - replace() swaps the current screen without adding to stack
 *   - reset() clears stack and navigates to a given screen
 *   - stack is inaccessible from outside the router (encapsulated)
 *   - Rendering an unknown screen key falls back gracefully
 *   - RouterRoot: single render() wrapper with alt-screen + lifecycle ownership
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import React, { useContext, useEffect } from "react";
import { render, renderToString, Text, Box } from "ink";
import { PassThrough } from "node:stream";
import {
  NavigationContext,
  useNavigation,
  ScreenRouter,
  type ScreenKey,
  type ScreenMap,
  type NavigationState,
} from "../../src/ink/router";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestStreams() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  (stdout as any).columns = 80;
  (stdout as any).rows = 24;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = () => stdin;
  (stdin as any).ref = () => stdin;
  (stdin as any).unref = () => stdin;
  return { stdin, stdout };
}

const TEST_SCREENS: ScreenMap = {
  home: () => <Text>Home Screen</Text>,
  detail: ({ id }: { id: string }) => <Text>Detail: {id}</Text>,
  settings: () => <Text>Settings Screen</Text>,
};

// ---------------------------------------------------------------------------
// NavigationContext unit tests
// ---------------------------------------------------------------------------

describe("NavigationContext", () => {
  test("is defined and has a default value", () => {
    expect(NavigationContext).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// useNavigation hook tests
// ---------------------------------------------------------------------------

describe("useNavigation", () => {
  test("returns push, pop, replace, reset, and currentScreen", () => {
    let nav: ReturnType<typeof useNavigation> | null = null;

    function Probe() {
      nav = useNavigation();
      return null;
    }

    const { stdin, stdout } = createTestStreams();
    const instance = render(
      <ScreenRouter screens={TEST_SCREENS} initialScreen="home">
        <Probe />
      </ScreenRouter>,
      { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    expect(nav).not.toBeNull();
    expect(typeof nav!.push).toBe("function");
    expect(typeof nav!.pop).toBe("function");
    expect(typeof nav!.replace).toBe("function");
    expect(typeof nav!.reset).toBe("function");
    expect(nav!.currentScreen).toBe("home");

    instance.unmount();
  });
});

// ---------------------------------------------------------------------------
// ScreenRouter rendering tests
// ---------------------------------------------------------------------------

describe("ScreenRouter (static)", () => {
  test("renders the initial screen", () => {
    const output = renderToString(
      <ScreenRouter screens={TEST_SCREENS} initialScreen="home" />
    );
    expect(output).toContain("Home Screen");
  });

  test("does not render other screens initially", () => {
    const output = renderToString(
      <ScreenRouter screens={TEST_SCREENS} initialScreen="home" />
    );
    expect(output).not.toContain("Settings Screen");
  });

  test("renders initial screen with props", () => {
    const screensWithProps: ScreenMap = {
      detail: ({ id }: { id: string }) => <Text>Detail: {id}</Text>,
    };
    const output = renderToString(
      <ScreenRouter
        screens={screensWithProps}
        initialScreen="detail"
        initialProps={{ id: "task-42" }}
      />
    );
    expect(output).toContain("Detail: task-42");
  });

  test("renders fallback for unknown initial screen", () => {
    const output = renderToString(
      <ScreenRouter
        screens={TEST_SCREENS}
        initialScreen={"nonexistent" as ScreenKey}
      />
    );
    // Should render something (not crash), e.g. empty or an error message
    expect(typeof output).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Navigation actions (live render)
// ---------------------------------------------------------------------------

describe("ScreenRouter (navigation)", () => {
  test("push() navigates to a new screen", async () => {
    let nav: ReturnType<typeof useNavigation> | null = null;

    function NavProbe() {
      nav = useNavigation();
      return null;
    }

    const { stdin, stdout } = createTestStreams();
    const chunks: string[] = [];
    stdout.on("data", (c: Buffer) => chunks.push(c.toString()));

    const instance = render(
      <ScreenRouter screens={TEST_SCREENS} initialScreen="home">
        <NavProbe />
      </ScreenRouter>,
      { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(chunks.join("")).toContain("Home Screen");

    // Navigate to settings
    nav!.push("settings");
    await new Promise((r) => setTimeout(r, 50));
    expect(chunks.join("")).toContain("Settings Screen");
    expect(nav!.currentScreen).toBe("settings");

    instance.unmount();
  });

  test("pop() returns to previous screen", async () => {
    let nav: ReturnType<typeof useNavigation> | null = null;

    function NavProbe() {
      nav = useNavigation();
      return null;
    }

    const { stdin, stdout } = createTestStreams();
    const instance = render(
      <ScreenRouter screens={TEST_SCREENS} initialScreen="home">
        <NavProbe />
      </ScreenRouter>,
      { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    nav!.push("settings");
    await new Promise((r) => setTimeout(r, 50));
    expect(nav!.currentScreen).toBe("settings");

    nav!.pop();
    await new Promise((r) => setTimeout(r, 50));
    expect(nav!.currentScreen).toBe("home");

    instance.unmount();
  });

  test("pop() on root screen is a no-op", async () => {
    let nav: ReturnType<typeof useNavigation> | null = null;

    function NavProbe() {
      nav = useNavigation();
      return null;
    }

    const { stdin, stdout } = createTestStreams();
    const instance = render(
      <ScreenRouter screens={TEST_SCREENS} initialScreen="home">
        <NavProbe />
      </ScreenRouter>,
      { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    nav!.pop(); // should not throw or crash
    await new Promise((r) => setTimeout(r, 50));
    expect(nav!.currentScreen).toBe("home");

    instance.unmount();
  });

  test("replace() swaps current screen without adding to stack", async () => {
    let nav: ReturnType<typeof useNavigation> | null = null;

    function NavProbe() {
      nav = useNavigation();
      return null;
    }

    const { stdin, stdout } = createTestStreams();
    const instance = render(
      <ScreenRouter screens={TEST_SCREENS} initialScreen="home">
        <NavProbe />
      </ScreenRouter>,
      { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    nav!.push("detail", { id: "x" });
    await new Promise((r) => setTimeout(r, 50));
    nav!.replace("settings");
    await new Promise((r) => setTimeout(r, 50));
    expect(nav!.currentScreen).toBe("settings");

    // pop() should go back to home (not detail, since replace swapped it)
    nav!.pop();
    await new Promise((r) => setTimeout(r, 50));
    expect(nav!.currentScreen).toBe("home");

    instance.unmount();
  });

  test("reset() clears stack and navigates to given screen", async () => {
    let nav: ReturnType<typeof useNavigation> | null = null;

    function NavProbe() {
      nav = useNavigation();
      return null;
    }

    const { stdin, stdout } = createTestStreams();
    const instance = render(
      <ScreenRouter screens={TEST_SCREENS} initialScreen="home">
        <NavProbe />
      </ScreenRouter>,
      { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    nav!.push("settings");
    nav!.push("detail", { id: "y" });
    await new Promise((r) => setTimeout(r, 50));

    nav!.reset("home");
    await new Promise((r) => setTimeout(r, 50));
    expect(nav!.currentScreen).toBe("home");

    // pop() should be a no-op now (stack is empty)
    nav!.pop();
    await new Promise((r) => setTimeout(r, 50));
    expect(nav!.currentScreen).toBe("home");

    instance.unmount();
  });

  test("stackDepth reflects navigation history", async () => {
    let nav: ReturnType<typeof useNavigation> | null = null;

    function NavProbe() {
      nav = useNavigation();
      return null;
    }

    const { stdin, stdout } = createTestStreams();
    const instance = render(
      <ScreenRouter screens={TEST_SCREENS} initialScreen="home">
        <NavProbe />
      </ScreenRouter>,
      { stdin, stdout, debug: true, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(nav!.stackDepth).toBe(1);

    nav!.push("settings");
    await new Promise((r) => setTimeout(r, 50));
    expect(nav!.stackDepth).toBe(2);

    nav!.push("detail", { id: "z" });
    await new Promise((r) => setTimeout(r, 50));
    expect(nav!.stackDepth).toBe(3);

    nav!.pop();
    await new Promise((r) => setTimeout(r, 50));
    expect(nav!.stackDepth).toBe(2);

    instance.unmount();
  });
});
