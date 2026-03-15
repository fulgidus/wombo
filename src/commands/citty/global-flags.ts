/**
 * global-flags.ts — Extracts global flags that can appear before the command.
 *
 * Global flags are flags that can appear anywhere in the argument list
 * (before or after the command). They are stripped from the args array
 * so the remaining args can be parsed normally.
 *
 * Supported global flags:
 *   --dev         Developer mode (boolean)
 *   --force       Force mode (boolean)
 *   --output <v>  Output format (string: "text" | "json" | "toon")
 *   -o <v>        Alias for --output
 *   -h / --help   Help request (boolean)
 */

import type { OutputFormat } from "../../lib/output.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GlobalFlags {
  /** Developer mode enabled */
  dev: boolean;
  /** Force mode enabled */
  force: boolean;
  /** Output format override (undefined = use default) */
  output?: OutputFormat;
  /** Help was requested */
  help: boolean;
}

export interface ExtractResult {
  /** Extracted global flags */
  flags: GlobalFlags;
  /** Remaining args with global flags stripped */
  remaining: string[];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract global flags from a raw argument array.
 *
 * Scans through the args, pulling out recognized global flags
 * and their values. Returns the extracted flags and the remaining
 * args (with global flags removed).
 *
 * @param args - Raw CLI arguments (after slicing off bun/script path)
 */
export function extractGlobalFlags(args: string[]): ExtractResult {
  const flags: GlobalFlags = {
    dev: false,
    force: false,
    help: false,
  };
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--dev":
        flags.dev = true;
        break;
      case "--force":
        flags.force = true;
        break;
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--output":
      case "-o": {
        // Consume the next argument as the output format value
        const next = args[i + 1];
        if (next && !next.startsWith("-")) {
          flags.output = next as OutputFormat;
          i++; // skip the value
        }
        // If no value follows, leave output undefined (will use default)
        break;
      }
      default:
        remaining.push(arg);
        break;
    }
  }

  return { flags, remaining };
}
