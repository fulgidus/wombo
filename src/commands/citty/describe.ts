/**
 * describe.ts — Citty command definition for `woco describe`.
 *
 * Proof-of-concept citty command definition that replaces the
 * hand-rolled describe handling in index.ts. Supports:
 *   - `woco describe` — list all command schemas (JSON)
 *   - `woco describe <command>` — specific command schema (JSON)
 *   - `woco describe --output toon` — TOON legend format
 *   - `woco describe <command> --output toon` — specific command TOON spec
 */

import { defineCommand } from "citty";
import { resolve } from "node:path";
import {
  findCommandDef,
  commandToSchema,
  allCommandSchemas,
} from "../../lib/schema.js";
import { buildToonSpec, renderToonLegend } from "../../lib/toon-spec.js";

/**
 * Read the version string from package.json.
 */
async function getPackageVersion(): Promise<string> {
  const pkgPath = resolve(import.meta.dir, "../../..", "package.json");
  try {
    const pkg = await Bun.file(pkgPath).json();
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const describeCommand = defineCommand({
  meta: {
    name: "describe",
    description: "Emit JSON schema of a command's arguments and flags",
  },
  args: {
    command: {
      type: "positional",
      description: "Command to describe (e.g. 'launch', 'tasks add')",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: json (default) or toon",
      required: false,
    },
  },
  async run({ args }) {
    const outputFormat = args.output;
    const commandName = args.command;

    if (outputFormat === "toon") {
      const version = await getPackageVersion();

      if (!commandName) {
        // Full TOON spec legend
        console.log(renderToonLegend(version));
      } else {
        // JSON structure for a specific command in TOON mode
        const spec = buildToonSpec(version);
        const cmdSpec = spec.commands.find((c) => c.command === commandName);
        if (!cmdSpec) {
          console.error(
            `Unknown command: "${commandName}". Run 'woco describe --output toon' to see the full TOON spec.`
          );
          process.exit(1);
        }
        console.log(JSON.stringify(cmdSpec, null, 2));
      }
      return;
    }

    // Default: JSON output
    if (!commandName) {
      // List all commands
      console.log(JSON.stringify(allCommandSchemas(), null, 2));
    } else {
      // Describe a specific command
      const def = findCommandDef(commandName);
      if (!def) {
        console.error(
          `Unknown command: "${commandName}". Run 'woco describe' to list all commands.`
        );
        process.exit(1);
      }
      console.log(JSON.stringify(commandToSchema(def), null, 2));
    }
  },
});
