/**
 * lifecycle.test.ts — Tests for TuiSession: single-ownership alt-screen +
 * raw mode lifecycle for the full TUI session.
 *
 * TDD: written before the implementation.
 *
 * Covers:
 *   - TuiSession.start() enters alt screen once
 *   - TuiSession.stop() exits alt screen once
 *   - Calling start() twice is a no-op (idempotent)
 *   - Calling stop() before start() is a no-op
 *   - TuiSession.isActive() reflects lifecycle state
 *   - installGuard / removeGuard wires process exit handlers
 *   - getStdin() returns process.stdin directly (no proxy needed)
 *   - stdinIsTTY captures the startup isTTY value
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { PassThrough } from "node:stream";

// We test the module in isolation by mocking process.stdout writes
// so we don't actually write escape codes during CI.

describe("TuiSession", () => {
  // We import lazily inside each test so module-level state is reset
  // (Bun caches modules, so we test the exported functions directly
  //  rather than re-requiring).

  test("module exports TuiSession, getStdin, stdinIsTTY", async () => {
    const mod = await import("../../src/ink/tui-session");
    expect(mod.TuiSession).toBeDefined();
    expect(mod.getStdin).toBeDefined();
    expect(typeof mod.stdinIsTTY).toBe("boolean");
  });

  test("stdinIsTTY is a boolean captured at import time", async () => {
    const { stdinIsTTY } = await import("../../src/ink/tui-session");
    // In test env stdin is not a TTY, so it should be false
    expect(typeof stdinIsTTY).toBe("boolean");
  });

  test("getStdin() returns process.stdin (no proxy)", async () => {
    const { getStdin } = await import("../../src/ink/tui-session");
    expect(getStdin()).toBe(process.stdin);
  });

  test("TuiSession.isActive() is false before start()", async () => {
    const { TuiSession } = await import("../../src/ink/tui-session");
    const session = new TuiSession();
    expect(session.isActive()).toBe(false);
  });

  test("TuiSession.isActive() is true after start()", async () => {
    const { TuiSession } = await import("../../src/ink/tui-session");
    const session = new TuiSession({ skipTty: true });
    session.start();
    expect(session.isActive()).toBe(true);
    session.stop();
  });

  test("TuiSession.isActive() is false after stop()", async () => {
    const { TuiSession } = await import("../../src/ink/tui-session");
    const session = new TuiSession({ skipTty: true });
    session.start();
    session.stop();
    expect(session.isActive()).toBe(false);
  });

  test("start() is idempotent — calling twice does not double-enter", async () => {
    const { TuiSession } = await import("../../src/ink/tui-session");
    const writes: string[] = [];
    const session = new TuiSession({
      skipTty: false,
      stdout: {
        isTTY: true,
        write: (s: string) => { writes.push(s); return true; },
      } as any,
    });
    session.start();
    session.start(); // second call should be no-op
    // Only one ENTER_ALT_SCREEN should have been written
    const altScreenWrites = writes.filter((w) => w.includes("\x1b[?1049h"));
    expect(altScreenWrites.length).toBe(1);
    session.stop();
  });

  test("stop() before start() is a no-op — does not throw", async () => {
    const { TuiSession } = await import("../../src/ink/tui-session");
    const session = new TuiSession({ skipTty: true });
    expect(() => session.stop()).not.toThrow();
  });

  test("stop() writes EXIT_ALT_SCREEN escape when TTY active", async () => {
    const { TuiSession } = await import("../../src/ink/tui-session");
    const writes: string[] = [];
    const session = new TuiSession({
      skipTty: false,
      stdout: {
        isTTY: true,
        write: (s: string) => { writes.push(s); return true; },
      } as any,
    });
    session.start();
    writes.length = 0; // clear start writes
    session.stop();
    const exitWrites = writes.filter((w) => w.includes("\x1b[?1049l"));
    expect(exitWrites.length).toBeGreaterThanOrEqual(1);
  });

  test("installGuard() adds process exit listener, removeGuard() removes it", async () => {
    const { TuiSession } = await import("../../src/ink/tui-session");
    const session = new TuiSession({ skipTty: true });
    const listenersBefore = process.listenerCount("exit");
    session.start();
    const listenersAfter = process.listenerCount("exit");
    expect(listenersAfter).toBeGreaterThan(listenersBefore);
    session.stop();
    const listenersAfterStop = process.listenerCount("exit");
    expect(listenersAfterStop).toBe(listenersBefore);
  });

  test("onStart callback fires when session starts", async () => {
    const { TuiSession } = await import("../../src/ink/tui-session");
    let called = false;
    const session = new TuiSession({
      skipTty: true,
      onStart: () => { called = true; },
    });
    session.start();
    expect(called).toBe(true);
    session.stop();
  });

  test("onStop callback fires when session stops", async () => {
    const { TuiSession } = await import("../../src/ink/tui-session");
    let called = false;
    const session = new TuiSession({
      skipTty: true,
      onStop: () => { called = true; },
    });
    session.start();
    session.stop();
    expect(called).toBe(true);
  });
});
