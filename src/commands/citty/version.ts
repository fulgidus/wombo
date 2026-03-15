/**
 * version.ts — Citty command definition for `woco version`.
 *
 * This is a proof-of-concept citty command definition that replaces the
 * hand-rolled version handling in index.ts. It demonstrates the pattern
 * for migrating commands to citty.
 */

import { defineCommand } from "citty";
import { resolve } from "node:path";

/**
 * Read the version string from package.json.
 * Uses the same resolution path as the original index.ts implementation.
 */
async function getPackageVersion(): Promise<string> {
  const pkgPath = resolve(import.meta.dir, "../../..", "package.json");
  try {
    const pkg = await Bun.file(pkgPath).json();
    return pkg.version ?? "(unknown version)";
  } catch {
    return "(unknown version)";
  }
}

export const versionCommand = defineCommand({
  meta: async () => {
    const version = await getPackageVersion();
    return {
      name: "version",
      version,
      description: "Print version and exit (also: -v, -V)",
    };
  },
  async run() {
    const version = await getPackageVersion();
    console.log(`wombo-combo ${version}`);
  },
});
