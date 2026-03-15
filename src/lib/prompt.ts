/**
 * prompt.ts — Generate agent prompts from feature specs.
 *
 * Responsibilities:
 *   - Transform a Feature into a structured prompt for the agent
 *   - Include feature spec, subtasks, constraints, forbidden items, references
 *   - Generate the build command and success criteria
 *   - Inject scoped file manifests and shared knowledge for context reduction
 *   - All project-specific values come from config (no hardcoded Astro references)
 */

import type { Feature, Subtask } from "./tasks.js";
import { formatDuration, parseDurationMinutes } from "./tasks.js";
import type { WomboConfig } from "../config.js";
import { isPortlessAvailable, portlessUrl } from "./portless.js";
import type { QuestHitlMode } from "./quest.js";
import { compressConstraints, compressSource } from "./prompt-compress.js";
import { formatHunksForLLM, type Tier25Result } from "./conflict-hunks.js";

// ---------------------------------------------------------------------------
// Quest Context (optional — passed when launching within a quest)
// ---------------------------------------------------------------------------

/**
 * Contextual information about the quest a task belongs to.
 * Used to enrich the agent prompt with quest-level goals and constraints.
 */
export interface QuestPromptContext {
  /** Quest ID */
  questId: string;
  /** Human-readable quest goal */
  goal: string;
  /** Extra constraints from the quest (already merged into the task) */
  addedConstraints: string[];
  /** Extra forbidden items from the quest (already merged into the task) */
  addedForbidden: string[];
  /** Quest knowledge document (shared architectural notes, API contracts, etc.) */
  knowledge: string | null;
  /**
   * Scoped file manifest — files predicted by the planner as relevant to this
   * task. When provided, injected as a structured "Files You'll Need" section
   * that gives the agent a head start on exploring the codebase.
   */
  fileManifest?: string[];
}

// ---------------------------------------------------------------------------
// Prompt Generation
// ---------------------------------------------------------------------------

/**
 * Generate the full prompt for an autonomous agent working on a feature.
 *
 * @param quest - Optional quest context. When provided, injects a Quest Context
 *                section and knowledge into the prompt so agents understand
 *                the broader mission they are contributing to.
 * @param hitlMode - Optional HITL mode. When "cautious" or "supervised", injects
 *                   instructions for using the query_human tool to ask the
 *                   human operator questions.
 */
