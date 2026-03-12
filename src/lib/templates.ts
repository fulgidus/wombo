/**
 * templates.ts — Resolve paths to bundled template files and install helpers.
 *
 * All template paths are resolved relative to the source file location
 * using import.meta.dir (Bun-specific). This ensures templates are found
 * whether running from source (bun dev) or from an installed package.
 */

import { join, dirname, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { WomboConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Template Paths
// ---------------------------------------------------------------------------

/**
 * Absolute path to the bundled wave-worker agent definition template.
 * Used by `wombo init` to install the agent definition into the project,
 * and by `wombo launch` to reinstall it if missing.
 */
export const AGENT_TEMPLATE_PATH = join(dirname(import.meta.dir), "templates", "wave-worker.md");

// ---------------------------------------------------------------------------
// Template Rendering
// ---------------------------------------------------------------------------

/**
 * Default runtime description used when no project-specific value is available.
 */
const DEFAULT_RUNTIME = "Bun (not Node). TypeScript, strict mode, ESM only.";

/**
 * Render the agent template by replacing {{placeholders}} with config values.
 *
 * Supported placeholders:
 *   - {{featuresFile}}  — path to the features YAML file (e.g. ".features.yml")
 *   - {{branchPrefix}}  — git branch prefix (e.g. "feature/")
 *   - {{buildCommand}}  — build command (e.g. "bun run build")
 *   - {{runtime}}       — project runtime description
 *   - {{project}}       — project directory name
 */
export function renderAgentTemplate(
  config: WomboConfig,
  projectRoot: string
): string {
  const raw = readFileSync(AGENT_TEMPLATE_PATH, "utf-8");
  const projectName = projectRoot.split("/").pop() ?? "project";

  return raw
    .replace(/\{\{featuresFile\}\}/g, config.featuresFile)
    .replace(/\{\{branchPrefix\}\}/g, config.git.branchPrefix)
    .replace(/\{\{buildCommand\}\}/g, config.build.command)
    .replace(/\{\{runtime\}\}/g, DEFAULT_RUNTIME)
    .replace(/\{\{project\}\}/g, projectName);
}

// ---------------------------------------------------------------------------
// Agent Definition Guard
// ---------------------------------------------------------------------------

/**
 * Ensure the agent definition file exists at the expected path.
 * If missing, reinstall from the bundled template and warn the user.
 *
 * Called at the start of `wombo launch` to prevent the failure mode where
 * agents spawn without their agent definition file.
 *
 * @returns true if the file was reinstalled, false if it already existed.
 */
export function ensureAgentDefinition(
  projectRoot: string,
  config: WomboConfig
): boolean {
  const agentDir = resolve(projectRoot, "agent");
  const agentDefPath = resolve(agentDir, `${config.agent.name}.md`);

  if (existsSync(agentDefPath)) {
    return false;
  }

  // Agent definition missing — reinstall from bundled template
  console.warn(
    `\x1b[33m[WARNING]\x1b[0m Agent definition not found: agent/${config.agent.name}.md`
  );
  console.warn(`  Reinstalling from bundled template...`);

  try {
    mkdirSync(agentDir, { recursive: true });
    const content = renderAgentTemplate(config, projectRoot);
    writeFileSync(agentDefPath, content, "utf-8");
    console.warn(`  Restored agent/${config.agent.name}.md\n`);
    return true;
  } catch (err: any) {
    console.error(
      `  Failed to restore agent definition: ${err.message}`
    );
    console.error(
      `  Agents may launch without their definition file.\n`
    );
    return false;
  }
}
