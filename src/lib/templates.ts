/**
 * templates.ts — Resolve paths to bundled template files.
 *
 * All template paths are resolved relative to the source file location
 * using import.meta.dir (Bun-specific). This ensures templates are found
 * whether running from source (bun dev) or from an installed package.
 */

import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Template Paths
// ---------------------------------------------------------------------------

/**
 * Absolute path to the bundled wave-worker agent definition template.
 * Used by `wombo init` to install the agent definition into the project,
 * and by `wombo launch` to reinstall it if missing.
 */
export const AGENT_TEMPLATE_PATH = join(dirname(import.meta.dir), "templates", "wave-worker.md");
