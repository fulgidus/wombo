/**
 * tui-onboarding.ts — Onboarding wizard for wombo-combo TUI.
 *
 * A multi-step blessed wizard that collects project profile information:
 *   1. Project type (greenfield / brownfield)
 *   2. [brownfield only] Auto-scout the codebase with ProgressScreen spinner
 *   3. Project name
 *   4. Description
 *
 * If the user selects "brownfield", the scout runs automatically between
 * steps 1 and 3. The scout result is stored as `codebase_summary` in the
 * final profile.
 *
 * Also provides `structureRawInputs()`, a pure function that converts the raw
 * text collected by the onboarding wizard into a fully typed ProjectProfile.
 *
 * Each wizard step collects free-form text. This module parses that text into
 * structured data:
 *
 *   - **Objectives:** One per line, optionally prefixed with [high]/[medium]/[low].
 *   - **Tech stack:** Looks for "runtime:", "language:", "frameworks:", "tools:" patterns.
 *   - **Conventions:** Looks for "commits:", "branches:", "testing:", "coding_style:", "naming:" prefixes.
 *   - **Rules:** Each non-empty line becomes a ProjectRule with auto-generated ID.
 *
 * Usage:
 *   const profile = await runOnboardingWizard({ projectRoot });
 *   if (profile) saveProject(projectRoot, profile);
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import blessed from "neo-blessed";
import type { Widgets } from "neo-blessed";
import { parse as parseYaml } from "yaml";
import type { WomboConfig } from "../config.js";
import { resolveAgentBin } from "../config.js";
import { buildScoutIndex, formatScoutTree } from "./subagents/scout.js";
import type { ScoutIndex } from "./subagents/scout.js";
import { ProgressScreen } from "./tui-progress.js";
import {
  createBlankProfile,
  normalizeProfile,
  PROFILE_SECTIONS,
  type ProfileSection,
  type ProjectProfile,
  type ProjectType,
  type ProjectObjective,
  type ProjectRule,
  type RuleRigidity,
  type TechStack,
  type ProjectConventions,
} from "./project-store.js";

// ---------------------------------------------------------------------------
// runBrownfieldScout — standalone scout function
// ---------------------------------------------------------------------------

/**
 * Run the brownfield codebase scout and return a formatted tree string.
 *
 * Calls `buildScoutIndex(projectRoot)` and formats the result with
 * `formatScoutTree`. If scouting fails for any reason, returns an empty
 * string (graceful fallback).
 *
 * @param projectRoot — Absolute path to the project root directory.
 * @returns A compact file tree string suitable for prompt injection, or ""
 *          on failure.
 */
