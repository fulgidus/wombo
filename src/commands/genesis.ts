/**
 * genesis.ts — CLI command for project-level inception (Genesis).
 *
 * Genesis is the top of the Quest system hierarchy:
 *   Genesis → Quests → Tasks
 *
 * It takes a project vision, tech stack, and constraints, runs the genesis
 * planner agent, and produces a set of quests that decompose the vision
 * into scoped missions.
 *
 * Usage:
 *   woco genesis "Project vision..." [--tech-stack "..."] [--constraint "..."] [--model "..."] [--dry-run]
 *   woco g "Vision text" --tech-stack "React, Node, Postgres"
 *
 * The command:
 *   1. Accepts vision, constraints, tech stack via CLI args or interactive prompts
 *   2. Runs the genesis planner agent (headless, read-only)
 *   3. Shows a genesis review TUI for interactive accept/reject/edit
 *   4. On approve: creates Quest objects for each accepted quest
 *   5. Saves genesis knowledge if provided
 */

import type { WomboConfig } from "../config.js";
import type { OutputFormat } from "../lib/output.js";
import type { ProposedQuest, GenesisResult } from "../lib/genesis-planner.js";
import { runGenesisPlanner } from "../lib/genesis-planner.js";
import { createBlankQuest } from "../lib/quest.js";
import {
  saveQuest,
  saveQuestKnowledge,
  listQuestIds,
} from "../lib/quest-store.js";
import { GenesisReview } from "../lib/tui-genesis-review.js";
import { output, outputError, outputMessage } from "../lib/output.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenesisCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  /** The project vision text (first positional arg) */
  vision?: string;
  /** Tech stack description */
  techStack?: string;
  /** Constraints (can be passed multiple times) */
  constraints?: string[];
  /** Model override for the planner agent */
  model?: string;
  /** Show what would happen without actually creating quests */
  dryRun?: boolean;
  /** Skip the TUI review and auto-approve all quests */
  noTui?: boolean;
  /** Output format */
  outputFmt?: OutputFormat;
}

// ---------------------------------------------------------------------------
// ANSI Helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

// ---------------------------------------------------------------------------
// Main Command
// ---------------------------------------------------------------------------

