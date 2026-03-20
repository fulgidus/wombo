/**
 * usage.ts — Citty command definition for `woco usage`.
 *
 * Wraps the existing cmdUsage() with citty's defineCommand() for typed args.
 * Config-dependent: requires project initialization.
 */

import { defineCommand } from "citty";
import { loadConfig, validateConfig, isProjectInitialized } from "../../config";
import { resolveOutputFormat } from "../../lib/output";
import { cmdUsage, type UsageGroupBy, VALID_USAGE_GROUP_BY, VALID_EXPORT_FORMATS } from "../usage";
import type { ExportFormat } from "../../lib/analytics-export";

export const usageCommand = defineCommand({
  meta: {
    name: "usage",
    description: "Show token usage statistics",
  },
  args: {
    by: {
      type: "string",
      description: "Group by: task, model, provider, quest, or harness",
      required: false,
    },
    since: {
      type: "string",
      description: "Start of date range filter (ISO 8601)",
      required: false,
    },
    until: {
      type: "string",
      description: "End of date range filter (ISO 8601)",
      required: false,
    },
    format: {
      type: "string",
      description: "Usage output format: table (default) or json",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
    export: {
      type: "string",
      description: "Export format: csv, json, or html (writes to --export-file)",
      required: false,
    },
    "export-file": {
      type: "string",
      description: "Output file path for export (default: usage-export.<format>)",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = process.cwd();
    if (!isProjectInitialized(projectRoot)) {
      console.error("Project not initialized. Run 'woco init' first.");
      process.exit(1);
    }
    const config = loadConfig(projectRoot);
    validateConfig(config);

    // Validate --by value
    const by = args.by as UsageGroupBy | undefined;
    if (by && !VALID_USAGE_GROUP_BY.includes(by)) {
      console.error(`Invalid --by value: "${by}". Valid values: ${VALID_USAGE_GROUP_BY.join(", ")}`);
      process.exit(1);
    }

    // Validate --format value
    const usageFormat = (args.format === "json" ? "json" : "table") as "table" | "json";

    // Validate --export value
    const exportFmt = args.export as ExportFormat | undefined;
    if (exportFmt && !VALID_EXPORT_FORMATS.includes(exportFmt)) {
      console.error(`Invalid --export value: "${exportFmt}". Valid values: ${VALID_EXPORT_FORMATS.join(", ")}`);
      process.exit(1);
    }

    // Resolve export file path (use provided --export-file or default to usage-export.<format>)
    const exportFile = args["export-file"] ?? (exportFmt ? `usage-export.${exportFmt}` : undefined);

    await cmdUsage({
      projectRoot,
      config,
      by,
      since: args.since,
      until: args.until,
      usageFormat,
      outputFmt: resolveOutputFormat(args.output),
      export: exportFmt,
      exportFile,
    });
  },
});
