/**
 * tui-constants.test.ts — Tests for shared TUI display constants and helpers.
 *
 * Verifies:
 *   - Quest status color/abbreviation maps
 *   - Task status color/abbreviation maps
 *   - Agent status color/icon maps
 *   - Priority color maps
 *   - elapsed() time formatter
 *   - progressBar() formatter
 */

import { describe, test, expect } from "bun:test";
import {
  QUEST_STATUS_COLORS,
  QUEST_STATUS_ABBREV,
  TASK_STATUS_COLORS,
  TASK_STATUS_ABBREV,
  AGENT_STATUS_COLORS,
  AGENT_STATUS_ICONS,
  TASK_PRIORITY_COLORS,
  elapsed,
  progressBar,
} from "./tui-constants";

// ---------------------------------------------------------------------------
// Quest Status Maps
// ---------------------------------------------------------------------------

describe("QUEST_STATUS_COLORS", () => {
  test("has entries for all quest statuses", () => {
    const statuses = ["draft", "planning", "active", "paused", "completed", "abandoned"];
    for (const s of statuses) {
      expect(QUEST_STATUS_COLORS[s]).toBeDefined();
    }
  });

  test("active quests are green", () => {
    expect(QUEST_STATUS_COLORS.active).toBe("green");
  });

  test("abandoned quests are red", () => {
    expect(QUEST_STATUS_COLORS.abandoned).toBe("red");
  });
});

describe("QUEST_STATUS_ABBREV", () => {
  test("has entries for all quest statuses", () => {
    const statuses = ["draft", "planning", "active", "paused", "completed", "abandoned"];
    for (const s of statuses) {
      expect(QUEST_STATUS_ABBREV[s]).toBeDefined();
      expect(QUEST_STATUS_ABBREV[s].length).toBe(4);
    }
  });
});

// ---------------------------------------------------------------------------
// Task Status Maps
// ---------------------------------------------------------------------------

describe("TASK_STATUS_COLORS", () => {
  test("has entries for all task statuses", () => {
    const statuses = ["backlog", "planned", "in_progress", "blocked", "in_review", "done", "cancelled"];
    for (const s of statuses) {
      expect(TASK_STATUS_COLORS[s]).toBeDefined();
    }
  });

  test("blocked tasks are red", () => {
    expect(TASK_STATUS_COLORS.blocked).toBe("red");
  });

  test("done tasks are green", () => {
    expect(TASK_STATUS_COLORS.done).toBe("green");
  });
});

describe("TASK_STATUS_ABBREV", () => {
  test("has entries for all task statuses", () => {
    const statuses = ["backlog", "planned", "in_progress", "blocked", "in_review", "done", "cancelled"];
    for (const s of statuses) {
      expect(TASK_STATUS_ABBREV[s]).toBeDefined();
      expect(TASK_STATUS_ABBREV[s].length).toBe(4);
    }
  });
});

// ---------------------------------------------------------------------------
// Agent Status Maps
// ---------------------------------------------------------------------------

describe("AGENT_STATUS_COLORS", () => {
  test("has entries for all agent statuses", () => {
    const statuses = [
      "queued", "installing", "running", "completed",
      "verified", "failed", "merged", "retry", "resolving_conflict",
    ];
    for (const s of statuses) {
      expect(AGENT_STATUS_COLORS[s as keyof typeof AGENT_STATUS_COLORS]).toBeDefined();
    }
  });

  test("failed agents are red", () => {
    expect(AGENT_STATUS_COLORS.failed).toBe("red");
  });
});

describe("AGENT_STATUS_ICONS", () => {
  test("has entries for all agent statuses", () => {
    const statuses = [
      "queued", "installing", "running", "completed",
      "verified", "failed", "merged", "retry", "resolving_conflict",
    ];
    for (const s of statuses) {
      expect(AGENT_STATUS_ICONS[s as keyof typeof AGENT_STATUS_ICONS]).toBeDefined();
    }
  });

  test("verified agents get a checkmark", () => {
    expect(AGENT_STATUS_ICONS.verified).toBe("✓");
  });

  test("failed agents get an X", () => {
    expect(AGENT_STATUS_ICONS.failed).toBe("✗");
  });
});

// ---------------------------------------------------------------------------
// Priority Colors
// ---------------------------------------------------------------------------

describe("TASK_PRIORITY_COLORS", () => {
  test("has entries for all priorities", () => {
    const priorities = ["critical", "high", "medium", "low", "wishlist"];
    for (const p of priorities) {
      expect(TASK_PRIORITY_COLORS[p]).toBeDefined();
    }
  });

  test("critical is red", () => {
    expect(TASK_PRIORITY_COLORS.critical).toBe("red");
  });

  test("high is yellow", () => {
    expect(TASK_PRIORITY_COLORS.high).toBe("yellow");
  });
});

// ---------------------------------------------------------------------------
// elapsed() formatter
// ---------------------------------------------------------------------------

describe("elapsed", () => {
  test("returns dash for null input", () => {
    expect(elapsed(null)).toBe("-");
  });

  test("formats seconds", () => {
    const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
    const result = elapsed(thirtySecsAgo);
    expect(result).toMatch(/^\d+s$/);
  });

  test("formats minutes", () => {
    const fiveMinsAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = elapsed(fiveMinsAgo);
    expect(result).toMatch(/^\d+m$/);
  });

  test("formats hours", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const result = elapsed(twoHoursAgo);
    expect(result).toMatch(/^\d+h\d+m$/);
  });
});

// ---------------------------------------------------------------------------
// progressBar() formatter
// ---------------------------------------------------------------------------

describe("progressBar", () => {
  test("returns empty bar for zero estimate", () => {
    const bar = progressBar(5000, 0);
    expect(bar).toBe("░".repeat(10));
  });

  test("returns full bar when elapsed exceeds estimate", () => {
    const bar = progressBar(20000, 10000);
    expect(bar).toBe("█".repeat(10));
  });

  test("returns half-filled bar at 50%", () => {
    const bar = progressBar(5000, 10000, 10);
    expect(bar).toBe("█████░░░░░");
  });

  test("respects custom width", () => {
    const bar = progressBar(5000, 10000, 20);
    expect(bar.length).toBe(20);
  });
});
