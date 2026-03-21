/**
 * tui-session.ts — Persist TUI session state across opens/closes.
 *
 * Stores task selection, sort preferences, and view state so the user
 * can close the TUI and reopen it without losing work.
 *
 * File: .wombo-combo/tui-session.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { WOMBO_DIR } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SortField = "priority" | "status" | "name" | "stream" | "effort";
export type SortOrder = "asc" | "desc";

export interface TUISession {
  /** IDs of tasks selected for the next wave launch */
  selected: string[];
  /** Current sort field */
  sortBy: SortField;
  /** Sort direction */
  sortOrder: SortOrder;
  /** Which view was last active */
  lastView: "browser" | "monitor";
  /** Collapsed stream group IDs (for tree display) */
  collapsed: string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const SESSION_FILE = "tui-session.json";

const DEFAULT_SESSION: TUISession = {
  selected: [],
  sortBy: "priority",
  sortOrder: "desc",
  lastView: "browser",
  collapsed: [],
};

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

function sessionPath(projectRoot: string): string {
  return resolve(projectRoot, WOMBO_DIR, SESSION_FILE);
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load TUI session from disk. Returns defaults if not found.
 */
export function loadTUISession(projectRoot: string): TUISession {
  const fp = sessionPath(projectRoot);
  try {
    if (existsSync(fp)) {
      const raw = readFileSync(fp, "utf-8");
      const data = JSON.parse(raw);
      return { ...DEFAULT_SESSION, ...data };
    }
  } catch {
    // Corrupt file — use defaults
  }
  return { ...DEFAULT_SESSION };
}

/**
 * Save TUI session to disk.
 */
export function saveTUISession(projectRoot: string, session: TUISession): void {
  const dir = resolve(projectRoot, WOMBO_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fp = sessionPath(projectRoot);
  writeFileSync(fp, JSON.stringify(session, null, 2) + "\n");
}
