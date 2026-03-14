/**
 * quest.ts — CLI subcommands for quest management.
 *
 * Usage:
 *   woco quest create <id> "Title" --goal "Goal description"  (alias: q c)
 *   woco quest list                                           (alias: q ls)
 *   woco quest show <id>                                      (alias: q sh)
 *   woco quest activate <id>                                  (alias: q a)
 *   woco quest pause <id>                                     (alias: q p)
 *   woco quest complete <id>                                  (alias: q co)
 *   woco quest abandon <id>                                   (alias: q ab)
 */

import type { WomboConfig } from "../config.js";
import type { Priority, Difficulty } from "../lib/tasks.js";
import type { OutputFormat } from "../lib/output.js";
import type { QuestStatus, QuestHitlMode, Quest } from "../lib/quest.js";
import {
  createBlankQuest,
  VALID_QUEST_STATUSES,
  VALID_HITL_MODES,
  QUEST_STATUS_ORDER,
} from "../lib/quest.js";
import {
  loadQuest,
  saveQuest,
  loadAllQuests,
  listQuestIds,
  deleteQuest,
  loadQuestKnowledge,
} from "../lib/quest-store.js";
import {
  createQuestBranch,
  questBranchExists,
  deleteQuestBranch,
} from "../lib/worktree.js";
import {
  mergeQuestIntoBranch,
} from "../lib/merger.js";
import {
  runQuestPlanner,
  applyPlanToQuest,
  type PlanResult,
} from "../lib/quest-planner.js";
import { VALID_PRIORITIES, VALID_DIFFICULTIES } from "../lib/task-schema.js";
import { output, outputError, outputMessage } from "../lib/output.js";
import { validateEnum } from "../lib/validate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuestCommandOptions {
  projectRoot: string;
  config: WomboConfig;
  subcommand: string;
  questId?: string;
  title?: string;
  goal?: string;
  priority?: Priority;
  difficulty?: Difficulty;
  hitlMode?: QuestHitlMode;
  status?: string;
  agent?: string;
  dryRun?: boolean;
  force?: boolean;
  outputFmt?: OutputFormat;
  fields?: string[];
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
const BLUE = "\x1b[34m";

const STATUS_COLOR: Record<QuestStatus, string> = {
  draft: "\x1b[37m",       // white
  planning: "\x1b[36m",    // cyan
  active: "\x1b[34m",      // blue
  paused: "\x1b[33m",      // yellow
  completed: "\x1b[32m",   // green
  abandoned: "\x1b[90m",   // gray
};

// ---------------------------------------------------------------------------
// Subcommand: create
// ---------------------------------------------------------------------------

