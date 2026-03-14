#!/usr/bin/env bun
/**
 * hitl-ask.ts — Agent-side script for asking human questions.
 *
 * Usage (by agent via bash tool):
 *   bun <path>/hitl-ask.ts "Your question here"
 *   bun <path>/hitl-ask.ts --context "working on auth" "Should I use OAuth2 or SAML?"
 *
 * Environment:
 *   WOMBO_HITL_DIR    — Path to the .wombo-combo/hitl/ directory
 *   WOMBO_AGENT_ID    — The agent's feature ID
 *   WOMBO_PROJECT_ROOT — Path to the project root (alternative to HITL_DIR)
 *
 * Behavior:
 *   1. Writes question file to hitl dir
 *   2. Polls for answer file at 1-second intervals
 *   3. When answer arrives, prints it to stdout and exits 0
 *   4. If timeout (30 min), prints timeout message and exits 1
 *
 * The agent sees the stdout output as the bash tool's result.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const HITL_DIR = process.env.WOMBO_HITL_DIR;
const AGENT_ID = process.env.WOMBO_AGENT_ID;
const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

if (!HITL_DIR) {
  console.error("Error: WOMBO_HITL_DIR environment variable not set.");
  console.error("This script should only be called by agents managed by wombo-combo.");
  process.exit(1);
}

if (!AGENT_ID) {
  console.error("Error: WOMBO_AGENT_ID environment variable not set.");
  console.error("This script should only be called by agents managed by wombo-combo.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let context: string | undefined;
let questionText = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--context" && i + 1 < args.length) {
    context = args[++i];
  } else {
    questionText = args[i];
  }
}

if (!questionText) {
  console.error("Usage: hitl-ask [--context <context>] <question>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

const questionFile = join(HITL_DIR, `${AGENT_ID}.question.json`);
const answerFile = join(HITL_DIR, `${AGENT_ID}.answer.json`);

// ---------------------------------------------------------------------------
// Write question
// ---------------------------------------------------------------------------

// Ensure directory exists
if (!existsSync(HITL_DIR)) {
  mkdirSync(HITL_DIR, { recursive: true });
}

const questionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const question = {
  id: questionId,
  agentId: AGENT_ID,
  text: questionText,
  context,
  timestamp: new Date().toISOString(),
};

// Atomic write
const tmpFile = questionFile + ".tmp";
writeFileSync(tmpFile, JSON.stringify(question, null, 2), "utf-8");
renameSync(tmpFile, questionFile);

console.error(`[hitl] Question submitted. Waiting for human response...`);
console.error(`[hitl] Question: ${questionText}`);

// ---------------------------------------------------------------------------
// Poll for answer
// ---------------------------------------------------------------------------

const startTime = Date.now();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollForAnswer(): Promise<void> {
  while (true) {
    // Check timeout
    if (Date.now() - startTime > TIMEOUT_MS) {
      console.error("[hitl] Timeout: No response received within 30 minutes.");
      // Clean up question file
      try { if (existsSync(questionFile)) unlinkSync(questionFile); } catch { /* */ }
      console.log("TIMEOUT: The human operator did not respond within 30 minutes. Proceed with your best judgment.");
      process.exit(0); // Exit 0 so the agent sees the message as tool output, not an error
    }

    // Check for answer
    if (existsSync(answerFile)) {
      try {
        const raw = readFileSync(answerFile, "utf-8");
        const answer = JSON.parse(raw);

        // Clean up both files
        try { unlinkSync(questionFile); } catch { /* */ }
        try { unlinkSync(answerFile); } catch { /* */ }

        // Print the answer to stdout — this is what the agent sees
        console.log(answer.text);
        process.exit(0);
      } catch (err) {
        // JSON parse error — wait and retry (file might be partially written)
        console.error("[hitl] Answer file found but unreadable, retrying...");
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

pollForAnswer();
