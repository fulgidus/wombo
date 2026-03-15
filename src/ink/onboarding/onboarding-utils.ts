/**
 * onboarding-utils.ts — Pure utility functions for the Ink onboarding wizard.
 *
 * Extracted from tui-onboarding.ts — these are all pure functions with no
 * UI dependency. They parse raw user input text into structured ProjectProfile
 * data and serialize profile sections for editing and display.
 *
 * Functions:
 *   - parseObjectives — parse "[priority] text" lines into ProjectObjective[]
 *   - parseTechStack — parse "field: value" lines into TechStack
 *   - parseConventions — parse "field: value" lines into ProjectConventions
 *   - parseRules — parse plain lines into ProjectRule[]
 *   - parseRulesRich — parse "[rigidity] scope: text" lines into ProjectRule[]
 *   - structureRawInputs — convert RawInputs into a full ProjectProfile
 *   - serializeSectionForEdit — serialize a section as editable text
 *   - parseSectionEdit — parse edited text back into profile data
 *   - formatSectionForDisplay — format a section as readable plain text
 *   - summarizeSection — one-line summary of a section for menus
 */

import {
  createBlankProfile,
  PROFILE_SECTIONS,
  type ProfileSection,
  type ProjectProfile,
  type ProjectObjective,
  type ProjectRule,
  type RuleRigidity,
  type TechStack,
  type ProjectConventions,
} from "../../lib/project-store";

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
// Step definitions for the collectInputs wizard
// ---------------------------------------------------------------------------

/**
 * Step definitions for the collectInputs wizard.
 * Each step collects one field of RawInputs.
 */
export interface InputStep {
  /** RawInputs field this step populates */
  field: keyof RawInputs;
  /** Step header label */
  label: string;
  /** Prompt text shown below the label */
  prompt: string;
  /** Whether this step uses a textarea (multi-line) instead of a textbox */
  multiline?: boolean;
  /** Whether this step uses a selection list instead of text input */
  selection?: boolean;
  /** Selection list items (labels for display) */
  selectionItems?: string[];
  /** Whether the field can be left empty */
  optional?: boolean;
}

export const INPUT_STEPS: InputStep[] = [
  {
    field: "type",
    label: "Project Type",
    prompt: "Is this a new project or an existing codebase?",
    selection: true,
    selectionItems: [
      "brownfield — Existing codebase (will auto-scan)",
      "greenfield — New project from scratch",
    ],
  },
  {
    field: "name",
    label: "Project Name",
    prompt: "What is the name of this project?",
  },
  {
    field: "description",
    label: "Project Description",
    prompt: "Brief description of the project (optional)",
    optional: true,
  },
  {
    field: "vision",
    label: "Vision",
    prompt: "What is the long-term vision for this project? (optional)",
    multiline: true,
    optional: true,
  },
  {
    field: "objectives",
    label: "Objectives",
    prompt:
      "List your project objectives, one per line.\nOptionally prefix with [high], [medium], or [low] for priority.",
    multiline: true,
    optional: true,
  },
  {
    field: "techStack",
    label: "Tech Stack",
    prompt:
      'Describe your tech stack.\nUse "runtime:", "language:", "frameworks:", "tools:" prefixes.',
    multiline: true,
    optional: true,
  },
  {
    field: "conventions",
    label: "Conventions",
    prompt:
      'Describe your project conventions.\nUse "commits:", "branches:", "testing:", "coding_style:", "naming:" prefixes.',
    multiline: true,
    optional: true,
  },
  {
    field: "rules",
    label: "Rules",
    prompt: "List your project rules, one per line. (optional)",
    multiline: true,
    optional: true,
  },
];

// ---------------------------------------------------------------------------
// Section names
// ---------------------------------------------------------------------------

/** Human-friendly names for each profile section. */
export const SECTION_NAMES: Record<ProfileSection, string> = {
  identity: "Identity",
  vision: "Vision",
  objectives: "Objectives",
  tech_stack: "Tech Stack",
  conventions: "Conventions",
  rules: "Rules",
};