export async function runBrownfieldScout(projectRoot: string): Promise<string> {
  try {
    const index = await buildScoutIndex(projectRoot);
    return formatScoutTree(index, {
      maxDepth: 4,
      showSymbolCounts: true,
      maxLines: 150,
    });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// runLlmSynthesis — LLM agent enhancement of raw profile
// ---------------------------------------------------------------------------

/**
 * Extract text content from the JSON event stream produced by the agent.
 * Looks for "text" type events and concatenates their part.text fields.
 * Non-JSON lines are included as-is (plain text fallback).
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

/**
 * Extract YAML content from fenced code blocks in agent output.
 * Returns the content of the last ```yaml ... ``` block found, or null.
 */
function extractYamlFromFencedBlocks(text: string): string | null {
  const pattern = /```ya?ml\s*\n([\s\S]*?)```/gi;
  let lastMatch: string | null = null;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    lastMatch = m[1];
  }

  return lastMatch?.trim() ?? null;
}

/**
 * Format a ProjectProfile as a markdown document for the LLM prompt.
 * Includes all raw profile data so the agent can enhance it.
 */
function formatProfileAsMarkdown(profile: ProjectProfile): string {
  const sections: string[] = [];

  sections.push("# Current Project Profile\n");

  // Identity
  sections.push("## Identity\n");
  if (profile.name) sections.push(`- **Name:** ${profile.name}`);
  sections.push(`- **Type:** ${profile.type}`);
  if (profile.description) sections.push(`- **Description:** ${profile.description}`);
  sections.push("");

  // Vision
  if (profile.vision) {
    sections.push("## Vision\n");
    sections.push(profile.vision);
    sections.push("");
  }

  // Objectives
  if (profile.objectives.length > 0) {
    sections.push("## Objectives\n");
    for (const obj of profile.objectives) {
      sections.push(`- [${obj.priority}] ${obj.text} (status: ${obj.status})`);
    }
    sections.push("");
  }

  // Tech stack
  const ts = profile.tech_stack;
  sections.push("## Tech Stack\n");
  if (ts.runtime) sections.push(`- **Runtime:** ${ts.runtime}`);
  if (ts.language) sections.push(`- **Language:** ${ts.language}`);
  if (ts.frameworks.length > 0) sections.push(`- **Frameworks:** ${ts.frameworks.join(", ")}`);
  if (ts.tools.length > 0) sections.push(`- **Tools:** ${ts.tools.join(", ")}`);
  if (ts.notes) sections.push(`- **Notes:** ${ts.notes}`);
  sections.push("");

  // Conventions
  const conv = profile.conventions;
  const convEntries = Object.entries(conv).filter(([, v]) => v && v.trim());
  if (convEntries.length > 0) {
    sections.push("## Conventions\n");
    for (const [key, value] of convEntries) {
      const label = key.replace(/_/g, " ");
      sections.push(`- **${label.charAt(0).toUpperCase() + label.slice(1)}:** ${value}`);
    }
    sections.push("");
  }

  // Rules
  if (profile.rules.length > 0) {
    sections.push("## Rules\n");
    for (const rule of profile.rules) {
      const parts = [`- **[${rule.rigidity}] ${rule.scope}:** ${rule.text}`];
      if (rule.consequences) parts.push(`  - Consequences: ${rule.consequences}`);
      if (rule.tags.length > 0) parts.push(`  - Tags: ${rule.tags.join(", ")}`);
      sections.push(parts.join("\n"));
    }
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Build the full synthesis prompt for the LLM agent.
 * Includes the raw profile data and optional codebase summary.
 */
function buildSynthesisPrompt(profile: ProjectProfile): string {
  const sections: string[] = [];

  sections.push("# Onboarding Profile Synthesis\n");
  sections.push(
    "You are enhancing a raw project profile collected from an onboarding wizard. " +
    "The user provided rough inputs that need to be refined into a well-structured " +
    "project profile.\n"
  );

  // Include all raw profile data
  sections.push(formatProfileAsMarkdown(profile));

  // Include codebase summary if present
  if (profile.codebase_summary) {
    sections.push("## Codebase Summary\n");
    sections.push("The following is an auto-scanned codebase structure:\n");
    sections.push("```");
    sections.push(profile.codebase_summary);
    sections.push("```\n");
  }

  // Instructions for the agent
  sections.push("## Instructions\n");
  sections.push(
    "Produce an enhanced YAML profile within a fenced ```yaml code block. " +
    "The YAML must conform to the ProjectProfile schema with these fields:\n"
  );
  sections.push("- **name**: string — Keep as-is unless clearly wrong");
  sections.push("- **type**: \"greenfield\" | \"brownfield\" — Keep as-is");
  sections.push("- **description**: string — Improve clarity if needed");
  sections.push("- **vision**: string — Expand into a compelling long-term vision statement");
  sections.push(
    "- **objectives**: array of {id, text, priority, status, quest_ids} — " +
    "Better-structured objectives with clear priorities (high/medium/low)"
  );
  sections.push(
    "- **tech_stack**: {runtime, language, frameworks, tools, notes} — " +
    "Infer missing details from the codebase summary if available"
  );
  sections.push(
    "- **conventions**: {commits, branches, testing, coding_style, naming} — " +
    "Infer from codebase patterns if not provided"
  );
  sections.push(
    "- **rules**: array of {id, text, scope, rigidity, consequences, tags} — " +
    "Expand rules with proper scope (e.g. 'runtime', 'distribution', 'tui'), " +
    "rigidity ('hard'/'soft'/'preference'), and meaningful consequences"
  );
  sections.push("");
  sections.push(
    "Keep the enhanced profile faithful to the user's intent. " +
    "Do not invent goals or rules the user didn't imply. " +
    "Preserve existing IDs where possible. " +
    "Output ONLY the YAML in a single fenced code block."
  );

  return sections.join("\n");
}

/**
 * Spawn an LLM agent to enhance the raw project profile.
 *
 * Follows the same agent-spawning pattern as genesis-planner.ts:
 *   1. resolveAgentBin(config) to get the binary path.
 *   2. Check existsSync(agentBin), return original profile if not found.
 *   3. Build a prompt with all raw profile data + codebase_summary.
 *   4. spawn(agentBin, ['run', '--format', 'json', ...]).
 *   5. Capture stdout, extract text from JSON events, find YAML.
 *   6. Normalize parsed result with normalizeProfile.
 *   7. Return enhanced profile, falling back to original on error.
 *
 * @param profile — The raw profile to enhance.
 * @param config — The WomboConfig for resolving agent binary.
 * @param projectRoot — Absolute path to the project root.
 * @param onProgress — Callback to report status to the ProgressScreen.
 * @returns The enhanced profile, or the original on failure.
 */
export async function runLlmSynthesis(
  profile: ProjectProfile,
  config: WomboConfig,
  projectRoot: string,
  onProgress: (msg: string) => void
): Promise<ProjectProfile> {
  try {
    // 1. Resolve agent binary path
    onProgress("Resolving agent binary...");
    const agentBin = resolveAgentBin(config);

    // 2. Check agent binary exists
    if (!existsSync(agentBin)) {
      onProgress("Agent binary not found — skipping LLM synthesis");
      return profile;
    }

    // 3. Build the synthesis prompt
    onProgress("Building synthesis prompt...");
    const prompt = buildSynthesisPrompt(profile);

    // 4. Spawn the agent
    onProgress("Launching LLM synthesis agent...");
    const args = [
      "run",
      "--format", "json",
      "--agent", "genesis-planner-agent",
      "--dir", projectRoot,
      "--title", "woco: onboarding synthesis",
      prompt,
    ];

    const child = spawn(agentBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      env: {
        ...process.env,
        OPENCODE_DIR: projectRoot,
      },
    });

    child.stdin?.end();

    // 5. Capture stdout
    const chunks: Buffer[] = [];
    let stderrText = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString();
    });

    // Wait for process to exit with a 5-minute timeout
    const SYNTHESIS_TIMEOUT_MS = 5 * 60 * 1000;
    const exitCode = await new Promise<number>((resolve) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // Best effort
          }
          resolve(-1);
        }
      }, SYNTHESIS_TIMEOUT_MS);

      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(code ?? 1);
        }
      });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          stderrText += `\nSpawn error: ${err.message}`;
          resolve(1);
        }
      });
    });

    const rawOutput = Buffer.concat(chunks).toString("utf-8");

    if (exitCode === -1) {
      onProgress("LLM synthesis timed out — using raw profile");
      return profile;
    }

    if (exitCode !== 0 && !rawOutput.trim()) {
      onProgress("LLM synthesis failed — using raw profile");
      return profile;
    }

    // Extract text from JSON event stream
    onProgress("Parsing LLM synthesis output...");
    const textContent = extractTextFromJsonEvents(rawOutput);

    // Find YAML in fenced code blocks
    const yamlStr = extractYamlFromFencedBlocks(textContent);

    if (!yamlStr) {
      onProgress("No YAML found in LLM output — using raw profile");
      return profile;
    }

    // 6. Parse YAML and normalize
    onProgress("Applying enhanced profile...");
    const parsed = parseYaml(yamlStr);

    if (!parsed || typeof parsed !== "object") {
      onProgress("Invalid YAML from LLM — using raw profile");
      return profile;
    }

    const enhanced = normalizeProfile(parsed as Record<string, unknown>);

    // Preserve metadata from the original profile
    enhanced.created_at = profile.created_at;
    enhanced.updated_at = profile.updated_at;
    enhanced.genesis_count = profile.genesis_count;

    // Preserve codebase_summary from original if the LLM didn't include it
    if (!enhanced.codebase_summary && profile.codebase_summary) {
      enhanced.codebase_summary = profile.codebase_summary;
    }

    // 7. Return enhanced profile
    onProgress("LLM synthesis complete");
    return enhanced;
  } catch {
    // Graceful fallback: return original profile on any error
    onProgress("LLM synthesis error — using raw profile");
    return profile;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OnboardingWizardOptions {
  /** Project root directory. */
  projectRoot: string;
}

export interface OnboardingWizardResult {
  /** The completed project profile. */
  profile: ProjectProfile;
  /** The raw scout index (if brownfield scouting was performed). */
  scoutIndex: ScoutIndex | null;
}

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
// Helpers
// ---------------------------------------------------------------------------

function escapeBlessedTags(text: string): string {
  return text.replace(/\{/g, "\uFF5B").replace(/\}/g, "\uFF5D");
}

function cleanupScreen(screen: Widgets.Screen): void {
  screen.destroy();
  if (process.stdin.isTTY) {
    try {
      process.stdin.removeAllListeners("keypress");
      process.stdin.removeAllListeners("data");
      if (typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
  process.stdout.write("\x1B[2J\x1B[H");
}

// ---------------------------------------------------------------------------
// runOnboardingWizard — main entry point
// ---------------------------------------------------------------------------

/**
 * Run the onboarding wizard as a standalone blessed screen.
 *
 * Returns the completed profile (with codebase_summary populated for
 * brownfield projects), or null if the user cancelled.
 *
 * Steps:
 *   1. Select project type (greenfield / brownfield)
 *   2. [brownfield] Show ProgressScreen while scouting, then display summary
 *   3. Enter project name
 *   4. Enter project description
 */
export function runOnboardingWizard(
  opts: OnboardingWizardOptions
): Promise<OnboardingWizardResult | null> {
  const { projectRoot } = opts;

  return new Promise<OnboardingWizardResult | null>((resolve) => {
    const screen = blessed.screen({
      smartCSR: true,
      title: "wombo-combo -- Onboarding",
      fullUnicode: true,
    });

    // Modal container
    const modal = blessed.box({
      parent: screen,
      top: "center",
      left: "center",
      width: "70%",
      height: "80%",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "magenta" },
        fg: "white",
        bg: "black",
      },
      label: " {magenta-fg}Project Onboarding{/magenta-fg} ",
      shadow: true,
    });

    // Content area (instructions / step header)
    const content = blessed.box({
      parent: modal,
      top: 0,
      left: 1,
      right: 1,
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Single-line textbox (for name and description steps)
    const textbox = blessed.textbox({
      parent: modal,
      top: 3,
      left: 1,
      right: 1,
      height: 3,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        fg: "white",
        bg: "black",
        focus: { border: { fg: "magenta" } },
      },
      inputOnFocus: true,
      hidden: true,
    });

    // Selection list (for type selection)
    const selectList = blessed.list({
      parent: modal,
      top: 3,
      left: 1,
      right: 1,
      height: "100%-8",
      tags: true,
      keys: true,
      vi: true,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" },
        bg: "black",
      },
      hidden: true,
    });

    // Info box (for scout summary display)
    const infoBox = blessed.box({
      parent: modal,
      top: 3,
      left: 1,
      right: 1,
      bottom: 4,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      style: { fg: "white", bg: "black" },
      hidden: true,
    });

    // Status line at bottom of modal
    const statusLine = blessed.box({
      parent: modal,
      bottom: 0,
      left: 1,
      right: 1,
      height: 1,
      tags: true,
      style: { fg: "gray", bg: "black" },
    });

    // Allow Ctrl+C to bail out
    screen.key(["C-c"], () => {
      cleanupScreen(screen);
      resolve(null);
    });

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    let projectType: ProjectType = "brownfield";
    let projectName = "";
    let projectDescription = "";
    let scoutResult = "";
    let scoutIndex: ScoutIndex | null = null;

    type Step = "type" | "scout_summary" | "name" | "description";
    const allSteps: Step[] = ["type", "scout_summary", "name", "description"];
    let currentStepIdx = 0;

    // -----------------------------------------------------------------------
    // Computed step list (scout_summary only if brownfield)
    // -----------------------------------------------------------------------

    function activeSteps(): Step[] {
      if (projectType === "brownfield") {
        return allSteps;
      }
      // Greenfield: skip scout_summary
      return allSteps.filter((s) => s !== "scout_summary");
    }

    function currentStep(): Step {
      return activeSteps()[currentStepIdx];
    }

    function stepCount(): number {
      return activeSteps().length;
    }

    // -----------------------------------------------------------------------
    // Step rendering
    // -----------------------------------------------------------------------

    function showStep(step: Step): void {
      textbox.hide();
      selectList.hide();
      infoBox.hide();

      const stepLabel = `Step ${currentStepIdx + 1}/${stepCount()}`;

      switch (step) {
        case "type": {
          content.setContent(
            `{bold}${stepLabel} -- Project Type{/bold}\n` +
            `{gray-fg}Is this a new project or an existing codebase?{/gray-fg}\n` +
            `{gray-fg}Esc to cancel{/gray-fg}`
          );
          statusLine.setContent("{gray-fg}Select your project type{/gray-fg}");
          selectList.setItems([
            "  {green-fg}\u25CF{/green-fg}  brownfield  {gray-fg}-- Existing codebase (will auto-scan){/gray-fg}",
            "  {cyan-fg}\u25CF{/cyan-fg}  greenfield  {gray-fg}-- New project from scratch{/gray-fg}",
          ] as any);
          const typeIdx = projectType === "brownfield" ? 0 : 1;
          selectList.select(typeIdx);
          selectList.show();
          selectList.focus();
          break;
        }

        case "scout_summary": {
          content.setContent(
            `{bold}${stepLabel} -- Codebase Scout Results{/bold}\n` +
            `{gray-fg}Auto-scan found the following structure{/gray-fg}\n` +
            `{gray-fg}Press Enter to continue, Esc to go back{/gray-fg}`
          );

          if (scoutIndex) {
            const fileCount = scoutIndex.files.length;
            const symbolCount = scoutIndex.totalSymbols;
            statusLine.setContent(
              `{cyan-fg}Found ${fileCount} file${fileCount === 1 ? "" : "s"} and ${symbolCount} symbol${symbolCount === 1 ? "" : "s"}{/cyan-fg}`
            );

            // Show a truncated version of the scout tree in the info box
            const treePreview = scoutResult.split("\n").slice(0, 30).join("\n");
            const truncNote = scoutResult.split("\n").length > 30
              ? "\n{gray-fg}... (truncated for display){/gray-fg}"
              : "";
            infoBox.setContent(escapeBlessedTags(treePreview) + truncNote);
          } else {
            statusLine.setContent(
              "{yellow-fg}Scout found no results (empty or unrecognized project){/yellow-fg}"
            );
            infoBox.setContent("{gray-fg}No codebase structure detected.{/gray-fg}");
          }

          infoBox.show();
          infoBox.focus();
          break;
        }

        case "name": {
          content.setContent(
            `{bold}${stepLabel} -- Project Name{/bold}\n` +
            `{gray-fg}What is the name of this project?{/gray-fg}\n` +
            `{gray-fg}Esc to go back{/gray-fg}`
          );
          statusLine.setContent(`{gray-fg}Type: ${projectType}{/gray-fg}`);
          textbox.setValue(projectName);
          textbox.show();
          textbox.focus();
          break;
        }

        case "description": {
          content.setContent(
            `{bold}${stepLabel} -- Project Description{/bold}\n` +
            `{gray-fg}Brief description of the project (optional){/gray-fg}\n` +
            `{gray-fg}Esc to go back{/gray-fg}`
          );
          statusLine.setContent(
            `{gray-fg}Type: ${projectType} | Name: ${projectName}{/gray-fg}`
          );
          textbox.setValue(projectDescription);
          textbox.show();
          textbox.focus();
          break;
        }
      }

      screen.render();
    }

    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------

    function goBack(): void {
      if (currentStepIdx <= 0) {
        cleanupScreen(screen);
        resolve(null);
        return;
      }
      currentStepIdx--;
      showStep(currentStep());
    }

    function advanceOrFinish(): void {
      currentStepIdx++;
      if (currentStepIdx >= stepCount()) {
        finishWizard();
        return;
      }
      showStep(currentStep());
    }

    // -----------------------------------------------------------------------
    // Scout phase (async, uses ProgressScreen)
    // -----------------------------------------------------------------------

    async function runScoutPhase(): Promise<void> {
      // Destroy the wizard screen temporarily for the ProgressScreen
      modal.hide();
      screen.render();

      // Use a separate ProgressScreen for the scout
      const progress = new ProgressScreen("Scanning codebase...", projectRoot);
      progress.start();
      progress.setStatus("Building codebase index...");

      try {
        const index = await buildScoutIndex(projectRoot);
        scoutIndex = index;
        scoutResult = formatScoutTree(index, {
          maxDepth: 4,
          showSymbolCounts: true,
          maxLines: 150,
        });

        const fileCount = index.files.length;
        const symbolCount = index.totalSymbols;
        progress.showSuccess(
          `Found ${fileCount} file${fileCount === 1 ? "" : "s"} and ${symbolCount} symbol${symbolCount === 1 ? "" : "s"}`
        );
        await progress.waitForDismiss(1500);
      } catch {
        // Graceful fallback: empty scout result
        scoutIndex = null;
        scoutResult = "";
        progress.showInfo("Scout completed with no results");
        await progress.waitForDismiss(1500);
      }

      progress.destroy();

      // Restore the wizard screen
      modal.show();
      screen.render();

      // Now advance to the scout_summary step
      advanceOrFinish();
    }

    // -----------------------------------------------------------------------
    // Finish
    // -----------------------------------------------------------------------

    function finishWizard(): void {
      const profile = createBlankProfile(projectName);
      profile.type = projectType;
      profile.description = projectDescription;
      profile.codebase_summary = scoutResult;

      // Show confirmation briefly
      content.setContent(
        `{bold}{green-fg}\u2714 Profile created!{/green-fg}{/bold}\n\n` +
        `  {white-fg}${escapeBlessedTags(projectName)}{/white-fg}\n` +
        `  Type: ${projectType}`
      );
      statusLine.setContent("{gray-fg}Continuing...{/gray-fg}");
      textbox.hide();
      selectList.hide();
      infoBox.hide();
      screen.render();

      setTimeout(() => {
        cleanupScreen(screen);
        resolve({
          profile,
          scoutIndex,
        });
      }, 1200);
    }

    // -----------------------------------------------------------------------
    // Input handlers
    // -----------------------------------------------------------------------

    // Selection list (type step)
    selectList.key(["enter", "space"], () => {
      if (currentStep() !== "type") return;
      const idx = (selectList as any).selected ?? 0;
      projectType = idx === 0 ? "brownfield" : "greenfield";

      if (projectType === "brownfield") {
        // After selecting brownfield, run the scout phase first
        // We need to advance past the "type" step, then the scout runs
        // and its callback advances to scout_summary
        currentStepIdx++; // Move to scout_summary position
        runScoutPhase();
      } else {
        advanceOrFinish();
      }
    });

    selectList.key(["escape"], () => {
      goBack();
    });

    // Textbox submit/cancel (for name and description steps)
    textbox.on("submit", (value: string) => {
      const trimmed = (value ?? "").trim();
      const step = currentStep();

      if (step === "name") {
        if (!trimmed) {
          statusLine.setContent("{red-fg}Name cannot be empty{/red-fg}");
          screen.render();
          textbox.focus();
          return;
        }
        projectName = trimmed;
        advanceOrFinish();
      } else if (step === "description") {
        projectDescription = trimmed;
        advanceOrFinish();
      }
    });

    textbox.on("cancel", () => {
      goBack();
    });

    // Info box navigation (scout_summary step)
    infoBox.key(["enter"], () => {
      if (currentStep() === "scout_summary") {
        advanceOrFinish();
      }
    });

    infoBox.key(["escape"], () => {
      if (currentStep() === "scout_summary") {
        goBack();
      }
    });

    // Start at step 0
    showStep(currentStep());
  });
}

// ---------------------------------------------------------------------------
// reviewSections — section-by-section review flow
// ---------------------------------------------------------------------------

/** Human-friendly names for each section. */
const SECTION_NAMES: Record<ProfileSection, string> = {
  identity: "Identity",
  vision: "Vision",
  objectives: "Objectives",
  tech_stack: "Tech Stack",
  conventions: "Conventions",
  rules: "Rules",
};

/**
 * Format a section of the profile as readable text for display using blessed tags.
 */
function formatSectionForDisplay(
  section: ProfileSection,
  profile: ProjectProfile,
): string {
  switch (section) {
    case "identity": {
      const lines: string[] = [];
      lines.push(`{bold}Name:{/bold} ${escapeBlessedTags(profile.name || "(not set)")}`);
      lines.push(`{bold}Type:{/bold} ${profile.type}`);
      lines.push(`{bold}Description:{/bold} ${escapeBlessedTags(profile.description || "(not set)")}`);
      return lines.join("\n");
    }

    case "vision": {
      if (!profile.vision) return "{gray-fg}(no vision set){/gray-fg}";
      return escapeBlessedTags(profile.vision);
    }

    case "objectives": {
      if (profile.objectives.length === 0) return "{gray-fg}(no objectives){/gray-fg}";
      const lines: string[] = [];
      for (const obj of profile.objectives) {
        const pColor =
          obj.priority === "high" ? "yellow" :
          obj.priority === "low" ? "gray" : "white";
        lines.push(
          `  {${pColor}-fg}[${obj.priority}]{/${pColor}-fg} ${escapeBlessedTags(obj.text)} {gray-fg}(${obj.status}){/gray-fg}`
        );
      }
      return lines.join("\n");
    }

    case "tech_stack": {
      const ts = profile.tech_stack;
      const lines: string[] = [];
      lines.push(`{bold}Runtime:{/bold}    ${escapeBlessedTags(ts.runtime || "(not set)")}`);
      lines.push(`{bold}Language:{/bold}   ${escapeBlessedTags(ts.language || "(not set)")}`);
      lines.push(`{bold}Frameworks:{/bold} ${ts.frameworks.length > 0 ? escapeBlessedTags(ts.frameworks.join(", ")) : "(none)"}`);
      lines.push(`{bold}Tools:{/bold}      ${ts.tools.length > 0 ? escapeBlessedTags(ts.tools.join(", ")) : "(none)"}`);
      if (ts.notes) lines.push(`{bold}Notes:{/bold}      ${escapeBlessedTags(ts.notes)}`);
      return lines.join("\n");
    }

    case "conventions": {
      const conv = profile.conventions;
      const lines: string[] = [];
      lines.push(`{bold}Commits:{/bold}      ${escapeBlessedTags(conv.commits || "(not set)")}`);
      lines.push(`{bold}Branches:{/bold}     ${escapeBlessedTags(conv.branches || "(not set)")}`);
      lines.push(`{bold}Testing:{/bold}      ${escapeBlessedTags(conv.testing || "(not set)")}`);
      lines.push(`{bold}Coding style:{/bold} ${escapeBlessedTags(conv.coding_style || "(not set)")}`);
      lines.push(`{bold}Naming:{/bold}       ${escapeBlessedTags(conv.naming || "(not set)")}`);
      return lines.join("\n");
    }

    case "rules": {
      if (profile.rules.length === 0) return "{gray-fg}(no rules){/gray-fg}";
      const lines: string[] = [];
      for (const rule of profile.rules) {
        const rColor =
          rule.rigidity === "hard" ? "red" :
          rule.rigidity === "preference" ? "gray" : "yellow";
        lines.push(
          `  {${rColor}-fg}[${rule.rigidity}]{/${rColor}-fg} {bold}${escapeBlessedTags(rule.scope)}{/bold}: ${escapeBlessedTags(rule.text)}`
        );
        if (rule.consequences) {
          lines.push(`    {gray-fg}Consequences: ${escapeBlessedTags(rule.consequences)}{/gray-fg}`);
        }
      }
      return lines.join("\n");
    }
  }
}

/**
 * Serialize a section of the profile as editable plain text.
 * The user edits this in a textarea and the result is parsed back.
 */
function serializeSectionForEdit(
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
          if (rule.consequences) line += ` (consequences: ${rule.consequences})`;
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
function parseSectionEdit(
  section: ProfileSection,
  text: string,
  profile: ProjectProfile,
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

/**
 * Parse rules from text that may include rigidity and scope.
 *
 * Supports the richer format produced by serializeSectionForEdit:
 *   [hard] runtime: Always use Bun (consequences: build breaks)
 *   [soft] general: Keep dependencies minimal
 *
 * Falls back to plain parseRules() if the format doesn't match.
 */
function parseRulesRich(raw: string): ProjectRule[] {
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

/**
 * Walk the user through a sequential section-by-section review of the
 * synthesized project profile.
 *
 * Uses blessed widgets (not console.log). Creates a full-screen blessed view
 * (or reuses a provided screen via the ownsScreen pattern).
 *
 * Layout:
 *   - Content box showing the current section's data, nicely formatted
 *   - Status bar showing "Section N/6 — SectionName" and keybinds
 *   - Keybinds: A = approve, R = revise, B = back, Q = cancel
 *
 * Sections reviewed:
 *   1. Identity (name, type, description)
 *   2. Vision
 *   3. Objectives (formatted list with priorities)
 *   4. Tech Stack (runtime, language, frameworks, tools)
 *   5. Conventions (commits, branches, testing, coding_style, naming)
 *   6. Rules (formatted with scope, rigidity, consequences)
 *
 * @param profile  — The synthesized profile to review.
 * @param screen   — Optional existing blessed screen to reuse.
 * @returns The approved (possibly edited) profile, or null if cancelled.
 */
export function reviewSections(
  profile: ProjectProfile,
  screen?: Widgets.Screen,
): Promise<{ approved: ProjectProfile | null }> {
  return new Promise<{ approved: ProjectProfile | null }>((resolve) => {
    // Deep-clone the profile so edits are non-destructive until approved
    const workingProfile: ProjectProfile = JSON.parse(JSON.stringify(profile));

    const ownsScreen = !screen;
    const scr = screen ?? blessed.screen({
      smartCSR: true,
      title: "wombo-combo -- Profile Review",
      fullUnicode: true,
    });

    // Track per-section approval
    const sections = [...PROFILE_SECTIONS]; // 6 sections
    const approved: Record<ProfileSection, boolean> = {
      identity: false,
      vision: false,
      objectives: false,
      tech_stack: false,
      conventions: false,
      rules: false,
    };

    let currentIdx = 0;
    let editMode = false;

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    const destroyScreen = () => {
      if (!ownsScreen) return;
      scr.destroy();
      if (process.stdin.isTTY) {
        try {
          process.stdin.removeAllListeners("keypress");
          process.stdin.removeAllListeners("data");
          if (typeof process.stdin.setRawMode === "function") {
            process.stdin.setRawMode(false);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
      process.stdout.write("\x1B[2J\x1B[H");
    };

    // -----------------------------------------------------------------------
    // Layout: full-screen view
    // -----------------------------------------------------------------------

    const container = blessed.box({
      parent: scr,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Header
    const headerBox = blessed.box({
      parent: container,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Content box — shows the section data
    const contentBox = blessed.box({
      parent: container,
      top: 3,
      left: 0,
      width: "100%",
      height: "100%-6",
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      border: { type: "line" },
      style: {
        border: { fg: "gray" },
        fg: "white",
        bg: "black",
      },
      padding: { left: 1, right: 1 },
    });

    // Status bar
    const statusBar = blessed.box({
      parent: container,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Edit textarea (hidden by default)
    const editArea = blessed.textarea({
      parent: container,
      top: 3,
      left: 0,
      width: "100%",
      height: "100%-6",
      border: { type: "line" },
      style: {
        border: { fg: "magenta" },
        fg: "white",
        bg: "black",
        focus: { border: { fg: "cyan" } },
      },
      inputOnFocus: true,
      hidden: true,
      padding: { left: 1, right: 1 },
    });

    contentBox.focus();

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    function currentSection(): ProfileSection {
      return sections[currentIdx];
    }

    function refreshView(): void {
      const sec = currentSection();
      const secName = SECTION_NAMES[sec];
      const secNum = currentIdx + 1;
      const totalSecs = sections.length;

      // Header
      const approvedCount = Object.values(approved).filter(Boolean).length;
      let headerLine1 = ` {bold}wombo-combo{/bold} {magenta-fg}Profile Review{/magenta-fg}`;
      headerLine1 += `  {gray-fg}|{/gray-fg}  {green-fg}${approvedCount}{/green-fg}/{gray-fg}${totalSecs} approved{/gray-fg}`;

      const isApproved = approved[sec];
      const badge = isApproved
        ? `  {green-fg}✔ APPROVED{/green-fg}`
        : `  {yellow-fg}● PENDING{/yellow-fg}`;
      const headerLine2 = ` {bold}Section ${secNum}/${totalSecs} — ${secName}{/bold}${badge}`;

      headerBox.setContent(`${headerLine1}\n${headerLine2}`);

      // Content
      const displayContent = formatSectionForDisplay(sec, workingProfile);
      contentBox.setContent(displayContent);
      contentBox.setLabel(` {cyan-fg}${secName}{/cyan-fg} `);
      contentBox.setScrollPerc(0);

      // Status bar
      let keys = ` {bold}Keys:{/bold}`;
      keys += `  {green-fg}A{/green-fg} approve`;
      keys += `  {magenta-fg}R{/magenta-fg} revise`;
      if (currentIdx > 0) keys += `  {cyan-fg}B{/cyan-fg} back`;
      keys += `  {red-fg}Q{/red-fg} cancel`;

      let status = ` {gray-fg}Section ${secNum}/${totalSecs} — ${secName}{/gray-fg}`;
      if (Object.values(approved).every(Boolean)) {
        status += `  {green-fg}All sections approved — press A on last section to finish{/green-fg}`;
      }

      statusBar.setContent(`${keys}\n${status}`);

      scr.render();
    }

    // -----------------------------------------------------------------------
    // Section navigation
    // -----------------------------------------------------------------------

    function advanceSection(): void {
      if (currentIdx < sections.length - 1) {
        currentIdx++;
        refreshView();
      } else {
        // On last section — check if all approved
        if (Object.values(approved).every(Boolean)) {
          finishReview();
        } else {
          // Find first unapproved section
          const firstUnapproved = sections.findIndex((s) => !approved[s]);
          if (firstUnapproved >= 0) {
            currentIdx = firstUnapproved;
            refreshView();
          }
        }
      }
    }

    function goBack(): void {
      if (currentIdx > 0) {
        currentIdx--;
        refreshView();
      }
    }

    function cancelReview(): void {
      container.destroy();
      destroyScreen();
      resolve({ approved: null });
    }

    function finishReview(): void {
      // Brief confirmation
      contentBox.setContent(
        `{bold}{green-fg}✔ Profile approved!{/green-fg}{/bold}\n\n` +
        `  All ${sections.length} sections have been reviewed and approved.\n` +
        `  {gray-fg}Continuing...{/gray-fg}`
      );
      statusBar.setContent(` {gray-fg}Finishing...{/gray-fg}`);
      scr.render();

      setTimeout(() => {
        container.destroy();
        destroyScreen();
        resolve({ approved: workingProfile });
      }, 1200);
    }

    // -----------------------------------------------------------------------
    // Edit mode
    // -----------------------------------------------------------------------

    function enterEditMode(): void {
      if (editMode) return;
      editMode = true;

      const sec = currentSection();
      const editText = serializeSectionForEdit(sec, workingProfile);

      contentBox.hide();
      editArea.setValue(editText);
      editArea.show();
      editArea.focus();

      // Update status bar for edit mode
      const secName = SECTION_NAMES[sec];
      statusBar.setContent(
        ` {bold}Editing:{/bold} {magenta-fg}${secName}{/magenta-fg}\n` +
        ` {gray-fg}Enter = save changes  |  Escape = discard changes{/gray-fg}`
      );

      headerBox.setContent(
        ` {bold}wombo-combo{/bold} {magenta-fg}Profile Review{/magenta-fg}  {gray-fg}|{/gray-fg}  {magenta-fg}EDITING{/magenta-fg}\n` +
        ` {bold}Section ${currentIdx + 1}/${sections.length} — ${secName}{/bold}  {magenta-fg}✎ Edit mode{/magenta-fg}`
      );

      scr.render();
    }

    function exitEditMode(save: boolean): void {
      if (!editMode) return;
      editMode = false;

      if (save) {
        const editedText = editArea.getValue() ?? "";
        const sec = currentSection();
        const patch = parseSectionEdit(sec, editedText, workingProfile);

        // Apply patch to working profile
        Object.assign(workingProfile, patch);

        // Deep-merge for nested objects
        if (patch.tech_stack) {
          workingProfile.tech_stack = { ...workingProfile.tech_stack, ...patch.tech_stack };
        }
        if (patch.conventions) {
          workingProfile.conventions = { ...workingProfile.conventions, ...patch.conventions };
        }

        // Reset approval for this section since content changed
        approved[sec] = false;
      }

      editArea.hide();
      contentBox.show();
      contentBox.focus();
      refreshView();
    }

    // -----------------------------------------------------------------------
    // Key bindings
    // -----------------------------------------------------------------------

    // Edit area keybinds
    editArea.key(["enter"], () => {
      exitEditMode(true);
    });

    editArea.key(["escape"], () => {
      exitEditMode(false);
    });

    // Main screen keybinds
    scr.key(["a"], () => {
      if (editMode) return;
      const sec = currentSection();
      approved[sec] = true;
      advanceSection();
    });

    scr.key(["r"], () => {
      if (editMode) return;
      enterEditMode();
    });

    scr.key(["b"], () => {
      if (editMode) return;
      goBack();
    });

    scr.key(["q", "escape"], () => {
      if (editMode) return;
      cancelReview();
    });

    scr.key(["C-c"], () => {
      if (editMode) {
        exitEditMode(false);
        return;
      }
      cancelReview();
    });

    // Initial render
    refreshView();
  });
}

// ---------------------------------------------------------------------------
// showSectionMenu — section-menu editor for existing profiles
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
function summarizeSection(
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
      const truncated = profile.vision.length > 60
        ? profile.vision.slice(0, 57) + "..."
        : profile.vision;
      return truncated;
    }

    case "objectives": {
      if (profile.objectives.length === 0) return "(no objectives)";
      const highCount = profile.objectives.filter((o) => o.priority === "high").length;
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
      const filled = Object.values(conv).filter((v) => v && v.trim()).length;
      if (filled === 0) return "(no conventions set)";
      return `${filled}/5 fields set`;
    }

    case "rules": {
      if (profile.rules.length === 0) return "(no rules)";
      return `${profile.rules.length} rule${profile.rules.length === 1 ? "" : "s"}`;
    }
  }
}

/**
 * Show a blessed selectList of the 6 profile sections plus a
 * "Re-run LLM synthesis" option. Each item shows the section name and a
 * one-line summary of current content.
 *
 * Uses the ownsScreen pattern: if no screen is provided, creates and manages
 * its own. Otherwise, renders as a modal on the provided screen.
 *
 * @param profile — The current project profile.
 * @param screen  — Optional existing blessed screen to reuse.
 * @returns An action indicating what the user chose:
 *   - { action: 'edit', section: ProfileSection } — user wants to edit a section
 *   - { action: 'resynthesize' } — user wants to re-run LLM synthesis
 *   - { action: 'back' } — user pressed Escape / cancelled
 */
export function showSectionMenu(
  profile: ProjectProfile,
  screen?: Widgets.Screen,
): Promise<
  | { action: "edit"; section: ProfileSection }
  | { action: "resynthesize" }
  | { action: "back" }
> {
  return new Promise((resolve) => {
    const ownsScreen = !screen;
    const scr =
      screen ??
      blessed.screen({
        smartCSR: true,
        title: "wombo-combo -- Edit Profile",
        fullUnicode: true,
      });

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    const destroyScreen = () => {
      if (!ownsScreen) return;
      scr.destroy();
      if (process.stdin.isTTY) {
        try {
          process.stdin.removeAllListeners("keypress");
          process.stdin.removeAllListeners("data");
          if (typeof process.stdin.setRawMode === "function") {
            process.stdin.setRawMode(false);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
      process.stdout.write("\x1B[2J\x1B[H");
    };

    // -----------------------------------------------------------------------
    // Layout
    // -----------------------------------------------------------------------

    const container = blessed.box({
      parent: scr,
      top: "center",
      left: "center",
      width: "70%",
      height: "80%",
      tags: true,
      border: { type: "line" },
      style: {
        border: { fg: "magenta" },
        fg: "white",
        bg: "black",
      },
      label: " {magenta-fg}Edit Profile{/magenta-fg} ",
      shadow: true,
    });

    // Header
    const headerBox = blessed.box({
      parent: container,
      top: 0,
      left: 1,
      right: 1,
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });
    headerBox.setContent(
      `{bold}Select a section to edit{/bold}\n` +
        `{gray-fg}Use arrow keys to navigate, Enter to select{/gray-fg}\n` +
        `{gray-fg}Esc to go back{/gray-fg}`
    );

    // Build menu items: 6 sections + resynthesize
    const menuItems: string[] = [];
    for (const sec of PROFILE_SECTIONS) {
      const name = SECTION_NAMES[sec];
      const summary = escapeBlessedTags(summarizeSection(sec, profile));
      menuItems.push(
        `  {cyan-fg}${name}{/cyan-fg}  {gray-fg}— ${summary}{/gray-fg}`
      );
    }
    menuItems.push(
      `  {magenta-fg}Re-run LLM synthesis{/magenta-fg}  {gray-fg}— regenerate profile from scratch{/gray-fg}`
    );

    const selectList = blessed.list({
      parent: container,
      top: 3,
      left: 1,
      right: 1,
      height: "100%-6",
      tags: true,
      keys: true,
      vi: true,
      border: { type: "line" },
      style: {
        border: { fg: "cyan" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { fg: "white" },
        bg: "black",
      },
    });
    selectList.setItems(menuItems as any);
    selectList.select(0);

    // Status line
    const statusLine = blessed.box({
      parent: container,
      bottom: 0,
      left: 1,
      right: 1,
      height: 1,
      tags: true,
      style: { fg: "gray", bg: "black" },
    });
    statusLine.setContent(
      "{gray-fg}Enter: select  |  Esc: back{/gray-fg}"
    );

    selectList.focus();
    scr.render();

    // -----------------------------------------------------------------------
    // Input handlers
    // -----------------------------------------------------------------------

    let resolved = false;

    const finish = (
      result:
        | { action: "edit"; section: ProfileSection }
        | { action: "resynthesize" }
        | { action: "back" }
    ) => {
      if (resolved) return;
      resolved = true;
      container.destroy();
      destroyScreen();
      resolve(result);
    };

    selectList.key(["enter", "space"], () => {
      const idx = (selectList as any).selected ?? 0;
      if (idx < PROFILE_SECTIONS.length) {
        finish({ action: "edit", section: PROFILE_SECTIONS[idx] });
      } else {
        finish({ action: "resynthesize" });
      }
    });

    selectList.key(["escape"], () => {
      finish({ action: "back" });
    });

    scr.key(["C-c"], () => {
      finish({ action: "back" });
    });
  });
}

// ---------------------------------------------------------------------------
// editSingleSection — textarea editor for a single profile section
// ---------------------------------------------------------------------------

/**
 * Open a textarea pre-populated with the section's current content formatted
 * as editable text. The user edits the text, and the result is parsed back
 * into the profile.
 *
 * Uses the ownsScreen pattern: if no screen is provided, creates and manages
 * its own. Otherwise, renders as a modal on the provided screen.
 *
 * @param profile — The current project profile (not mutated).
 * @param section — Which section to edit.
 * @param screen  — Optional existing blessed screen to reuse.
 * @returns The updated profile with the edited section applied.
 */
export function editSingleSection(
  profile: ProjectProfile,
  section: ProfileSection,
  screen?: Widgets.Screen,
): Promise<ProjectProfile> {
  return new Promise((resolve) => {
    // Deep-clone the profile so edits are non-destructive
    const workingProfile: ProjectProfile = JSON.parse(
      JSON.stringify(profile)
    );

    const ownsScreen = !screen;
    const scr =
      screen ??
      blessed.screen({
        smartCSR: true,
        title: "wombo-combo -- Edit Section",
        fullUnicode: true,
      });

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    const destroyScreen = () => {
      if (!ownsScreen) return;
      scr.destroy();
      if (process.stdin.isTTY) {
        try {
          process.stdin.removeAllListeners("keypress");
          process.stdin.removeAllListeners("data");
          if (typeof process.stdin.setRawMode === "function") {
            process.stdin.setRawMode(false);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
      process.stdout.write("\x1B[2J\x1B[H");
    };

    // -----------------------------------------------------------------------
    // Layout
    // -----------------------------------------------------------------------

    const secName = SECTION_NAMES[section];

    const container = blessed.box({
      parent: scr,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Header
    const headerBox = blessed.box({
      parent: container,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });
    headerBox.setContent(
      ` {bold}wombo-combo{/bold} {magenta-fg}Edit Section{/magenta-fg}\n` +
        ` {bold}${secName}{/bold}  {magenta-fg}✎ Edit mode{/magenta-fg}\n` +
        ` {gray-fg}Edit the content below, then press Ctrl+S to save or Escape to discard{/gray-fg}`
    );

    // Edit textarea
    const editArea = blessed.textarea({
      parent: container,
      top: 3,
      left: 0,
      width: "100%",
      height: "100%-6",
      border: { type: "line" },
      style: {
        border: { fg: "magenta" },
        fg: "white",
        bg: "black",
        focus: { border: { fg: "cyan" } },
      },
      inputOnFocus: true,
      label: ` {cyan-fg}${secName}{/cyan-fg} `,
      padding: { left: 1, right: 1 },
    });

    // Status bar
    const statusBar = blessed.box({
      parent: container,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      style: { fg: "white", bg: "black" },
    });
    statusBar.setContent(
      ` {bold}Keys:{/bold}  {green-fg}Ctrl+S{/green-fg} save  |  {red-fg}Escape{/red-fg} discard\n` +
        ` {gray-fg}Editing: ${secName}{/gray-fg}`
    );

    // Pre-populate with serialized section content
    const editText = serializeSectionForEdit(section, workingProfile);
    editArea.setValue(editText);
    editArea.focus();
    scr.render();

    // -----------------------------------------------------------------------
    // Input handlers
    // -----------------------------------------------------------------------

    let resolved = false;

    const finishSave = () => {
      if (resolved) return;
      resolved = true;

      const editedText = editArea.getValue() ?? "";
      const patch = parseSectionEdit(section, editedText, workingProfile);

      // Apply patch to working profile
      Object.assign(workingProfile, patch);

      // Deep-merge for nested objects
      if (patch.tech_stack) {
        workingProfile.tech_stack = {
          ...workingProfile.tech_stack,
          ...patch.tech_stack,
        };
      }
      if (patch.conventions) {
        workingProfile.conventions = {
          ...workingProfile.conventions,
          ...patch.conventions,
        };
      }

      workingProfile.updated_at = new Date().toISOString();

      container.destroy();
      destroyScreen();
      resolve(workingProfile);
    };

    const finishDiscard = () => {
      if (resolved) return;
      resolved = true;
      container.destroy();
      destroyScreen();
      // Return original profile unchanged
      resolve(profile);
    };

    // Ctrl+S to save
    scr.key(["C-s"], () => {
      finishSave();
    });

    // Enter to save (same as reviewSections edit mode)
    editArea.key(["enter"], () => {
      finishSave();
    });

    // Escape to discard
    editArea.key(["escape"], () => {
      finishDiscard();
    });

    scr.key(["C-c"], () => {
      finishDiscard();
    });
  });
}

// ---------------------------------------------------------------------------
// Internal parsers (for structureRawInputs)
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
// Public API — structureRawInputs
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
