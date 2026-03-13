/**
 * init.ts — Interactive guided setup for .wombo-combo/config.json.
 *
 * Usage: woco init [--force]
 *
 * Walks the user through every config section, showing defaults and
 * accepting overrides.  Press Enter on any prompt to keep the default.
 *
 * Key behaviors:
 *   - Checks for required external tools (git, tmux/dmux, portless) when
 *     the user selects options that depend on them.
 *   - If a tool is missing, offers to install it or defers a reminder to
 *     the end of init.
 *   - Creates all operative files: config.json, tasks.yml, archive.yml,
 *     state.json, logs/, history/.
 *   - Ensures the .wombo-combo/ directory exists before writing anything.
 */

import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { stringify as stringifyYaml } from "yaml";
import { CONFIG_FILE, DEFAULT_CONFIG, WOMBO_DIR, type WomboConfig, type AgentRegistryMode } from "../config.js";
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
// Dependency checking
// ---------------------------------------------------------------------------

interface DependencyInfo {
  /** Binary name to look up via `which` */
  bin: string;
  /** Human-readable name */
  name: string;
  /** Install instructions per platform */
  installHint: string;
  /** Which config feature requires this */
  requiredBy: string;
}

/** Check if a binary is available on PATH. */
function isBinAvailable(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Try to install a tool. Returns true if the install command succeeded. */
async function tryInstall(dep: DependencyInfo, p: Prompter): Promise<boolean> {
  const installCmd = getInstallCommand(dep.bin);
  if (!installCmd) {
    return false;
  }

  const doInstall = await p.yesNo(
    `  ${dep.name} not found. Attempt to install via '${installCmd}'?`,
    false
  );

  if (!doInstall) return false;

  try {
    console.log(`  Installing ${dep.name}...`);
    execSync(installCmd, { stdio: "inherit", timeout: 120_000 });
    // Verify it worked
    if (isBinAvailable(dep.bin)) {
      console.log(`  ${dep.name} installed successfully.`);
      return true;
    }
    console.log(`  Install command ran but ${dep.bin} still not found on PATH.`);
    return false;
  } catch {
    console.log(`  Installation failed.`);
    return false;
  }
}

/** Return a platform-appropriate install command for common tools. */
function getInstallCommand(bin: string): string | null {
  const isLinux = process.platform === "linux";
  const isMac = process.platform === "darwin";

  switch (bin) {
    case "git":
      if (isMac) return "brew install git";
      if (isLinux) {
        // Try to detect package manager
        if (isBinAvailable("apt-get")) return "sudo apt-get install -y git";
        if (isBinAvailable("dnf")) return "sudo dnf install -y git";
        if (isBinAvailable("pacman")) return "sudo pacman -S --noconfirm git";
      }
      return null;

    case "tmux":
      if (isMac) return "brew install tmux";
      if (isLinux) {
        if (isBinAvailable("apt-get")) return "sudo apt-get install -y tmux";
        if (isBinAvailable("dnf")) return "sudo dnf install -y tmux";
        if (isBinAvailable("pacman")) return "sudo pacman -S --noconfirm tmux";
      }
      return null;

    case "dmux":
      // dmux is typically installed from source or via cargo
      if (isBinAvailable("cargo")) return "cargo install dmux";
      return null;

    case "portless":
      if (isBinAvailable("npm")) return "npm install -g portless";
      if (isBinAvailable("bun")) return "bun install -g portless";
      return null;

    default:
      return null;
  }
}

/**
 * Check a dependency. If missing, offer to install or add to deferred list.
 * Returns true if the dependency is available (either already present or freshly installed).
 */
async function checkDependency(
  dep: DependencyInfo,
  p: Prompter,
  deferredWarnings: string[]
): Promise<boolean> {
  if (isBinAvailable(dep.bin)) return true;

  console.log(`\n  \x1b[33m[WARNING]\x1b[0m ${dep.name} is not installed (required by: ${dep.requiredBy}).`);

  const installed = await tryInstall(dep, p);
  if (installed) return true;

  // Defer the warning to end of init
  deferredWarnings.push(
    `  - ${dep.name}: ${dep.installHint} (needed for ${dep.requiredBy})`
  );
  return false;
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

  console.log(`\nwombo-combo — Project Setup`);
  console.log(`Configuring ${CONFIG_FILE} for ${opts.projectRoot}`);
  console.log(`Press Enter to accept the default shown in [brackets].\n`);

  const p = new Prompter();
  const deferredWarnings: string[] = [];

  try {
    const cfg: WomboConfig = structuredClone(DEFAULT_CONFIG);

    // -- Check git upfront (always required) --------------------------------
    await checkDependency(
      {
        bin: "git",
        name: "git",
        installHint: "https://git-scm.com/downloads",
        requiredBy: "core (worktrees, branches)",
      },
      p,
      deferredWarnings
    );

    // -- General ----------------------------------------------------------
    section("General");
    cfg.tasksDir = await p.string("Tasks directory", cfg.tasksDir);
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

    // Check multiplexer availability
    if (cfg.agent.multiplexer === "dmux") {
      await checkDependency(
        {
          bin: "dmux",
          name: "dmux",
          installHint: "cargo install dmux  or  https://github.com/nicholasgasior/dmux",
          requiredBy: "multiplexer (agent.multiplexer = dmux)",
        },
        p,
        deferredWarnings
      );
    } else if (cfg.agent.multiplexer === "tmux") {
      await checkDependency(
        {
          bin: "tmux",
          name: "tmux",
          installHint: "https://github.com/tmux/tmux",
          requiredBy: "multiplexer (agent.multiplexer = tmux)",
        },
        p,
        deferredWarnings
      );
    } else {
      // "auto" — check both, warn only if neither is found
      const hasDmux = isBinAvailable("dmux");
      const hasTmux = isBinAvailable("tmux");
      if (!hasDmux && !hasTmux) {
        console.log(`\n  \x1b[33m[WARNING]\x1b[0m No terminal multiplexer found (dmux or tmux).`);
        console.log(`  Interactive mode (--interactive) requires a multiplexer.`);
        const installTmux = await p.yesNo("Attempt to install tmux?", false);
        if (installTmux) {
          const installed = await tryInstall(
            {
              bin: "tmux",
              name: "tmux",
              installHint: "https://github.com/tmux/tmux",
              requiredBy: "multiplexer (interactive mode)",
            },
            p
          );
          if (!installed) {
            deferredWarnings.push(
              "  - tmux or dmux: needed for interactive mode (--interactive). Install one:\n" +
              "      tmux: https://github.com/tmux/tmux\n" +
              "      dmux: https://github.com/nicholasgasior/dmux"
            );
          }
        } else {
          deferredWarnings.push(
            "  - tmux or dmux: needed for interactive mode (--interactive). Install one:\n" +
            "      tmux: https://github.com/tmux/tmux\n" +
            "      dmux: https://github.com/nicholasgasior/dmux"
          );
        }
      }
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
      // Check portless availability
      await checkDependency(
        {
          bin: "portless",
          name: "portless",
          installHint: "npm install -g portless",
          requiredBy: "portless integration (portless.enabled = true)",
        },
        p,
        deferredWarnings
      );

      cfg.portless.bin = await p.stringOrNull("Portless binary path (or 'auto')", cfg.portless.bin);
      cfg.portless.proxyPort = await p.number("Proxy port", cfg.portless.proxyPort);
      cfg.portless.https = await p.yesNo("Enable HTTPS/HTTP2", cfg.portless.https);
    }

    // -- TDD (Test-Driven Development) ------------------------------------
    section("TDD (Test-Driven Development)");
    console.log("  When enabled, agents follow the red-green-refactor TDD cycle.\n");
    cfg.tdd.enabled = await p.yesNo("Enable TDD workflow for agents", cfg.tdd.enabled);
    if (cfg.tdd.enabled) {
      cfg.tdd.testCommand = await p.string("Test command", cfg.tdd.testCommand);
    }

    // -- Defaults ---------------------------------------------------------
    section("Runtime Defaults");
    cfg.defaults.maxConcurrent = await p.number("Max concurrent agents", cfg.defaults.maxConcurrent);
    cfg.defaults.maxRetries = await p.number("Max retries per agent", cfg.defaults.maxRetries);

    // -- Write all operative files -----------------------------------------
    console.log(`\n${"─".repeat(60)}`);

    // Ensure .wombo-combo/ directory exists before writing any files
    const womboDir = resolve(opts.projectRoot, WOMBO_DIR);
    if (!existsSync(womboDir)) mkdirSync(womboDir, { recursive: true });

    // 1. config.json
    const json = JSON.stringify(cfg, null, 2) + "\n";
    writeFileSync(configPath, json, "utf-8");
    console.log(`\nCreated ${CONFIG_FILE}`);

    // 2. tasks/ folder store
    const now = new Date().toISOString();
    const projectName = opts.projectRoot.split("/").pop() ?? "project";
    const tasksDirPath = resolve(womboDir, cfg.tasksDir);
    if (existsSync(tasksDirPath) && !opts.force) {
      console.log(`${cfg.tasksDir}/ already exists, skipping.`);
    } else {
      mkdirSync(tasksDirPath, { recursive: true });
      const metaContent = stringifyYaml({
        version: "1.0",
        meta: {
          created_at: now,
          updated_at: now,
          project: projectName,
          generator: "wombo-combo",
          maintainer: "user",
        },
      }, { lineWidth: 120 });
      writeFileSync(resolve(tasksDirPath, "_meta.yml"), metaContent, "utf-8");
      console.log(`Created ${WOMBO_DIR}/${cfg.tasksDir}/ with _meta.yml.`);
    }

    // 3. archive/ folder store
    const archiveDirPath = resolve(womboDir, cfg.archiveDir);
    if (existsSync(archiveDirPath) && !opts.force) {
      console.log(`${cfg.archiveDir}/ already exists, skipping.`);
    } else {
      mkdirSync(archiveDirPath, { recursive: true });
      const archiveMeta = stringifyYaml({
        version: "1.0",
        meta: {
          created_at: now,
          updated_at: now,
          project: projectName,
          generator: "wombo-combo",
          maintainer: "user",
        },
      }, { lineWidth: 120 });
      writeFileSync(resolve(archiveDirPath, "_meta.yml"), archiveMeta, "utf-8");
      console.log(`Created ${WOMBO_DIR}/${cfg.archiveDir}/.`);
    }

    // 4. logs/ directory
    const logsDir = resolve(womboDir, "logs");
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
      console.log(`Created ${WOMBO_DIR}/logs/`);
    }

    // 5. history/ directory
    const historyDir = resolve(womboDir, "history");
    if (!existsSync(historyDir)) {
      mkdirSync(historyDir, { recursive: true });
      console.log(`Created ${WOMBO_DIR}/history/`);
    }

    // -- Install agent definition template --------------------------------
    const agentDir = resolve(opts.projectRoot, ".opencode", "agents");
    const agentDefPath = resolve(agentDir, `${cfg.agent.name}.md`);

    let installAgent = true;
    if (existsSync(agentDefPath) && !opts.force) {
      installAgent = await p.yesNo(
        `.opencode/agents/${cfg.agent.name}.md already exists. Overwrite?`,
        false
      );
    }

    if (installAgent) {
      mkdirSync(agentDir, { recursive: true });
      const agentTemplate = renderAgentTemplate(cfg, opts.projectRoot);
      writeFileSync(agentDefPath, agentTemplate, "utf-8");
      console.log(`Created .opencode/agents/${cfg.agent.name}.md from template.`);
    } else {
      console.log(`.opencode/agents/${cfg.agent.name}.md already exists, skipping.`);
    }

    // Migrate: remove legacy agent/ from configFiles if present
    const legacyIdx = cfg.agent.configFiles.indexOf("agent/");
    if (legacyIdx !== -1) {
      cfg.agent.configFiles.splice(legacyIdx, 1);
      const updatedJson = JSON.stringify(cfg, null, 2) + "\n";
      writeFileSync(configPath, updatedJson, "utf-8");
      console.log(`Removed legacy agent/ from configFiles (agents now live in .opencode/agents/).`);
    }

    // -- Deferred dependency warnings -------------------------------------
    if (deferredWarnings.length > 0) {
      console.log(`\n\x1b[33m── Missing Dependencies ─────────────────────────────────────\x1b[0m`);
      console.log(`The following tools were not found and should be installed`);
      console.log(`before running wombo-combo:\n`);
      for (const warning of deferredWarnings) {
        console.log(warning);
      }
      console.log();
    }

    console.log(`\nYou're all set! Run 'woco help' to see available commands.\n`);
  } finally {
    p.close();
  }
}
