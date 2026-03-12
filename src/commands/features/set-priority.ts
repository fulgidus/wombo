/**
 * features/set-priority.ts — Change a feature's priority.
 *
 * Usage:
 *   wombo features set-priority <feature-id> <priority>
 *
 * Valid priorities: critical, high, medium, low, wishlist
 *
 * Supports --output json and --dry-run.
 * Works on both top-level features and subtasks.
 */

import type { WomboConfig } from "../../config.js";
import {
  loadFeatures,
  saveFeatures,
  findFeatureById,
  type Priority,
} from "../../lib/features.js";
import { outputError, outputMessage, type OutputFormat } from "../../lib/output.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const VALID_PRIORITIES: Priority[] = [
  "critical",
  "high",
  "medium",
  "low",
  "wishlist",
];

export interface FeaturesSetPriorityOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId: string;
  newPriority: string;
  outputFmt?: OutputFormat;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdFeaturesSetPriority(opts: FeaturesSetPriorityOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.featureId || !opts.newPriority) {
    outputError(fmt, `Usage: wombo features set-priority <feature-id> <priority>\nValid priorities: ${VALID_PRIORITIES.join(", ")}`);
    return;
  }

  // Validate priority
  if (!VALID_PRIORITIES.includes(opts.newPriority as Priority)) {
    outputError(fmt, `Invalid priority: "${opts.newPriority}"\nValid priorities: ${VALID_PRIORITIES.join(", ")}`);
    return;
  }

  const data = loadFeatures(projectRoot, config);
  const feature = findFeatureById(data, opts.featureId);

  if (!feature) {
    outputError(fmt, `Feature "${opts.featureId}" not found.`);
    return;
  }

  const oldPriority = feature.priority;
  const newPriority = opts.newPriority as Priority;

  if (oldPriority === newPriority) {
    outputMessage(fmt, `Feature "${opts.featureId}" already has priority "${newPriority}".`, {
      id: opts.featureId,
      priority: newPriority,
      changed: false,
    });
    return;
  }

  // Dry-run: show what would change without writing
  if (opts.dryRun) {
    outputMessage(fmt, `[dry-run] Would change "${opts.featureId}" priority: ${oldPriority} → ${newPriority}`, {
      dry_run: true,
      id: opts.featureId,
      old_priority: oldPriority,
      new_priority: newPriority,
      changed: false,
    });
    return;
  }

  // Apply priority change
  feature.priority = newPriority;

  saveFeatures(projectRoot, config, data);

  outputMessage(fmt, `Feature "${opts.featureId}" priority: ${oldPriority} → ${newPriority}`, {
    id: opts.featureId,
    old_priority: oldPriority,
    new_priority: newPriority,
    changed: true,
  });
}
