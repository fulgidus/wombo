/**
 * features/set-difficulty.ts — Change a feature's difficulty.
 *
 * Usage:
 *   wombo features set-difficulty <feature-id> <difficulty>
 *
 * Valid difficulties: trivial, easy, medium, hard, very_hard
 *
 * Supports --output json and --dry-run.
 * Works on both top-level features and subtasks.
 */

import type { WomboConfig } from "../../config.js";
import {
  loadFeatures,
  saveFeatures,
  findFeatureById,
  type Difficulty,
} from "../../lib/features.js";
import { outputError, outputMessage, type OutputFormat } from "../../lib/output.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const VALID_DIFFICULTIES: Difficulty[] = [
  "trivial",
  "easy",
  "medium",
  "hard",
  "very_hard",
];

export interface FeaturesSetDifficultyOptions {
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

export async function cmdFeaturesSetDifficulty(opts: FeaturesSetDifficultyOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.featureId || !opts.newDifficulty) {
    outputError(fmt, `Usage: wombo features set-difficulty <feature-id> <difficulty>\nValid difficulties: ${VALID_DIFFICULTIES.join(", ")}`);
    return;
  }

  // Validate difficulty
  if (!VALID_DIFFICULTIES.includes(opts.newDifficulty as Difficulty)) {
    outputError(fmt, `Invalid difficulty: "${opts.newDifficulty}"\nValid difficulties: ${VALID_DIFFICULTIES.join(", ")}`);
    return;
  }

  const data = loadFeatures(projectRoot, config);
  const feature = findFeatureById(data, opts.featureId);

  if (!feature) {
    outputError(fmt, `Feature "${opts.featureId}" not found.`);
    return;
  }

  const oldDifficulty = feature.difficulty;
  const newDifficulty = opts.newDifficulty as Difficulty;

  if (oldDifficulty === newDifficulty) {
    outputMessage(fmt, `Feature "${opts.featureId}" already has difficulty "${newDifficulty}".`, {
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

  outputMessage(fmt, `Feature "${opts.featureId}" difficulty: ${oldDifficulty} → ${newDifficulty}`, {
    id: opts.featureId,
    old_difficulty: oldDifficulty,
    new_difficulty: newDifficulty,
    changed: true,
  });
}
