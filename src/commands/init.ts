/**
 * init.ts — Interactive guided setup for wombo.json.
 *
 * Usage: wombo init [--force]
 *
 * Walks the user through every config section, showing defaults and
 * accepting overrides.  Press Enter on any prompt to keep the default.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { CONFIG_FILE, DEFAULT_CONFIG, type WomboConfig } from "../config.js";

export interface InitOptions {
  projectRoot: string;
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Prompt helper — reads one line at a time from stdin
// ---------------------------------------------------------------------------

class Prompter {
  private lines: AsyncIterableIterator<string>;
  private done = false;
  private rl: ReturnType<typeof createInterface>;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY ?? false });
    this.lines = this.rl[Symbol.asyncIterator]();
  }

  /** Read one line from stdin after printing the prompt. */
  private async ask(prompt: string): Promise<string> {
    if (this.done) return "";
    process.stdout.write(prompt);
    const result = await this.lines.next();
    if (result.done) {
      this.done = true;
      return "";
    }
    return result.value.trim();
  }

  async string(label: string, defaultVal: string): Promise<string> {
    const answer = await this.ask(`  ${label} [${defaultVal}]: `);
    return answer || defaultVal;
  }

  async number(label: string, defaultVal: number): Promise<number> {
    const answer = await this.ask(`  ${label} [${defaultVal}]: `);
    if (!answer) return defaultVal;
    const n = parseInt(answer, 10);
    return isNaN(n) ? defaultVal : n;
  }

  async stringOrNull(label: string, defaultVal: string | null): Promise<string | null> {
    const display = defaultVal ?? "auto-detect";
    const answer = await this.ask(`  ${label} [${display}]: `);
    if (!answer) return defaultVal;
    if (answer.toLowerCase() === "null" || answer.toLowerCase() === "auto") return null;
    return answer;
  }

  async stringList(label: string, defaultVal: string[]): Promise<string[]> {
    const display = defaultVal.join(", ");
    const answer = await this.ask(`  ${label} [${display}]: `);
    if (!answer) return defaultVal;
    return answer.split(",").map((s) => s.trim()).filter(Boolean);
  }

  close(): void {
    this.rl.close();
  }
}

// ---------------------------------------------------------------------------
// Section printer
// ---------------------------------------------------------------------------

function section(title: string): void {
  console.log(`\n--- ${title} ${"─".repeat(Math.max(0, 56 - title.length))}`);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function cmdInit(opts: InitOptions): Promise<void> {
  const configPath = resolve(opts.projectRoot, CONFIG_FILE);

  if (existsSync(configPath) && !opts.force) {
    console.error(
      `${CONFIG_FILE} already exists. Use --force to overwrite.`
    );
    process.exit(1);
  }

  console.log(`\nWombo — Project Setup`);
  console.log(`Configuring ${CONFIG_FILE} for ${opts.projectRoot}`);
  console.log(`Press Enter to accept the default shown in [brackets].\n`);

  const p = new Prompter();

  try {
    const cfg: WomboConfig = structuredClone(DEFAULT_CONFIG);

    // -- General ----------------------------------------------------------
    section("General");
    cfg.featuresFile = await p.string("Features YAML file", cfg.featuresFile);
    cfg.baseBranch = await p.string("Base branch", cfg.baseBranch);

    // -- Build ------------------------------------------------------------
    section("Build");
    cfg.build.command = await p.string("Build command", cfg.build.command);
    cfg.build.timeout = await p.number("Build timeout (ms)", cfg.build.timeout);
    cfg.build.artifactDir = await p.string("Artifact directory", cfg.build.artifactDir);

    // -- Install ----------------------------------------------------------
    section("Install");
    cfg.install.command = await p.string("Install command", cfg.install.command);
    cfg.install.timeout = await p.number("Install timeout (ms)", cfg.install.timeout);

    // -- Git --------------------------------------------------------------
    section("Git");
    cfg.git.branchPrefix = await p.string("Branch prefix", cfg.git.branchPrefix);
    cfg.git.worktreePrefix = await p.string("Worktree prefix", cfg.git.worktreePrefix);
    cfg.git.remote = await p.string("Remote name", cfg.git.remote);
    cfg.git.mergeStrategy = await p.string("Merge strategy flag", cfg.git.mergeStrategy);

    // -- Agent ------------------------------------------------------------
    section("Agent");
    cfg.agent.bin = await p.stringOrNull("Agent binary path (or 'auto')", cfg.agent.bin);
    cfg.agent.name = await p.string("Agent name", cfg.agent.name);
    cfg.agent.configFiles = await p.stringList(
      "Config files to copy (comma-sep)",
      cfg.agent.configFiles
    );
    cfg.agent.tmuxPrefix = await p.string("tmux session prefix", cfg.agent.tmuxPrefix);

    // -- Defaults ---------------------------------------------------------
    section("Runtime Defaults");
    cfg.defaults.maxConcurrent = await p.number("Max concurrent agents", cfg.defaults.maxConcurrent);
    cfg.defaults.maxRetries = await p.number("Max retries per agent", cfg.defaults.maxRetries);

    // -- Write ------------------------------------------------------------
    console.log(`\n${"─".repeat(60)}`);
    const json = JSON.stringify(cfg, null, 2) + "\n";
    writeFileSync(configPath, json, "utf-8");
    console.log(`\nCreated ${CONFIG_FILE}\n`);
  } finally {
    p.close();
  }
}
