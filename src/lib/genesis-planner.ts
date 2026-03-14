/**
 * genesis-planner.ts — Genesis planner execution pipeline.
 *
 * Launches the genesis-planner agent as a single-agent headless process,
 * captures its structured YAML output (quests, not tasks), validates the
 * plan (DAG check, unique IDs), and returns the proposed quests.
 *
 * The genesis planner runs in the project root (read-only) and produces
 * a high-level quest decomposition from a project vision.
 *
 * This mirrors the quest-planner pipeline but at one level higher:
 *   genesis-planner → quests
 *   quest-planner   → tasks
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { WomboConfig } from "../config.js";
import { resolveAgentBin } from "../config.js";
import type { Priority, Difficulty } from "./tasks.js";
import type { QuestHitlMode } from "./quest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A proposed quest from the genesis planner (before validation). */
export interface ProposedQuest {
  id: string;
  title: string;
  goal: string;
  priority: Priority;
  difficulty: Difficulty;
  depends_on: string[];
  constraints: {
    add: string[];
    ban: string[];
  };
  hitl_mode: QuestHitlMode;
  notes: string[];
}

/** Raw genesis planner output shape (parsed from YAML). */
export interface GenesisOutput {
  quests: ProposedQuest[];
  knowledge?: string;
}

/** Validation issue found in the proposed genesis plan. */
export interface GenesisValidationIssue {
  level: "error" | "warning";
  questId?: string;
  message: string;
}

/** Result of running the genesis planner. */
export interface GenesisResult {
  success: boolean;
  quests: ProposedQuest[];
  knowledge: string | null;
  issues: GenesisValidationIssue[];
  rawOutput: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Prompt Generation
// ---------------------------------------------------------------------------

/**
 * Generate the prompt for the genesis planner agent.
 * Includes the project vision, goals, tech stack, and codebase outline.
 */
export function generateGenesisPrompt(
  vision: string,
  projectRoot: string,
  config: WomboConfig,
  opts?: {
    techStack?: string;
    constraints?: string[];
    existingQuestIds?: string[];
  }
): string {
  const sections: string[] = [];

  sections.push(`# Genesis: Project Decomposition`);

  sections.push(`\n## Project Vision\n`);
  sections.push(vision.trim());

  if (opts?.techStack) {
    sections.push(`\n## Tech Stack\n`);
    sections.push(opts.techStack.trim());
  }

  if (opts?.constraints && opts.constraints.length > 0) {
    sections.push(`\n## Project Constraints\n`);
    for (const c of opts.constraints) {
      sections.push(`- ${c}`);
    }
  }

  // Codebase outline
  sections.push(`\n## Codebase Outline\n`);
  sections.push(
    "Below is the directory tree of the project. Use your tools to explore " +
    "specific files in depth.\n"
  );
  sections.push("```");
  sections.push(generateDirectoryTree(projectRoot, 3));
  sections.push("```");

  // Existing quests (if re-running genesis)
  if (opts?.existingQuestIds && opts.existingQuestIds.length > 0) {
    sections.push(`\n## Existing Quests\n`);
    sections.push(
      "This project already has quests. Your plan should either replace them " +
      "entirely or extend them. Existing quest IDs:\n"
    );
    for (const qid of opts.existingQuestIds) {
      sections.push(`- \`${qid}\``);
    }
  }

  // Build info
  sections.push(`\n## Build System\n`);
  sections.push(`Build command: \`${config.build.command}\``);
  if (config.build.timeout) {
    sections.push(`Build timeout: ${config.build.timeout}ms`);
  }

  sections.push(`\n## Instructions\n`);
  sections.push(
    "Explore the codebase thoroughly, then produce a quest breakdown as specified " +
    "in your agent definition. Output a single YAML fenced code block as your " +
    "final output."
  );

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Directory Tree Generator (same as quest-planner.ts)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".wombo-combo",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
  ".idea",
  ".vscode",
]);

function generateDirectoryTree(
  rootPath: string,
  maxDepth: number,
  prefix: string = "",
  currentDepth: number = 0
): string {
  if (currentDepth >= maxDepth) return "";

  let entries: string[];
  try {
    entries = readdirSync(rootPath).sort();
  } catch {
    return "";
  }

  const lines: string[] = [];
  const filtered = entries.filter(
    (e) => !e.startsWith(".") || e === ".opencode"
  );

  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of filtered) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = resolve(rootPath, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        dirs.push(entry);
      } else {
        files.push(entry);
      }
    } catch {
      // skip unreadable
    }
  }

  for (const file of files) {
    lines.push(`${prefix}${file}`);
  }

  for (const dir of dirs) {
    lines.push(`${prefix}${dir}/`);
    const sub = generateDirectoryTree(
      resolve(rootPath, dir),
      maxDepth,
      prefix + "  ",
      currentDepth + 1
    );
    if (sub) lines.push(sub);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// YAML Extraction from Agent Output
// ---------------------------------------------------------------------------

/**
 * Extract the YAML genesis plan from the agent's raw text output.
 * Looks for the last ```yaml ... ``` fenced code block.
 */
export function extractGenesisYaml(rawOutput: string): string | null {
  const pattern = /```ya?ml\s*\n([\s\S]*?)```/gi;
  let lastMatch: string | null = null;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(rawOutput)) !== null) {
    lastMatch = m[1];
  }

  return lastMatch?.trim() ?? null;
}

