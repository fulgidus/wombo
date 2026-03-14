/**
 * project-store.ts — CRUD for .wombo-combo/project.yml
 *
 * The project profile is the persistent base layer of context for all agents.
 * It stores project identity, vision, objectives, tech stack, conventions,
 * and structured rules with rich properties (scope, rigidity, consequences,
 * pre/post hooks).
 *
 * First-run detection: if project.yml does not exist, the TUI should trigger
 * the onboarding wizard. Re-running the wizard operates non-destructively
 * via a section-menu editor.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { WOMBO_DIR } from "../config.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Whether this is a greenfield or brownfield project. */
export type ProjectType = "greenfield" | "brownfield";

/** How strict a rule is. */
export type RuleRigidity = "hard" | "soft" | "preference";

/** Trackable status for high-level objectives. */
export type ObjectiveStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "abandoned";

/**
 * A high-level project objective that quests map to.
 */
export interface ProjectObjective {
  /** Unique identifier (e.g. "obj-1") */
  id: string;
  /** What this objective aims to achieve */
  text: string;
  /** Relative priority */
  priority: "high" | "medium" | "low";
  /** Current status — trackable */
  status: ObjectiveStatus;
  /** Quest IDs that serve this objective */
  quest_ids: string[];
}

/**
 * Pre/post hooks attached to a rule.
 * Rules can specify commands to run at certain trigger points.
 */
export interface RuleHooks {
  /** When to run: pre-launch, post-merge, pre-commit, etc. */
  trigger: string;
  /** Commands to run before the triggered operation */
  pre: string[];
  /** Commands to run after the triggered operation */
  post: string[];
}

/**
 * A structured project rule with rich properties.
 */
export interface ProjectRule {
  /** Unique identifier (e.g. "rule-1") */
  id: string;
  /** Human-readable rule text */
  text: string;
  /** What area the rule applies to (e.g. "tui", "runtime", "distribution") */
  scope: string;
  /** How strict the rule is */
  rigidity: RuleRigidity;
  /** What happens if the rule is violated */
  consequences: string;
  /** Categorization tags */
  tags: string[];
  /** Optional pre/post hooks */
  hooks?: RuleHooks;
}

/**
 * Project tech stack description.
 */
export interface TechStack {
  /** Primary runtime (e.g. "Bun", "Node", "Deno") */
  runtime: string;
  /** Primary language and mode (e.g. "TypeScript (strict, ESM)") */
  language: string;
  /** Frameworks and libraries */
  frameworks: string[];
  /** Dev tools */
  tools: string[];
  /** Additional notes */
  notes: string;
}

/**
 * Coding style and project conventions.
 */
export interface ProjectConventions {
  /** Commit message format (e.g. "Conventional commits with scope") */
  commits: string;
  /** Branch naming (e.g. "quest/<id> for quests, feature/<id> for tasks") */
  branches: string;
  /** Testing approach (e.g. "bun test") */
  testing: string;
  /** Coding style notes (e.g. "Strict TS, Bun APIs preferred, ESM only") */
  coding_style: string;
  /** Naming conventions (e.g. "kebab-case files, camelCase code") */
  naming: string;
}

/**
 * The full project profile stored in .wombo-combo/project.yml.
 */
export interface ProjectProfile {
  // --- Identity ---
  /** Project name */
  name: string;
  /** Greenfield or brownfield */
  type: ProjectType;
  /** Short project description */
  description: string;

  // --- Strategic ---
  /** Long-term vision for the project */
  vision: string;
  /** High-level trackable objectives */
  objectives: ProjectObjective[];

  // --- Technical ---
  /** Tech stack description */
  tech_stack: TechStack;

  // --- Conventions ---
  /** Coding style and project conventions */
  conventions: ProjectConventions;

  // --- Rules ---
  /** Structured rules with rich properties */
  rules: ProjectRule[];

  // --- Brownfield context ---
  /** Auto-populated codebase summary (from scout) */
  codebase_summary: string;

