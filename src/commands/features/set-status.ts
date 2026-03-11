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
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdFeaturesSetStatus(opts: FeaturesSetStatusOptions): Promise<void> {
  const { projectRoot, config } = opts;

  if (!opts.featureId || !opts.newStatus) {
    console.error("Usage: wombo features set-status <feature-id> <new-status>");
    console.error(`Valid statuses: ${VALID_STATUSES.join(", ")}`);
    process.exit(1);
    return;
  }

  // Validate status
  if (!VALID_STATUSES.includes(opts.newStatus as FeatureStatus)) {
    console.error(`Invalid status: "${opts.newStatus}"`);
    console.error(`Valid statuses: ${VALID_STATUSES.join(", ")}`);
    process.exit(1);
    return;
  }

  const data = loadFeatures(projectRoot, config);
  const feature = findFeatureById(data, opts.featureId);

  if (!feature) {
    console.error(`Feature "${opts.featureId}" not found.`);
    process.exit(1);
    return;
  }

  const oldStatus = feature.status;
  const newStatus = opts.newStatus as FeatureStatus;

  if (oldStatus === newStatus) {
    console.log(`Feature "${opts.featureId}" is already in status "${newStatus}".`);
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

  console.log(`Feature "${opts.featureId}": ${oldStatus} → ${newStatus}`);
}
