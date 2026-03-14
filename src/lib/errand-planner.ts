/**
 * errand-planner.ts -- Lightweight task generation for quest-less "errands".
 *
 * Takes a brief natural-language description from the user and runs the
 * quest-planner agent with a simplified prompt to generate 1-N tasks that
 * are not associated with any quest.
 *
 * Reuses the quest-planner agent definition, YAML parsing, and validation
 * pipeline from quest-planner.ts.  The difference is the prompt: instead of
 * a quest goal + constraints + branching context, the errand prompt just
 * describes a quick job.
 *
 * Created tasks go directly into the task store (no quest association).
 */

import { spawn } from "node:child_process";
import type { WomboConfig } from "../config.js";
import { resolveAgentBin } from "../config.js";
import type { ProposedTask, PlanResult } from "./quest-planner.js";
import {
  extractPlanYaml,
  parsePlanYaml,
  validatePlan,
} from "./quest-planner.js";
import { createBlankTask, saveTaskToStore, loadTasks } from "./tasks.js";
import type { Task } from "./tasks.js";
import { buildScoutIndex, formatScoutTree } from "./subagents/scout.js";

// ---------------------------------------------------------------------------
// Prompt Generation
// ---------------------------------------------------------------------------

/**
 * Generate the prompt for errand-style task generation.
 * Lighter than a full quest prompt -- no quest context, no branches, no HITL.
 */
async function generateErrandPrompt(
  description: string,
  projectRoot: string,
  config: WomboConfig
): Promise<string> {
  const sections: string[] = [];

  sections.push(`# Errand: Quick Task Generation`);
  sections.push(``);
  sections.push(
    `You are being asked to turn a brief request into one or more atomic tasks ` +
    `that autonomous coding agents can execute. These are standalone "errands" ` +
    `-- quick jobs not associated with any larger quest.`
  );
  sections.push(``);
  sections.push(`## Request`);
  sections.push(``);
  sections.push(description.trim());
  sections.push(``);

  // Codebase outline
  sections.push(`## Codebase Outline`);
  sections.push(``);
  sections.push(
    "Below is the project structure. Use your tools to explore specific files " +
    "in depth if needed."
  );
  sections.push(``);
  sections.push("```");
  try {
    const scoutIndex = await buildScoutIndex(projectRoot);
    sections.push(
      formatScoutTree(scoutIndex, {
        maxDepth: 4,
        showSymbolCounts: true,
        maxLines: 150,
      })
    );
  } catch {
    // Minimal fallback
    sections.push("(codebase outline unavailable)");
  }
  sections.push("```");

  // Existing tasks (for ID dedup)
  const tasksData = loadTasks(projectRoot, config);
  if (tasksData.tasks.length > 0) {
    sections.push(``);
    sections.push(`## Existing Task IDs`);
    sections.push(``);
    sections.push(
      "These task IDs already exist -- do NOT reuse them. Pick unique IDs."
    );
    sections.push(``);
    for (const t of tasksData.tasks) {
      sections.push(`- \`${t.id}\``);
    }
  }

  // Build info
  sections.push(``);
  sections.push(`## Build System`);
  sections.push(``);
  sections.push(`Build command: \`${config.build.command}\``);
  if (config.build.timeout) {
    sections.push(`Build timeout: ${config.build.timeout}ms`);
  }

  sections.push(``);
  sections.push(`## Instructions`);
  sections.push(``);
  sections.push(
    "Explore the codebase briefly to understand the request, then produce a " +
    "task breakdown. For simple requests this will be 1 task; for more complex " +
    "ones, 2-5 tasks with dependencies.\n\n" +
    "If the request mentions a specific agent type or specialization, set the " +
    "`agent` field accordingly. Otherwise, omit it (the generalist agent will " +
    "be used).\n\n" +
    "Output a single YAML fenced code block as your final output, using the " +
    "same format as the quest planner."
  );

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Errand Planner Execution
// ---------------------------------------------------------------------------

/**
 * Run the errand planner: launch the quest-planner agent with an errand-
 * specific prompt, parse its YAML output, validate, and return the result.
 */
export async function runErrandPlanner(
  description: string,
  projectRoot: string,
  config: WomboConfig,
  opts?: {
    model?: string;
    onProgress?: (message: string) => void;
  }
): Promise<PlanResult> {
  const onProgress = opts?.onProgress ?? (() => {});

  // Generate the prompt
  onProgress("Generating errand prompt...");
  const prompt = await generateErrandPrompt(description, projectRoot, config);

  // Launch the planner agent (reuse quest-planner-agent definition)
  onProgress("Launching errand planner...");
  const agentBin = resolveAgentBin(config);
  const agentName = "quest-planner-agent";

  const args = [
    "run",
    "--format",
    "json",
    "--agent",
    agentName,
    "--dir",
    projectRoot,
    "--title",
    `woco: errand`,
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

  // Collect stdout
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

  onProgress("Parsing errand planner output...");

  if (exitCode !== 0 && !rawOutput.trim()) {
    return {
      success: false,
      tasks: [],
      knowledge: null,
      issues: [],
      rawOutput,
      error: `Errand planner exited with code ${exitCode}. stderr: ${stderrText.slice(0, 500)}`,
    };
  }

  // Extract text events from JSON output stream
  const textContent = extractTextFromJsonEvents(rawOutput);

  // Extract YAML
  const yamlStr = extractPlanYaml(textContent);

  if (!yamlStr) {
    return {
      success: false,
      tasks: [],
      knowledge: null,
      issues: [],
      rawOutput: textContent,
      error:
        "Errand planner did not produce a YAML task plan in a fenced code block.",
    };
  }

  // Parse the YAML
  let plan: { tasks: ProposedTask[]; knowledge?: string };
  try {
    plan = parsePlanYaml(yamlStr);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      tasks: [],
      knowledge: null,
      issues: [],
      rawOutput: textContent,
      error: `Failed to parse errand YAML: ${reason}`,
    };
  }

  // Validate
  onProgress(`Validating errand plan (${plan.tasks.length} tasks)...`);
  const issues = validatePlan(plan);
  const hasErrors = issues.some((i) => i.level === "error");

  return {
    success: !hasErrors,
    tasks: plan.tasks,
    knowledge: plan.knowledge ?? null,
    issues,
    rawOutput: textContent,
    error: hasErrors
      ? "Errand plan has validation errors -- review and fix before approving."
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Apply Errand Plan (create tasks without a quest)
// ---------------------------------------------------------------------------

/**
 * Apply an approved errand plan: create tasks directly in the task store
 * without associating them with any quest.
 */
export function applyErrandPlan(
  plan: PlanResult,
  projectRoot: string,
  config: WomboConfig
): Task[] {
  const tasks: Task[] = [];

  for (const proposed of plan.tasks) {
    const task = createBlankTask(proposed.id, proposed.title, proposed.description, {
      priority: proposed.priority,
      difficulty: proposed.difficulty,
      effort: proposed.effort,
    });

    // Copy over planner fields
    task.depends_on = proposed.depends_on;
    task.constraints = proposed.constraints;
    task.forbidden = proposed.forbidden;
    task.references = proposed.references;
    task.notes = proposed.notes;
    if (proposed.agent) {
      task.agent = proposed.agent;
    }

    saveTaskToStore(projectRoot, config, task);
    tasks.push(task);
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract text content from the JSON event stream.
 * (Duplicated from quest-planner.ts to avoid exporting an internal helper.)
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
      textParts.push(trimmed);
    }
  }

  return textParts.join("");
}
