/**
 * interactive-monitor.ts — Completion detection for interactive (tmux) agents.
 *
 * When agents are launched in interactive mode (via tmux), the agent's
 * TUI stays open even after the work is done. This monitor detects completion
 * using a dual strategy:
 *
 *   1. **PID polling** (primary) — If the agent's PID is no longer running,
 *      the agent has exited. This covers crashes, manual kills, and agents
 *      that do exit cleanly.
 *
 *   2. **Pane content stability** (fallback) — If the PID is still alive but
 *      the pane text hasn't changed for N consecutive polls, the agent is
 *      idle. Combined with branch commit detection, this determines whether
 *      the agent finished its work or is genuinely stuck.
 *
 * On completion detection:
 *   - The tmux session is killed (no zombie sessions).
 *   - The `onComplete` or `onError` callback fires, depending on whether
 *     commits were made on the agent's branch.
 */

import { tmuxCapturePaneText, tmuxKillSession, tmuxHasSession } from "./tmux.js";
import { isProcessRunning } from "./launcher.js";
import { branchHasChanges } from "./worktree.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InteractiveAgent {
  featureId: string;
  pid: number;
  sessionName: string;
  worktree: string;
  branch: string;
  baseBranch: string;
}

export interface InteractiveMonitorCallbacks {
  /** Agent completed (PID died or pane went idle) with commits on its branch. */
  onComplete: (featureId: string) => void;
  /** Agent exited or went idle but made no commits — likely failed. */
  onError: (featureId: string, reason: string) => void;
  /** Optional: called on each poll tick with agent activity info. */
  onActivity?: (featureId: string, activity: string) => void;
}

interface MonitoredAgent {
  agent: InteractiveAgent;
  /** Last captured pane text (for stability comparison). */
  lastPaneText: string | null;
  /** Number of consecutive polls where pane text was unchanged. */
  stableCount: number;
  /** Whether this agent has been finalized (callback fired). */
  done: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to poll (ms). */
const POLL_INTERVAL_MS = 5_000;

/**
 * Number of consecutive polls with identical pane content before we consider
 * the agent idle. At 5s intervals, 12 polls = 60 seconds of no change.
 */
const STABLE_THRESHOLD = 12;

// ---------------------------------------------------------------------------
// InteractiveMonitor
// ---------------------------------------------------------------------------

export class InteractiveMonitor {
  private agents: Map<string, MonitoredAgent> = new Map();
  private callbacks: InteractiveMonitorCallbacks;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped: boolean = false;

  constructor(callbacks: InteractiveMonitorCallbacks) {
    this.callbacks = callbacks;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Add an interactive agent to be monitored.
   */
  addAgent(agent: InteractiveAgent): void {
    this.agents.set(agent.featureId, {
      agent,
      lastPaneText: null,
      stableCount: 0,
      done: false,
    });
  }

  /**
   * Start the polling loop. Call this after adding all initial agents.
   */
  start(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.pollAll();
    }, POLL_INTERVAL_MS);

    // Don't keep the event loop alive just for monitoring
    if (this.pollTimer.unref) {
      this.pollTimer.unref();
    }
  }

  /**
   * Stop monitoring. Does NOT kill sessions — use `killAll()` for that.
   */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Kill all monitored tmux sessions and stop monitoring.
   */
  killAll(): number {
    this.stop();
    let killed = 0;
    for (const [, monitored] of this.agents) {
      if (!monitored.done) {
        try {
          tmuxKillSession(monitored.agent.sessionName);
          killed++;
        } catch {
          // Session may already be dead
        }
      }
    }
    return killed;
  }

  /**
   * Check if all monitored agents are done.
   */
  allDone(): boolean {
    for (const [, m] of this.agents) {
      if (!m.done) return false;
    }
    return true;
  }

  /**
   * Get the count of agents still being monitored.
   */
  activeCount(): number {
    let count = 0;
    for (const [, m] of this.agents) {
      if (!m.done) count++;
    }
    return count;
  }

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  private pollAll(): void {
    if (this.stopped) return;

    for (const [featureId, monitored] of this.agents) {
      if (monitored.done) continue;

      const { agent } = monitored;

      // ── Strategy 1: PID polling ─────────────────────────────────────
      if (!isProcessRunning(agent.pid)) {
        this.finalize(monitored, "pid_exited");
        continue;
      }

      // ── Strategy 2: Pane content stability ──────────────────────────
      // PID is still alive — check if the TUI is just sitting idle.
      const paneText = tmuxCapturePaneText(agent.sessionName);

      if (paneText === null) {
        // Can't capture pane — session might have been killed externally.
        // Check if session still exists.
        try {
          if (!tmuxHasSession(agent.sessionName)) {
            this.finalize(monitored, "session_gone");
            continue;
          }
        } catch {
        // muxHasSession threw — treat as session gone
          this.finalize(monitored, "session_gone");
          continue;
        }

        // Session exists but capture failed — wait for PID to die.
        this.callbacks.onActivity?.(featureId, "running (capture unavailable)");
        continue;
      }

      // Compare pane text to last poll
      if (paneText === monitored.lastPaneText) {
        monitored.stableCount++;

        if (monitored.stableCount >= STABLE_THRESHOLD) {
          // Pane has been static for STABLE_THRESHOLD * POLL_INTERVAL_MS.
          // Agent is almost certainly done.
          this.finalize(monitored, "pane_stable");
          continue;
        }

        this.callbacks.onActivity?.(
          featureId,
          `idle ${monitored.stableCount * POLL_INTERVAL_MS / 1000}s`
        );
      } else {
        // Pane changed — agent is still active, reset counter.
        monitored.stableCount = 0;
        monitored.lastPaneText = paneText;
        this.callbacks.onActivity?.(featureId, "active");
      }
    }
  }

  // -----------------------------------------------------------------------
  // Finalization
  // -----------------------------------------------------------------------

  private finalize(
    monitored: MonitoredAgent,
    reason: "pid_exited" | "session_gone" | "pane_stable"
  ): void {
    monitored.done = true;
    const { agent } = monitored;

    // Kill the tmux session if it's still around (covers pane_stable case
    // where the PID is alive but the agent is done).
    try {
      tmuxKillSession(agent.sessionName);
    } catch {
      // Already dead — fine.
    }

    // Check if the agent produced any commits.
    let hasCommits = false;
    try {
      hasCommits = branchHasChanges(agent.worktree, agent.branch, agent.baseBranch);
    } catch {
      // If we can't check (worktree gone?), assume no commits.
    }

    if (hasCommits) {
      this.callbacks.onComplete(agent.featureId);
    } else {
      const reasonText =
        reason === "pid_exited"
          ? "Agent process exited with no commits"
          : reason === "session_gone"
            ? "tmux session disappeared with no commits"
            : "Agent went idle with no commits (possible stuck TUI)";
      this.callbacks.onError(agent.featureId, reasonText);
    }
  }
}