/**
 * Parse the extracted YAML into a GenesisOutput.
 */
export function parseGenesisYaml(yaml: string): GenesisOutput {
  const parsed = parseYaml(yaml);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Genesis planner output is not a valid YAML object.");
  }

  const quests: ProposedQuest[] = [];
  const rawQuests = (parsed as any).quests;

  if (!Array.isArray(rawQuests)) {
    throw new Error("Genesis planner output missing 'quests' array.");
  }

  for (const raw of rawQuests) {
    if (!raw || typeof raw !== "object") continue;

    const constraints = raw.constraints && typeof raw.constraints === "object"
      ? {
          add: Array.isArray(raw.constraints.add) ? raw.constraints.add.map(String) : [],
          ban: Array.isArray(raw.constraints.ban) ? raw.constraints.ban.map(String) : [],
        }
      : { add: [], ban: [] };

    quests.push({
      id: String(raw.id ?? ""),
      title: String(raw.title ?? ""),
      goal: String(raw.goal ?? ""),
      priority: String(raw.priority ?? "medium") as Priority,
      difficulty: String(raw.difficulty ?? "medium") as Difficulty,
      depends_on: Array.isArray(raw.depends_on) ? raw.depends_on.map(String) : [],
      constraints,
      hitl_mode: String(raw.hitl_mode ?? "yolo") as QuestHitlMode,
      notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
    });
  }

  const knowledge = typeof (parsed as any).knowledge === "string"
    ? (parsed as any).knowledge
    : null;

  return { quests, knowledge };
}

// ---------------------------------------------------------------------------
// Plan Validation
// ---------------------------------------------------------------------------

const VALID_PRIORITIES = new Set(["critical", "high", "medium", "low", "wishlist"]);
const VALID_DIFFICULTIES = new Set(["trivial", "easy", "medium", "hard", "very_hard"]);
const VALID_HITL = new Set(["yolo", "cautious", "supervised"]);
const ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Validate a proposed genesis plan:
 * - Unique quest IDs
 * - Valid kebab-case IDs
 * - Valid priority/difficulty/hitl_mode enums
 * - DAG check (no cycles)
 * - Dependencies reference existing quest IDs
 */
export function validateGenesisPlan(plan: GenesisOutput): GenesisValidationIssue[] {
  const issues: GenesisValidationIssue[] = [];
  const ids = new Set<string>();

  // Pass 1: basic field validation
  for (const quest of plan.quests) {
    if (ids.has(quest.id)) {
      issues.push({
        level: "error",
        questId: quest.id,
        message: `Duplicate quest ID: "${quest.id}"`,
      });
    }
    ids.add(quest.id);

    if (!ID_RE.test(quest.id)) {
      issues.push({
        level: "error",
        questId: quest.id,
        message: `Quest ID must be kebab-case: "${quest.id}"`,
      });
    }

    if (!quest.title.trim()) {
      issues.push({
        level: "error",
        questId: quest.id,
        message: "Quest has no title.",
      });
    }

    if (!quest.goal.trim()) {
      issues.push({
        level: "error",
        questId: quest.id,
        message: "Quest has no goal.",
      });
    }

    if (!VALID_PRIORITIES.has(quest.priority)) {
      issues.push({
        level: "warning",
        questId: quest.id,
        message: `Invalid priority "${quest.priority}", will default to "medium".`,
      });
    }
    if (!VALID_DIFFICULTIES.has(quest.difficulty)) {
      issues.push({
        level: "warning",
        questId: quest.id,
        message: `Invalid difficulty "${quest.difficulty}", will default to "medium".`,
      });
    }
    if (!VALID_HITL.has(quest.hitl_mode)) {
      issues.push({
        level: "warning",
        questId: quest.id,
        message: `Invalid hitl_mode "${quest.hitl_mode}", will default to "yolo".`,
      });
    }
  }

  // Pass 2: dependency validation
  for (const quest of plan.quests) {
    for (const dep of quest.depends_on) {
      if (!ids.has(dep)) {
        issues.push({
          level: "error",
          questId: quest.id,
          message: `Depends on unknown quest ID: "${dep}"`,
        });
      }
    }
  }

  // Pass 3: cycle detection (DFS-based)
  const cycleErrors = detectCycles(plan.quests);
  issues.push(...cycleErrors);

  return issues;
}