async function questCreate(opts: QuestCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.questId) {
    outputError(fmt, "Usage: woco quest create <id> \"Title\" --goal \"Goal description\"");
    return;
  }

  if (!opts.title) {
    outputError(fmt, "A title is required. Usage: woco quest create <id> \"Title\" --goal \"...\"");
    return;
  }

  if (!opts.goal) {
    outputError(fmt, "--goal is required when creating a quest.");
    return;
  }

  // Validate enums if provided
  if (opts.priority) {
    const r = validateEnum(opts.priority, VALID_PRIORITIES, "--priority");
    if (!r.valid) { outputError(fmt, r.error!); return; }
  }
  if (opts.difficulty) {
    const r = validateEnum(opts.difficulty, VALID_DIFFICULTIES, "--difficulty");
    if (!r.valid) { outputError(fmt, r.error!); return; }
  }
  if (opts.hitlMode) {
    const r = validateEnum(opts.hitlMode, VALID_HITL_MODES as readonly string[], "--hitl");
    if (!r.valid) { outputError(fmt, r.error!); return; }
  }

  // Check for duplicate
  const existing = loadQuest(projectRoot, opts.questId);
  if (existing) {
    outputError(fmt, `Quest "${opts.questId}" already exists (status: ${existing.status}).`);
    return;
  }

  const baseBranch = config.baseBranch;
  const quest = createBlankQuest(opts.questId, opts.title, opts.goal, baseBranch, {
    priority: opts.priority,
    difficulty: opts.difficulty,
    hitlMode: opts.hitlMode,
    agent: opts.agent,
  });

  if (opts.dryRun) {
    outputMessage(fmt, `[dry-run] Would create quest: ${quest.id} — ${quest.title}`, {
      dry_run: true,
      id: quest.id,
      title: quest.title,
      goal: quest.goal,
      priority: quest.priority,
      difficulty: quest.difficulty,
      hitlMode: quest.hitlMode,
      branch: quest.branch,
      baseBranch: quest.baseBranch,
    });
    return;
  }

  // Save to store
  saveQuest(projectRoot, quest);

  outputMessage(fmt, `Created quest: ${quest.id} — ${quest.title}`, {
    id: quest.id,
    title: quest.title,
    goal: quest.goal,
    status: quest.status,
    priority: quest.priority,
    difficulty: quest.difficulty,
    hitlMode: quest.hitlMode,
    branch: quest.branch,
    baseBranch: quest.baseBranch,
  });

  if (fmt === "text") {
    console.log(`  priority: ${quest.priority}, difficulty: ${quest.difficulty}`);
    console.log(`  hitl: ${quest.hitlMode}, branch: ${quest.branch}`);
    console.log(`  Status is "draft". Use ${BOLD}woco quest activate ${quest.id}${RESET} to create the branch and start.`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

async function questList(opts: QuestCommandOptions): Promise<void> {
  const { projectRoot } = opts;
  const fmt = opts.outputFmt ?? "text";

  const quests = loadAllQuests(projectRoot);

  if (quests.length === 0) {
    output(fmt, { quests: [], total: 0 }, () => {
      console.log("No quests found. Use `woco quest create` to create one.");
    });
    return;
  }

  // Filter by status if specified
  let filtered = quests;
  if (opts.status) {
    filtered = quests.filter((q) => q.status === opts.status);
    if (filtered.length === 0) {
      output(fmt, { quests: [], total: 0, filter: opts.status }, () => {
        console.log(`No quests with status "${opts.status}".`);
      });
      return;
    }
  }

  // Sort by status order then by priority
  const PRIORITY_ORDER: Record<string, number> = {
    critical: 0, high: 1, medium: 2, low: 3, wishlist: 4,
  };
  filtered.sort((a, b) => {
    const sa = QUEST_STATUS_ORDER[a.status] ?? 99;
    const sb = QUEST_STATUS_ORDER[b.status] ?? 99;
    if (sa !== sb) return sa - sb;
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    return pa - pb;
  });

  const questData = filtered.map((q) => ({
    id: q.id,
    title: q.title,
    status: q.status,
    priority: q.priority,
    difficulty: q.difficulty,
    hitlMode: q.hitlMode,
    branch: q.branch,
    tasks: q.taskIds.length,
    depends_on: q.depends_on,
  }));

  output(
    fmt,
    { quests: questData, total: filtered.length },
    () => {
      console.log(`\n${BOLD}Quests (${filtered.length} total)${RESET}\n`);

      // Group by status
      const byStatus = new Map<QuestStatus, Quest[]>();
      for (const q of filtered) {
        const list = byStatus.get(q.status) ?? [];
        list.push(q);
        byStatus.set(q.status, list);
      }

      const statusOrder: QuestStatus[] = [
        "active", "planning", "draft", "paused", "completed", "abandoned",
      ];

      for (const status of statusOrder) {
        const group = byStatus.get(status);
        if (!group?.length) continue;

        const color = STATUS_COLOR[status] ?? "";
        console.log(`  ${color}${BOLD}${status.toUpperCase()}${RESET} (${group.length})`);

        for (const q of group) {
          const tasks = q.taskIds.length > 0 ? ` ${DIM}(${q.taskIds.length} tasks)${RESET}` : "";
          const deps = q.depends_on.length > 0 ? ` ${DIM}deps: ${q.depends_on.join(", ")}${RESET}` : "";
          console.log(
            `    ${color}${q.id}${RESET} — ${q.title} [${q.priority}/${q.difficulty}] ${DIM}hitl:${q.hitlMode}${RESET}${tasks}${deps}`
          );
        }
        console.log("");
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Subcommand: show
// ---------------------------------------------------------------------------

async function questShow(opts: QuestCommandOptions): Promise<void> {
  const { projectRoot } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.questId) {
    outputError(fmt, "Usage: woco quest show <quest-id>");
    return;
  }

  const quest = loadQuest(projectRoot, opts.questId);
  if (!quest) {
    outputError(fmt, `Quest "${opts.questId}" not found.`);
    return;
  }

  const knowledge = loadQuestKnowledge(projectRoot, quest.id);

  const fullData = {
    ...quest,
    has_knowledge: knowledge !== null,
    knowledge_length: knowledge?.length ?? 0,
  };

  output(
    fmt,
    fullData,
    () => {
      const sc = STATUS_COLOR[quest.status] ?? "";
      console.log(`\n${BOLD}Quest: ${quest.title}${RESET}`);
      console.log(`  ID:          ${quest.id}`);
      console.log(`  Status:      ${sc}${quest.status}${RESET}`);
      console.log(`  Priority:    ${quest.priority}`);
      console.log(`  Difficulty:  ${quest.difficulty}`);
      console.log(`  HITL Mode:   ${quest.hitlMode}`);
      console.log(`  Branch:      ${CYAN}${quest.branch}${RESET}`);
      console.log(`  Base Branch: ${quest.baseBranch}`);

      if (quest.created_at) console.log(`  Created:     ${DIM}${quest.created_at}${RESET}`);
      if (quest.started_at) console.log(`  Started:     ${DIM}${quest.started_at}${RESET}`);
      if (quest.ended_at) console.log(`  Ended:       ${DIM}${quest.ended_at}${RESET}`);

      console.log(`\n  ${BOLD}Goal:${RESET}`);
      for (const line of quest.goal.split("\n")) {
        console.log(`    ${line}`);
      }

      if (quest.taskIds.length > 0) {
        console.log(`\n  ${BOLD}Tasks (${quest.taskIds.length}):${RESET}`);
        for (const tid of quest.taskIds) {
          console.log(`    - ${tid}`);
        }
      }

      if (quest.depends_on.length > 0) {
        console.log(`\n  ${BOLD}Dependencies:${RESET}`);
        for (const dep of quest.depends_on) {
          console.log(`    - ${dep}`);
        }
      }

      if (quest.constraints.add.length > 0) {
        console.log(`\n  ${BOLD}Constraints (add):${RESET}`);
        for (const c of quest.constraints.add) {
          console.log(`    + ${c}`);
        }
      }

      if (quest.constraints.ban.length > 0) {
        console.log(`\n  ${BOLD}Constraints (ban):${RESET}`);
        for (const b of quest.constraints.ban) {
          console.log(`    ${RED}- ${b}${RESET}`);
        }
      }

      if (Object.keys(quest.constraints.override).length > 0) {
        console.log(`\n  ${BOLD}Config Overrides:${RESET}`);
        console.log(`    ${DIM}${JSON.stringify(quest.constraints.override)}${RESET}`);
      }

      if (quest.notes.length > 0) {
        console.log(`\n  ${BOLD}Notes:${RESET}`);
        for (const n of quest.notes) {
          console.log(`    - ${n}`);
        }
      }

      if (quest.agent_type) {
        console.log(`  Agent Type:  ${quest.agent_type}`);
      }
      if (quest.agent) {
        console.log(`  Agent:       ${quest.agent}`);
      }

      if (knowledge !== null) {
        console.log(`\n  ${BOLD}Knowledge:${RESET} ${DIM}${knowledge.length} chars${RESET}`);
      }

      console.log("");
    }
  );
}

// ---------------------------------------------------------------------------
// Subcommand: activate
// ---------------------------------------------------------------------------

async function questActivate(opts: QuestCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.questId) {
    outputError(fmt, "Usage: woco quest activate <quest-id>");
    return;
  }

  const quest = loadQuest(projectRoot, opts.questId);
  if (!quest) {
    outputError(fmt, `Quest "${opts.questId}" not found.`);
    return;
  }

  if (quest.status === "active") {
    outputMessage(fmt, `Quest "${quest.id}" is already active.`, { id: quest.id, status: quest.status });
    return;
  }

  if (quest.status === "completed" || quest.status === "abandoned") {
    outputError(fmt, `Quest "${quest.id}" is ${quest.status} and cannot be reactivated.`);
    return;
  }

  // Create the quest branch if it doesn't exist
  const branchAlreadyExists = questBranchExists(projectRoot, quest.id);
  if (!branchAlreadyExists) {
    try {
      await createQuestBranch(projectRoot, quest.id, quest.baseBranch);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      outputError(fmt, `Failed to create quest branch "${quest.branch}": ${reason}`);
      return;
    }
  }

  quest.status = "active";
  if (!quest.started_at) {
    quest.started_at = new Date().toISOString();
  }
  saveQuest(projectRoot, quest);

  outputMessage(fmt, `Quest "${quest.id}" activated.`, {
    id: quest.id,
    status: quest.status,
    branch: quest.branch,
    branchCreated: !branchAlreadyExists,
  });

  if (fmt === "text") {
    if (!branchAlreadyExists) {
      console.log(`  Branch ${CYAN}${quest.branch}${RESET} created from ${quest.baseBranch}.`);
    }
    console.log(`  Use ${BOLD}woco launch${RESET} to start agents on quest tasks.`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: pause
// ---------------------------------------------------------------------------

async function questPause(opts: QuestCommandOptions): Promise<void> {
  const { projectRoot } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.questId) {
    outputError(fmt, "Usage: woco quest pause <quest-id>");
    return;
  }

  const quest = loadQuest(projectRoot, opts.questId);
  if (!quest) {
    outputError(fmt, `Quest "${opts.questId}" not found.`);
    return;
  }

  if (quest.status === "paused") {
    outputMessage(fmt, `Quest "${quest.id}" is already paused.`, { id: quest.id, status: quest.status });
    return;
  }

  if (quest.status !== "active" && quest.status !== "planning") {
    outputError(fmt, `Quest "${quest.id}" is ${quest.status} — only active/planning quests can be paused.`);
    return;
  }

  quest.status = "paused";
  saveQuest(projectRoot, quest);

  outputMessage(fmt, `Quest "${quest.id}" paused.`, { id: quest.id, status: quest.status });

  if (fmt === "text") {
    console.log(`  Branch ${CYAN}${quest.branch}${RESET} preserved. Use ${BOLD}woco quest activate ${quest.id}${RESET} to resume.`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: complete
// ---------------------------------------------------------------------------

async function questComplete(opts: QuestCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.questId) {
    outputError(fmt, "Usage: woco quest complete <quest-id>");
    return;
  }

  const quest = loadQuest(projectRoot, opts.questId);
  if (!quest) {
    outputError(fmt, `Quest "${opts.questId}" not found.`);
    return;
  }

  if (quest.status === "completed") {
    outputMessage(fmt, `Quest "${quest.id}" is already completed.`, { id: quest.id, status: quest.status });
    return;
  }

  if (quest.status === "abandoned") {
    outputError(fmt, `Quest "${quest.id}" was abandoned and cannot be completed. Create a new quest instead.`);
    return;
  }

  // Check if the branch exists
  const hasBranch = questBranchExists(projectRoot, quest.id);

  if (opts.dryRun) {
    outputMessage(fmt, `[dry-run] Would complete quest "${quest.id}" and merge ${quest.branch} into ${quest.baseBranch}.`, {
      dry_run: true,
      id: quest.id,
      branch: quest.branch,
      baseBranch: quest.baseBranch,
      hasBranch,
    });
    return;
  }

  // Merge quest branch into base if it exists
  let mergeSuccess = true;
  let mergeMessage = "";
  if (hasBranch) {
    try {
      const result = await mergeQuestIntoBranch(projectRoot, quest.branch, quest.baseBranch, config);
      if (!result.success) {
        mergeSuccess = false;
        mergeMessage = result.error || "Merge failed (unknown reason)";
      }
    } catch (err: unknown) {
      mergeSuccess = false;
      mergeMessage = err instanceof Error ? err.message : String(err);
    }
  }

  if (!mergeSuccess && !opts.force) {
    outputError(
      fmt,
      `Merge of ${quest.branch} into ${quest.baseBranch} failed: ${mergeMessage}\nUse --force to complete without merging.`
    );
    return;
  }

  // Update quest status
  quest.status = "completed";
  quest.ended_at = new Date().toISOString();
  saveQuest(projectRoot, quest);

  // Clean up the quest branch (optional, only if merge succeeded)
  if (mergeSuccess && hasBranch) {
    deleteQuestBranch(projectRoot, quest.id);
  }

  outputMessage(fmt, `Quest "${quest.id}" completed.`, {
    id: quest.id,
    status: quest.status,
    merged: mergeSuccess,
    branchDeleted: mergeSuccess && hasBranch,
    mergeError: mergeSuccess ? undefined : mergeMessage,
  });

  if (fmt === "text") {
    if (mergeSuccess && hasBranch) {
      console.log(`  ${GREEN}Merged${RESET} ${CYAN}${quest.branch}${RESET} into ${quest.baseBranch} and deleted the branch.`);
    } else if (!mergeSuccess) {
      console.log(`  ${YELLOW}Warning:${RESET} Merge failed (${mergeMessage}). Quest marked complete with --force.`);
      console.log(`  Branch ${CYAN}${quest.branch}${RESET} preserved for manual resolution.`);
    } else {
      console.log(`  No branch to merge (quest had no branch).`);
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand: abandon
// ---------------------------------------------------------------------------

async function questAbandon(opts: QuestCommandOptions): Promise<void> {
  const { projectRoot } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.questId) {
    outputError(fmt, "Usage: woco quest abandon <quest-id>");
    return;
  }

  const quest = loadQuest(projectRoot, opts.questId);
  if (!quest) {
    outputError(fmt, `Quest "${opts.questId}" not found.`);
    return;
  }

  if (quest.status === "abandoned") {
    outputMessage(fmt, `Quest "${quest.id}" is already abandoned.`, { id: quest.id, status: quest.status });
    return;
  }

  if (quest.status === "completed") {
    outputError(fmt, `Quest "${quest.id}" is completed — cannot abandon a completed quest.`);
    return;
  }

  if (opts.dryRun) {
    const hasBranch = questBranchExists(projectRoot, quest.id);
    outputMessage(fmt, `[dry-run] Would abandon quest "${quest.id}".`, {
      dry_run: true,
      id: quest.id,
      branch: quest.branch,
      hasBranch,
      wouldDeleteBranch: hasBranch && !!opts.force,
    });
    return;
  }

  quest.status = "abandoned";
  quest.ended_at = new Date().toISOString();
  saveQuest(projectRoot, quest);

  // Optionally delete the branch with --force
  let branchDeleted = false;
  if (opts.force) {
    const hasBranch = questBranchExists(projectRoot, quest.id);
    if (hasBranch) {
      branchDeleted = deleteQuestBranch(projectRoot, quest.id);
    }
  }

  outputMessage(fmt, `Quest "${quest.id}" abandoned.`, {
    id: quest.id,
    status: quest.status,
    branchDeleted,
  });

  if (fmt === "text") {
    if (branchDeleted) {
      console.log(`  Branch ${CYAN}${quest.branch}${RESET} deleted.`);
    } else {
      const hasBranch = questBranchExists(projectRoot, quest.id);
      if (hasBranch) {
        console.log(`  Branch ${CYAN}${quest.branch}${RESET} preserved. Use ${BOLD}--force${RESET} to delete it.`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand: plan
// ---------------------------------------------------------------------------

async function questPlan(opts: QuestCommandOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.questId) {
    outputError(fmt, "Usage: woco quest plan <quest-id> [--model <model>]");
    return;
  }

  const quest = loadQuest(projectRoot, opts.questId);
  if (!quest) {
    outputError(fmt, `Quest "${opts.questId}" not found.`);
    return;
  }

  if (quest.status === "completed" || quest.status === "abandoned") {
    outputError(fmt, `Quest "${quest.id}" is ${quest.status} and cannot be planned.`);
    return;
  }

  // Set quest to planning status
  quest.status = "planning";
  saveQuest(projectRoot, quest);

  if (fmt === "text") {
    console.log(`\n${BOLD}Planning quest: ${quest.title}${RESET}`);
    console.log(`  Goal: ${quest.goal}`);
    console.log(`  Running quest planner agent...\n`);
  }

  let result: PlanResult;
  try {
    result = await runQuestPlanner(quest, projectRoot, config, {
      model: opts.dryRun ? undefined : undefined, // model passed via config or CLI
      onProgress: (msg) => {
        if (fmt === "text") {
          console.log(`  ${DIM}${msg}${RESET}`);
        }
      },
    });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    // Revert planning status on failure
    quest.status = "draft";
    saveQuest(projectRoot, quest);
    outputError(fmt, `Planner failed: ${reason}`);
    return;
  }

  // Show results
  if (fmt === "text") {
    console.log(`\n  ${BOLD}Planner produced ${result.tasks.length} tasks${RESET}`);

    if (result.issues.length > 0) {
      console.log(`\n  ${BOLD}Validation Issues:${RESET}`);
      for (const issue of result.issues) {
        const color = issue.level === "error" ? RED : YELLOW;
        const prefix = issue.level === "error" ? "ERROR" : "WARN";
        const taskRef = issue.taskId ? ` [${issue.taskId}]` : "";
        console.log(`    ${color}${prefix}${taskRef}: ${issue.message}${RESET}`);
      }
    }

    if (result.tasks.length > 0) {
      console.log(`\n  ${BOLD}Proposed Tasks:${RESET}`);
      for (const task of result.tasks) {
        const deps = task.depends_on.length > 0
          ? ` ${DIM}deps: ${task.depends_on.join(", ")}${RESET}`
          : "";
        console.log(
          `    ${CYAN}${task.id}${RESET} — ${task.title} ` +
          `[${task.priority}/${task.difficulty}] ${DIM}${task.effort}${RESET}${deps}`
        );
      }
    }

    if (result.knowledge) {
      console.log(`\n  ${BOLD}Knowledge:${RESET} ${DIM}${result.knowledge.length} chars${RESET}`);
    }
  }

  if (!result.success) {
    // Revert to draft if plan has errors
    quest.status = "draft";
    saveQuest(projectRoot, quest);

    output(fmt, {
      success: false,
      tasks: result.tasks,
      issues: result.issues,
      error: result.error,
    }, () => {
      console.log(`\n  ${RED}Plan has errors. Quest reverted to draft.${RESET}`);
      console.log(`  Fix issues and run ${BOLD}woco quest plan ${quest.id}${RESET} again.\n`);
    });
    return;
  }

  if (opts.dryRun) {
    // Revert to previous status
    quest.status = "draft";
    saveQuest(projectRoot, quest);

    output(fmt, {
      dry_run: true,
      success: true,
      tasks: result.tasks,
      knowledge: result.knowledge ? `${result.knowledge.length} chars` : null,
      issues: result.issues,
    }, () => {
      console.log(`\n  ${GREEN}[dry-run]${RESET} Plan looks good. Run without --dry-run to apply.`);
    });
    return;
  }

  // Apply the plan — creates tasks and activates the quest
  const tasks = applyPlanToQuest(result, quest, projectRoot, config);

  output(fmt, {
    success: true,
    quest_id: quest.id,
    quest_status: quest.status,
    tasks_created: tasks.length,
    task_ids: tasks.map((t) => t.id),
    has_knowledge: result.knowledge !== null,
  }, () => {
    console.log(`\n  ${GREEN}Plan applied!${RESET}`);
    console.log(`  Created ${tasks.length} tasks and activated quest "${quest.id}".`);
    if (result.knowledge) {
      console.log(`  Saved knowledge file (${result.knowledge.length} chars).`);
    }
    console.log(`\n  Use ${BOLD}woco launch --quest ${quest.id}${RESET} or the TUI to start agents.\n`);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleQuestSubcommand(opts: QuestCommandOptions): Promise<void> {
  switch (opts.subcommand) {
    case "create":
      await questCreate(opts);
      break;
    case "list":
      await questList(opts);
      break;
    case "show":
      await questShow(opts);
      break;
    case "activate":
      await questActivate(opts);
      break;
    case "pause":
      await questPause(opts);
      break;
    case "complete":
      await questComplete(opts);
      break;
    case "abandon":
      await questAbandon(opts);
      break;
    case "plan":
      await questPlan(opts);
      break;
    case "help":
    case "--help":
    case "-h":
      questHelp();
      break;
    default:
      outputError(
        opts.outputFmt ?? "text",
        `Unknown quest subcommand: "${opts.subcommand}". Run 'woco quest help' for usage.`
      );
      return;
  }
}

// ---------------------------------------------------------------------------
// Quest-specific help
// ---------------------------------------------------------------------------

function questHelp(): void {
  console.log(`
Quest Subcommands:                (alias)
  quest create <id> "Title"       (c)     Create a new quest (--goal, --priority, --difficulty, --hitl)
  quest list                      (ls)    List all quests (--status to filter)
  quest show <id>                 (sh)    Show full quest details
  quest plan <id>                 (pl)    Run planner agent to decompose quest into tasks
  quest activate <id>             (a)     Activate a quest (creates branch, sets status to active)
  quest pause <id>                (p)     Pause an active quest
  quest complete <id>             (co)    Complete quest (merges branch into base, --force to skip merge)
  quest abandon <id>              (ab)    Abandon quest without merging (--force to delete branch)

Options:
  --goal <text>             Quest goal (required for create)
  --priority <level>        Priority (critical/high/medium/low/wishlist)
  --difficulty <level>      Difficulty (trivial/easy/medium/hard/very_hard)
  --hitl <mode>             HITL mode (yolo/cautious/supervised, default: yolo)
  --status <status>         Filter by status (for list)
  --agent <name>            Agent definition override for all tasks in this quest
  --model <name>            Model override (for plan)
  --dry-run                 Show what would happen without doing it
  --force                   Force action (complete: skip merge; abandon: delete branch)
  --output <fmt>            Output format (text/json/toon)

Examples:
  woco quest create auth-overhaul "Auth Overhaul" --goal "Replace basic auth with OAuth2"
  woco quest create ui-refresh "UI Refresh" --goal "Modernize UI" --priority high --hitl cautious
  woco quest plan auth-overhaul
  woco quest plan auth-overhaul --dry-run
  woco quest list
  woco quest list --status active
  woco quest show auth-overhaul
  woco quest activate auth-overhaul
  woco quest pause auth-overhaul
  woco quest complete auth-overhaul
  woco quest abandon auth-overhaul --force
  woco q c my-quest "My Quest" --goal "Do something"
  woco q pl my-quest
  woco q ls
  woco q sh my-quest
`);
}
