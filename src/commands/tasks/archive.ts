/**
 * tasks/archive.ts — Move done/cancelled tasks to the archive section.
 *
 * Usage:
 *   woco tasks archive              # archive all done + cancelled
 *   woco tasks archive <task-id>    # archive a specific task
 *   woco tasks archive --dry-run    # show what would be archived
 */

import type { WomboConfig } from "../../config";
import {
  loadFeatures,
  saveFeatures,
  type Feature,
} from "../../lib/tasks";
import { outputError, outputMessage, type OutputFormat } from "../../lib/output";
import { loadQuest } from "../../lib/quest-store";
import { getQuestTaskIds } from "../../lib/quest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TasksArchiveOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId?: string;
  dryRun?: boolean;
  outputFmt?: OutputFormat;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdTasksArchive(opts: TasksArchiveOptions): Promise<void> {
  const fmt = opts.outputFmt ?? "text";

  try {
    const { projectRoot, config } = opts;
    const data = loadFeatures(projectRoot, config);

    // Ensure archive array exists
    if (!data.archive) {
      data.archive = [];
    }

    let toArchive: Feature[];

    if (opts.featureId) {
      // Archive a specific feature
      const idx = data.tasks.findIndex((f: Feature) => f.id === opts.featureId);
      if (idx === -1) {
        // Check if already in archive
        if (data.archive.find((f) => f.id === opts.featureId)) {
          outputMessage(fmt, `Task "${opts.featureId}" is already in the archive.`, {
            already_archived: true,
            id: opts.featureId,
          });
          return;
        }
        outputError(fmt, `Task "${opts.featureId}" not found.`);
        return;
      }
      toArchive = [data.tasks[idx]];
    } else {
      // Archive all done + cancelled features
      toArchive = data.tasks.filter(
        (f: Feature) => f.status === "done" || f.status === "cancelled"
      );
    }

    if (toArchive.length === 0) {
      outputMessage(fmt, "No tasks to archive.", { count: 0 });
      return;
    }

    if (opts.dryRun) {
      outputMessage(fmt, `Would archive ${toArchive.length} task(s)`, {
        dry_run: true,
        count: toArchive.length,
        archived: toArchive.map((f) => ({ id: f.id, title: f.title, status: f.status })),
      });
      if (fmt === "text") {
        console.log("");
        for (const f of toArchive) {
          console.log(`  ${f.id} — ${f.title} (${f.status})`);
        }
      }
      return;
    }

    // Move features from active to archive
    const archiveIds = new Set(toArchive.map((f) => f.id));
    data.tasks = data.tasks.filter((f: Feature) => !archiveIds.has(f.id));
    data.archive.push(...toArchive);

    saveFeatures(projectRoot, config, data);

    outputMessage(fmt, `Archived ${toArchive.length} task(s)`, {
      count: toArchive.length,
      archived: toArchive.map((f) => ({ id: f.id, title: f.title, status: f.status })),
    });
    if (fmt === "text") {
      for (const f of toArchive) {
        console.log(`  ${f.id} — ${f.title} (${f.status})`);
      }
    }

    // Nudge: if any archived tasks belonged to a quest and that quest now
    // has zero remaining active tasks, suggest completing it.
    if (fmt === "text") {
      const questIds = new Set(
        toArchive.map((f) => f.quest).filter((q): q is string => !!q)
      );
      for (const qid of questIds) {
        const quest = loadQuest(projectRoot, qid);
        if (!quest) continue;
        // Only nudge for non-terminal quests
        if (quest.status === "completed" || quest.status === "abandoned") continue;
        const remaining = getQuestTaskIds(qid, data.tasks);
        if (remaining.length === 0) {
          console.log(
            `\n  Quest "${qid}" has no remaining active tasks.` +
            `\n  Consider completing it: woco quest complete ${qid}`
          );
        }
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    outputError(fmt, `Archive failed: ${message}`);
  }
}
