/**
 * templates.ts — Resolve paths to bundled template files, render agent
 * definitions, and compose patched agent definitions from imported agents.
 *
 * Template architecture:
 *
 *   generalist-agent.md          — standalone agent definition (no imported base)
 *   wc-patch.description.end.md  — appended to imported agent's frontmatter description
 *   wc-patch.body.start.md       — prepended to imported agent's body
 *   wc-patch.body.end.md         — appended to imported agent's body
 *
 * Conditional blocks (portless, browser testing) are injected programmatically
 * by the render/patch functions based on config — never left as "if enabled"
 * prose for the LLM to interpret.
 */

import { join, dirname, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import YAML from "yaml";
import type { WomboConfig } from "../config.js";
import { isPortlessAvailable } from "./portless.js";
import { normalizeAgentFormat } from "./format-converter.js";

// ---------------------------------------------------------------------------
// Template Directory & Paths
// ---------------------------------------------------------------------------

const TEMPLATES_DIR = join(dirname(import.meta.dir), "templates");

/** Standalone generalist agent template. */
export const GENERALIST_TEMPLATE_PATH = join(TEMPLATES_DIR, "generalist-agent.md");

/** Patch: text appended to an imported agent's frontmatter `description` field. */
export const PATCH_DESCRIPTION_END_PATH = join(TEMPLATES_DIR, "wc-patch.description.end.md");

/** Patch: markdown prepended to an imported agent's body. */
export const PATCH_BODY_START_PATH = join(TEMPLATES_DIR, "wc-patch.body.start.md");

/** Patch: markdown appended to an imported agent's body. */
export const PATCH_BODY_END_PATH = join(TEMPLATES_DIR, "wc-patch.body.end.md");

/**
 * Backward-compatible alias. Code that referenced `AGENT_TEMPLATE_PATH`
 * continues to work — it now points to the generalist template.
 */
export const AGENT_TEMPLATE_PATH = GENERALIST_TEMPLATE_PATH;

// ---------------------------------------------------------------------------
// Deterministic Conditional Blocks
// ---------------------------------------------------------------------------

/**
 * Portless server-testing block. Injected by render/patch functions ONLY when
 * `config.portless.enabled` is true. The agent never sees "if portless is
 * enabled" — it either gets these instructions or it doesn't.
 */
const PORTLESS_BLOCK = `
## Server Testing (portless)

Your environment is preconfigured with **portless** for collision-free localhost servers:

- **\`PORTLESS_ENABLED=1\`** is set in your environment.
- **Do NOT hardcode port numbers.** Use \`process.env.PORT\` or let your framework pick a port automatically.
- **Use \`portless run <cmd>\`** to start dev servers (e.g., \`portless run bun start\`). This auto-assigns a port and gives you a stable \`.localhost\` URL via \`PORTLESS_URL\`.
- **Check \`PORTLESS_URL\`** in your environment for the stable URL assigned to your worktree's server.
- Multiple agents can run dev servers simultaneously without port conflicts — portless handles routing through its proxy.
- **Never hardcode port numbers.** Always use the portless-assigned port.
`;

/**
 * TDD red-green-refactor block. Injected by render/patch functions ONLY when
 * `config.tdd.enabled` is true. The agent never sees "if TDD is enabled" —
 * it either gets these instructions or it doesn't.
 *
 * The `{{testCommand}}` placeholder is replaced at render time.
 */
const TDD_BLOCK = `
## Test-Driven Development (TDD)

You MUST follow the **red-green-refactor** TDD cycle for all implementation work:

### The TDD Cycle

1. **🔴 Red — Write a failing test first**
   - Before writing any implementation code, write a test that describes the desired behavior.
   - Use Bun's built-in test runner. Create test files alongside source files using the \`.test.ts\` naming convention.
   - The test MUST fail initially — this proves the test is actually testing something.

2. **🔴 Verify the test fails**
   - Run \`{{testCommand}}\` and confirm the new test fails with the expected error.
   - If the test passes without implementation, the test is not testing the right thing — rewrite it.

3. **🟢 Green — Write minimal code to pass**
   - Implement just enough production code to make the failing test pass.
   - Do NOT write more code than necessary to satisfy the test.
   - Do NOT add features or handle edge cases not covered by a test yet.

4. **🟢 Verify the test passes**
   - Run \`{{testCommand}}\` and confirm ALL tests pass (both new and existing).
   - If any test fails, fix the implementation — do NOT modify the test to make it pass (unless the test itself is wrong).

5. **🔵 Refactor**
   - Clean up the implementation while keeping all tests green.
   - Extract helpers, rename variables, simplify logic — but run \`{{testCommand}}\` after each change.
   - If a refactor breaks a test, undo the refactor and try a different approach.

### TDD Rules

- **Never skip the red step.** Every new behavior starts with a failing test.
- **One behavior per cycle.** Each red-green-refactor iteration should cover exactly one small behavior or edge case.
- **Tests are first-class code.** Keep them readable, well-named, and focused.
- **Run tests frequently.** Run \`{{testCommand}}\` after every meaningful change — not just at the end.
- **Commit at green.** Each commit should have all tests passing. Use the cycle boundaries as natural commit points.

### Test File Conventions

- Place test files next to the source: \`src/foo.ts\` → \`src/foo.test.ts\` (or \`tests/foo.test.ts\`)
- Use descriptive test names: \`test("returns empty array when input is null", ...)\`
- Import from \`bun:test\`: \`import { describe, test, expect } from "bun:test";\`
`;

/**
 * Build the TDD block with the configured test command substituted in.
 */
function buildTddBlock(config: WomboConfig): string {
  return TDD_BLOCK.replace(/\{\{testCommand\}\}/g, config.tdd.testCommand);
}

// ---------------------------------------------------------------------------
// Placeholder Substitution
// ---------------------------------------------------------------------------

/**
 * Default runtime description used when no project-specific value is available.
 */
const DEFAULT_RUNTIME = "Bun (not Node). TypeScript, strict mode, ESM only.";

/**
 * Replace {{placeholders}} in template content with config-derived values.
 *
 * Supported placeholders:
 *   - {{tasksFile}}      — tasks YAML filename (e.g. "tasks.yml")
 *   - {{branchPrefix}}   — git branch prefix (e.g. "feature/")
 *   - {{buildCommand}}   — build command (e.g. "bun run build")
 *   - {{runtime}}        — project runtime description
 *   - {{project}}        — project directory name
 */
function applyPlaceholders(
  content: string,
  config: WomboConfig,
  projectRoot: string
): string {
  const projectName = projectRoot.split("/").pop() ?? "project";
  return content
    .replace(/\{\{tasksDir\}\}/g, config.tasksDir)
    .replace(/\{\{branchPrefix\}\}/g, config.git.branchPrefix)
    .replace(/\{\{buildCommand\}\}/g, config.build.command)
    .replace(/\{\{runtime\}\}/g, DEFAULT_RUNTIME)
    .replace(/\{\{project\}\}/g, projectName);
}

// ---------------------------------------------------------------------------
// Frontmatter Parsing
// ---------------------------------------------------------------------------

/**
 * Split a markdown file with YAML frontmatter into its two parts.
 * Returns the raw YAML string (without delimiters) and the body.
 */
function splitFrontmatter(md: string): { yaml: string; body: string } {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { yaml: "", body: md };
  }
  return { yaml: match[1], body: match[2] };
}

