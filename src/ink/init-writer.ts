/**
 * init-writer.ts — Write the initial wombo-combo project files.
 *
 * Creates only the essential files:
 *   - .wombo-combo/config.json — project configuration
 *   - .wombo-combo/tasks/_meta.yml — tasks folder store
 *   - .wombo-combo/archive/_meta.yml — archive folder store
 *
 * Does NOT create runtime artifacts (logs/, history/) — those are
 * created on demand by the runtime. This aligns with the principle
 * that init should only create tracked project files.
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { WOMBO_DIR, DEFAULT_CONFIG, type WomboConfig } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal config values collected from the init form.
 * Everything else inherits from DEFAULT_CONFIG.
 */
export interface InitWriterConfig {
  baseBranch: string;
  buildCommand: string;
  installCommand: string;
}

/**
 * Result of writing init files.
 */
export interface InitWriterResult {
  /** List of relative paths of files/dirs that were created. */
  createdFiles: string[];
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Write the essential wombo-combo project files.
 *
 * @param projectRoot — absolute path to the project root
 * @param config — values collected from the init form
 * @param force — if true, overwrite existing files
 * @returns result with list of created files
 * @throws if config.json already exists and force is false
 */
export function writeInitFiles(
  projectRoot: string,
  config: InitWriterConfig,
  force: boolean,
): InitWriterResult {
  const womboDir = resolve(projectRoot, WOMBO_DIR);
  const configPath = resolve(womboDir, "config.json");
  const createdFiles: string[] = [];

  // Check for existing config
  if (existsSync(configPath) && !force) {
    throw new Error(
      `${WOMBO_DIR}/config.json already exists. Use --force to overwrite.`
    );
  }

  // Ensure .wombo-combo/ directory exists
  if (!existsSync(womboDir)) {
    mkdirSync(womboDir, { recursive: true });
  }

  // 1. Build full config from defaults + user values
  const fullConfig: WomboConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    baseBranch: config.baseBranch,
    build: {
      ...DEFAULT_CONFIG.build,
      command: config.buildCommand,
    },
    install: {
      ...DEFAULT_CONFIG.install,
      command: config.installCommand,
    },
  };

  // 2. Write config.json
  const json = JSON.stringify(fullConfig, null, 2) + "\n";
  writeFileSync(configPath, json, "utf-8");
  createdFiles.push(`${WOMBO_DIR}/config.json`);

  // 3. Write tasks/ folder store
  const now = new Date().toISOString();
  const projectName = projectRoot.split("/").pop() ?? "project";
  const tasksDirPath = resolve(womboDir, fullConfig.tasksDir);

  if (!existsSync(tasksDirPath) || force) {
    mkdirSync(tasksDirPath, { recursive: true });
    const metaContent = stringifyYaml(
      {
        version: "1.0",
        meta: {
          created_at: now,
          updated_at: now,
          project: projectName,
          generator: "wombo-combo",
          maintainer: "user",
        },
      },
      { lineWidth: 120 },
    );
    writeFileSync(resolve(tasksDirPath, "_meta.yml"), metaContent, "utf-8");
    createdFiles.push(`${WOMBO_DIR}/${fullConfig.tasksDir}/`);
  }

  // 4. Write archive/ folder store
  const archiveDirPath = resolve(womboDir, fullConfig.archiveDir);

  if (!existsSync(archiveDirPath) || force) {
    mkdirSync(archiveDirPath, { recursive: true });
    const archiveMeta = stringifyYaml(
      {
        version: "1.0",
        meta: {
          created_at: now,
          updated_at: now,
          project: projectName,
          generator: "wombo-combo",
          maintainer: "user",
        },
      },
      { lineWidth: 120 },
    );
    writeFileSync(resolve(archiveDirPath, "_meta.yml"), archiveMeta, "utf-8");
    createdFiles.push(`${WOMBO_DIR}/${fullConfig.archiveDir}/`);
  }

  return { createdFiles };
}
