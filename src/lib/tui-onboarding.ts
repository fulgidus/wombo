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

import blessed from "neo-blessed";
import type { Widgets } from "neo-blessed";
import { buildScoutIndex, formatScoutTree } from "./subagents/scout.js";
import type { ScoutIndex } from "./subagents/scout.js";
import { ProgressScreen } from "./tui-progress.js";
import {
  createBlankProfile,
  type ProjectProfile,
  type ProjectType,
  type ProjectObjective,
  type ProjectRule,
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
