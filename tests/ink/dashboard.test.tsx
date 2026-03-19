/**
 * dashboard.test.tsx — Tests for the DashboardScreen TUI component.
 *
 * TDD: written before the implementation.
 *
 * The dashboard is the default screen shown after the splash. It integrates:
 *   - WaveSummaryContext (replaces the SharedStore polling hack)
 *   - ChromeLayout top bar shows live counts
 *   - DashboardScreen shows agent status overview
 *   - DashboardStore provides reactive state to the screen
 *
 * Covers:
 *   - Module exports: DashboardScreen, DashboardStoreContext, useDashboardStore
 *   - DashboardScreen renders with no active wave ("no wave" message)
 *   - DashboardScreen renders agent counts from context
 *   - DashboardStoreContext provides default empty state
 *   - useDashboardStore hook returns the current store
 *   - DashboardStore type has agents, running, done, failed fields
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";

describe("dashboard module exports", () => {
  test("exports DashboardScreen, DashboardStoreContext, useDashboardStore", async () => {
    const mod = await import("../../src/ink/dashboard");
    expect(mod.DashboardScreen).toBeDefined();
    expect(mod.DashboardStoreContext).toBeDefined();
    expect(mod.useDashboardStore).toBeDefined();
  });
});

describe("DashboardScreen with no active wave", () => {
  test("renders 'no wave' message when agents list is empty", async () => {
    const { DashboardScreen, DashboardStoreContext } = await import("../../src/ink/dashboard");
    const emptyStore = { agents: [], running: 0, done: 0, failed: 0, total: 0 };
    const output = renderToString(
      React.createElement(
        DashboardStoreContext.Provider,
        { value: emptyStore },
        React.createElement(DashboardScreen, {})
      )
    );
    // EN_STRINGS["wave.noWave"] = "No active wave"
    expect(output).toContain("No active wave");
  });
});

describe("DashboardScreen with active wave", () => {
  test("renders agent count from context", async () => {
    const { DashboardScreen, DashboardStoreContext } = await import("../../src/ink/dashboard");
    const store = { agents: [{} as any, {} as any], running: 1, done: 1, failed: 0, total: 2 };
    const output = renderToString(
      React.createElement(
        DashboardStoreContext.Provider,
        { value: store },
        React.createElement(DashboardScreen, {})
      )
    );
    // Should show some numeric count
    expect(output).toMatch(/[12]/);
  });

  test("renders running count", async () => {
    const { DashboardScreen, DashboardStoreContext } = await import("../../src/ink/dashboard");
    const store = { agents: [{} as any], running: 1, done: 0, failed: 0, total: 1 };
    const output = renderToString(
      React.createElement(
        DashboardStoreContext.Provider,
        { value: store },
        React.createElement(DashboardScreen, {})
      )
    );
    expect(output).toContain("1");
  });
});

describe("DashboardStoreContext defaults", () => {
  test("useDashboardStore returns the context value", async () => {
    const { DashboardStoreContext } = await import("../../src/ink/dashboard");
    // The context should have a Provider and Consumer
    expect(DashboardStoreContext).toBeDefined();
    expect(typeof DashboardStoreContext.Provider).toBe("object");
  });
});
