/**
 * resume.ts — Citty command definition for `woco resume`.
 *
 * Parses all resume-related flags using citty's declarative args schema,
 * then delegates to the existing `cmdResume()` implementation in
 * `src/commands/resume.ts`.
 *
 * Flags:
 *   --max-concurrent, --model/-m, --interactive, --no-tui, --auto-push,
 *   --base-branch, --max-retries, --output/-o
 */

import { defineCommand } from "citty";
import { resolve } from "node:path";
import { loadConfig, validateConfig, isProjectInitialized, WOMBO_DIR } from "../../config.js";
import { ensureTasksFile } from "../../lib/tasks.js";
import { resolveOutputFormat, type OutputFormat } from "../../lib/output.js";
import { cmdResume, type ResumeCommandOptions } from "../resume.js";

// ---------------------------------------------------------------------------
// Parsed resume args (intermediate representation before config merge)
// ---------------------------------------------------------------------------

export interface ParsedResumeArgs {
  maxConcurrent?: number;
  model?: string;
  interactive: boolean;
  noTui: boolean;
  autoPush: boolean;
  baseBranch?: string;
  maxRetries?: number;
  outputFmt?: OutputFormat;
}

/**
 * Parse raw citty args into a typed intermediate representation.
 *
 * Exported for testing — the citty `run()` handler calls this internally.
 */
export function parseResumeArgs(args: Record<string, any>): ParsedResumeArgs {
  return {
    maxConcurrent: args.maxConcurrent
      ? parseInt(args.maxConcurrent, 10)
      : undefined,
    model: args.model ?? undefined,
    interactive: args.interactive ?? false,
    noTui: args.noTui ?? false,
    autoPush: args.autoPush ?? false,
    baseBranch: args.baseBranch ?? undefined,
    maxRetries: args.maxRetries
      ? parseInt(args.maxRetries, 10)
      : undefined,
    outputFmt: args.output
      ? resolveOutputFormat(args.output)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Citty command definition
// ---------------------------------------------------------------------------

export const resumeCommand = defineCommand({
  meta: {
    name: "resume",
    description: "Resume a previously stopped wave (also: r)",
  },
  args: {
    maxConcurrent: {
      type: "string",
      description: "Maximum number of concurrent agents",
      required: false,
    },
    model: {
      type: "string",
      alias: "m",
      description: "AI model to use for agents",
      required: false,
    },
    interactive: {
      type: "boolean",
      description: "Launch agents in interactive (multiplexer) mode",
      required: false,
    },
    noTui: {
      type: "boolean",
      description: "Disable TUI dashboard, use plain console output",
      required: false,
    },
    autoPush: {
      type: "boolean",
      description: "Automatically push branches after merge",
      required: false,
    },
    baseBranch: {
      type: "string",
      description: "Base branch to create feature branches from",
      required: false,
    },
    maxRetries: {
      type: "string",
      description: "Maximum number of retries per agent",
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
    const parsed = parseResumeArgs(args);

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

    // Build ResumeCommandOptions, merging parsed args with config defaults
    const opts: ResumeCommandOptions = {
      projectRoot,
      config,
      maxConcurrent: parsed.maxConcurrent,
      model: parsed.model,
      interactive: parsed.interactive,
      noTui: parsed.noTui,
      autoPush: parsed.autoPush,
      baseBranch: parsed.baseBranch,
      maxRetries: parsed.maxRetries,
      outputFmt: parsed.outputFmt,
    };

    await cmdResume(opts);
  },
});
