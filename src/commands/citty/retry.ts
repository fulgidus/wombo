/**
 * retry.ts — Citty command definition for `woco retry`.
 *
 * Parses all retry-related flags using citty's declarative args schema,
 * then delegates to the existing `cmdRetry()` implementation in
 * `src/commands/retry.ts`.
 *
 * Args:
 *   <feature-id>  — positional: ID of the failed agent to retry
 * Flags:
 *   --model/-m, --interactive, --dry-run, --output/-o
 */

import { defineCommand } from "citty";
import { resolve } from "node:path";
import { loadConfig, validateConfig, isProjectInitialized, WOMBO_DIR } from "../../config.js";
import { ensureTasksFile } from "../../lib/tasks.js";
import { resolveOutputFormat, outputError, type OutputFormat } from "../../lib/output.js";
import { cmdRetry, type RetryCommandOptions } from "../retry.js";

// ---------------------------------------------------------------------------
// Parsed retry args (intermediate representation before config merge)
// ---------------------------------------------------------------------------

export interface ParsedRetryArgs {
  featureId?: string;
  model?: string;
  interactive: boolean;
  dryRun: boolean;
  outputFmt?: OutputFormat;
}

/**
 * Parse raw citty args into a typed intermediate representation.
 *
 * Exported for testing — the citty `run()` handler calls this internally.
 */
export function parseRetryArgs(args: Record<string, any>): ParsedRetryArgs {
  return {
    featureId: args.featureId ?? undefined,
    model: args.model ?? undefined,
    interactive: args.interactive ?? false,
    dryRun: args.dryRun ?? false,
    outputFmt: args.output
      ? resolveOutputFormat(args.output)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Citty command definition
// ---------------------------------------------------------------------------

export const retryCommand = defineCommand({
  meta: {
    name: "retry",
    description: "Retry a specific failed agent (also: re)",
  },
  args: {
    featureId: {
      type: "positional",
      description: "Feature/task ID of the failed agent to retry",
      required: false,
    },
    model: {
      type: "string",
      alias: "m",
      description: "AI model to use for the retried agent",
      required: false,
    },
    interactive: {
      type: "boolean",
      description: "Launch agent in interactive (multiplexer) mode",
      required: false,
    },
    dryRun: {
      type: "boolean",
      description: "Show what would be retried without actually retrying",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text (default), json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = resolve(process.cwd());
    const parsed = parseRetryArgs(args);
    const fmt = parsed.outputFmt ?? "text";

    // Validate positional arg
    if (!parsed.featureId) {
      outputError(fmt, "Usage: woco retry <feature-id>");
      return;
    }

    // Load and validate config
    const config = loadConfig(projectRoot);
    validateConfig(config);

    // Guard: project must be initialized
    if (!isProjectInitialized(projectRoot)) {
      console.error(
        `\nThis project hasn't been initialized yet.\n` +
          `Run \`woco init\` to set up ${WOMBO_DIR}/ with config, tasks, and archive stores.\n`
      );
      process.exit(1);
    }

    // Ensure tasks file exists
    await ensureTasksFile(projectRoot, config);

    // Build RetryCommandOptions
    const opts: RetryCommandOptions = {
      projectRoot,
      config,
      featureId: parsed.featureId,
      model: parsed.model,
      interactive: parsed.interactive,
      dryRun: parsed.dryRun,
      outputFmt: parsed.outputFmt,
    };

    await cmdRetry(opts);
  },
});