export async function cmdGenesis(opts: GenesisCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.vision) {
    outputError(
      fmt,
      'Usage: woco genesis "Project vision text" [--tech-stack "..."] [--constraint "..."] [--model "..."] [--dry-run]'
    );
    return;
  }

  const vision = opts.vision.trim();
  if (!vision) {
    outputError(fmt, "Vision text cannot be empty.");
    return;
  }

  // Gather existing quest IDs (so the planner can see what already exists)
  const existingQuestIds = listQuestIds(projectRoot);

  if (fmt === "text") {
    console.log(`\n${BOLD}Genesis: Project Decomposition${RESET}`);
    console.log(`  Vision: ${DIM}${vision.slice(0, 100)}${vision.length > 100 ? "..." : ""}${RESET}`);
    if (opts.techStack) {
      console.log(`  Tech stack: ${DIM}${opts.techStack}${RESET}`);
    }
    if (opts.constraints && opts.constraints.length > 0) {
      console.log(`  Constraints: ${DIM}${opts.constraints.length} specified${RESET}`);
    }
    if (existingQuestIds.length > 0) {
      console.log(`  Existing quests: ${DIM}${existingQuestIds.length} (${existingQuestIds.join(", ")})${RESET}`);
    }
    console.log(`\n  Running genesis planner agent...\n`);
  }

  // Show a planning spinner
  const spinChars = ["\u2802", "\u2806", "\u2807", "\u2803", "\u2809", "\u280C", "\u280E", "\u280B"];
  let spinIdx = 0;
  let lastProgress = "";
  const spinTimer =
    fmt === "text"
      ? setInterval(() => {
          const ch = spinChars[spinIdx % spinChars.length];
          spinIdx++;
          process.stdout.write(`\r  ${ch} ${lastProgress}`);
        }, 120)
      : null;

  let result: GenesisResult;
  try {
    result = await runGenesisPlanner(vision, projectRoot, config, {
      techStack: opts.techStack,
      constraints: opts.constraints,
      existingQuestIds,
      model: opts.model,
      onProgress: (msg) => {
        lastProgress = msg;
      },
    });
  } catch (err: unknown) {
    if (spinTimer) {
      clearInterval(spinTimer);
      process.stdout.write("\r" + " ".repeat(80) + "\r");
    }
    const reason = err instanceof Error ? err.message : String(err);
    outputError(fmt, `Genesis planner failed: ${reason}`);
    return;
  }

  if (spinTimer) {
    clearInterval(spinTimer);
    process.stdout.write("\r" + " ".repeat(80) + "\r");
  }

  // Report initial results
  if (fmt === "text") {
    console.log(`  Planner produced ${result.quests.length} quests.`);
    if (result.issues.length > 0) {
      const errors = result.issues.filter((i) => i.level === "error").length;
      const warnings = result.issues.filter((i) => i.level === "warning").length;
      if (errors > 0) console.log(`  ${RED}${errors} validation error(s).${RESET}`);
      if (warnings > 0) console.log(`  ${YELLOW}${warnings} validation warning(s).${RESET}`);
    }
  }

  if (!result.success && result.quests.length === 0) {
    // Total failure
    output(
      fmt,
      { success: false, quests: [], error: result.error, issues: result.issues },
      () => {
        console.log(`\n  ${RED}Genesis failed: ${result.error ?? "No quests produced"}${RESET}\n`);
      }
    );
    return;
  }

  // Dry run — show results without creating anything
  if (opts.dryRun) {
    output(
      fmt,
      {
        dry_run: true,
        success: result.success,
        quests: result.quests.map((q) => ({
          id: q.id,
          title: q.title,
          priority: q.priority,
          difficulty: q.difficulty,
          hitl_mode: q.hitl_mode,
          depends_on: q.depends_on,
        })),
        knowledge: result.knowledge ? `${result.knowledge.length} chars` : null,
        issues: result.issues,
      },
      () => {
        console.log(`\n  ${BOLD}Proposed Quests:${RESET}`);
        for (const q of result.quests) {
          const deps =
            q.depends_on.length > 0 ? ` ${DIM}deps: ${q.depends_on.join(", ")}${RESET}` : "";
          console.log(
            `    ${CYAN}${q.id}${RESET} — ${q.title} [${q.priority}/${q.difficulty}] ${DIM}hitl:${q.hitl_mode}${RESET}${deps}`
          );
        }
        if (result.knowledge) {
          console.log(`\n  ${BOLD}Knowledge:${RESET} ${DIM}${result.knowledge.length} chars${RESET}`);
        }
        console.log(`\n  ${GREEN}[dry-run]${RESET} No quests created.\n`);
      }
    );
    return;
  }

  // Non-interactive mode (--no-tui) — auto-approve all quests
  if (opts.noTui) {
    const created = applyGenesisResult(result.quests, result.knowledge, projectRoot, config);
    output(
      fmt,
      {
        success: true,
        quests_created: created.length,
        quest_ids: created.map((q) => q.id),
        has_knowledge: result.knowledge !== null,
      },
      () => {
        console.log(`\n  ${GREEN}Genesis applied!${RESET} Created ${created.length} quest(s).`);
        for (const q of created) {
          console.log(`    ${CYAN}${q.id}${RESET} — ${q.title}`);
        }
        if (result.knowledge) {
          console.log(`  Saved knowledge to first quest.`);
        }
        console.log(`\n  Use ${BOLD}woco quest list${RESET} to see quests.`);
        console.log(`  Use ${BOLD}woco quest plan <id>${RESET} to plan a quest.\n`);
      }
    );
    return;
  }

  // Interactive mode — show the Genesis Review TUI
  if (fmt === "text") {
    console.log(`  Opening genesis review...\n`);
    await sleep(1000);
  }

  // Clear terminal before showing TUI
  process.stdout.write("\x1B[2J\x1B[H");

  const reviewAction = await showGenesisReview(result);

  if (reviewAction.type === "cancel") {
    console.log(`\n  Genesis plan discarded.\n`);
    return;
  }

  // User approved — create the quests
  const created = applyGenesisResult(
    reviewAction.quests,
    reviewAction.knowledge,
    projectRoot,
    config
  );

  output(
    fmt,
    {
      success: true,
      quests_created: created.length,
      quest_ids: created.map((q) => q.id),
      has_knowledge: reviewAction.knowledge !== null,
    },
    () => {
      console.log(`\n  ${GREEN}Genesis approved!${RESET} Created ${created.length} quest(s).`);
      for (const q of created) {
        console.log(`    ${CYAN}${q.id}${RESET} — ${q.title}`);
      }
      if (reviewAction.knowledge) {
        console.log(`  Saved knowledge to first quest.`);
      }
      console.log(`\n  Use ${BOLD}woco quest list${RESET} to see quests.`);
      console.log(`  Use ${BOLD}woco quest plan <id>${RESET} to plan individual quests.\n`);
    }
  );
}

// ---------------------------------------------------------------------------
// Apply Genesis Result — creates Quest objects from approved ProposedQuests
// ---------------------------------------------------------------------------

interface CreatedQuest {
  id: string;
  title: string;
}

function applyGenesisResult(
  acceptedQuests: ProposedQuest[],
  knowledge: string | null,
  projectRoot: string,
  config: WomboConfig
): CreatedQuest[] {
  const baseBranch = config.baseBranch;
  const created: CreatedQuest[] = [];

  for (const proposed of acceptedQuests) {
    const quest = createBlankQuest(proposed.id, proposed.title, proposed.goal, baseBranch, {
      priority: proposed.priority,
      difficulty: proposed.difficulty,
      hitlMode: proposed.hitl_mode,
    });

    // Apply constraints from the genesis planner
    quest.constraints = {
      add: proposed.constraints.add ?? [],
      ban: proposed.constraints.ban ?? [],
      override: {},
    };

    // Apply dependencies
    quest.depends_on = proposed.depends_on ?? [];

    // Apply notes
    quest.notes = proposed.notes ?? [];

    // Save the quest to the store
    saveQuest(projectRoot, quest);

    created.push({ id: quest.id, title: quest.title });
  }

  // Save knowledge to the first quest (project-level knowledge)
  if (knowledge && created.length > 0) {
    saveQuestKnowledge(projectRoot, created[0].id, knowledge);
  }

  return created;
}

// ---------------------------------------------------------------------------
// Genesis Review TUI — Promise-based wrapper
// ---------------------------------------------------------------------------

type GenesisReviewResult =
  | { type: "approve"; quests: ProposedQuest[]; knowledge: string | null }
  | { type: "cancel" };

function showGenesisReview(genesisResult: GenesisResult): Promise<GenesisReviewResult> {
  return new Promise<GenesisReviewResult>((resolve) => {
    const review = new GenesisReview({
      genesisResult,

      onApprove: (quests, knowledge) => {
        resolve({ type: "approve", quests, knowledge });
      },

      onCancel: () => {
        resolve({ type: "cancel" });
      },
    });

    review.start();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
