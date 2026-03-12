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
import { outputError, outputMessage, type OutputFormat } from "../../lib/output.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeaturesArchiveOptions {
  projectRoot: string;
  config: WomboConfig;
  featureId?: string;
  dryRun?: boolean;
  outputFmt?: OutputFormat;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdFeaturesArchive(opts: FeaturesArchiveOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

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
        outputMessage(fmt, `Feature "${opts.featureId}" is already in the archive.`, {
          already_archived: true,
          id: opts.featureId,
        });
        return;
      }
      outputError(fmt, `Feature "${opts.featureId}" not found.`);
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
    outputMessage(fmt, "No features to archive.", { count: 0 });
    return;
  }

  if (opts.dryRun) {
    outputMessage(fmt, `Would archive ${toArchive.length} feature(s)`, {
      dry_run: true,
      count: toArchive.length,
      features: toArchive.map((f) => ({ id: f.id, title: f.title, status: f.status })),
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
  data.features = data.features.filter((f) => !archiveIds.has(f.id));
  data.archive.push(...toArchive);

  saveFeatures(projectRoot, config, data);

  outputMessage(fmt, `Archived ${toArchive.length} feature(s)`, {
    count: toArchive.length,
    features: toArchive.map((f) => ({ id: f.id, title: f.title, status: f.status })),
  });
  if (fmt === "text") {
    for (const f of toArchive) {
      console.log(`  ${f.id} — ${f.title} (${f.status})`);
    }
  }
}