export function generatePrompt(
  feature: Feature,
  baseBranch: string,
  config: WomboConfig,
  quest?: QuestPromptContext,
  hitlMode?: QuestHitlMode
): string {
  const sections: string[] = [];

  // Header
  sections.push(`# Feature Implementation: ${feature.title}`);
  sections.push(`**Feature ID:** \`${feature.id}\``);
  sections.push(`**Branch:** \`${config.git.branchPrefix}${feature.id}\``);
  sections.push(`**Base:** \`${baseBranch}\``);
  sections.push(
    `**Estimated Effort:** ${formatDuration(parseDurationMinutes(feature.effort))}`
  );
  sections.push(
    `**Difficulty:** ${feature.difficulty} | **Priority:** ${feature.priority}`
  );

  // Description
  sections.push(`\n## Description\n`);
  sections.push(feature.description.trim());

  // Subtasks
  if (feature.subtasks.length > 0) {
    sections.push(`\n## Subtasks\n`);
    sections.push(
      "Complete these in order. Mark each done with a commit when finished.\n"
    );
    for (let i = 0; i < feature.subtasks.length; i++) {
      sections.push(formatSubtask(feature.subtasks[i], i + 1, 0));
    }
  }

  // Constraints (compressed to reduce tokens)
  if (feature.constraints.length > 0) {
    sections.push(`\n## Constraints\n`);
    sections.push(
      "You MUST follow these constraints. Violating any is a failure.\n"
    );
    const compressed = compressConstraints(feature.constraints);
    for (const c of compressed) {
      sections.push(`- ${c}`);
    }
  }

  // Forbidden (compressed to reduce tokens)
  if (feature.forbidden.length > 0) {
    sections.push(`\n## Forbidden\n`);
    sections.push(
      "You MUST NOT do any of the following. Violating any is a failure.\n"
    );
    const compressed = compressConstraints(feature.forbidden);
    for (const f of compressed) {
      sections.push(`- ${f}`);
    }
  }

  // References (files to explore)
  if (feature.references.length > 0) {
    sections.push(`\n## Key Files to Explore\n`);
    sections.push(
      "Start by reading these files to understand the current state:\n"
    );
    for (const r of feature.references) {
      sections.push(`- \`${r}\``);
    }
  }

  // Scoped file manifest (from planner predictions, if available)
  if (quest?.fileManifest && quest.fileManifest.length > 0) {
    // Deduplicate with references (don't show files twice)
    const refSet = new Set(feature.references.map((r) => r.toLowerCase()));
    const manifestOnly = quest.fileManifest.filter(
      (f) => !refSet.has(f.toLowerCase())
    );

    if (manifestOnly.length > 0) {
      sections.push(`\n## Predicted File Manifest\n`);
      sections.push(
        "The quest planner predicts these additional files are relevant to this task. " +
        "Use this as a starting point — you may discover other files are needed too.\n"
      );
      for (const f of manifestOnly) {
        sections.push(`- \`${f}\``);
      }
    }
  }

  // Notes
  if (feature.notes.length > 0) {
    sections.push(`\n## Planning Notes\n`);
    for (const n of feature.notes) {
      sections.push(`- ${n}`);
    }
  }

  // Quest context — injected when this task is part of a quest
  if (quest) {
    sections.push(`\n## Quest Context\n`);
    sections.push(
      `This task is part of **Quest \`${quest.questId}\`**.\n`
    );
    sections.push(`**Quest Goal:** ${quest.goal}\n`);
    sections.push(
      `Your work on this task contributes to the quest's overall goal. ` +
      `Keep the quest goal in mind when making design decisions.\n`
    );
    if (quest.addedConstraints.length > 0) {
      sections.push(`**Quest-level constraints** (already included in Constraints above):\n`);
      for (const c of quest.addedConstraints) {
        sections.push(`- ${c}`);
      }
      sections.push("");
    }
    if (quest.addedForbidden.length > 0) {
      sections.push(`**Quest-level forbidden items** (already included in Forbidden above):\n`);
      for (const f of quest.addedForbidden) {
        sections.push(`- ${f}`);
      }
      sections.push("");
    }
    if (quest.knowledge) {
      sections.push(`### Shared Knowledge\n`);
      sections.push(
        `The following knowledge document contains architectural decisions, ` +
        `API contracts, and shared context discovered during quest planning. ` +
        `Read this carefully — it prevents you from re-discovering things ` +
        `that other agents have already figured out.\n`
      );
      sections.push("---");
      sections.push(quest.knowledge.trim());
      sections.push("---\n");
    }

    // Knowledge contribution instructions
    sections.push(`### Knowledge Contributions\n`);
    sections.push(
      `If you discover important architectural decisions, API contracts, ` +
      `or patterns that would help other agents working on this quest, ` +
      `document them clearly in your commit messages and code comments. ` +
      `The orchestrator will extract these for the shared knowledge cache.`
    );
    sections.push("");
  }

  // Build verification — uses config, no hardcoded Astro command
  sections.push(`\n## Build Verification\n`);
  sections.push(
    "After completing all changes, run the build to verify everything works:\n"
  );
  sections.push("```bash");
  sections.push(config.build.command);
  sections.push("```\n");
  sections.push(
    "If the build fails, fix the errors before considering the task complete."
  );

  // Browser testing — inform agents about browser verification capabilities
  if (config.browser.enabled) {
    sections.push(`\n## Browser Testing\n`);
    sections.push(
      "This project has browser-based verification enabled. After the build passes, " +
      "browser tests will run automatically as part of the verification pipeline.\n"
    );
    sections.push("To add browser tests for this feature:\n");
    sections.push("1. Create the directory `.wombo-browser/tests/` in the worktree root");
    sections.push("2. Add test scripts (`.sh`, `.ts`, or `.js` files) that will be executed in order");
    sections.push("3. Each test script receives these environment variables:");
    sections.push("   - `BROWSER_DEBUG_PORT` — Chrome DevTools Protocol port");
    sections.push("   - `BROWSER_WS_ENDPOINT` — WebSocket endpoint for the browser");
    sections.push("   - `BROWSER_HEADLESS` — whether the browser is running headless");
    sections.push("   - `BROWSER_SCREENSHOT_PATH` — path to save a screenshot for this test");
    sections.push("4. A test passes if it exits with code 0, fails otherwise\n");
    if (config.browser.testCommand) {
      sections.push(
        `Alternatively, the project uses a custom browser test command: \`${config.browser.testCommand}\``
      );
    }
    sections.push(
      "\nBrowser tests are optional — if no tests are found, browser verification is skipped."
    );
  }

  // Portless server testing instructions
  if (config.portless.enabled && isPortlessAvailable(config)) {
    sections.push(`\n## Server Testing (portless)\n`);
    sections.push(
      "This worktree is configured with **portless** to prevent port collisions " +
      "between concurrent agents. When starting any localhost server for testing:\n"
    );
    sections.push("```bash");
    sections.push("# Instead of running a server directly:");
    sections.push("#   npm run dev");
    sections.push("#   bun run dev");
    sections.push("#   node server.js");
    sections.push("");
    sections.push("# Wrap it with portless:");
    sections.push(`portless run npm run dev`);
    sections.push(`portless run bun run dev`);
    sections.push(`portless run node server.js`);
    sections.push("```\n");
    sections.push(
      `Your dev server will be available at: \`${portlessUrl(feature.id, config)}\``
    );
    sections.push("");
    sections.push("**Rules:**");
    sections.push("- ALWAYS use `portless run <command>` when starting any server that listens on a port");
    sections.push("- Do NOT hardcode port numbers — portless assigns ports automatically via the `PORT` env var");
    sections.push("- The `PORT` and `PORTLESS_URL` environment variables are set automatically");
    sections.push("- If you need to reference the server URL in tests or config, use the `PORTLESS_URL` env var");
  }

  // TDD instructions — deterministic injection based on config
  if (config.tdd?.enabled) {
    const testCmd = config.tdd.testCommand || "bun test";
    const strictLabel = config.tdd.strictTdd
      ? "**Strict TDD is ON** — every new source file MUST have a corresponding test file, or verification will fail."
      : "TDD is enabled in advisory mode. Missing tests produce warnings but do not block verification. Use `--strict-tdd` to enforce.";
    sections.push(`\n## Test-Driven Development (TDD)\n`);
    sections.push(strictLabel);
    sections.push(
      "\nYou MUST follow the **red-green-refactor** TDD cycle for all implementation work:\n"
    );
    sections.push("### Workflow\n");
    sections.push(`1. **🔴 Red** — Write a failing test first. Run \`${testCmd}\` to confirm it fails.`);
    sections.push(`2. **🟢 Green** — Write minimal code to make the test pass. Run \`${testCmd}\` to confirm.`);
    sections.push(`3. **🔵 Refactor** — Clean up while keeping tests green. Run \`${testCmd}\` after each change.`);
    sections.push(`4. **Repeat** for each new behavior or edge case.\n`);
    sections.push("### Rules\n");
    sections.push("- **Never skip the red step.** Every new behavior starts with a failing test.");
    sections.push("- **One behavior per cycle.** Each iteration covers exactly one small behavior.");
    sections.push("- **Commit at green.** Each commit should have all tests passing.");
    sections.push(`- **Run tests frequently.** Run \`${testCmd}\` after every meaningful change.`);
    sections.push("- Use `import { describe, test, expect } from \"bun:test\";` for test files.");
    sections.push("- Place tests next to source: `src/foo.ts` → `src/foo.test.ts` (or `tests/foo.test.ts`).");
    sections.push("\n### Non-Testable Changes\n");
    sections.push(
      "The following types of files are **exempt** from TDD requirements — " +
      "you do NOT need to write tests for them:\n"
    );
    sections.push("- Documentation files (`.md`, `.mdx`, `.txt`)");
    sections.push("- Configuration files (`.json`, `.yml`, `.yaml`, `.toml`, `.env`)");
    sections.push("- Type declaration files (`.d.ts`)");
    sections.push("- Re-export barrel files (`index.ts` with only `export ... from` statements)");
    sections.push("- Types-only files (containing only `type`, `interface`, or `enum` declarations)");
    sections.push("- Asset files (images, SVGs, CSS)");
    sections.push("\n### Verification\n");
    sections.push(
      "After all changes are complete, the verification pipeline will automatically:"
    );
    sections.push(`1. Run \`${testCmd}\` and verify all tests pass`);
    sections.push("2. Check that every new/modified source file has a corresponding test file");
    sections.push("3. Report coverage ratio of tested vs untested files");
    if (config.tdd.strictTdd) {
      sections.push(
        "\n**⚠️ Strict mode is active.** Verification will FAIL if any testable source file is missing a test."
      );
    }
  }

  // HITL — Human-in-the-Loop instructions
  if (hitlMode && hitlMode !== "yolo") {
    sections.push(`\n## Human-in-the-Loop\n`);

    sections.push(
      "You can ask the human operator questions using the `hitl-ask` command via bash.\n"
    );
    sections.push("```bash");
    sections.push("bun $WOMBO_HITL_ASK \"Your question here\"");
    sections.push("```\n");
    sections.push(
      "The command will **block** until the human responds. Their answer will be " +
      "printed to stdout. Use this when you need clarification or approval.\n"
    );
    sections.push(
      "You can optionally provide context about what you're working on:\n"
    );
    sections.push("```bash");
    sections.push("bun $WOMBO_HITL_ASK --context \"working on auth middleware\" \"Should I use JWT or session cookies?\"");
    sections.push("```\n");

    if (hitlMode === "cautious") {
      sections.push(
        "**HITL Mode: Cautious** — Ask the human when you are genuinely uncertain " +
        "about a design decision, encounter an ambiguous requirement, or face a " +
        "choice that could significantly affect the project. If the answer is " +
        "reasonably clear from the codebase or requirements, proceed without asking."
      );
    } else if (hitlMode === "supervised") {
      sections.push(
        "**HITL Mode: Supervised** — You are expected to check in frequently. " +
        "Ask the human before:\n" +
        "- Making architectural decisions\n" +
        "- Choosing between alternative approaches\n" +
        "- Adding new dependencies\n" +
        "- Modifying existing public APIs\n" +
        "- Any change that affects other parts of the system\n\n" +
        "When in doubt, ask. The human prefers to be consulted rather than surprised."
      );
    }

    sections.push("");
  }

  // Commit guidelines
  sections.push(`\n## Commit Guidelines\n`);
  sections.push("- Use conventional commits: `feat(scope):`, `fix(scope):`, `refactor(scope):`, `docs(scope):`");
  sections.push(`- Scope should be: \`${feature.id}\` or a relevant module name`);
  sections.push("- Commit after each logical unit of work (roughly per subtask)");
  sections.push("- Do NOT squash all changes into one commit");
  sections.push("- Do NOT push to remote -- the orchestrator handles that");
  sections.push(`- Do NOT modify \`${config.tasksDir}\` -- the orchestrator handles that`);

  // Final instruction
  sections.push(`\n## Execution\n`);
  sections.push("1. Read the key files listed above to understand the codebase");
  sections.push("2. Create a plan (use the TodoWrite tool)");
  if (config.tdd?.enabled) {
    const testCmd = config.tdd.testCommand || "bun test";
    sections.push("3. For each subtask, follow the TDD cycle: write a failing test, make it pass, refactor");
    sections.push("4. Commit after each green cycle");
    sections.push(`5. Run \`${testCmd}\` to verify all tests pass`);
    sections.push(`6. Run \`${config.build.command}\` to verify the build`);
    sections.push("7. If tests or build fail, fix the errors and re-run until both pass");
  } else {
    sections.push("3. Implement each subtask, committing as you go");
    sections.push(`4. Run \`${config.build.command}\` to verify`);
    sections.push("5. If the build passes, you are done");
    sections.push("6. If the build fails, fix the errors and re-run until it passes");
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Subtask Formatting
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Conflict Resolution Prompt
// ---------------------------------------------------------------------------

/**
 * Additional context for enriched conflict resolution prompts (Tier 3).
 * Contains structured hunk data from Tier 2.5 and git diffs.
 */
export interface ConflictResolutionContext {
  /** Structured hunk data from Tier 2.5 (if available) */
  tier25Result?: Tier25Result;
  /** Output of `git diff base...feature` — what the feature changed */
  featureDiff?: string;
  /** Output of `git diff base...HEAD` — what upstream changed */
  upstreamDiff?: string;
}

/**
 * Generate a prompt for an agent that resolves merge conflicts.
 *
 * Tier 3 (enriched): When Tier 2.5 structured hunk data is provided, the prompt
 * includes parsed conflict hunks with base/ours/theirs content, classification
 * metadata, and contextual diffs — giving the LLM much better information than
 * raw conflict markers.
 *
 * The agent is launched in the feature worktree AFTER `git merge <baseBranch>`
 * has been run there, leaving conflict markers in the working tree.
 *
 * @param feature - The feature being merged
 * @param baseBranch - The base branch being merged from
 * @param mergeError - Raw merge error output
 * @param config - Project configuration
 * @param quest - Optional quest context
 * @param conflictContext - Optional structured conflict data from Tier 2.5
 */
export function generateConflictResolutionPrompt(
  feature: Feature,
  baseBranch: string,
  mergeError: string,
  config: WomboConfig,
  quest?: QuestPromptContext,
  conflictContext?: ConflictResolutionContext
): string {
  const sections: string[] = [];

  sections.push(`# Merge Conflict Resolution: ${feature.title}`);
  sections.push(`**Feature ID:** \`${feature.id}\``);
  sections.push(`**Feature Branch:** \`${config.git.branchPrefix}${feature.id}\``);
  sections.push(`**Base Branch:** \`${baseBranch}\``);

  sections.push(`\n## Situation\n`);
  sections.push(
    `The feature branch \`${config.git.branchPrefix}${feature.id}\` has been completed and build-verified, ` +
    `but merging it into \`${baseBranch}\` produced conflicts. The base branch (\`${baseBranch}\`) has been ` +
    `merged INTO this feature branch's worktree, so the conflict markers are present in the working tree right now.`
  );

  // Tier 2.5 surgical resolution summary
  if (conflictContext?.tier25Result) {
    const t25 = conflictContext.tier25Result;
    sections.push(`\n## Pre-Resolution Summary (Automated)\n`);
    sections.push(
      `An automated tier 2.5 surgical resolver already processed the conflicts:\n` +
      `- **${t25.resolvedHunkCount}** of **${t25.totalHunks}** hunks resolved programmatically\n` +
      `- **${t25.resolvedFiles.length}** file(s) fully resolved: ${t25.resolvedFiles.join(", ") || "(none)"}\n` +
      `- **${t25.unresolvedFiles.length}** file(s) still need your help: ${t25.unresolvedFiles.join(", ")}\n\n` +
      `The resolved hunks have already been applied. You only need to handle the remaining unresolved hunks below.`
    );
  }

  // Structured conflict hunks (Tier 3 enrichment)
  if (conflictContext?.tier25Result) {
    const hunkText = formatHunksForLLM(conflictContext.tier25Result.fileResults);
    if (hunkText.trim()) {
      sections.push(`\n## Unresolved Conflict Hunks\n`);
      sections.push(
        `Each hunk below shows the **base** (common ancestor), **ours** (your feature), ` +
        `and **theirs** (upstream changes). Your job is to produce a merged version that ` +
        `preserves the intent of both sides.\n`
      );
      sections.push(hunkText);
    }
  }

  // Feature description
  sections.push(`\n## Feature Description\n`);
  sections.push(feature.description.trim());

  // Quest context (if task is part of a quest)
  if (quest) {
    sections.push(`\n## Quest Context\n`);
    sections.push(
      `This task is part of **Quest \`${quest.questId}\`** with goal: ${quest.goal}\n`
    );
    sections.push(
      `Keep the quest goal in mind when resolving conflicts — prefer resolutions ` +
      `that align with the quest's intent.`
    );
  }

  // Contextual diffs — what each side changed
  if (conflictContext?.featureDiff || conflictContext?.upstreamDiff) {
    sections.push(`\n## Contextual Diffs\n`);
    sections.push(
      `These diffs show what each side changed relative to the common ancestor. ` +
      `Use them to understand the intent behind each change.\n`
    );

    if (conflictContext.featureDiff) {
      sections.push(`### Feature Branch Changes (what you implemented)\n`);
      sections.push("```diff");
      // Truncate if very large to avoid overwhelming the LLM
      const featureDiff = truncateDiff(conflictContext.featureDiff, 5000);
      sections.push(featureDiff);
      sections.push("```");
    }

    if (conflictContext.upstreamDiff) {
      sections.push(`\n### Upstream Changes (what others merged into ${baseBranch})\n`);
      sections.push("```diff");
      const upstreamDiff = truncateDiff(conflictContext.upstreamDiff, 5000);
      sections.push(upstreamDiff);
      sections.push("```");
    }
  }

  // Merge error output (fallback context when structured data isn't available)
  if (!conflictContext?.tier25Result) {
    sections.push(`\n## Merge Error Output\n`);
    sections.push("```");
    sections.push(mergeError);
    sections.push("```");
  }

  sections.push(`\n## Your Task\n`);
  sections.push("1. Find all files with conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)");
  sections.push("2. Resolve each conflict by combining both sides intelligently:");
  sections.push(`   - The \`HEAD\` side is the feature's work (keep this intent)`);
  sections.push(`   - The \`${baseBranch}\` side is upstream changes (integrate these)`);
  sections.push("3. Remove ALL conflict markers — no `<<<<<<<`, `=======`, or `>>>>>>>` should remain");
  sections.push("4. Run the build to verify everything compiles:");
  sections.push("   ```bash");
  sections.push(`   ${config.build.command}`);
  sections.push("   ```");
  sections.push("5. If the build fails, fix the errors");
  sections.push("6. Stage all resolved files and commit the merge:");
  sections.push("   ```bash");
  sections.push("   git add -A");
  sections.push('   git commit --no-edit');
  sections.push("   ```");

  sections.push(`\n## Rules\n`);
  sections.push("- Do NOT abort the merge (`git merge --abort`)");
  sections.push("- Do NOT create new branches or rebase");
  sections.push("- Do NOT push to remote");
  sections.push(`- Do NOT modify \`${config.tasksDir}\``);
  sections.push("- Keep BOTH the feature's changes and the upstream changes where possible");
  sections.push("- If in doubt, prefer the feature's implementation but ensure upstream additions are not lost");
  sections.push("- This is your ONE chance — there are no retries. Be thorough and careful.");

  return sections.join("\n");
}

/**
 * Truncate a diff to a maximum number of lines, appending a note if truncated.
 */
function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  return lines.slice(0, maxLines).join("\n") + `\n\n... (truncated — ${lines.length - maxLines} more lines)`;
}

/**
 * Generate a prompt for Tier 4 "nuclear re-run" — re-implementing a feature
 * from scratch on the current base branch, using the original feature's diff
 * as a reference implementation.
 *
 * @param feature - The feature to re-implement
 * @param baseBranch - The current base branch
 * @param featureDiff - The diff from the original feature implementation
 * @param config - Project configuration
 * @param quest - Optional quest context
 */
export function generateTier4RerunPrompt(
  feature: Feature,
  baseBranch: string,
  featureDiff: string,
  config: WomboConfig,
  quest?: QuestPromptContext
): string {
  const sections: string[] = [];

  sections.push(`# Re-implement Feature: ${feature.title}`);
  sections.push(`**Feature ID:** \`${feature.id}\``);
  sections.push(`**Base Branch:** \`${baseBranch}\``);

  sections.push(`\n## Situation\n`);
  sections.push(
    `This feature was previously implemented on an older version of the codebase, ` +
    `but the codebase has changed significantly and the original implementation could not ` +
    `be merged cleanly. Multiple automated conflict resolution strategies have failed.\n\n` +
    `You are starting from a **clean checkout of the current \`${baseBranch}\`**. ` +
    `Your task is to re-implement the feature from scratch, using the reference ` +
    `implementation below as a guide for what the feature should do.`
  );

  sections.push(`\n## Feature Description\n`);
  sections.push(feature.description.trim());

  // Quest context
  if (quest) {
    sections.push(`\n## Quest Context\n`);
    sections.push(
      `This task is part of **Quest \`${quest.questId}\`** with goal: ${quest.goal}\n`
    );
    if (quest.knowledge) {
      sections.push(`### Quest Knowledge\n`);
      sections.push(quest.knowledge);
    }
  }

  // Feature constraints and subtasks
  if (feature.constraints.length > 0) {
    sections.push(`\n## Constraints\n`);
    for (const c of feature.constraints) {
      sections.push(`- ${c}`);
    }
  }

  if (feature.forbidden.length > 0) {
    sections.push(`\n## Forbidden\n`);
    for (const f of feature.forbidden) {
      sections.push(`- ${f}`);
    }
  }

  sections.push(`\n## Reference Implementation (previous attempt)\n`);
  sections.push(
    `The diff below shows what the previous implementation changed. Use this as a ` +
    `guide for WHAT to implement, but adapt it to the CURRENT state of the codebase. ` +
    `Do not blindly apply this diff — the file contents may have changed.\n`
  );
  sections.push("```diff");
  sections.push(truncateDiff(featureDiff, 8000));
  sections.push("```");

  sections.push(`\n## Your Task\n`);
  sections.push("1. Study the reference implementation above to understand the feature's intent");
  sections.push("2. Examine the current codebase to understand what has changed");
  sections.push("3. Re-implement the feature, adapting to the current code");
  sections.push("4. Run the build to verify everything compiles:");
  sections.push("   ```bash");
  sections.push(`   ${config.build.command}`);
  sections.push("   ```");
  sections.push("5. Fix any build errors");
  sections.push("6. Commit your changes:");
  sections.push("   ```bash");
  sections.push("   git add -A");
  sections.push(`   git commit -m "feat(${feature.id}): re-implement ${feature.title}"`);
  sections.push("   ```");

  sections.push(`\n## Rules\n`);
  sections.push("- Do NOT push to remote");
  sections.push(`- Do NOT modify \`${config.tasksDir}\``);
  sections.push("- Implement the full feature — do not leave TODOs or stubs");
  sections.push("- Ensure the build passes before committing");

  return sections.join("\n");
}

/**
 * Generate a prompt for resolving conflicts during a per-commit rebase (Tier 3.5).
 *
 * This is a smaller-scope version of the conflict resolution prompt — it's for
 * a single commit being replayed during `git rebase`, not the full feature merge.
 *
 * @param feature - The feature being rebased
 * @param commitMessage - The commit message being replayed
 * @param commitHash - The commit hash being replayed
 * @param conflictFiles - Files with conflicts in this commit
 * @param totalCommits - Total commits to replay
 * @param currentCommit - Current commit number (1-indexed)
 * @param config - Project configuration
 */
export function generateRebaseCommitPrompt(
  feature: Feature,
  commitMessage: string,
  commitHash: string,
  conflictFiles: string[],
  totalCommits: number,
  currentCommit: number,
  config: WomboConfig
): string {
  const sections: string[] = [];

  sections.push(`# Rebase Conflict Resolution (commit ${currentCommit}/${totalCommits})`);
  sections.push(`**Feature:** ${feature.title} (\`${feature.id}\`)`);
  sections.push(`**Commit:** \`${commitHash.substring(0, 8)}\` — ${commitMessage}`);
  sections.push(`**Conflicting files:** ${conflictFiles.join(", ")}`);

  sections.push(`\n## Situation\n`);
  sections.push(
    `This is a single commit from the feature branch being replayed on top of the ` +
    `current base. The rebase paused because this commit conflicts with upstream changes.\n\n` +
    `The scope is SMALL — only this one commit's changes need to be reconciled.`
  );

  sections.push(`\n## Your Task\n`);
  sections.push("1. Resolve the conflict markers in the listed files");
  sections.push("2. Keep the intent of this commit while integrating upstream changes");
  sections.push("3. Run the build to verify:");
  sections.push("   ```bash");
  sections.push(`   ${config.build.command}`);
  sections.push("   ```");
  sections.push("4. Stage resolved files and continue:");
  sections.push("   ```bash");
  sections.push("   git add -A");
  sections.push("   git -c core.editor=true rebase --continue");
  sections.push("   ```");

  sections.push(`\n## Rules\n`);
  sections.push("- Do NOT abort the rebase");
  sections.push("- Do NOT push to remote");
  sections.push("- Keep changes minimal — only fix this commit's conflicts");

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Subtask Formatting
// ---------------------------------------------------------------------------

function formatSubtask(
  subtask: Subtask,
  index: number,
  depth: number
): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];

  lines.push(
    `${indent}${index}. **${subtask.title}** (\`${subtask.id}\`, ${formatDuration(parseDurationMinutes(subtask.effort))})`
  );
  lines.push(`${indent}   ${subtask.description.trim()}`);

  if (subtask.constraints.length > 0) {
    for (const c of subtask.constraints) {
      lines.push(`${indent}   - Constraint: ${c}`);
    }
  }
  if (subtask.forbidden.length > 0) {
    for (const f of subtask.forbidden) {
      lines.push(`${indent}   - Forbidden: ${f}`);
    }
  }
  if (subtask.references.length > 0) {
    lines.push(
      `${indent}   - Files: ${subtask.references.map((r) => `\`${r}\``).join(", ")}`
    );
  }
  if (subtask.depends_on.length > 0) {
    lines.push(
      `${indent}   - Depends on: ${subtask.depends_on.map((d) => `\`${d}\``).join(", ")}`
    );
  }

  // Nested subtasks
  if (subtask.subtasks.length > 0) {
    for (let i = 0; i < subtask.subtasks.length; i++) {
      lines.push(formatSubtask(subtask.subtasks[i], i + 1, depth + 1));
    }
  }

  return lines.join("\n");
}
