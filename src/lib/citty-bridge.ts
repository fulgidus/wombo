/**
 * citty-bridge.ts — Bridge between citty command definitions and schema.ts types.
 *
 * Reads citty's declarative `defineCommand()` metadata (args, meta) and
 * produces `CommandDef` objects compatible with the existing schema
 * introspection layer. This eliminates the dual-maintenance problem:
 * citty definitions become the single source of truth for command metadata.
 *
 * The bridge handles:
 *   - Converting citty arg specs to FlagDef / PositionalDef
 *   - camelCase → kebab-case conversion for flag names
 *   - Filtering out global flags (output, dev, force) that are already
 *     handled by GLOBAL_FLAGS in schema.ts
 *   - Applying extended metadata (aliases, mutating, supportsDryRun, etc.)
 *     that citty doesn't natively support
 */

import type { CommandDef as CittyCommandDef } from "citty";
import type { CommandDef, FlagDef, PositionalDef } from "./schema.js";

// ---------------------------------------------------------------------------
// Extended metadata for citty commands (wombo-specific fields)
// ---------------------------------------------------------------------------

/**
 * Per-flag overrides that can't be expressed in citty's arg spec.
 * Allows setting defaults, enums, type refinements, and other schema
 * properties that citty doesn't support natively.
 */
export interface FlagOverride {
  /** Override the type (e.g. "number" for citty "string" args that are parsed as numbers) */
  type?: FlagDef["type"];
  /** Default value */
  default?: unknown;
  /** Allowed values */
  enum?: readonly string[];
  /** Mark as required */
  required?: boolean;
  /** Override the flag name (e.g. for aliased flags like --tasks/--features) */
  name?: string;
  /** Override the alias */
  alias?: string;
  /** Override the description */
  description?: string;
}

/**
 * Wombo-specific metadata for a citty command.
 * This fills in the gaps that citty's `defineCommand()` doesn't cover.
 */
export interface BridgeCommandMeta {
  /** Short aliases (e.g. ["i"] for init, ["lo"] for logs) */
  aliases?: string[];
  /** Whether this command mutates state */
  mutating: boolean;
  /** Whether this command supports --dry-run */
  supportsDryRun: boolean;
  /** Shorter summary for shell completion menus */
  completionSummary?: string;
  /** Extended description (longer than meta.description) */
  description?: string;
  /** Per-flag overrides keyed by citty arg name (camelCase) */
  flagOverrides?: Record<string, FlagOverride>;
  /** Per-positional overrides keyed by citty arg name (camelCase) */
  positionalOverrides?: Record<string, Partial<PositionalDef>>;
}

// ---------------------------------------------------------------------------
// Global flag names that should be filtered from per-command flag lists
// ---------------------------------------------------------------------------

/**
 * Citty arg names (camelCase) that correspond to global flags.
 * These are handled by GLOBAL_FLAGS in schema.ts and should not
 * appear in per-command flag lists.
 */
const GLOBAL_FLAG_NAMES = new Set(["output", "dev", "force"]);

// ---------------------------------------------------------------------------
// camelCase → kebab-case conversion
// ---------------------------------------------------------------------------

/**
 * Convert a camelCase string to kebab-case.
 * e.g. "topPriority" → "top-priority", "dryRun" → "dry-run"
 */
export function camelToKebab(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

// ---------------------------------------------------------------------------
// Single arg conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single citty arg definition to a FlagDef.
 * Returns null for positional args (which are handled separately).
 */
export function cittyArgToFlagDef(
  argName: string,
  argSpec: Record<string, unknown>,
  override?: FlagOverride,
): FlagDef | null {
  // Positional args aren't flags
  if (argSpec.type === "positional") return null;

  const kebabName = override?.name
    ? override.name
    : `--${camelToKebab(argName)}`;

  const type = override?.type ?? (argSpec.type as FlagDef["type"]) ?? "string";
  const alias = override?.alias ?? (argSpec.alias ? `-${argSpec.alias}` : undefined);
  const description = override?.description ?? (argSpec.description as string) ?? "";

  const flag: FlagDef = {
    name: kebabName,
    description,
    type,
  };

  if (alias !== undefined) flag.alias = alias;
  if (override?.required !== undefined) flag.required = override.required;
  if (override?.default !== undefined) flag.default = override.default;
  if (override?.enum !== undefined) flag.enum = override.enum;

  return flag;
}

/**
 * Convert a single citty positional arg to a PositionalDef.
 * Returns null for non-positional args.
 */
export function cittyArgToPositionalDef(
  argName: string,
  argSpec: Record<string, unknown>,
  override?: Partial<PositionalDef>,
): PositionalDef | null {
  if (argSpec.type !== "positional") return null;

  return {
    name: override?.name ?? camelToKebab(argName),
    description: override?.description ?? (argSpec.description as string) ?? "",
    required: override?.required ?? (argSpec.required as boolean) ?? false,
  };
}

// ---------------------------------------------------------------------------
// Full command conversion
// ---------------------------------------------------------------------------

/**
 * Convert a citty command definition + extended metadata into a CommandDef.
 *
 * @param cittyCmd - The citty command (from defineCommand())
 * @param meta - Wombo-specific metadata for this command
 */
export function cittyCommandToCommandDef(
  cittyCmd: CittyCommandDef,
  meta: BridgeCommandMeta,
): CommandDef {
  // citty meta can be a plain object, a function, or a Promise.
  // For the bridge we only support plain objects (all our commands use them).
  const rawMeta = cittyCmd.meta;
  const cmdMeta = (rawMeta && typeof rawMeta === "object" && !("then" in rawMeta))
    ? rawMeta as { name?: string; description?: string }
    : { name: "unknown", description: "" };

  const name = cmdMeta.name ?? "unknown";
  const summary = cmdMeta.description ?? "";

  // Extract args from citty command
  const args = cittyCmd.args ?? {};

  // Build positionals
  const positionals: PositionalDef[] = [];
  for (const [argName, argSpec] of Object.entries(args)) {
    const spec = argSpec as Record<string, unknown>;
    if (spec.type !== "positional") continue;
    const pos = cittyArgToPositionalDef(
      argName,
      spec,
      meta.positionalOverrides?.[argName],
    );
    if (pos) positionals.push(pos);
  }

  // Build flags (filtering out globals)
  const flags: FlagDef[] = [];
  for (const [argName, argSpec] of Object.entries(args)) {
    const spec = argSpec as Record<string, unknown>;
    if (spec.type === "positional") continue;
    if (GLOBAL_FLAG_NAMES.has(argName)) continue;

    const flag = cittyArgToFlagDef(argName, spec, meta.flagOverrides?.[argName]);
    if (flag) flags.push(flag);
  }

  const result: CommandDef = {
    name,
    summary,
    positionals,
    flags,
    mutating: meta.mutating,
    supportsDryRun: meta.supportsDryRun,
  };

  if (meta.aliases?.length) result.aliases = meta.aliases;
  if (meta.completionSummary) result.completionSummary = meta.completionSummary;
  if (meta.description) result.description = meta.description;

  return result;
}