/**
 * Detect cycles in the quest dependency graph using DFS.
 */
function detectCycles(quests: ProposedQuest[]): GenesisValidationIssue[] {
  const issues: GenesisValidationIssue[] = [];
  const adj = new Map<string, string[]>();
  const questIds = new Set<string>();

  for (const q of quests) {
    questIds.add(q.id);
    adj.set(q.id, q.depends_on.filter((d) => questIds.has(d)));
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of questIds) color.set(id, WHITE);

  function dfs(node: string, path: string[]): boolean {
    color.set(node, GRAY);
    path.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (color.get(neighbor) === GRAY) {
        const cycleStart = path.indexOf(neighbor);
        const cycle = path.slice(cycleStart).concat(neighbor);
        issues.push({
          level: "error",
          message: `Dependency cycle detected: ${cycle.join(" \u2192 ")}`,
        });
        return true;
      }
      if (color.get(neighbor) === WHITE) {
        if (dfs(neighbor, path)) return true;
      }
    }

    path.pop();
    color.set(node, BLACK);
    return false;
  }

  for (const id of questIds) {
    if (color.get(id) === WHITE) {
      dfs(id, []);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Genesis Planner Execution
// ---------------------------------------------------------------------------

/**
 * Run the genesis planner agent and capture its output.
 *
 * The planner runs headlessly in the project root (it only reads code).
 * Its stdout is captured and parsed for the YAML quest plan.
 */
export async function runGenesisPlanner(
  vision: string,
  projectRoot: string,
  config: WomboConfig,
  opts?: {
    techStack?: string;
    constraints?: string[];
    existingQuestIds?: string[];
    model?: string;
    onProgress?: (message: string) => void;
  }
): Promise<GenesisResult> {
  const onProgress = opts?.onProgress ?? (() => {});

  // Generate the prompt
  onProgress("Generating genesis prompt...");
  const prompt = generateGenesisPrompt(vision, projectRoot, config, {
    techStack: opts?.techStack,
    constraints: opts?.constraints,
    existingQuestIds: opts?.existingQuestIds,
  });

  // Launch the genesis planner agent
  onProgress("Launching genesis planner agent...");
  const agentBin = resolveAgentBin(config);
  const agentName = "genesis-planner-agent";

  const args = [
    "run",
    "--format", "json",
    "--agent", agentName,
    "--dir", projectRoot,
    "--title", "woco: genesis",
  ];

  if (opts?.model) {
    args.push("--model", opts.model);
  }

  args.push(prompt);

  const child = spawn(agentBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    env: {
      ...process.env,
      OPENCODE_DIR: projectRoot,
    },
  });

  child.stdin?.end();

  // Collect all stdout
  const chunks: Buffer[] = [];
  let stderrText = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString();
  });

  // Wait for process to exit
  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

  const rawOutput = Buffer.concat(chunks).toString("utf-8");

  onProgress("Parsing genesis output...");

  if (exitCode !== 0 && !rawOutput.trim()) {
    return {
      success: false,
      quests: [],
      knowledge: null,
      issues: [],
      rawOutput,
      error: `Genesis planner agent exited with code ${exitCode}. stderr: ${stderrText.slice(0, 500)}`,
    };
  }

  // Extract text events from the JSON output stream
  const textContent = extractTextFromJsonEvents(rawOutput);

  // Extract YAML from the text content
  const yamlStr = extractGenesisYaml(textContent);

  if (!yamlStr) {
    return {
      success: false,
      quests: [],
      knowledge: null,
      issues: [],
      rawOutput: textContent,
      error: "Genesis planner agent did not produce a YAML quest plan in a fenced code block.",
    };
  }

  // Parse the YAML
  let plan: GenesisOutput;
  try {
    plan = parseGenesisYaml(yamlStr);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      quests: [],
      knowledge: null,
      issues: [],
      rawOutput: textContent,
      error: `Failed to parse genesis YAML: ${reason}`,
    };
  }

  // Validate the plan
  onProgress(`Validating genesis plan (${plan.quests.length} quests)...`);
  const issues = validateGenesisPlan(plan);
  const hasErrors = issues.some((i) => i.level === "error");

  return {
    success: !hasErrors,
    quests: plan.quests,
    knowledge: plan.knowledge ?? null,
    issues,
    rawOutput: textContent,
    error: hasErrors ? "Genesis plan has validation errors — review and fix before approving." : undefined,
  };
}

/**
 * Extract text content from the JSON event stream.
 * Looks for "text" type events and concatenates their part.text fields.
 */
function extractTextFromJsonEvents(rawOutput: string): string {
  const lines = rawOutput.split("\n");
  const textParts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);
      if (event.type === "text" && event.part?.text) {
        textParts.push(event.part.text);
      }
    } catch {
      // Not JSON — might be plain text output, include it
      textParts.push(trimmed);
    }
  }

  return textParts.join("");
}