/**
 * Reassemble frontmatter YAML and body into a markdown string.
 */
function joinFrontmatter(yaml: string, body: string): string {
  if (!yaml.trim()) return body;
  return `---\n${yaml.trimEnd()}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// Generalist Agent Rendering
// ---------------------------------------------------------------------------

/**
 * Render the standalone generalist agent template.
 *
 * This is the default agent definition for projects that don't import a
 * specialized agent from an external registry. Portless instructions are
 * injected deterministically based on config.
 */
export function renderGeneralistAgent(
  config: WomboConfig,
  projectRoot: string
): string {
  let raw = readFileSync(GENERALIST_TEMPLATE_PATH, "utf-8");

  // Deterministic portless injection
  if (config.portless.enabled && isPortlessAvailable(config)) {
    // Insert portless block before "## What You Must Never Do" (or at end)
    const neverDoMarker = "## What You Must Never Do";
    const idx = raw.indexOf(neverDoMarker);
    if (idx !== -1) {
      raw = raw.slice(0, idx) + PORTLESS_BLOCK + "\n" + raw.slice(idx);
    } else {
      raw += "\n" + PORTLESS_BLOCK;
    }
  }

  // Deterministic TDD injection
  if (config.tdd.enabled) {
    const tddContent = buildTddBlock(config);
    const neverDoMarker = "## What You Must Never Do";
    const idx = raw.indexOf(neverDoMarker);
    if (idx !== -1) {
      raw = raw.slice(0, idx) + tddContent + "\n" + raw.slice(idx);
    } else {
      raw += "\n" + tddContent;
    }
  }

  return applyPlaceholders(raw, config, projectRoot);
}

// ---------------------------------------------------------------------------
// Imported Agent Patching
// ---------------------------------------------------------------------------

/**
 * Patch an imported agent definition (e.g. from agency-agents) with
 * wombo-combo operational context.
 *
 * Composition order:
 *   1. Parse the imported agent's frontmatter and body
 *   2. Append wc-patch.description.end to the `description` frontmatter field
 *   3. Prepend wc-patch.body.start to the body
 *   4. Append wc-patch.body.end to the body
 *   5. Conditionally inject portless block (deterministic, based on config)
 *   6. Apply {{placeholder}} substitution to the entire result
 *
 * @param rawAgentMd  — raw markdown content of the imported agent file
 * @param config      — wombo-combo project config
 * @param projectRoot — absolute path to the project root
 */
export function patchImportedAgent(
  rawAgentMd: string,
  config: WomboConfig,
  projectRoot: string
): string {
  // Normalize agency-agents format to woco-compatible format before patching.
  // If the content is already in woco format, this is a no-op.
  const normalizedMd = normalizeAgentFormat(rawAgentMd);

  const { yaml: rawYaml, body: rawBody } = splitFrontmatter(normalizedMd);

  // --- Patch frontmatter description ---
  let patchedYaml = rawYaml;
  if (rawYaml) {
    try {
      const descPatchRaw = readFileSync(PATCH_DESCRIPTION_END_PATH, "utf-8").trim();
      if (descPatchRaw) {
        const doc = YAML.parseDocument(rawYaml);
        const currentDesc = doc.get("description");
        if (typeof currentDesc === "string") {
          doc.set("description", currentDesc.trimEnd() + "\n\n" + descPatchRaw);
        } else {
          // No description field — add one
          doc.set("description", descPatchRaw);
        }
        // Ensure mode is set for wombo-combo compatibility
        if (!doc.has("mode")) {
          doc.set("mode", "primary");
        }
        patchedYaml = YAML.stringify(doc, { lineWidth: 0 }).trimEnd();
      }
    } catch {
      // Patch file missing or YAML parse error — proceed without patching
    }
  }

  // --- Patch body ---
  let patchedBody = rawBody;

  // Prepend body.start
  try {
    const bodyStart = readFileSync(PATCH_BODY_START_PATH, "utf-8");
    if (bodyStart.trim()) {
      patchedBody = bodyStart + patchedBody;
    }
  } catch {
    // Patch file missing — skip
  }

  // Append body.end
  try {
    const bodyEnd = readFileSync(PATCH_BODY_END_PATH, "utf-8");
    if (bodyEnd.trim()) {
      patchedBody = patchedBody.trimEnd() + "\n" + bodyEnd;
    }
  } catch {
    // Patch file missing — skip
  }

  // Deterministic portless injection (appended after body.end)
  if (config.portless.enabled && isPortlessAvailable(config)) {
    patchedBody = patchedBody.trimEnd() + "\n" + PORTLESS_BLOCK;
  }

  // Deterministic TDD injection (appended after portless or body.end)
  if (config.tdd.enabled) {
    patchedBody = patchedBody.trimEnd() + "\n" + buildTddBlock(config);
  }

  // --- Reassemble & substitute placeholders ---
  const composed = joinFrontmatter(patchedYaml, patchedBody);
  return applyPlaceholders(composed, config, projectRoot);
}

// ---------------------------------------------------------------------------
// Backward Compatibility
// ---------------------------------------------------------------------------

/**
 * Render the agent template. Backward-compatible wrapper around
 * `renderGeneralistAgent` — existing code that calls this function
 * continues to work unchanged.
 */
export function renderAgentTemplate(
  config: WomboConfig,
  projectRoot: string
): string {
  return renderGeneralistAgent(config, projectRoot);
}

// ---------------------------------------------------------------------------
// Agent Definition Guard
// ---------------------------------------------------------------------------

/**
 * Ensure the agent definition file exists at the expected path.
 * If missing, reinstall from the bundled generalist template and warn.
 *
 * Called at the start of `woco launch` to prevent the failure mode where
 * agents spawn without their agent definition file.
 *
 * @returns true if the file was reinstalled, false if it already existed.
 */
export function ensureAgentDefinition(
  projectRoot: string,
  config: WomboConfig
): boolean {
  const agentDir = resolve(projectRoot, ".opencode", "agents");
  const agentDefPath = resolve(agentDir, `${config.agent.name}.md`);

  if (existsSync(agentDefPath)) {
    return false;
  }

  // Agent definition missing — reinstall from bundled template
  console.warn(
    `\x1b[33m[WARNING]\x1b[0m Agent definition not found: .opencode/agents/${config.agent.name}.md`
  );
  console.warn(`  Reinstalling from bundled generalist template...`);

  try {
    mkdirSync(agentDir, { recursive: true });
    const content = renderGeneralistAgent(config, projectRoot);
    writeFileSync(agentDefPath, content, "utf-8");
    console.warn(`  Restored .opencode/agents/${config.agent.name}.md\n`);
    return true;
  } catch (err: any) {
    console.error(
      `  Failed to restore agent definition: ${err.message}`
    );
    console.error(
      `  Agents may launch without their definition file.\n`
    );
    return false;
  }
}
