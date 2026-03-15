/**
 * init.ts — Interactive guided setup for .wombo-combo/config.json.
 *
 * Usage: woco init [--force]
 *
 * Renders a minimal Ink confirmation screen that:
 *   - Auto-detects project name from folder, base branch from git,
 *     build/install commands from package.json.
 *   - Shows all defaults with 3 editable fields (baseBranch,
 *     build.command, install.command).
 *   - On confirm, writes only essential files: config.json, tasks/, archive/.
 *   - Does NOT create runtime artifacts (logs/, history/), auto-install
 *     shell completions, or check dependencies inline.
 *
 * NOTE: The ink/init-app module is dynamically imported to avoid pulling
 * the `ink` dependency into the static import graph. The `ink` reconciler
 * contains a top-level await that breaks `require()` in schema.ts.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_FILE } from "../config";

export interface InitOptions {
  projectRoot: string;
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdInit(opts: InitOptions): Promise<void> {
  const configPath = resolve(opts.projectRoot, CONFIG_FILE);

  if (existsSync(configPath) && !opts.force) {
    console.error(
      `${CONFIG_FILE} already exists. Use --force to overwrite.`
    );
    process.exit(1);
  }

  // Dynamic import to avoid pulling `ink` into the static import graph.
  // See module-level comment for why this is necessary.
  const { renderInitApp } = await import("../ink/init-app");

  await renderInitApp({
    projectRoot: opts.projectRoot,
    force: opts.force ?? false,
  });
}
