/**
 * features/set-status.ts — Change a feature's status.
 *
 * Usage:
 *   wombo features set-status <feature-id> <new-status>
 *
 * Valid statuses: backlog, planned, in_progress, blocked, in_review, done, cancelled
 */

import type { WomboConfig } from "../../config.js";
import {
  loadFeatures,
  saveFeatures,
  findFeatureById,
  type FeatureStatus,
} from "../../lib/features.js";
import { outputError, outputMessage, type OutputFormat } from "../../lib/output.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const VALID_STATUSES: FeatureStatus[] = [
  "backlog",
  "planned",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "cancelled",
];

export interface FeaturesSetStatusOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId: string;
  newStatus: string;
  outputFmt?: OutputFormat;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdFeaturesSetStatus(opts: FeaturesSetStatusOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.featureId || !opts.newStatus) {
    outputError(fmt, `Usage: wombo features set-status <feature-id> <new-status>\nValid statuses: ${VALID_STATUSES.join(", ")}`);
    return;
  }

  // Validate status
  if (!VALID_STATUSES.includes(opts.newStatus as FeatureStatus)) {
    outputError(fmt, `Invalid status: "${opts.newStatus}"\nValid statuses: ${VALID_STATUSES.join(", ")}`);
    return;
  }

  const data = loadFeatures(projectRoot, config);
  const feature = findFeatureById(data, opts.featureId);

  if (!feature) {
    outputError(fmt, `Feature "${opts.featureId}" not found.`);
    return;
  }

  const oldStatus = feature.status;
  const newStatus = opts.newStatus as FeatureStatus;

  if (oldStatus === newStatus) {
    outputMessage(fmt, `Feature "${opts.featureId}" is already in status "${newStatus}".`, {
      id: opts.featureId,
      status: newStatus,
      changed: false,
    });
    return;
  }

  // Dry-run: show what would change without writing
  if (opts.dryRun) {
    outputMessage(fmt, `[dry-run] Would change "${opts.featureId}": ${oldStatus} → ${newStatus}`, {
      dry_run: true,
      id: opts.featureId,
      old_status: oldStatus,
      new_status: newStatus,
      changed: false,
    });
    return;
  }

  // Apply status change
  feature.status = newStatus;

  // Set timestamps
  if (newStatus === "in_progress" && !feature.started_at) {
    feature.started_at = new Date().toISOString();
  }
  if (newStatus === "done" || newStatus === "cancelled") {
    feature.ended_at = new Date().toISOString();
    if (newStatus === "done") {
      feature.completion = 100;
    }
  }

  saveFeatures(projectRoot, config, data);

  outputMessage(fmt, `Feature "${opts.featureId}": ${oldStatus} → ${newStatus}`, {
    id: opts.featureId,
    old_status: oldStatus,
    new_status: newStatus,
    changed: true,
  });
}
