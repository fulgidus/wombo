/**
 * tasks/list.ts — List and filter tasks from the tasks file.
 *
 * Usage:
 *   woco tasks list                     # list all tasks
 *   woco tasks list --status backlog    # filter by status
 *   woco tasks list --priority high     # filter by priority
 *   woco tasks list --ready             # show only ready tasks
 *   woco tasks list --archive           # include archived tasks
 */

import type { WomboConfig } from "../../config.js";
import {
  loadFeatures,
  getReadyFeatures,
  featureSummary,
  formatDuration,
  parseDurationMinutes,
  type Feature,
  type FeatureStatus,
  type Priority,
  type Difficulty,
  type FeaturesFile,
} from "../../lib/tasks.js";
import { output, filterFieldsArray, renderCompactTable, type OutputFormat } from "../../lib/output.js";
import { renderTasksList } from "../../lib/toon.js";
import { loadAllQuests } from "../../lib/quest-store.js";
import type { Quest } from "../../lib/quest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TasksListOptions {
  projectRoot: string;
  config: WomboConfig;
  status?: FeatureStatus;
  priority?: Priority;
  difficulty?: Difficulty;
  ready?: boolean;
  includeArchive?: boolean;
  outputFmt?: OutputFormat;
  fields?: string[];
}

// ---------------------------------------------------------------------------
// ANSI Helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const STATUS_COLOR: Record<FeatureStatus, string> = {
  backlog: "\x1b[37m",     // white
  planned: "\x1b[36m",     // cyan
  in_progress: "\x1b[34m", // blue
  blocked: "\x1b[31m",     // red
  in_review: "\x1b[33m",   // yellow
  done: "\x1b[32m",        // green
  cancelled: "\x1b[90m",   // gray
};

// ---------------------------------------------------------------------------
// Quest reverse-map helpers
// ---------------------------------------------------------------------------

interface QuestInfo {
  id: string;
  title: string;
  status: string;
}

/**
 * Build a map from taskId → QuestInfo by scanning all quests' taskIds.
 */
