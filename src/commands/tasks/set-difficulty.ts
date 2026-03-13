/**
 * tasks/set-difficulty.ts — Change a task's difficulty.
 *
 * Usage:
 *   woco tasks set-difficulty <task-id> <difficulty>
 *
 * Valid difficulties: trivial, easy, medium, hard, very_hard
 *
 * Supports --output json and --dry-run.
 * Works on both top-level tasks and subtasks.
 */

import type { WomboConfig } from "../../config.js";
import {
  loadFeatures,
  saveFeatures,
  findFeatureById,
  type Difficulty,
} from "../../lib/tasks.js";
import { VALID_DIFFICULTIES } from "../../lib/task-schema.js";
import { outputError, outputMessage, type OutputFormat } from "../../lib/output.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TasksSetDifficultyOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId: string;
  newDifficulty: string;
  outputFmt?: OutputFormat;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdTasksSetDifficulty(opts: TasksSetDifficultyOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.featureId || !opts.newDifficulty) {
    outputError(fmt, `Usage: woco tasks set-difficulty <task-id> <difficulty>\nValid difficulties: ${VALID_DIFFICULTIES.join(", ")}`);
    return;
  }

  // Validate difficulty
  if (!(VALID_DIFFICULTIES as readonly string[]).includes(opts.newDifficulty)) {
    outputError(fmt, `Invalid difficulty: "${opts.newDifficulty}"\nValid difficulties: ${VALID_DIFFICULTIES.join(", ")}`);
    return;
  }

  const data = loadFeatures(projectRoot, config);
  const feature = findFeatureById(data, opts.featureId);

  if (!feature) {
    outputError(fmt, `Task "${opts.featureId}" not found.`);
    return;
  }

  const oldDifficulty = feature.difficulty;
  const newDifficulty = opts.newDifficulty as Difficulty;

  if (oldDifficulty === newDifficulty) {
    outputMessage(fmt, `Task "${opts.featureId}" already has difficulty "${newDifficulty}".`, {
      id: opts.featureId,
      difficulty: newDifficulty,
      changed: false,
    });
    return;
  }

  // Dry-run: show what would change without writing
  if (opts.dryRun) {
    outputMessage(fmt, `[dry-run] Would change "${opts.featureId}" difficulty: ${oldDifficulty} → ${newDifficulty}`, {
      dry_run: true,
      id: opts.featureId,
      old_difficulty: oldDifficulty,
      new_difficulty: newDifficulty,
      changed: false,
    });
    return;
  }

  // Apply difficulty change
  feature.difficulty = newDifficulty;

  saveFeatures(projectRoot, config, data);

  outputMessage(fmt, `Task "${opts.featureId}" difficulty: ${oldDifficulty} → ${newDifficulty}`, {
    id: opts.featureId,
    old_difficulty: oldDifficulty,
    new_difficulty: newDifficulty,
    changed: true,
  });
}
