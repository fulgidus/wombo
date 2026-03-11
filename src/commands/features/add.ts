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
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdFeaturesAdd(opts: FeaturesAddOptions): Promise<void> {
  const { projectRoot, config } = opts;

  if (!opts.id) {
    console.error("Usage: wombo features add <id> --title \"Feature Title\"");
    process.exit(1);
    return;
  }

  if (!opts.title) {
    console.error("--title is required when adding a feature.");
    process.exit(1);
    return;
  }

  const data = loadFeatures(projectRoot, config);

  // Check for duplicate ID
  const existingIds = allFeatureIds(data);
  if (existingIds.includes(opts.id)) {
    console.error(`Feature ID "${opts.id}" already exists.`);
    process.exit(1);
    return;
  }

  // Validate depends_on references
  if (opts.dependsOn?.length) {
    for (const dep of opts.dependsOn) {
      if (!existingIds.includes(dep)) {
        console.error(`Dependency "${dep}" does not exist in the features file.`);
        process.exit(1);
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

  // Append to features list
  data.features.push(feature);
  saveFeatures(projectRoot, config, data);

  console.log(`Added feature: ${opts.id} — ${opts.title}`);
  console.log(`  priority: ${feature.priority}, difficulty: ${feature.difficulty}, effort: ${feature.effort}`);
  if (feature.depends_on.length > 0) {
    console.log(`  depends on: ${feature.depends_on.join(", ")}`);
  }
}
