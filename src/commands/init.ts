/**
 * init.ts — Interactive guided setup for .wombo-combo/config.json.
 *
 * Usage: wombo init [--force]
 *
 * Walks the user through every config section, showing defaults and
 * accepting overrides.  Press Enter on any prompt to keep the default.
 */

import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { CONFIG_FILE, DEFAULT_CONFIG, WOMBO_DIR, type WomboConfig, type AgentRegistryMode } from "../config.js";
import { FEATURES_TEMPLATE_PATH } from "../lib/tasks.js";
import { renderAgentTemplate } from "../lib/templates.js";

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

  async yesNo(label: string, defaultVal: boolean): Promise<boolean> {
    const display = defaultVal ? "Y/n" : "y/N";
    const answer = await this.ask(`  ${label} [${display}]: `);
    if (!answer) return defaultVal;
    return answer.toLowerCase().startsWith("y");
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
    cfg.tasksFile = await p.string("Tasks YAML file", cfg.tasksFile);
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
    cfg.agent.tmuxPrefix = await p.string("Multiplexer session prefix", cfg.agent.tmuxPrefix);
    const muxPref = await p.string(
      "Multiplexer preference (auto/dmux/tmux)",
      cfg.agent.multiplexer
    );
    if (muxPref === "auto" || muxPref === "dmux" || muxPref === "tmux") {
      cfg.agent.multiplexer = muxPref;
    } else {
      console.log(`  Invalid multiplexer "${muxPref}", using "auto".`);
      cfg.agent.multiplexer = "auto";
    }

    // -- Agent Registry ---------------------------------------------------
    section("Agent Registry (specialized agent downloads)");
    console.log("  Pull specialized agent definitions from an external registry at launch time.\n");
    const modePref = await p.string(
      "Mode (auto/monitored/disabled)",
      cfg.agentRegistry.mode
    );
    const validModes: AgentRegistryMode[] = ["auto", "monitored", "disabled"];
    if (validModes.includes(modePref as AgentRegistryMode)) {
      cfg.agentRegistry.mode = modePref as AgentRegistryMode;
    } else {
      console.log(`  Invalid mode "${modePref}", using "auto".`);
      cfg.agentRegistry.mode = "auto";
    }
    if (cfg.agentRegistry.mode !== "disabled") {
      cfg.agentRegistry.source = await p.string(
        "Source repo (owner/repo)",
        cfg.agentRegistry.source
      );
    }

    // -- Portless ---------------------------------------------------------
    section("Portless (localhost server testing)");
    console.log("  Portless prevents port collisions when multiple agents run dev servers.\n");
    cfg.portless.enabled = await p.yesNo("Enable portless integration", cfg.portless.enabled);
    if (cfg.portless.enabled) {
      cfg.portless.bin = await p.stringOrNull("Portless binary path (or 'auto')", cfg.portless.bin);
      cfg.portless.proxyPort = await p.number("Proxy port", cfg.portless.proxyPort);
      cfg.portless.https = await p.yesNo("Enable HTTPS/HTTP2", cfg.portless.https);
    }

    // -- Defaults ---------------------------------------------------------
    section("Runtime Defaults");
    cfg.defaults.maxConcurrent = await p.number("Max concurrent agents", cfg.defaults.maxConcurrent);
    cfg.defaults.maxRetries = await p.number("Max retries per agent", cfg.defaults.maxRetries);

    // -- Write config ------------------------------------------------------
    console.log(`\n${"─".repeat(60)}`);
    const json = JSON.stringify(cfg, null, 2) + "\n";
    writeFileSync(configPath, json, "utf-8");
    console.log(`\nCreated ${CONFIG_FILE}`);

    // -- Create features file from template -------------------------------
    const womboDir = resolve(opts.projectRoot, WOMBO_DIR);
    if (!existsSync(womboDir)) mkdirSync(womboDir, { recursive: true });
    const featuresPath = resolve(womboDir, cfg.tasksFile);
    if (existsSync(featuresPath) && !opts.force) {
      console.log(`${cfg.tasksFile} already exists, skipping.`);
    } else {
      const template = readFileSync(FEATURES_TEMPLATE_PATH, "utf-8");
      const now = new Date().toISOString();
      const content = template
        .replace(/created_at:\s*".*?"/, `created_at: "${now}"`)
        .replace(/updated_at:\s*".*?"/, `updated_at: "${now}"`);
      writeFileSync(featuresPath, content, "utf-8");
      console.log(`Created ${cfg.tasksFile} from template.`);
    }

    // -- Install agent definition template --------------------------------
    const agentDir = resolve(opts.projectRoot, "agent");
    const agentDefPath = resolve(agentDir, `${cfg.agent.name}.md`);

    let installAgent = true;
    if (existsSync(agentDefPath) && !opts.force) {
      installAgent = await p.yesNo(
        `agent/${cfg.agent.name}.md already exists. Overwrite?`,
        false
      );
    }

    if (installAgent) {
      mkdirSync(agentDir, { recursive: true });
      const agentTemplate = renderAgentTemplate(cfg, opts.projectRoot);
      writeFileSync(agentDefPath, agentTemplate, "utf-8");
      console.log(`Created agent/${cfg.agent.name}.md from template.`);
    } else {
      console.log(`agent/${cfg.agent.name}.md already exists, skipping.`);
    }

    // Ensure agent/ is in configFiles
    if (!cfg.agent.configFiles.includes("agent/")) {
      cfg.agent.configFiles.push("agent/");
      // Re-write config with updated configFiles
      const updatedJson = JSON.stringify(cfg, null, 2) + "\n";
      writeFileSync(configPath, updatedJson, "utf-8");
      console.log(`Added agent/ to configFiles in ${CONFIG_FILE}.`);
    }

    console.log(`\nYou're all set! Run 'wombo help' to see available commands.\n`);
  } finally {
    p.close();
  }
}
