/**
 * tui-onboarding.ts — Onboarding wizard input parser for the wombo-combo TUI.
 *
 * Provides `structureRawInputs()`, a pure function that converts the raw text
 * collected by the onboarding wizard into a fully typed ProjectProfile.
 *
 * Each wizard step collects free-form text. This module parses that text into
 * structured data:
 *
 *   - **Objectives:** One per line, optionally prefixed with [high]/[medium]/[low].
 *   - **Tech stack:** Looks for "runtime:", "language:", "frameworks:", "tools:" patterns.
 *   - **Conventions:** Looks for "commits:", "branches:", "testing:", "coding_style:", "naming:" prefixes.
 *   - **Rules:** Each non-empty line becomes a ProjectRule with auto-generated ID.
 *
 * This is a pure function with no side effects — easy to test.
 */

import {
  createBlankProfile,
  type ProjectProfile,
  type ProjectObjective,
  type ProjectRule,
  type TechStack,
  type ProjectConventions,
} from "./project-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw text inputs collected from the onboarding wizard steps.
 * Each field is a free-form string that will be parsed into structured data.
 */
export interface RawInputs {
  /** Project name */
  name: string;
  /** Project description */
  description: string;
  /** "greenfield" or "brownfield" */
  type: string;
  /** Long-term vision statement */
  vision: string;
  /** Multi-line objectives, one per line, optionally prefixed with [high]/[medium]/[low] */
  objectives: string;
  /** Free-form tech stack text with optional "runtime:", "language:", etc. patterns */
  techStack: string;
  /** Free-form conventions text with optional "commits:", "branches:", etc. prefixes */
  conventions: string;
  /** Free-form rules text, one rule per line */
  rules: string;
}

// ---------------------------------------------------------------------------
// Internal parsers
// ---------------------------------------------------------------------------

/** Priority prefix regex: matches [high], [medium], [low] at the start of a line. */
const PRIORITY_RE = /^\s*\[(high|medium|low)\]\s*/i;

/**
 * Parse objectives from raw multi-line text.
 *
 * Each non-empty line is one objective. Lines may be optionally prefixed with
 * `[high]`, `[medium]`, or `[low]` to set priority (case-insensitive).
 * Default priority is "medium". IDs are sequential: obj-1, obj-2, ...
 */
function parseObjectives(raw: string): ProjectObjective[] {
  if (!raw || !raw.trim()) return [];

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const objectives: ProjectObjective[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    let priority: "high" | "medium" | "low" = "medium";

    const match = line.match(PRIORITY_RE);
    if (match) {
      priority = match[1].toLowerCase() as "high" | "medium" | "low";
      line = line.slice(match[0].length).trim();
    }

    if (!line) continue;

    objectives.push({
      id: `obj-${objectives.length + 1}`,
      text: line,
      priority,
      status: "pending",
      quest_ids: [],
    });
  }

  return objectives;
}

/**
 * Known tech stack field patterns.
 * Matches lines like "runtime: Bun", "frameworks: React, Vue, Svelte", etc.
 */
const TECH_STACK_RE =
  /^\s*(runtime|language|frameworks|tools)\s*:\s*(.+)$/i;

/**
 * Parse tech stack from free-form text.
 *
 * Looks for patterns like:
 *   - `runtime: Bun`
 *   - `language: TypeScript (strict, ESM)`
 *   - `frameworks: React, Vue, Svelte`
 *   - `tools: eslint, prettier`
 *
 * Lines that don't match any known pattern are collected into `notes`.
 */
function parseTechStack(raw: string): TechStack {
  const result: TechStack = {
    runtime: "",
    language: "",
    frameworks: [],
    tools: [],
    notes: "",
  };

  if (!raw || !raw.trim()) return result;

  const noteLines: string[] = [];
  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(TECH_STACK_RE);
    if (match) {
      const field = match[1].toLowerCase();
      const value = match[2].trim();

      switch (field) {
        case "runtime":
          result.runtime = value;
          break;
        case "language":
          result.language = value;
          break;
        case "frameworks":
          result.frameworks = value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          break;
        case "tools":
          result.tools = value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          break;
      }
    } else {
      noteLines.push(trimmed);
    }
  }

  result.notes = noteLines.join("\n");
  return result;
}

/**
 * Known conventions field prefixes.
 * Matches lines like "commits: conventional with scope", "testing: bun test", etc.
 */
const CONVENTIONS_RE =
  /^\s*(commits|branches|testing|coding_style|naming)\s*:\s*(.+)$/i;

/**
 * Parse conventions from free-form text.
 *
 * Looks for lines prefixed with:
 *   - `commits:`
 *   - `branches:`
 *   - `testing:`
 *   - `coding_style:`
 *   - `naming:`
 *
 * Unmatched text goes into `coding_style`.
 */
function parseConventions(raw: string): ProjectConventions {
  const result: ProjectConventions = {
    commits: "",
    branches: "",
    testing: "",
    coding_style: "",
    naming: "",
  };

  if (!raw || !raw.trim()) return result;

  const unmatchedLines: string[] = [];
  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(CONVENTIONS_RE);
    if (match) {
      const field = match[1].toLowerCase();
      const value = match[2].trim();

      switch (field) {
        case "commits":
          result.commits = value;
          break;
        case "branches":
          result.branches = value;
          break;
        case "testing":
          result.testing = value;
          break;
        case "coding_style":
          result.coding_style = value;
          break;
        case "naming":
          result.naming = value;
          break;
      }
    } else {
      unmatchedLines.push(trimmed);
    }
  }

  // Unmatched text appended to coding_style
  if (unmatchedLines.length > 0) {
    const extra = unmatchedLines.join("\n");
    result.coding_style = result.coding_style
      ? `${result.coding_style}\n${extra}`
      : extra;
  }

  return result;
}

/**
 * Parse rules from free-form text.
 *
 * Each non-empty line becomes a ProjectRule with:
 *   - Auto-generated sequential ID: rule-1, rule-2, ...
 *   - Rigidity defaults to "soft"
 *   - Scope defaults to "general"
 *   - Empty consequences, tags, and no hooks
 */
function parseRules(raw: string): ProjectRule[] {
  if (!raw || !raw.trim()) return [];

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const rules: ProjectRule[] = [];

  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;

    rules.push({
      id: `rule-${rules.length + 1}`,
      text,
      scope: "general",
      rigidity: "soft",
      consequences: "",
      tags: [],
    });
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert raw text inputs from the onboarding wizard into a full ProjectProfile.
 *
 * This is a **pure function** with no side effects — it does not read or write
 * files, and it does not depend on any external state. The only non-deterministic
 * aspect is the timestamps (created_at / updated_at) which are set to "now".
 *
 * @param raw — The raw text inputs collected from each wizard step.
 * @returns A fully populated ProjectProfile ready to be saved.
 */
export function structureRawInputs(raw: RawInputs): ProjectProfile {
  const profile = createBlankProfile(raw.name.trim() || undefined);

  // Identity
  profile.description = raw.description.trim();
  profile.type =
    raw.type.trim().toLowerCase() === "greenfield"
      ? "greenfield"
      : "brownfield";
  profile.vision = raw.vision.trim();

  // Objectives
  profile.objectives = parseObjectives(raw.objectives);

  // Tech stack
  profile.tech_stack = parseTechStack(raw.techStack);

  // Conventions
  profile.conventions = parseConventions(raw.conventions);

  // Rules
  profile.rules = parseRules(raw.rules);

  // Metadata — created_at/updated_at already set by createBlankProfile()
  // genesis_count already defaults to 0 from createBlankProfile()

  return profile;
}
