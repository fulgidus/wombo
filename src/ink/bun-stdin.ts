/**
 * bun-stdin.ts — Stable stdin wrapper for sequential Ink renders.
 *
 * @deprecated Use `getStdin()` from `./tui-session` instead.
 *
 * This module is kept for backward compatibility with the existing standalone
 * run-*.tsx launchers (run-quest-wizard, run-progress, etc.) that each call
 * inkRender() independently. Once those launchers are migrated to the
 * ScreenRouter (tui-dashboard task), this file can be deleted.
 *
 * Problem: Bun's `process.stdin.isTTY` can become `undefined` after an
 * Ink instance calls `stdin.setRawMode(false)` on unmount. The next
 * `render()` call creates a new `App` component that captures
 * `isRawModeSupported = stdin.isTTY` — if that's `undefined`/falsy,
 * `useInput` silently does nothing and no keys work.
 *
 * Fix: wrap `process.stdin` in a Proxy that hard-codes `isTTY = true`
 * (using the value captured at process startup, before any Ink instance
 * can corrupt it). All other property accesses delegate to the real stdin.
 *
 * The wrapper is created once and reused across all `render()` calls.
 */

/** Whether stdin was a TTY at process startup (captured before Ink touches it). */
const IS_TTY: boolean = !!(process.stdin as NodeJS.ReadStream).isTTY;

let _stdinWrapper: typeof process.stdin | null = null;

/**
 * Returns a stable stdin wrapper whose `isTTY` property always reflects
 * the startup value, regardless of what Ink does during unmount.
 *
 * Pass this as the `stdin` option to every `render()` call.
 */
export function getStableStdin(): typeof process.stdin {
  if (_stdinWrapper) return _stdinWrapper;

  _stdinWrapper = new Proxy(process.stdin, {
    get(target, prop) {
      if (prop === "isTTY") return IS_TTY;
      const val = (target as any)[prop];
      return typeof val === "function" ? val.bind(target) : val;
    },
  });

  return _stdinWrapper;
}