  // --- Metadata ---
  /** ISO 8601 creation timestamp */
  created_at: string;
  /** ISO 8601 last-updated timestamp */
  updated_at: string;
  /** Number of times genesis has been run */
  genesis_count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename for the project profile inside .wombo-combo/ */
const PROJECT_FILE = "project.yml";

const YAML_OPTS = {
  lineWidth: 120,
  defaultKeyType: "PLAIN" as const,
  defaultStringType: "PLAIN" as const,
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Create a blank project profile with sensible defaults.
 */
export function createBlankProfile(name?: string): ProjectProfile {
  const now = new Date().toISOString();
  return {
    name: name ?? "",
    type: "brownfield",
    description: "",
    vision: "",
    objectives: [],
    tech_stack: {
      runtime: "",
      language: "",
      frameworks: [],
      tools: [],
      notes: "",
    },
    conventions: {
      commits: "",
      branches: "",
      testing: "",
      coding_style: "",
      naming: "",
    },
    rules: [],
    codebase_summary: "",
    created_at: now,
    updated_at: now,
    genesis_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the full path to the project YAML file.
 */
function projectPath(projectRoot: string): string {
  return resolve(projectRoot, WOMBO_DIR, PROJECT_FILE);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

/**
 * Normalize a parsed objective to ensure all fields are present.
 */
function normalizeObjective(
  obj: Partial<ProjectObjective>
): ProjectObjective {
  return {
    id: obj.id ?? `obj-${randomUUID().slice(0, 8)}`,
    text: obj.text ?? "",
    priority: obj.priority ?? "medium",
    status: obj.status ?? "pending",
    quest_ids: obj.quest_ids ?? [],
  };
}

/**
 * Normalize a parsed rule to ensure all fields are present.
 */
function normalizeRule(rule: Partial<ProjectRule>): ProjectRule {
  return {
    id: rule.id ?? `rule-${randomUUID().slice(0, 8)}`,
    text: rule.text ?? "",
    scope: rule.scope ?? "general",
    rigidity: rule.rigidity ?? "soft",
    consequences: rule.consequences ?? "",
    tags: rule.tags ?? [],
    hooks: rule.hooks
      ? {
          trigger: rule.hooks.trigger ?? "",
          pre: rule.hooks.pre ?? [],
          post: rule.hooks.post ?? [],
        }
      : undefined,
  };
}

/**
 * Normalize a parsed tech stack to ensure all fields are present.
 */
function normalizeTechStack(ts: Partial<TechStack>): TechStack {
  return {
    runtime: ts.runtime ?? "",
    language: ts.language ?? "",
    frameworks: ts.frameworks ?? [],
    tools: ts.tools ?? [],
    notes: ts.notes ?? "",
  };
}

/**
 * Normalize parsed conventions to ensure all fields are present.
 */
function normalizeConventions(
  conv: Partial<ProjectConventions>
): ProjectConventions {
  return {
    commits: conv.commits ?? "",
    branches: conv.branches ?? "",
    testing: conv.testing ?? "",
    coding_style: conv.coding_style ?? "",
    naming: conv.naming ?? "",
  };
}

/**
 * Normalize a full parsed profile.
 */
function normalizeProfile(raw: Record<string, unknown>): ProjectProfile {
  const now = new Date().toISOString();
  return {
    name: (raw.name as string) ?? "",
    type: (raw.type as ProjectType) ?? "brownfield",
    description: (raw.description as string) ?? "",
    vision: (raw.vision as string) ?? "",
    objectives: Array.isArray(raw.objectives)
      ? raw.objectives.map((o: unknown) =>
          normalizeObjective(o as Partial<ProjectObjective>)
        )
      : [],
    tech_stack: normalizeTechStack(
      (raw.tech_stack as Partial<TechStack>) ?? {}
    ),
    conventions: normalizeConventions(
      (raw.conventions as Partial<ProjectConventions>) ?? {}
    ),
    rules: Array.isArray(raw.rules)
      ? raw.rules.map((r: unknown) =>
          normalizeRule(r as Partial<ProjectRule>)
        )
      : [],
    codebase_summary: (raw.codebase_summary as string) ?? "",
    created_at: (raw.created_at as string) ?? now,
    updated_at: (raw.updated_at as string) ?? now,
    genesis_count: (raw.genesis_count as number) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Public API — Detection
// ---------------------------------------------------------------------------

/**
 * Check whether a project profile exists.
 * Used for first-run detection in the TUI.
 */
export function projectExists(projectRoot: string): boolean {
  return existsSync(projectPath(projectRoot));
}

// ---------------------------------------------------------------------------
// Public API — Load
// ---------------------------------------------------------------------------

/**
 * Load the project profile from .wombo-combo/project.yml.
 * Returns null if the file does not exist.
 * Throws on parse errors.
 */
export function loadProject(projectRoot: string): ProjectProfile | null {
  const filePath = projectPath(projectRoot);
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);

  if (!parsed || typeof parsed !== "object") return null;

  return normalizeProfile(parsed as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Public API — Save
// ---------------------------------------------------------------------------

/**
 * Save the project profile to .wombo-combo/project.yml.
 * Updates the `updated_at` timestamp automatically.
 */
export function saveProject(
  projectRoot: string,
  profile: ProjectProfile
): void {
  const filePath = projectPath(projectRoot);
  ensureDir(dirname(filePath));

  // Always bump updated_at on save
  const toSave: ProjectProfile = {
    ...profile,
    updated_at: new Date().toISOString(),
  };

  const yaml = stringifyYaml(toSave, YAML_OPTS);
  atomicWrite(filePath, yaml);
}

// ---------------------------------------------------------------------------
// Public API — Section updates (for non-destructive editing)
// ---------------------------------------------------------------------------

/**
 * Update a specific section of the project profile.
 * Loads the existing profile, merges the patch, and saves.
 *
 * @param projectRoot — The project root directory.
 * @param patch — Partial profile with only the fields to update.
 * @returns The updated full profile.
 */
export function updateProject(
  projectRoot: string,
  patch: Partial<ProjectProfile>
): ProjectProfile {
  const existing = loadProject(projectRoot);
  if (!existing) {
    throw new Error("No project profile found. Run onboarding first.");
  }

  const merged: ProjectProfile = {
    ...existing,
    ...patch,
    // Deep-merge nested objects instead of replacing them
    tech_stack: patch.tech_stack
      ? { ...existing.tech_stack, ...patch.tech_stack }
      : existing.tech_stack,
    conventions: patch.conventions
      ? { ...existing.conventions, ...patch.conventions }
      : existing.conventions,
    // Arrays replace entirely (objectives, rules) — no deep merge
    objectives: patch.objectives ?? existing.objectives,
    rules: patch.rules ?? existing.rules,
  };

  saveProject(projectRoot, merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Public API — Objective helpers
// ---------------------------------------------------------------------------

/**
 * Add an objective to the project profile.
 */
export function addObjective(
  projectRoot: string,
  text: string,
  priority: "high" | "medium" | "low" = "medium"
): ProjectObjective {
  const profile = loadProject(projectRoot);
  if (!profile) {
    throw new Error("No project profile found. Run onboarding first.");
  }

  const nextNum =
    profile.objectives.length > 0
      ? Math.max(
          ...profile.objectives.map((o) => {
            const m = o.id.match(/^obj-(\d+)$/);
            return m ? parseInt(m[1], 10) : 0;
          })
        ) + 1
      : 1;

  const objective: ProjectObjective = {
    id: `obj-${nextNum}`,
    text: text.trim(),
    priority,
    status: "pending",
    quest_ids: [],
  };

  profile.objectives.push(objective);
  saveProject(projectRoot, profile);
  return objective;
}

/**
 * Update the status of an objective.
 */
export function setObjectiveStatus(
  projectRoot: string,
  objectiveId: string,
  status: ObjectiveStatus
): boolean {
  const profile = loadProject(projectRoot);
  if (!profile) return false;

  const obj = profile.objectives.find((o) => o.id === objectiveId);
  if (!obj) return false;

  obj.status = status;
  saveProject(projectRoot, profile);
  return true;
}

/**
 * Link a quest to an objective.
 */
export function linkQuestToObjective(
  projectRoot: string,
  objectiveId: string,
  questId: string
): boolean {
  const profile = loadProject(projectRoot);
  if (!profile) return false;

  const obj = profile.objectives.find((o) => o.id === objectiveId);
  if (!obj) return false;

  if (!obj.quest_ids.includes(questId)) {
    obj.quest_ids.push(questId);
    saveProject(projectRoot, profile);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API — Rule helpers
// ---------------------------------------------------------------------------

/**
 * Add a rule to the project profile.
 */
export function addRule(
  projectRoot: string,
  rule: Omit<ProjectRule, "id">
): ProjectRule {
  const profile = loadProject(projectRoot);
  if (!profile) {
    throw new Error("No project profile found. Run onboarding first.");
  }

  const nextNum =
    profile.rules.length > 0
      ? Math.max(
          ...profile.rules.map((r) => {
            const m = r.id.match(/^rule-(\d+)$/);
            return m ? parseInt(m[1], 10) : 0;
          })
        ) + 1
      : 1;

  const newRule: ProjectRule = {
    ...rule,
    id: `rule-${nextNum}`,
  };

  profile.rules.push(newRule);
  saveProject(projectRoot, profile);
  return newRule;
}

// ---------------------------------------------------------------------------
// Public API — Genesis tracking
// ---------------------------------------------------------------------------

/**
 * Increment the genesis_count.
 * Called after a successful genesis run.
 */
export function bumpGenesisCount(projectRoot: string): number {
  const profile = loadProject(projectRoot);
  if (!profile) return 0;

  profile.genesis_count += 1;
  saveProject(projectRoot, profile);
  return profile.genesis_count;
}

// ---------------------------------------------------------------------------
// Public API — Prompt injection
// ---------------------------------------------------------------------------

/**
 * The section names that map to editable parts of the profile.
 * Used by the TUI section-menu editor.
 */
export const PROFILE_SECTIONS = [
  "identity",      // name, type, description
  "vision",        // vision
  "objectives",    // objectives array
  "tech_stack",    // tech stack
  "conventions",   // coding style, commits, branches, etc.
  "rules",         // structured rules
] as const;

export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/**
 * Format the project profile as a prompt section for agent injection.
 *
 * Returns a markdown-formatted string suitable for inclusion in any
 * agent prompt (genesis, quest planner, errand planner, task agent).
 */
export function formatProjectContext(profile: ProjectProfile): string {
  const lines: string[] = [];

  lines.push("## Project Context");
  lines.push("");

  // Identity
  if (profile.name) {
    lines.push(`**Project:** ${profile.name}`);
  }
  if (profile.description) {
    lines.push(`**Description:** ${profile.description}`);
  }
  lines.push(`**Type:** ${profile.type}`);
  lines.push("");

  // Vision
  if (profile.vision) {
    lines.push("### Vision");
    lines.push(profile.vision);
    lines.push("");
  }

  // Objectives
  if (profile.objectives.length > 0) {
    lines.push("### Objectives");
    for (const obj of profile.objectives) {
      const statusTag =
        obj.status === "completed"
          ? " [DONE]"
          : obj.status === "in_progress"
            ? " [IN PROGRESS]"
            : obj.status === "abandoned"
              ? " [ABANDONED]"
              : "";
      lines.push(
        `- **[${obj.priority}]** ${obj.text}${statusTag}`
      );
    }
    lines.push("");
  }

  // Tech stack
  const ts = profile.tech_stack;
  if (ts.runtime || ts.language) {
    lines.push("### Tech Stack");
    if (ts.runtime) lines.push(`- **Runtime:** ${ts.runtime}`);
    if (ts.language) lines.push(`- **Language:** ${ts.language}`);
    if (ts.frameworks.length > 0)
      lines.push(`- **Frameworks:** ${ts.frameworks.join(", ")}`);
    if (ts.tools.length > 0)
      lines.push(`- **Tools:** ${ts.tools.join(", ")}`);
    if (ts.notes) lines.push(`- **Notes:** ${ts.notes}`);
    lines.push("");
  }

  // Conventions
  const conv = profile.conventions;
  const convEntries = Object.entries(conv).filter(
    ([, v]) => v && v.trim()
  );
  if (convEntries.length > 0) {
    lines.push("### Conventions");
    for (const [key, value] of convEntries) {
      const label = key.replace(/_/g, " ");
      lines.push(
        `- **${label.charAt(0).toUpperCase() + label.slice(1)}:** ${value}`
      );
    }
    lines.push("");
  }

  // Rules
  if (profile.rules.length > 0) {
    lines.push("### Rules");
    for (const rule of profile.rules) {
      const rigidityTag =
        rule.rigidity === "hard"
          ? " [HARD]"
          : rule.rigidity === "preference"
            ? " [PREF]"
            : "";
      lines.push(
        `- **${rule.scope}${rigidityTag}:** ${rule.text}`
      );
      if (rule.consequences) {
        lines.push(`  - *Consequence:* ${rule.consequences}`);
      }
    }
    lines.push("");
  }

  // Codebase summary (for brownfield)
  if (profile.codebase_summary) {
    lines.push("### Codebase Summary");
    lines.push(profile.codebase_summary);
    lines.push("");
  }

  return lines.join("\n");
}
