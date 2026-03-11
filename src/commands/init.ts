/**
 * init.ts — Generate wombo.json in the target project root.
 *
 * Usage: wombo init [--force]
 *
 * Creates a wombo.json with sensible defaults. Refuses to overwrite
 * an existing config unless --force is passed.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_FILE, generateDefaultConfig } from "../config.js";

export interface InitOptions {
  projectRoot: string;
  force?: boolean;
}

export async function cmdInit(opts: InitOptions): Promise<void> {
  const configPath = resolve(opts.projectRoot, CONFIG_FILE);

  if (existsSync(configPath) && !opts.force) {
    console.error(
      `${CONFIG_FILE} already exists. Use --force to overwrite.`
    );
    process.exit(1);
  }

  writeFileSync(configPath, generateDefaultConfig(), "utf-8");
  console.log(`Created ${CONFIG_FILE} in ${opts.projectRoot}`);
  console.log("Edit it to match your project's build, install, and git settings.");
}
