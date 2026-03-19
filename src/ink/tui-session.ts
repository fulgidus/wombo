/**
 * tui-session.ts — Single-ownership alt-screen + raw mode lifecycle manager.
 *
 * Problem solved:
 *   The old pattern had 9 separate `inkRender()` calls. Each one called
 *   `stdin.setRawMode(false)` on unmount, corrupting `stdin.isTTY` for the
 *   next render. `bun-stdin.ts` worked around this with an isTTY proxy.
 *
 *   With the screen router (single `render()` call for the entire TUI
 *   session), we only need to:
 *     1. Enter the alternate screen buffer ONCE at TUI start.
 *     2. Set raw mode ONCE at TUI start (Ink does this internally on its
 *        single render call — we just don't unmount mid-session).
 *     3. Exit the alternate screen buffer ONCE at TUI stop.
 *     4. Install a safety-net guard to restore terminal on crash/SIGINT.
 *
 * Usage:
 *   const session = new TuiSession();
 *   session.start();                    // enter alt screen, install guard
 *   // ... mount a single ScreenRouter ...
 *   session.stop();                     // exit alt screen, remove guard
 *
 * The `getStdin()` helper replaces `getStableStdin()` from the old
 * `bun-stdin.ts`. Since we no longer unmount/remount Ink mid-session, the
 * isTTY corruption issue disappears — this function simply returns
 * `process.stdin` directly.
 *
 * The old `bun-stdin.ts` is kept for now (so existing standalone run-*.tsx
 * launchers continue working) but is deprecated. It will be removed when
 * those launchers are migrated to the router in tui-dashboard.
 */

// ---------------------------------------------------------------------------
// Escape sequences (same as alt-screen.ts — kept in sync)
// ---------------------------------------------------------------------------

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H";
const EXIT_ALT_SCREEN = "\x1b[?25h\x1b[?1049l";

// ---------------------------------------------------------------------------
// stdinIsTTY — stable capture at process start
// ---------------------------------------------------------------------------

/**
 * Whether stdin was a TTY at process startup, captured before any Ink
 * instance can call `setRawMode(false)` on it.
 *
 * Use this instead of `process.stdin.isTTY` wherever you need a reliable
 * answer that doesn't change across mount/unmount cycles.
 */
export const stdinIsTTY: boolean = !!(process.stdin as NodeJS.ReadStream).isTTY;

// ---------------------------------------------------------------------------
// getStdin — direct stdin access (replaces getStableStdin proxy)
// ---------------------------------------------------------------------------

/**
 * Returns `process.stdin` directly.
 *
 * Replaces the `getStableStdin()` proxy from `bun-stdin.ts`. With a single
 * Ink render() for the whole session (via ScreenRouter), there are no
 * mid-session unmount/remount cycles that corrupt `isTTY`, so no proxy is
 * needed.
 *
 * Pass this to `render()` as the `stdin` option.
 */
export function getStdin(): typeof process.stdin {
  return process.stdin;
}

// ---------------------------------------------------------------------------
// TuiSession options
// ---------------------------------------------------------------------------

export interface TuiSessionOptions {
  /**
   * Skip TTY operations (alt screen, setRawMode). Useful in tests where
   * stdout is not a real TTY.
   */
  skipTty?: boolean;

  /**
   * Override the stdout stream used for escape code writes.
   * Defaults to `process.stdout`. Pass a mock in tests.
   */
  stdout?: Pick<NodeJS.WriteStream, "isTTY" | "write">;

  /**
   * Called immediately after the session becomes active (after alt-screen
   * enter, before any Ink render).
   */
  onStart?: () => void;

  /**
   * Called immediately after the session becomes inactive (after alt-screen
   * exit, guards removed).
   */
  onStop?: () => void;
}

// ---------------------------------------------------------------------------
// TuiSession
// ---------------------------------------------------------------------------

/**
 * Owns the terminal alt-screen buffer and process signal guards for the
 * duration of a TUI session.
 *
 * Start once before mounting the ScreenRouter; stop once after unmounting.
 * Do NOT create multiple TuiSession instances simultaneously.
 */
export class TuiSession {
  private active = false;
  private removeGuard: (() => void) | null = null;
  private readonly opts: TuiSessionOptions;
  private readonly out: Pick<NodeJS.WriteStream, "isTTY" | "write">;

  constructor(opts: TuiSessionOptions = {}) {
    this.opts = opts;
    this.out = opts.stdout ?? process.stdout;
  }

  /** Whether the session is currently active. */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Enter the alternate screen buffer and install exit guards.
   * Idempotent — safe to call multiple times.
   */
  start(): void {
    if (this.active) return;
    this.active = true;

    if (!this.opts.skipTty && this.out.isTTY) {
      this.out.write(ENTER_ALT_SCREEN);
    }

    this.removeGuard = this._installGuard();
    this.opts.onStart?.();
  }

  /**
   * Exit the alternate screen buffer and remove exit guards.
   * Idempotent — safe to call before `start()` or multiple times.
   */
  stop(): void {
    if (!this.active) return;
    this.active = false;

    if (this.removeGuard) {
      this.removeGuard();
      this.removeGuard = null;
    }

    if (!this.opts.skipTty && this.out.isTTY) {
      this.out.write(EXIT_ALT_SCREEN);
    }

    this.opts.onStop?.();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _installGuard(): () => void {
    const onExit = () => {
      if (this.active) {
        this.active = false;
        if (!this.opts.skipTty && this.out.isTTY) {
          this.out.write(EXIT_ALT_SCREEN);
        }
      }
    };

    const onSignal = () => {
      onExit();
      process.exit(0);
    };

    process.on("exit", onExit);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    return () => {
      process.removeListener("exit", onExit);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
  }
}
