/**
 * features/archive.ts — Move done/cancelled features to the archive section.
 *
 * Usage:
 *   wombo features archive              # archive all done + cancelled
 *   wombo features archive <feature-id> # archive a specific feature
 *   wombo features archive --dry-run    # show what would be archived
 */

import type { WomboConfig } from "../../config.js";
import {
  loadFeatures,
  saveFeatures,
  findFeatureById,
  type Feature,
} from "../../lib/features.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeaturesArchiveOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId?: string;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdFeaturesArchive(opts: FeaturesArchiveOptions): Promise<void> {
  const { projectRoot, config } = opts;

  const data = loadFeatures(projectRoot, config);

  // Ensure archive array exists
  if (!data.archive) {
    data.archive = [];
  }

  let toArchive: Feature[];

  if (opts.featureId) {
    // Archive a specific feature
    const idx = data.features.findIndex((f) => f.id === opts.featureId);
    if (idx === -1) {
      // Check if already in archive
      if (data.archive.find((f) => f.id === opts.featureId)) {
        console.log(`Feature "${opts.featureId}" is already in the archive.`);
        return;
      }
      console.error(`Feature "${opts.featureId}" not found.`);
      process.exit(1);
      return;
    }
    toArchive = [data.features[idx]];
  } else {
    // Archive all done + cancelled features
    toArchive = data.features.filter(
      (f) => f.status === "done" || f.status === "cancelled"
    );
  }

  if (toArchive.length === 0) {
    console.log("No features to archive.");
    return;
  }

  if (opts.dryRun) {
    console.log(`\nWould archive ${toArchive.length} feature(s):\n`);
    for (const f of toArchive) {
      console.log(`  ${f.id} — ${f.title} (${f.status})`);
    }
    return;
  }

  // Move features from active to archive
  const archiveIds = new Set(toArchive.map((f) => f.id));
  data.features = data.features.filter((f) => !archiveIds.has(f.id));
  data.archive.push(...toArchive);

  saveFeatures(projectRoot, config, data);

  console.log(`\nArchived ${toArchive.length} feature(s):`);
  for (const f of toArchive) {
    console.log(`  ${f.id} — ${f.title} (${f.status})`);
  }
}
