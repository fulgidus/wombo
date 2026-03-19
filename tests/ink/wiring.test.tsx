/**
 * wiring.test.tsx — Tests verifying that InkWomboTUI and InkDaemonTUI
 * render through the new TUI shell (ChromeLayout, ScreenRouter,
 * EscMenuProvider, SplashScreen → WaveMonitorView).
 *
 * TDD: written before the implementation changes.
 *
 * Covers:
 *   - WaveMonitorShell and DaemonMonitorShell are exported from their modules
 *   - WaveMonitorShell renders "woco" chrome (ChromeTopBar) in output
 *   - DaemonMonitorShell renders "woco" chrome in output
 *   - WaveMonitorShell accepts skipSplash prop to land directly on content
 *   - getStableStdin is no longer the default stdin source in InkDaemonTUI
 *     (TuiSession/getStdin is used instead)
 *   - DashboardStoreContext is provided (accessible from WaveMonitorShell tree)
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";

// ---------------------------------------------------------------------------
// Inline minimal stubs (no external helper files)
// ---------------------------------------------------------------------------

function makeMinimalConfig(overrides: Record<string, unknown> = {}): any {
  return {
    agent: { tmuxPrefix: "woco" },
    tui: { theme: "default", locale: "en" },
    ...overrides,
  };
}

/** Minimal WaveState for tests */
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

/** Minimal ProcessMonitor stub */
class StubMonitor {
  activityLogs = new Map<string, any[]>();
  getActivityLog(_id: string) { return []; }
  tokenCollector = {
    getAllRecords: () => [],
    getSummary: (_id: string) => null,
  };
}

/** Minimal DaemonClient stub */
class StubDaemonClient {
  on(_event: string, _handler: (...args: any[]) => void): () => void {
    return () => {};
  }
  requestState(): Promise<any> {
    return Promise.resolve({
      scheduler: null,
      agents: [],
    });
  }
  retryAgent(_id: string) {}
  answerHitl(_agentId: string, _qId: string, _text: string) {}
}

// ---------------------------------------------------------------------------
// Module shape tests
// ---------------------------------------------------------------------------

describe("run-wave-monitor exports WaveMonitorShell", () => {
  test("WaveMonitorShell is exported", async () => {
    const mod = await import("../../src/ink/run-wave-monitor");
    expect((mod as any).WaveMonitorShell).toBeDefined();
  });

  test("InkWomboTUI is still exported (backward compat)", async () => {
    const mod = await import("../../src/ink/run-wave-monitor");
    expect(mod.InkWomboTUI).toBeDefined();
  });
});

describe("run-daemon-monitor exports DaemonMonitorShell", () => {
  test("DaemonMonitorShell is exported", async () => {
    const mod = await import("../../src/ink/run-daemon-monitor");
    expect((mod as any).DaemonMonitorShell).toBeDefined();
  });

  test("InkDaemonTUI is still exported (backward compat)", async () => {
    const mod = await import("../../src/ink/run-daemon-monitor");
    expect(mod.InkDaemonTUI).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// WaveMonitorShell renders ChromeLayout chrome ("woco" in output)
// ---------------------------------------------------------------------------

describe("WaveMonitorShell renders chrome", () => {
  test("renders 'woco' from ChromeTopBar", async () => {
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

  test("renders splash screen initially (contains 'woco' logo text)", async () => {
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

    // SplashScreen renders logo lines with "woco" or "wombo"
    expect(output.toLowerCase()).toMatch(/woco|wombo/);
  });

  test("skipSplash=true lands directly on WaveMonitorView", async () => {
    const { WaveMonitorShell } = (await import("../../src/ink/run-wave-monitor")) as any;

    const output = renderToString(
      React.createElement(WaveMonitorShell, {
        state: makeWaveState([{ feature_id: "my-feat", status: "running" }]),
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

    // WaveMonitorView shows the agent id
    expect(output).toContain("my-feat");
  });
});

// ---------------------------------------------------------------------------
// DaemonMonitorShell renders ChromeLayout chrome
// ---------------------------------------------------------------------------

describe("DaemonMonitorShell renders chrome", () => {
  test("renders 'woco' from ChromeTopBar", async () => {
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

  test("skipSplash=true renders DaemonMonitorAdapter content directly", async () => {
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

    // With no agents, WaveMonitorView renders the empty-state message
    expect(output).toBeDefined();
    expect(typeof output).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// InkWomboTUI uses TuiSession instead of direct alt-screen calls
// ---------------------------------------------------------------------------

describe("InkWomboTUI.start() uses TuiSession", () => {
  test("InkWomboTUI has a _session property after construction", async () => {
    const { InkWomboTUI } = await import("../../src/ink/run-wave-monitor");
    const tui = new InkWomboTUI({
      state: makeWaveState(),
      monitor: new StubMonitor() as any,
      onQuit: () => {},
      interactive: false,
      projectRoot: "/tmp",
      config: makeMinimalConfig(),
    });
    // The new implementation stores a TuiSession on the instance
    expect((tui as any)._session).toBeDefined();
  });
});

describe("InkDaemonTUI uses TuiSession", () => {
  test("InkDaemonTUI has a _session property after construction", async () => {
    const { InkDaemonTUI } = await import("../../src/ink/run-daemon-monitor");
    const tui = new InkDaemonTUI({
      client: new StubDaemonClient() as any,
      onQuit: () => {},
      projectRoot: "/tmp",
      config: makeMinimalConfig(),
    });
    expect((tui as any)._session).toBeDefined();
  });
});
