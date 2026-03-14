/**
 * tui-progress.ts — Blessed-based progress screen for long-running operations.
 *
 * Replaces console.log/error spinners with a proper TUI screen that shows:
 *   - Title and context
 *   - Animated braille spinner
 *   - Progress text (updated by the operation)
 *   - Result messages (success, error, info)
 *
 * Usage:
 *   const progress = new ProgressScreen("Running Planner");
 *   progress.start();
 *   try {
 *     const result = await someAsyncWork((msg) => progress.setStatus(msg));
 *     progress.showSuccess("Done! Created 5 tasks.");
 *     await progress.waitForDismiss(2000);
 *   } catch (err) {
 *     progress.showError(err.message);
 *     await progress.waitForDismiss(3000);
 *   }
 *   progress.destroy();
 */

import blessed from "neo-blessed";
import type { Widgets } from "neo-blessed";

// ---------------------------------------------------------------------------
// ProgressScreen
// ---------------------------------------------------------------------------

export class ProgressScreen {
  private screen: Widgets.Screen;
  private titleBox: Widgets.BoxElement;
  private spinnerBox: Widgets.BoxElement;
  private statusBox: Widgets.BoxElement;
  private logBox: Widgets.BoxElement;
  private footerBox: Widgets.BoxElement;

  private spinTimer: ReturnType<typeof setInterval> | null = null;
  private spinIdx = 0;
  private destroyed = false;

  private static readonly SPIN_CHARS = [
    "\u2802", "\u2806", "\u2807", "\u2803",
    "\u2809", "\u280C", "\u280E", "\u280B",
  ];

  constructor(title: string, context?: string) {
    this.screen = blessed.screen({
      smartCSR: true,
      title: title,
      fullUnicode: true,
    });

    // Title area at top
    this.titleBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
      content: this.buildTitle(title, context),
    });

    // Spinner + current status
    this.spinnerBox = blessed.box({
      parent: this.screen,
      top: 4,
      left: 2,
      width: 3,
      height: 1,
      tags: true,
      style: { fg: "magenta", bg: "black" },
      content: ProgressScreen.SPIN_CHARS[0],
    });

    this.statusBox = blessed.box({
      parent: this.screen,
      top: 4,
      left: 5,
      right: 2,
      height: 1,
      tags: true,
      style: { fg: "cyan", bg: "black" },
      content: "Starting...",
    });

    // Scrollable log area for result messages
    this.logBox = blessed.box({
      parent: this.screen,
      top: 6,
      left: 2,
      right: 2,
      bottom: 2,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      style: { fg: "white", bg: "black" },
      content: "",
    });

    // Footer
    this.footerBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      style: { fg: "gray", bg: "black" },
      content: "",
    });

    // Allow Ctrl+C to bail out
    this.screen.key(["C-c"], () => {
      this.destroy();
      process.exit(0);
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Start the spinner animation and render the screen. */
  start(): void {
    this.spinTimer = setInterval(() => {
      if (this.destroyed) return;
      this.spinIdx++;
      const ch = ProgressScreen.SPIN_CHARS[this.spinIdx % ProgressScreen.SPIN_CHARS.length];
      this.spinnerBox.setContent(`{magenta-fg}${ch}{/magenta-fg}`);
      this.screen.render();
    }, 120);
    this.screen.render();
  }

  /** Update the status text next to the spinner. */
  setStatus(text: string): void {
    if (this.destroyed) return;
    this.statusBox.setContent(`{cyan-fg}${text}{/cyan-fg}`);
    this.screen.render();
  }

  /** Append a line to the log area. */
  addLine(text: string): void {
    if (this.destroyed) return;
    const current = this.logBox.getContent();
    this.logBox.setContent(current ? current + "\n" + text : text);
    this.logBox.setScrollPerc(100);
    this.screen.render();
  }

  /** Stop the spinner and show a success message. */
  showSuccess(message: string): void {
    if (this.destroyed) return;
    this.stopSpinner();
    this.spinnerBox.setContent("{green-fg}\u2714{/green-fg}");
    this.statusBox.setContent(`{green-fg}${message}{/green-fg}`);
    this.screen.render();
  }

  /** Stop the spinner and show an error message. */
  showError(message: string): void {
    if (this.destroyed) return;
    this.stopSpinner();
    this.spinnerBox.setContent("{red-fg}\u2718{/red-fg}");
    this.statusBox.setContent(`{red-fg}${message}{/red-fg}`);
    this.screen.render();
  }

  /** Stop the spinner and show an info message. */
  showInfo(message: string): void {
    if (this.destroyed) return;
    this.stopSpinner();
    this.spinnerBox.setContent("{cyan-fg}\u2139{/cyan-fg}");
    this.statusBox.setContent(`{cyan-fg}${message}{/cyan-fg}`);
    this.screen.render();
  }

  /**
   * Wait for a timeout or keypress, whichever comes first.
   * Good for showing "Plan approved! Created 5 tasks" then auto-continuing.
   */
  waitForDismiss(timeoutMs: number = 2000): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.footerBox.setContent(" {gray-fg}Press any key to continue...{/gray-fg}");
    this.screen.render();

    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      const timer = setTimeout(done, timeoutMs);

      this.screen.once("keypress", () => {
        clearTimeout(timer);
        done();
      });
    });
  }

  /**
   * Wait indefinitely for any keypress before continuing.
   * Use for error messages that the user needs to read.
   */
  waitForKey(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.footerBox.setContent(" {gray-fg}Press any key to continue...{/gray-fg}");
    this.screen.render();

    return new Promise<void>((resolve) => {
      this.screen.once("keypress", () => {
        resolve();
      });
    });
  }

  /** Destroy the screen and clean up. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopSpinner();
    this.screen.destroy();
    // Clean up stdin state
    if (process.stdin.isTTY) {
      try {
        process.stdin.removeAllListeners("keypress");
        process.stdin.removeAllListeners("data");
        if (typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(false);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private buildTitle(title: string, context?: string): string {
    let content = `\n  {bold}{magenta-fg}${title}{/magenta-fg}{/bold}`;
    if (context) {
      content += `  {gray-fg}— ${context}{/gray-fg}`;
    }
    return content;
  }

  private stopSpinner(): void {
    if (this.spinTimer) {
      clearInterval(this.spinTimer);
      this.spinTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: confirm popup (creates its own screen)
// ---------------------------------------------------------------------------

/**
 * Show a yes/no confirm dialog in its own blessed screen.
 * Returns true if user confirms, false otherwise.
 */