// ---------------------------------------------------------------------------
// Parsers
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
export function parseObjectives(raw: string): ProjectObjective[] {
  if (!raw || !raw.trim()) return [];

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const objectives: ProjectObjective[] = [];

  for (const rawLine of lines) {
    let line = rawLine.trim();
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
export function parseTechStack(raw: string): TechStack {
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
export function parseConventions(raw: string): ProjectConventions {
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
export function parseRules(raw: string): ProjectRule[] {
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

/**
 * Parse rules from text that may include rigidity and scope.
 *
 * Supports the richer format produced by serializeSectionForEdit:
 *   [hard] runtime: Always use Bun (consequences: build breaks)
 *   [soft] general: Keep dependencies minimal
 *
 * Falls back to plain parseRules() if the format doesn't match.
 */
export function parseRulesRich(raw: string): ProjectRule[] {
  if (!raw || !raw.trim()) return [];

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const rules: ProjectRule[] = [];

  const RICH_RULE_RE =
    /^\s*\[(hard|soft|preference)\]\s+([^:]+):\s*(.+?)(?:\s*\(consequences:\s*(.+?)\)\s*)?$/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(RICH_RULE_RE);
    if (match) {
      const rigidity = match[1].toLowerCase() as RuleRigidity;
      const scope = match[2].trim();
      const text = match[3].trim();
      const consequences = match[4]?.trim() ?? "";

      rules.push({
        id: `rule-${rules.length + 1}`,
        text,
        scope,
        rigidity,
        consequences,
        tags: [],
      });
    } else {
      // Plain text fallback
      rules.push({
        id: `rule-${rules.length + 1}`,
        text: trimmed,
        scope: "general",
        rigidity: "soft",
        consequences: "",
        tags: [],
      });
    }
  }

  return rules;
}

// ---------------------------------------------------------------------------
// structureRawInputs
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

  return profile;
}

// ---------------------------------------------------------------------------
// Section serialization / deserialization (for edit mode)
// ---------------------------------------------------------------------------

/**
 * Serialize a section of the profile as editable plain text.
 * The user edits this in a TextInput and the result is parsed back.
 */
export function serializeSectionForEdit(
  section: ProfileSection,
  profile: ProjectProfile,
): string {
  switch (section) {
    case "identity": {
      const lines: string[] = [];
      lines.push(`name: ${profile.name}`);
      lines.push(`type: ${profile.type}`);
      lines.push(`description: ${profile.description}`);
      return lines.join("\n");
    }

    case "vision": {
      return profile.vision;
    }

    case "objectives": {
      if (profile.objectives.length === 0) return "";
      return profile.objectives
        .map((obj) => `[${obj.priority}] ${obj.text}`)
        .join("\n");
    }

    case "tech_stack": {
      const ts = profile.tech_stack;
      const lines: string[] = [];
      lines.push(`runtime: ${ts.runtime}`);
      lines.push(`language: ${ts.language}`);
      lines.push(`frameworks: ${ts.frameworks.join(", ")}`);
      lines.push(`tools: ${ts.tools.join(", ")}`);
      if (ts.notes) lines.push(`notes: ${ts.notes}`);
      return lines.join("\n");
    }

    case "conventions": {
      const conv = profile.conventions;
      const lines: string[] = [];
      lines.push(`commits: ${conv.commits}`);
      lines.push(`branches: ${conv.branches}`);
      lines.push(`testing: ${conv.testing}`);
      lines.push(`coding_style: ${conv.coding_style}`);
      lines.push(`naming: ${conv.naming}`);
      return lines.join("\n");
    }

    case "rules": {
      if (profile.rules.length === 0) return "";
      return profile.rules
        .map((rule) => {
          let line = `[${rule.rigidity}] ${rule.scope}: ${rule.text}`;
          if (rule.consequences)
            line += ` (consequences: ${rule.consequences})`;
          return line;
        })
        .join("\n");
    }
  }
}

/**
 * Parse edited text back into profile data for a given section.
 * Returns a partial profile patch.
 */
export function parseSectionEdit(
  section: ProfileSection,
  text: string,
  _profile: ProjectProfile,
): Partial<ProjectProfile> {
  switch (section) {
    case "identity": {
      const patch: Partial<ProjectProfile> = {};
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const nameMatch = trimmed.match(/^name:\s*(.*)$/i);
        if (nameMatch) {
          patch.name = nameMatch[1].trim();
          continue;
        }
        const typeMatch = trimmed.match(/^type:\s*(.*)$/i);
        if (typeMatch) {
          const t = typeMatch[1].trim().toLowerCase();
          if (t === "greenfield" || t === "brownfield") {
            patch.type = t;
          }
          continue;
        }
        const descMatch = trimmed.match(/^description:\s*(.*)$/i);
        if (descMatch) {
          patch.description = descMatch[1].trim();
          continue;
        }
      }
      return patch;
    }

    case "vision": {
      return { vision: text.trim() };
    }

    case "objectives": {
      return { objectives: parseObjectives(text) };
    }

    case "tech_stack": {
      return { tech_stack: parseTechStack(text) };
    }

    case "conventions": {
      return { conventions: parseConventions(text) };
    }

    case "rules": {
      return { rules: parseRulesRich(text) };
    }
  }
}

// ---------------------------------------------------------------------------
// Section display formatting (plain text for Ink — no blessed tags)
// ---------------------------------------------------------------------------

/**
 * Format a section of the profile as readable plain text for display.
 *
 * Unlike the blessed version, this uses no markup tags — the Ink components
 * handle styling via React props (bold, color, dimColor).
 *
 * Returns an array of lines that can be rendered by Ink components.
 */
export function formatSectionForDisplay(
  section: ProfileSection,
  profile: ProjectProfile,
): string {
  switch (section) {
    case "identity": {
      const lines: string[] = [];
      lines.push(`Name: ${profile.name || "(not set)"}`);
      lines.push(`Type: ${profile.type}`);
      lines.push(`Description: ${profile.description || "(not set)"}`);
      return lines.join("\n");
    }

    case "vision": {
      if (!profile.vision) return "(no vision set)";
      return profile.vision;
    }

    case "objectives": {
      if (profile.objectives.length === 0) return "(no objectives)";
      const lines: string[] = [];
      for (const obj of profile.objectives) {
        lines.push(`  [${obj.priority}] ${obj.text} (${obj.status})`);
      }
      return lines.join("\n");
    }

    case "tech_stack": {
      const ts = profile.tech_stack;
      const lines: string[] = [];
      lines.push(`Runtime:    ${ts.runtime || "(not set)"}`);
      lines.push(`Language:   ${ts.language || "(not set)"}`);
      lines.push(
        `Frameworks: ${ts.frameworks.length > 0 ? ts.frameworks.join(", ") : "(none)"}`,
      );
      lines.push(
        `Tools:      ${ts.tools.length > 0 ? ts.tools.join(", ") : "(none)"}`,
      );
      if (ts.notes) lines.push(`Notes:      ${ts.notes}`);
      return lines.join("\n");
    }

    case "conventions": {
      const conv = profile.conventions;
      const lines: string[] = [];
      lines.push(`Commits:      ${conv.commits || "(not set)"}`);
      lines.push(`Branches:     ${conv.branches || "(not set)"}`);
      lines.push(`Testing:      ${conv.testing || "(not set)"}`);
      lines.push(`Coding style: ${conv.coding_style || "(not set)"}`);
      lines.push(`Naming:       ${conv.naming || "(not set)"}`);
      return lines.join("\n");
    }

    case "rules": {
      if (profile.rules.length === 0) return "(no rules)";
      const lines: string[] = [];
      for (const rule of profile.rules) {
        lines.push(`  [${rule.rigidity}] ${rule.scope}: ${rule.text}`);
        if (rule.consequences) {
          lines.push(`    Consequences: ${rule.consequences}`);
        }
      }
      return lines.join("\n");
    }
  }
}

// ---------------------------------------------------------------------------
// Section summary (one-line for menus)
// ---------------------------------------------------------------------------

/**
 * Generate a one-line summary of a profile section for display in the menu.
 *
 * Examples:
 *   Identity: wombo-combo (brownfield)
 *   Tech Stack: Bun, TypeScript, neo-blessed
 *   Rules: 5 rules
 *   Objectives: 3 objectives (1 high)
 */
export function summarizeSection(
  section: ProfileSection,
  profile: ProjectProfile,
): string {
  switch (section) {
    case "identity": {
      const parts: string[] = [];
      if (profile.name) parts.push(profile.name);
      parts.push(`(${profile.type})`);
      return parts.join(" ") || "(not set)";
    }

    case "vision": {
      if (!profile.vision) return "(no vision set)";
      const truncated =
        profile.vision.length > 60
          ? profile.vision.slice(0, 57) + "..."
          : profile.vision;
      return truncated;
    }

    case "objectives": {
      if (profile.objectives.length === 0) return "(no objectives)";
      const highCount = profile.objectives.filter(
        (o) => o.priority === "high",
      ).length;
      const suffix = highCount > 0 ? ` (${highCount} high)` : "";
      return `${profile.objectives.length} objective${profile.objectives.length === 1 ? "" : "s"}${suffix}`;
    }

    case "tech_stack": {
      const ts = profile.tech_stack;
      const parts: string[] = [];
      if (ts.runtime) parts.push(ts.runtime);
      if (ts.language) parts.push(ts.language);
      if (ts.frameworks.length > 0) parts.push(ts.frameworks.join(", "));
      return parts.length > 0 ? parts.join(", ") : "(not set)";
    }

    case "conventions": {
      const conv = profile.conventions;
      const filled = Object.values(conv).filter(
        (v) => v && v.trim(),
      ).length;
      if (filled === 0) return "(no conventions set)";
      return `${filled}/5 fields set`;
    }

    case "rules": {
      if (profile.rules.length === 0) return "(no rules)";
      return `${profile.rules.length} rule${profile.rules.length === 1 ? "" : "s"}`;
    }
  }
}
