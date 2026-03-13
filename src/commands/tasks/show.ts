/**
 * tasks/show.ts — Show detailed information about a specific task.
 *
 * Usage:
 *   woco tasks show <task-id>
 */

import type { WomboConfig } from "../../config.js";
import {
  loadFeatures,
  findFeatureById,
  formatDuration,
  parseDurationMinutes,
  areDependenciesMet,
  getDoneFeatureIds,
  type Feature,
  type Subtask,
} from "../../lib/tasks.js";
import { output, outputError, filterFields, type OutputFormat } from "../../lib/output.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TasksShowOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId: string;
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

// ---------------------------------------------------------------------------
// Display Helpers
// ---------------------------------------------------------------------------

function statusColor(status: string): string {
  switch (status) {
    case "done": return GREEN;
    case "in_progress": return CYAN;
    case "blocked":
    case "failed": return RED;
    case "cancelled": return DIM;
    default: return "";
  }
}

function renderSubtask(st: Subtask, indent: number): void {
  const pad = "  ".repeat(indent);
  const color = statusColor(st.status);
  const effort = formatDuration(parseDurationMinutes(st.effort));
  const completionStr = st.completion > 0 ? ` (${st.completion}%)` : "";
  console.log(
    `${pad}${color}[${st.status}]${RESET} ${st.id} — ${st.title} [${st.priority}/${st.difficulty}] (${effort})${completionStr}`
  );
  if (st.subtasks?.length) {
    for (const sub of st.subtasks) {
      renderSubtask(sub, indent + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdTasksShow(opts: TasksShowOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.featureId) {
    outputError(fmt, "Usage: woco tasks show <task-id>");
    return;
  }

  const data = loadFeatures(projectRoot, config);
  const feature = findFeatureById(data, opts.featureId);

  if (!feature) {
    outputError(fmt, `Task "${opts.featureId}" not found.`);
    return;
  }

  const doneIds = getDoneFeatureIds(data);
  const depsMet = areDependenciesMet(feature, doneIds);
  const effort = formatDuration(parseDurationMinutes(feature.effort));

  const fullData = {
    ...feature,
    deps_met: depsMet,
    effort_formatted: effort,
  };

  // If --fields is specified, emit only those fields
  if (opts.fields?.length) {
    const filtered = filterFields(fullData as Record<string, unknown>, opts.fields);
    output(fmt, filtered, () => {
      for (const [key, val] of Object.entries(filtered)) {
        const display = Array.isArray(val) ? val.join(", ") : String(val ?? "");
        console.log(`${key}: ${display}`);
      }
    });
    return;
  }

  output(
    fmt,
    fullData,
    () => {
      console.log(`\n${BOLD}Task: ${feature.title}${RESET}`);
      console.log(`  ID:          ${feature.id}`);
      console.log(`  Status:      ${statusColor(feature.status)}${feature.status}${RESET}`);
      console.log(`  Priority:    ${feature.priority}`);
      console.log(`  Difficulty:  ${feature.difficulty}`);
      console.log(`  Effort:      ${effort}`);
      console.log(`  Completion:  ${feature.completion}%`);
      console.log(`  Deps met:    ${depsMet ? `${GREEN}yes${RESET}` : `${RED}no${RESET}`}`);

      if (feature.started_at) {
        console.log(`  Started:     ${feature.started_at}`);
      }
      if (feature.ended_at) {
        console.log(`  Ended:       ${feature.ended_at}`);
      }

      if (feature.description) {
        console.log(`\n  ${BOLD}Description:${RESET}`);
        for (const line of feature.description.split("\n")) {
          console.log(`    ${line}`);
        }
      }

      if (feature.depends_on.length > 0) {
        console.log(`\n  ${BOLD}Dependencies:${RESET}`);
        for (const dep of feature.depends_on) {
          const met = doneIds.has(dep);
          const icon = met ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
          console.log(`    ${icon} ${dep}`);
        }
      }

      if (feature.constraints.length > 0) {
        console.log(`\n  ${BOLD}Constraints:${RESET}`);
        for (const c of feature.constraints) {
          console.log(`    - ${c}`);
        }
      }

      if (feature.forbidden.length > 0) {
        console.log(`\n  ${BOLD}Forbidden:${RESET}`);
        for (const f of feature.forbidden) {
          console.log(`    - ${RED}${f}${RESET}`);
        }
      }

      if (feature.references.length > 0) {
        console.log(`\n  ${BOLD}References:${RESET}`);
        for (const r of feature.references) {
          console.log(`    - ${DIM}${r}${RESET}`);
        }
      }

      if (feature.notes.length > 0) {
        console.log(`\n  ${BOLD}Notes:${RESET}`);
        for (const n of feature.notes) {
          console.log(`    - ${n}`);
        }
      }

      if (feature.subtasks.length > 0) {
        console.log(`\n  ${BOLD}Subtasks (${feature.subtasks.length}):${RESET}`);
        for (const st of feature.subtasks) {
          renderSubtask(st, 2);
        }
      }

      console.log("");
    }
  );
}