export async function showConfirm(
  title: string,
  message: string
): Promise<boolean> {
  const screen = blessed.screen({
    smartCSR: true,
    title: title,
    fullUnicode: true,
  });

  const modal = blessed.box({
    parent: screen,
    top: "center",
    left: "center",
    width: "50%",
    height: 9,
    tags: true,
    border: { type: "line" },
    style: {
      border: { fg: "yellow" },
      fg: "white",
      bg: "black",
    },
    label: ` {yellow-fg}${title}{/yellow-fg} `,
    shadow: true,
  });

  blessed.box({
    parent: modal,
    top: 0,
    left: 1,
    right: 1,
    height: 3,
    tags: true,
    content: `\n  ${message}`,
    style: { fg: "white", bg: "black" },
  });

  blessed.box({
    parent: modal,
    bottom: 1,
    left: 1,
    right: 1,
    height: 1,
    tags: true,
    content: "  {green-fg}Y{/green-fg} Yes    {red-fg}N{/red-fg} No    {gray-fg}Esc{/gray-fg} Cancel",
    style: { fg: "white", bg: "black" },
  });

  screen.render();

  return new Promise<boolean>((resolve) => {
    const cleanup = (result: boolean) => {
      screen.destroy();
      if (process.stdin.isTTY) {
        try {
          process.stdin.removeAllListeners("keypress");
          process.stdin.removeAllListeners("data");
          if (typeof process.stdin.setRawMode === "function") {
            process.stdin.setRawMode(false);
          }
        } catch {
          // Ignore
        }
      }
      resolve(result);
    };

    screen.key(["y"], () => cleanup(true));
    screen.key(["n", "escape"], () => cleanup(false));
    screen.key(["C-c"], () => {
      cleanup(false);
      process.exit(0);
    });
  });
}
