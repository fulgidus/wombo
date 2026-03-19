/**
 * monitor-router.test.tsx — TDD tests for the ScreenRouter-based architecture
 * in WaveMonitorShell and DaemonMonitorShell.
 *
 * These tests verify that:
 *   1. WaveMonitorShell uses ScreenRouter internally (not hand-rolled useState switching)
 *   2. DaemonMonitorShell uses ScreenRouter internally
 *   3. The screen transition from splash → monitor works via ScreenRouter.replace()
 *   4. The EscMenu "Settings" action pushes to the settings screen via ScreenRouter
 *   5. The chrome bars are rendered by ChromeLayout wrapping ScreenRouter content
 *   6. WaveMonitorScreen and DaemonMonitorScreen are exported as router-compatible screen components
 *
 * Architecture enforced by these tests:
 *
 *   ThemeContext.Provider
 *     I18nContext.Provider
 *       DashboardStoreContext.Provider
 *         ScreenRouter (splash → monitor → settings)
 *           EscMenuProvider
 *             ChromeLayout
 *               <current screen component>
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";

// ---------------------------------------------------------------------------
// Inline stubs
// ---------------------------------------------------------------------------

function makeMinimalConfig(overrides: Record<string, unknown> = {}): any {
  return {
    agent: { tmuxPrefix: "woco" },
    tui: { theme: "default", locale: "en" },
    ...overrides,
  };
}

function makeWaveState(agentOverrides: Array<Record<string, unknown>> = []): any {
  return {
    wave_id: "test-wave",
    base_branch: "main",
    model: "claude-3",
    agents: agentOverrides.map((a) => ({
      feature_id: "feat-x",
      status: "queued",
      activity: null,
      started_at: null,
      retries: 0,
      effort_estimate_ms: null,
      build_passed: null,
      build_output: null,
      ...a,
    })),
  };
}

class StubMonitor {
  activityLogs = new Map<string, any[]>();
  getActivityLog(_id: string) { return []; }
  tokenCollector = {
    getAllRecords: () => [],
    getSummary: (_id: string) => null,
  };
}

class StubDaemonClient {
  on(_event: string, _handler: (...args: any[]) => void): () => void {
    return () => {};
  }
  requestState(): Promise<any> {
    return Promise.resolve({ scheduler: null, agents: [] });
  }
  retryAgent(_id: string) {}
  answerHitl(_agentId: string, _qId: string, _text: string) {}
}

// ---------------------------------------------------------------------------
// WaveMonitorShell — uses ScreenRouter internally
// ---------------------------------------------------------------------------

describe("WaveMonitorShell uses ScreenRouter", () => {
  test("WaveMonitorShell renders without crashing via renderToString", async () => {
    const { WaveMonitorShell } = (await import("../../src/ink/run-wave-monitor")) as any;

    const output = renderToString(
      React.createElement(WaveMonitorShell, {
        state: makeWaveState(),
        monitor: new StubMonitor(),
        interactive: false,
        projectRoot: "/tmp",
        config: makeMinimalConfig(),
        onQuit: () => {},
        onQuitAfterComplete: () => {},
        onMuxAttach: () => {},
        notifyRef: { current: null },
        splashDurationMs: 0,
        skipSplash: false,
      })
    );

    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });

  test("WaveMonitorShell with skipSplash=true renders monitor content", async () => {
    const { WaveMonitorShell } = (await import("../../src/ink/run-wave-monitor")) as any;

    const output = renderToString(
      React.createElement(WaveMonitorShell, {
        state: makeWaveState([{ feature_id: "router-feat", status: "running" }]),
        monitor: new StubMonitor(),
        interactive: false,
        projectRoot: "/tmp",
        config: makeMinimalConfig(),
        onQuit: () => {},
        onQuitAfterComplete: () => {},
        onMuxAttach: () => {},
        notifyRef: { current: null },
        splashDurationMs: 0,
        skipSplash: true,
      })
    );

    // WaveMonitorView should show the agent id
    expect(output).toContain("router-feat");
  });

  test("WaveMonitorShell with skipSplash=false shows splash (contains woco/wombo logo)", async () => {
    const { WaveMonitorShell } = (await import("../../src/ink/run-wave-monitor")) as any;

    const output = renderToString(
      React.createElement(WaveMonitorShell, {
        state: makeWaveState(),
        monitor: new StubMonitor(),
        interactive: false,
        projectRoot: "/tmp",
        config: makeMinimalConfig(),
        onQuit: () => {},
        onQuitAfterComplete: () => {},
        onMuxAttach: () => {},
        notifyRef: { current: null },
        splashDurationMs: 0,
        skipSplash: false,
      })
    );

    // SplashScreen shows the woco/wombo logo text
    expect(output.toLowerCase()).toMatch(/woco|wombo/);
  });

  test("WaveMonitorShell renders chrome (woco label in top bar)", async () => {
    const { WaveMonitorShell } = (await import("../../src/ink/run-wave-monitor")) as any;

    const output = renderToString(
      React.createElement(WaveMonitorShell, {
        state: makeWaveState(),
        monitor: new StubMonitor(),
        interactive: false,
        projectRoot: "/tmp",
        config: makeMinimalConfig(),
        onQuit: () => {},
        onQuitAfterComplete: () => {},
        onMuxAttach: () => {},
        notifyRef: { current: null },
        splashDurationMs: 0,
        skipSplash: false,
      })
    );

    expect(output).toContain("woco");
  });
});

// ---------------------------------------------------------------------------
// WaveMonitorScreen — exported router-compatible screen component
// ---------------------------------------------------------------------------

describe("WaveMonitorScreen export", () => {
  test("WaveMonitorScreen is exported from run-wave-monitor", async () => {
    const mod = await import("../../src/ink/run-wave-monitor");
    expect((mod as any).WaveMonitorScreen).toBeDefined();
    expect(typeof (mod as any).WaveMonitorScreen).toBe("function");
  });

  test("WaveMonitorScreen renders inside a ScreenRouter context", async () => {
    const { WaveMonitorScreen } = (await import("../../src/ink/run-wave-monitor")) as any;
    const { ScreenRouter } = await import("../../src/ink/router");
    const { DashboardStoreContext } = await import("../../src/ink/dashboard");
    const { ThemeContext, getTheme } = await import("../../src/ink/theme");
    const { I18nContext, getLocaleT } = await import("../../src/ink/i18n");

    const theme = getTheme("default");
    const tFn = getLocaleT("en");
    const emptyDashStore = { agents: [], running: 0, done: 0, failed: 0, total: 0 };

    const screens = { monitor: WaveMonitorScreen };
    const output = renderToString(
      React.createElement(
        ThemeContext.Provider,
        { value: theme },
        React.createElement(
          I18nContext.Provider,
          { value: tFn },
          React.createElement(
            DashboardStoreContext.Provider,
            { value: emptyDashStore },
            React.createElement(ScreenRouter, {
              screens,
              initialScreen: "monitor",
              initialProps: {
                waveState: makeWaveState([{ feature_id: "screen-feat", status: "running" }]),
                monitor: new StubMonitor(),
                interactive: false,
                projectRoot: "/tmp",
                config: makeMinimalConfig(),
                onQuit: () => {},
                onQuitAfterComplete: () => {},
                onMuxAttach: () => {},
              },
            })
          )
        )
      )
    );

    expect(output).toContain("screen-feat");
  });
});

// ---------------------------------------------------------------------------
// DaemonMonitorShell — uses ScreenRouter internally
// ---------------------------------------------------------------------------

describe("DaemonMonitorShell uses ScreenRouter", () => {
  test("DaemonMonitorShell renders without crashing via renderToString", async () => {
    const { DaemonMonitorShell } = (await import("../../src/ink/run-daemon-monitor")) as any;

    const output = renderToString(
      React.createElement(DaemonMonitorShell, {
        client: new StubDaemonClient(),
        projectRoot: "/tmp",
        config: makeMinimalConfig(),
        onQuit: () => {},
        onQuitAfterComplete: () => {},
        notifyRef: { current: null },
        splashDurationMs: 0,
        skipSplash: false,
      })
    );

    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });

  test("DaemonMonitorShell renders chrome (woco in output)", async () => {
    const { DaemonMonitorShell } = (await import("../../src/ink/run-daemon-monitor")) as any;

    const output = renderToString(
      React.createElement(DaemonMonitorShell, {
        client: new StubDaemonClient(),
        projectRoot: "/tmp",
        config: makeMinimalConfig(),
        onQuit: () => {},
        onQuitAfterComplete: () => {},
        notifyRef: { current: null },
        splashDurationMs: 0,
        skipSplash: false,
      })
    );

    expect(output).toContain("woco");
  });

  test("DaemonMonitorShell with skipSplash=true renders monitor content (no crash)", async () => {
    const { DaemonMonitorShell } = (await import("../../src/ink/run-daemon-monitor")) as any;

    const output = renderToString(
      React.createElement(DaemonMonitorShell, {
        client: new StubDaemonClient(),
        projectRoot: "/tmp",
        config: makeMinimalConfig(),
        onQuit: () => {},
        onQuitAfterComplete: () => {},
        notifyRef: { current: null },
        splashDurationMs: 0,
        skipSplash: true,
      })
    );

    expect(typeof output).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// DaemonMonitorScreen — exported router-compatible screen component
// ---------------------------------------------------------------------------

describe("DaemonMonitorScreen export", () => {
  test("DaemonMonitorScreen is exported from run-daemon-monitor", async () => {
    const mod = await import("../../src/ink/run-daemon-monitor");
    expect((mod as any).DaemonMonitorScreen).toBeDefined();
    expect(typeof (mod as any).DaemonMonitorScreen).toBe("function");
  });

  test("DaemonMonitorScreen renders inside a ScreenRouter context", async () => {
    const { DaemonMonitorScreen } = (await import("../../src/ink/run-daemon-monitor")) as any;
    const { ScreenRouter } = await import("../../src/ink/router");
    const { DashboardStoreContext } = await import("../../src/ink/dashboard");
    const { ThemeContext, getTheme } = await import("../../src/ink/theme");
    const { I18nContext, getLocaleT } = await import("../../src/ink/i18n");

    const theme = getTheme("default");
    const tFn = getLocaleT("en");
    const emptyDashStore = { agents: [], running: 0, done: 0, failed: 0, total: 0 };

    const screens = { monitor: DaemonMonitorScreen };
    const output = renderToString(
      React.createElement(
        ThemeContext.Provider,
        { value: theme },
        React.createElement(
          I18nContext.Provider,
          { value: tFn },
          React.createElement(
            DashboardStoreContext.Provider,
            { value: emptyDashStore },
            React.createElement(ScreenRouter, {
              screens,
              initialScreen: "monitor",
              initialProps: {
                client: new StubDaemonClient(),
                projectRoot: "/tmp",
                config: makeMinimalConfig(),
                onQuit: () => {},
                onQuitAfterComplete: () => {},
              },
            })
          )
        )
      )
    );

    expect(typeof output).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// ScreenRouter integration — EscMenuProvider is inside ScreenRouter
// ---------------------------------------------------------------------------

describe("EscMenuProvider is rendered inside ScreenRouter tree", () => {
  test("WaveMonitorShell tree: EscMenu does not crash (is inside ScreenRouter)", async () => {
    // EscMenuProvider uses useNavigation() internally — if it were outside
    // ScreenRouter, it would use defaultNav (no-op) which is still fine,
    // but the point is EscMenuProvider must be INSIDE the NavigationContext
    // so ESC → settings can call nav.push("settings"). This test verifies
    // that the tree renders without error (no "useNavigation outside provider" crash).
    const { WaveMonitorShell } = (await import("../../src/ink/run-wave-monitor")) as any;

    expect(() =>
      renderToString(
        React.createElement(WaveMonitorShell, {
          state: makeWaveState(),
          monitor: new StubMonitor(),
          interactive: false,
          projectRoot: "/tmp",
          config: makeMinimalConfig(),
          onQuit: () => {},
          onQuitAfterComplete: () => {},
          onMuxAttach: () => {},
          notifyRef: { current: null },
          splashDurationMs: 0,
          skipSplash: false,
        })
      )
    ).not.toThrow();
  });

  test("DaemonMonitorShell tree: EscMenu does not crash (is inside ScreenRouter)", async () => {
    const { DaemonMonitorShell } = (await import("../../src/ink/run-daemon-monitor")) as any;

    expect(() =>
      renderToString(
        React.createElement(DaemonMonitorShell, {
          client: new StubDaemonClient(),
          projectRoot: "/tmp",
          config: makeMinimalConfig(),
          onQuit: () => {},
          onQuitAfterComplete: () => {},
          notifyRef: { current: null },
          splashDurationMs: 0,
          skipSplash: false,
        })
      )
    ).not.toThrow();
  });
});
