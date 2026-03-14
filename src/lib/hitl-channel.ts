/**
 * hitl-channel.ts — File-based IPC for Human-in-the-Loop communication.
 *
 * Agents can ask humans questions in real-time. The channel works via
 * simple JSON files in .wombo-combo/hitl/:
 *
 *   .wombo-combo/hitl/<agent-id>.question.json  — agent writes question
 *   .wombo-combo/hitl/<agent-id>.answer.json    — monitor writes answer
 *
 * Flow:
 *   1. Agent runs `hitl-ask "question text"` via bash tool
 *   2. hitl-ask writes question file, polls for answer file
 *   3. Monitor detects question file, shows it in TUI
 *   4. Human types answer in TUI, monitor writes answer file
 *   5. hitl-ask reads answer, prints it, exits
 *   6. Agent sees answer as bash tool output
 *
 * Protocol:
 *   Question: { id, agentId, text, context?, timestamp }
 *   Answer:   { id, text, timestamp }
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
import { WOMBO_DIR } from "../config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subdirectory inside .wombo-combo/ for HITL files */
const HITL_DIR = "hitl";

/** How long to wait between polls when checking for answers (ms) */
export const HITL_POLL_INTERVAL_MS = 1000;

/** Maximum time an agent will wait for an answer before timing out (ms) */
export const HITL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A question from an agent to the human operator */
export interface HitlQuestion {
  /** Unique question ID (uuid-like) */
  id: string;
  /** Agent/feature ID that asked the question */
  agentId: string;
  /** The question text */
  text: string;
  /** Optional context (e.g. what the agent was doing) */
  context?: string;
  /** ISO 8601 timestamp when the question was asked */
  timestamp: string;
}

/** An answer from the human operator to an agent */
export interface HitlAnswer {
  /** Matches the question ID */
  id: string;
  /** The answer text */
  text: string;
  /** ISO 8601 timestamp when the answer was given */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function hitlDir(projectRoot: string): string {
  return resolve(projectRoot, WOMBO_DIR, HITL_DIR);
}

function questionFilePath(projectRoot: string, agentId: string): string {
  return join(hitlDir(projectRoot), `${agentId}.question.json`);
}

function answerFilePath(projectRoot: string, agentId: string): string {
  return join(hitlDir(projectRoot), `${agentId}.answer.json`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Generate a short unique ID */
function shortId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Public API — Questions (agent side)
// ---------------------------------------------------------------------------

/**
 * Submit a question from an agent.
 * Called by the hitl-ask script running inside the agent's process.
 */
export function submitQuestion(
  projectRoot: string,
  agentId: string,
  text: string,
  context?: string
): HitlQuestion {
  const dir = hitlDir(projectRoot);
  ensureDir(dir);

  const question: HitlQuestion = {
    id: shortId(),
    agentId,
    text,
    context,
    timestamp: new Date().toISOString(),
  };

  atomicWriteJson(questionFilePath(projectRoot, agentId), question);
  return question;
}

/**
 * Check if an answer is available for the given agent.
 * Called by the hitl-ask script while polling.
 */
export function getAnswer(
  projectRoot: string,
  agentId: string
): HitlAnswer | null {
  return readJson<HitlAnswer>(answerFilePath(projectRoot, agentId));
}

/**
 * Check if a question is pending for the given agent.
 */
export function getQuestion(
  projectRoot: string,
  agentId: string
): HitlQuestion | null {
  return readJson<HitlQuestion>(questionFilePath(projectRoot, agentId));
}

// ---------------------------------------------------------------------------
// Public API — Answers (monitor/TUI side)
// ---------------------------------------------------------------------------

/**
 * Submit an answer to a pending question.
 * Called by the TUI when the human types a response.
 */
export function submitAnswer(
  projectRoot: string,
  agentId: string,
  questionId: string,
  text: string
): HitlAnswer {
  const dir = hitlDir(projectRoot);
  ensureDir(dir);

  const answer: HitlAnswer = {
    id: questionId,
    text,
    timestamp: new Date().toISOString(),
  };

  atomicWriteJson(answerFilePath(projectRoot, agentId), answer);
  return answer;
}

/**
 * Get all pending questions from all agents.
 * A question is "pending" if there's a .question.json file but no
 * corresponding .answer.json file.
 */
export function getPendingQuestions(projectRoot: string): HitlQuestion[] {
  const dir = hitlDir(projectRoot);
  if (!existsSync(dir)) return [];

  const questions: HitlQuestion[] = [];

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith(".question.json")) continue;

      const agentId = file.replace(".question.json", "");
      // Only include if there's no answer yet
      if (existsSync(answerFilePath(projectRoot, agentId))) continue;

      const question = readJson<HitlQuestion>(join(dir, file));
      if (question) questions.push(question);
    }
  } catch {
    // Directory read error — return empty
  }

  // Sort by timestamp (oldest first — FIFO)
  questions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return questions;
}

// ---------------------------------------------------------------------------
// Public API — Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove question and answer files for a specific agent.
 * Called after the agent has received its answer and resumed.
 */
export function cleanupAgent(projectRoot: string, agentId: string): void {
  const qPath = questionFilePath(projectRoot, agentId);
  const aPath = answerFilePath(projectRoot, agentId);

  try { if (existsSync(qPath)) unlinkSync(qPath); } catch { /* ignore */ }
  try { if (existsSync(aPath)) unlinkSync(aPath); } catch { /* ignore */ }
}

/**
 * Remove all HITL files. Called during wave cleanup.
 */
export function cleanupAll(projectRoot: string): void {
  const dir = hitlDir(projectRoot);
  if (!existsSync(dir)) return;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      try { unlinkSync(join(dir, file)); } catch { /* ignore */ }
    }
  } catch {
    // Directory read error — skip
  }
}

/**
 * Get the hitl directory path (for env vars passed to agents).
 */
export function getHitlDir(projectRoot: string): string {
  return hitlDir(projectRoot);
}
