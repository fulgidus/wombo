/**
 * schema-types.ts — Shared types for the command/flag registry.
 *
 * These types are extracted from schema.ts to avoid circular dependencies
 * between schema.ts ↔ citty-registry.ts ↔ citty-bridge.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlagDef {
  /** Primary flag name, e.g. "--dry-run" */
  name: string;
  /** Short alias, e.g. "-o" */
  alias?: string;
  /** Description shown in help / schema */
  description: string;
  /** Type of the value: "boolean" flags take no value, others consume next arg */
  type: "string" | "number" | "boolean" | "string[]";
  /** Default value (undefined = required or absent) */
  default?: unknown;
  /** For enum-like flags, the set of allowed values */
  enum?: readonly string[];
  /** If true, this flag is required */
  required?: boolean;
}

export interface PositionalDef {
  /** Name used in usage strings, e.g. "feature-id" */
  name: string;
  description: string;
  required?: boolean;
}

export interface CommandDef {
  /** Command name as typed by the user, e.g. "launch" or "list" */
  name: string;
  /** Short aliases for this command, e.g. ["i"] for init, ["lo"] for logs */
  aliases?: string[];
  /** One-line summary */
  summary: string;
  /** Shorter summary for shell completion menus (falls back to summary) */
  completionSummary?: string;
  /** Longer description */
  description?: string;
  /** Positional arguments */
  positionals: PositionalDef[];
  /** Named flags */
  flags: FlagDef[];
  /** Whether this command mutates state (used for dry-run indication) */
  mutating: boolean;
  /** Whether this command supports --dry-run */
  supportsDryRun: boolean;
  /** Subcommands (for "tasks" parent) */
  subcommands?: CommandDef[];
}

// ---------------------------------------------------------------------------
// Global flags (available on every command)
// ---------------------------------------------------------------------------

export const GLOBAL_FLAGS: FlagDef[] = [
  {
    name: "--output",
    alias: "-o",
    description: "Output format: text (default), json, or toon",
    type: "string",
    default: "text",
    enum: ["text", "json", "toon"],
  },
  {
    name: "--force",
    description: "Force overwrite / skip safety prompts",
    type: "boolean",
    default: false,
  },
];