function buildTaskQuestMap(projectRoot: string): Map<string, QuestInfo> {
  const quests = loadAllQuests(projectRoot);
  const map = new Map<string, QuestInfo>();
  for (const q of quests) {
    const info: QuestInfo = { id: q.id, title: q.title, status: q.status };
    for (const tid of q.taskIds) {
      map.set(tid, info);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Status-grouped rendering (reused per quest section)
// ---------------------------------------------------------------------------

const STATUS_ORDER: FeatureStatus[] = [
  "in_progress",
  "planned",
  "backlog",
  "blocked",
  "in_review",
  "done",
  "cancelled",
];

function renderStatusGroups(
  tasks: Feature[],
  indent: string,
): void {
  const byStatus = new Map<FeatureStatus, Feature[]>();
  for (const f of tasks) {
    const list = byStatus.get(f.status) ?? [];
    list.push(f);
    byStatus.set(f.status, list);
  }

  for (const status of STATUS_ORDER) {
    const group = byStatus.get(status);
    if (!group?.length) continue;

    const color = STATUS_COLOR[status] ?? "";
    console.log(`${indent}${color}${BOLD}${status.toUpperCase()}${RESET} (${group.length})`);

    for (const f of group) {
      const effort = formatDuration(parseDurationMinutes(f.effort));
      const deps = f.depends_on.length > 0 ? ` ${DIM}deps: ${f.depends_on.join(", ")}${RESET}` : "";
      const completion = f.completion > 0 ? ` ${DIM}${f.completion}%${RESET}` : "";
      console.log(
        `${indent}  ${color}${f.id}${RESET} — ${f.title} [${f.priority}/${f.difficulty}] (${effort})${completion}${deps}`
      );
    }
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdTasksList(opts: TasksListOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const data = loadFeatures(projectRoot, config);

  let features: Feature[] = [...data.tasks];

  // Include archive if requested
  if (opts.includeArchive && data.archive?.length) {
    features = [...features, ...data.archive];
  }

  // Filter by status
  if (opts.status) {
    features = features.filter((f) => f.status === opts.status);
  }

  // Filter by priority
  if (opts.priority) {
    features = features.filter((f) => f.priority === opts.priority);
  }

  // Filter by difficulty
  if (opts.difficulty) {
    features = features.filter((f) => f.difficulty === opts.difficulty);
  }

  // Filter to ready-only
  if (opts.ready) {
    const readyFeatures = getReadyFeatures(data);
    const readyIds = new Set(readyFeatures.map((f) => f.id));
    features = features.filter((f) => readyIds.has(f.id));
  }

  if (features.length === 0) {
    output(opts.outputFmt ?? "text", { features: [], total: 0, effort: "0m" }, () => {
      console.log("No tasks match the given filters.");
    }, () => {
      // TOON: emit empty result
      console.log(renderTasksList([]));
    });
    return;
  }

  // Build quest reverse-map: taskId → QuestInfo
  const taskQuestMap = buildTaskQuestMap(projectRoot);

  // Display
  const totalEffort = features.reduce(
    (sum, f) => sum + parseDurationMinutes(f.effort),
    0
  );

  const fmt = opts.outputFmt ?? "text";

  // Build the structured data for each feature, enriched with quest info
  const featureData = features.map((f) => {
    const qi = taskQuestMap.get(f.id);
    return {
      id: f.id,
      title: f.title,
      status: f.status,
      priority: f.priority,
      difficulty: f.difficulty,
      effort: f.effort,
      completion: f.completion,
      depends_on: f.depends_on,
      quest: qi?.id ?? null,
    };
  });

  // If --fields is specified, use compact output mode
  if (opts.fields?.length) {
    const filtered = filterFieldsArray(featureData, opts.fields);
    output(
      fmt,
      { features: filtered, total: features.length, effort: formatDuration(totalEffort) },
      () => {
        renderCompactTable(
          featureData as Record<string, unknown>[],
          opts.fields!
        );
      },
      () => {
        // TOON: --fields is ignored; emit all fields in compact format
        console.log(renderTasksList(featureData));
      }
    );
    return;
  }

  // Group features by quest for display
  const byQuest = new Map<string | null, Feature[]>(); // key: questId or null
  const questInfoMap = new Map<string, QuestInfo>();    // questId → info
  for (const f of features) {
    const qi = taskQuestMap.get(f.id);
    const key = qi?.id ?? null;
    if (qi) questInfoMap.set(qi.id, qi);
    const list = byQuest.get(key) ?? [];
    list.push(f);
    byQuest.set(key, list);
  }

  output(
    fmt,
    {
      features: featureData,
      total: features.length,
      effort: formatDuration(totalEffort),
    },
    () => {
      console.log(`\n${BOLD}Tasks (${features.length} total, ~${formatDuration(totalEffort)} effort)${RESET}\n`);

      // Render quest-grouped sections (quests first, standalone last)
      const questIds = [...questInfoMap.keys()].sort();
      const standalone = byQuest.get(null);

      for (const qid of questIds) {
        const qi = questInfoMap.get(qid)!;
        const tasks = byQuest.get(qid)!;
        const questEffort = tasks.reduce((s, f) => s + parseDurationMinutes(f.effort), 0);
        console.log(`  ${BOLD}${qi.title}${RESET} ${DIM}[${qi.id}]${RESET} (${tasks.length} tasks, ~${formatDuration(questEffort)})`);
        renderStatusGroups(tasks, "    ");
      }

      if (standalone?.length) {
        if (questIds.length > 0) {
          // Only show header if there are also quest-grouped tasks
          console.log(`  ${BOLD}Standalone${RESET} (${standalone.length} tasks)`);
        }
        renderStatusGroups(standalone, questIds.length > 0 ? "    " : "  ");
      }
    },
    () => {
      // TOON renderer
      console.log(renderTasksList(featureData));
    }
  );
}
