/**
 * features/add.ts — Add a new feature to the features file.
 *
 * Usage:
 *   wombo features add <id> --title "Feature Title" [--description "..."]
 *                      [--priority medium] [--difficulty easy] [--effort PT2H]
 *                      [--depends-on "feat1,feat2"]
 */

import type { WomboConfig } from "../../config.js";
import {
  loadFeatures,
  saveFeatures,
  createBlankFeature,
  allFeatureIds,
  type Priority,
  type Difficulty,
} from "../../lib/features.js";
import { outputError, outputMessage, type OutputFormat } from "../../lib/output.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeaturesAddOptions {
  projectRoot: string;
  config: WomboConfig;
  id: string;
  title: string;
  description?: string;
  priority?: Priority;
  difficulty?: Difficulty;
  effort?: string;
  dependsOn?: string[];
  outputFmt?: OutputFormat;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdFeaturesAdd(opts: FeaturesAddOptions): Promise<void> {
  const { projectRoot, config } = opts;
  const fmt = opts.outputFmt ?? "text";

  if (!opts.id) {
    outputError(fmt, "Usage: wombo features add <id> --title \"Feature Title\"");
    return;
  }

  if (!opts.title) {
    outputError(fmt, "--title is required when adding a feature.");
    return;
  }

  const data = loadFeatures(projectRoot, config);

  // Check for duplicate ID
  const existingIds = allFeatureIds(data);
  if (existingIds.includes(opts.id)) {
    outputError(fmt, `Feature ID "${opts.id}" already exists.`);
    return;
  }

  // Validate depends_on references
  if (opts.dependsOn?.length) {
    for (const dep of opts.dependsOn) {
      if (!existingIds.includes(dep)) {
        outputError(fmt, `Dependency "${dep}" does not exist in the features file.`);
        return;
      }
    }
  }

  // Create the feature
  const feature = createBlankFeature(opts.id, opts.title, opts.description ?? "", {
    priority: opts.priority,
    difficulty: opts.difficulty,
    effort: opts.effort,
  });

  // Set dependencies
  if (opts.dependsOn?.length) {
    feature.depends_on = opts.dependsOn;
  }

  // Dry-run: show what would be added without writing
  if (opts.dryRun) {
    outputMessage(fmt, `[dry-run] Would add feature: ${opts.id} — ${opts.title}`, {
      dry_run: true,
      id: feature.id,
      title: feature.title,
      priority: feature.priority,
      difficulty: feature.difficulty,
      effort: feature.effort,
      depends_on: feature.depends_on,
    });
    return;
  }

  // Append to features list
  data.features.push(feature);
  saveFeatures(projectRoot, config, data);

  outputMessage(fmt, `Added feature: ${opts.id} — ${opts.title}`, {
    id: feature.id,
    title: feature.title,
    priority: feature.priority,
    difficulty: feature.difficulty,
    effort: feature.effort,
    depends_on: feature.depends_on,
  });

  if (fmt === "text") {
    console.log(`  priority: ${feature.priority}, difficulty: ${feature.difficulty}, effort: ${feature.effort}`);
    if (feature.depends_on.length > 0) {
      console.log(`  depends on: ${feature.depends_on.join(", ")}`);
    }
  }
}
