/**
 * completion.ts — Shell completion script generator for wombo-combo.
 *
 * Generates native completion scripts for bash, zsh, and fish.
 *
 * Install:
 *   woco completion install                                 # auto-detect shell, install
 *   eval "$(woco completion bash)"                          # manual: add to ~/.bashrc
 *   eval "$(woco completion zsh)"                           # manual: add to ~/.zshrc
 *   woco completion fish | source                           # fish
 *   woco completion fish > ~/.config/fish/completions/woco.fish  # persist
 *
 * Uninstall:
 *   woco completion uninstall                               # remove all installed completions
 */

import { basename, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import {
  COMMAND_REGISTRY,
  GLOBAL_FLAGS,
  getCommandFlags,
  type CommandDef,
  type FlagDef,
} from "../lib/schema";

/** Marker comment injected into rc files so we can find and remove our lines. */
export const RC_MARKER = "# Added by woco (wombo-combo) — do not edit this block";
export const RC_MARKER_END = "# End woco completion";

// ---------------------------------------------------------------------------
// Public API — generate scripts (stdout)
// ---------------------------------------------------------------------------

export function cmdCompletion({ shell }: { shell?: string }): void {
  const resolved = shell ?? detectShell();

  switch (resolved) {
    case "bash":
      process.stdout.write(bashScript());
      break;
    case "zsh":
      process.stdout.write(zshScript());
      break;
    case "fish":
      process.stdout.write(fishScript());
      break;
    default:
      console.error(`Unsupported shell: "${resolved}"`);
      console.error("Supported shells: bash, zsh, fish");
      console.error("");
      console.error("Install completions:");
      console.error("  woco completion install              # auto-detect & install");
      console.error('  eval "$(woco completion bash)"       # Bash: add to ~/.bashrc');
      console.error('  eval "$(woco completion zsh)"        # Zsh:  add to ~/.zshrc');
      console.error("  woco completion fish | source        # Fish");
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Public API — install / uninstall completions
// ---------------------------------------------------------------------------

/**
 * Auto-detect the user's shell and install completions:
 *   - zsh: write _woco to a fpath dir (or create one and wire it into .zshrc)
 *   - bash: append eval line to ~/.bashrc
 *   - fish: write to ~/.config/fish/completions/woco.fish
 *
 * Safe to call repeatedly — skips if already installed.
 */
export function installCompletions(): void {
  const shell = detectShell();

  switch (shell) {
    case "zsh":
      installZsh();
      break;
    case "bash":
      installBash();
      break;
    case "fish":
      installFish();
      break;
    default:
      console.log(`Shell "${shell}" is not supported for auto-install.`);
      console.log("Supported: bash, zsh, fish");
  }
}

/**
 * Remove all completions installed by `woco completion install`.
 */
export function uninstallCompletions(): void {
  let removed = false;

  // Zsh: remove _woco from fpath dir, remove fpath line from .zshrc
  removed = uninstallZsh() || removed;

  // Bash: remove our block from .bashrc
  removed = uninstallBash() || removed;

  // Fish: remove the completions file
  removed = uninstallFish() || removed;

  if (removed) {
    console.log("Shell completions removed.");
    console.log("Open a new terminal for changes to take effect.");
  } else {
    console.log("No woco completions found to remove.");
  }
}

// ---------------------------------------------------------------------------
// Zsh install/uninstall
// ---------------------------------------------------------------------------

/** Standard user completions dir for zsh. */
function zshCompletionsDir(): string {
  return resolve(homedir(), ".zsh", "completions");
}

function zshCompletionFile(): string {
  return resolve(zshCompletionsDir(), "_woco");
}

function installZsh(): void {
  const compDir = zshCompletionsDir();
  const compFile = zshCompletionFile();
  const zshrc = resolve(homedir(), ".zshrc");

  // 1. Write the completion function file
  mkdirSync(compDir, { recursive: true });
  writeFileSync(compFile, zshScript(), "utf-8");

  // 2. Ensure fpath includes our dir and compinit is called
  //    Only add if not already present.
  const fpathLine = `fpath=(${compDir} $fpath)`;
  const compinitLine = `autoload -Uz compinit && compinit`;

  let rcContent = "";
  if (existsSync(zshrc)) {
    rcContent = readFileSync(zshrc, "utf-8");
  }

  // Check if our marker block already exists
  if (rcContent.includes(RC_MARKER) && rcContent.includes("fpath=")) {
    // Already installed — just update the completion file (already written above)
    console.log("Zsh completions updated.");
    return;
  }

  // Check if fpath already includes our dir (user may have added it manually)
  const fpathAlready = rcContent.includes(compDir);
  const compinitAlready = rcContent.includes("compinit");

  if (!fpathAlready || !compinitAlready) {
    const block: string[] = [RC_MARKER];
    if (!fpathAlready) block.push(fpathLine);
    if (!compinitAlready) block.push(compinitLine);
    block.push(RC_MARKER_END);

    // Prepend to .zshrc — fpath must be set before compinit runs
    const newContent = block.join("\n") + "\n" + rcContent;
    writeFileSync(zshrc, newContent, "utf-8");
  }

  console.log("Zsh completions installed.");
  console.log("  Open a new terminal or run: source ~/.zshrc");
}

function uninstallZsh(): boolean {
  let removed = false;

  // Remove completion file
  const compFile = zshCompletionFile();
  if (existsSync(compFile)) {
    unlinkSync(compFile);
    removed = true;
  }

  // Remove our block from .zshrc
  const zshrc = resolve(homedir(), ".zshrc");
  if (existsSync(zshrc)) {
    const content = readFileSync(zshrc, "utf-8");
    const cleaned = removeMarkerBlock(content);
    if (cleaned !== content) {
      writeFileSync(zshrc, cleaned, "utf-8");
      removed = true;
    }
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Bash install/uninstall
// ---------------------------------------------------------------------------

function installBash(): void {
  const bashrc = resolve(homedir(), ".bashrc");
  const evalLine = 'eval "$(woco completion bash)"';

  let rcContent = "";
  if (existsSync(bashrc)) {
    rcContent = readFileSync(bashrc, "utf-8");
  }

  // Already installed?
  if (rcContent.includes(RC_MARKER) && rcContent.includes("woco completion bash")) {
    console.log("Bash completions already installed.");
    return;
  }

  // Also check for manual installs (user may have added eval line themselves)
  if (rcContent.includes("woco completion bash")) {
    console.log("Bash completions already present in ~/.bashrc.");
    return;
  }

  const block = [RC_MARKER, evalLine, RC_MARKER_END, ""].join("\n");
  writeFileSync(bashrc, rcContent + "\n" + block, "utf-8");

  console.log("Bash completions installed.");
  console.log("  Open a new terminal or run: source ~/.bashrc");
}

function uninstallBash(): boolean {
  const bashrc = resolve(homedir(), ".bashrc");
  if (!existsSync(bashrc)) return false;

  const content = readFileSync(bashrc, "utf-8");
  const cleaned = removeMarkerBlock(content);
  if (cleaned !== content) {
    writeFileSync(bashrc, cleaned, "utf-8");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fish install/uninstall
// ---------------------------------------------------------------------------

function fishCompletionFile(): string {
  return resolve(homedir(), ".config", "fish", "completions", "woco.fish");
}

function installFish(): void {
  const compFile = fishCompletionFile();
  const compDir = resolve(compFile, "..");

  mkdirSync(compDir, { recursive: true });
  writeFileSync(compFile, fishScript(), "utf-8");

  console.log("Fish completions installed.");
  console.log("  Open a new terminal or run: source " + compFile);
}

function uninstallFish(): boolean {
  const compFile = fishCompletionFile();
  if (existsSync(compFile)) {
    unlinkSync(compFile);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Remove lines between RC_MARKER and RC_MARKER_END (inclusive) from content.
 * Handles trailing newlines gracefully.
 *
 * Exported for testing.
 */
export function removeMarkerBlock(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    if (line.trim() === RC_MARKER) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.trim() === RC_MARKER_END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) {
      result.push(line);
    }
  }

  // Clean up leading/trailing blank lines that were left behind
  let text = result.join("\n");
  // Remove double blank lines at the seam
  text = text.replace(/\n{3,}/g, "\n\n");
  return text;
}

// ---------------------------------------------------------------------------
// Shell detection
// ---------------------------------------------------------------------------

/** Exported for testing. */
export function detectShell(): string {
  const shellPath = process.env.SHELL || "";
  const name = basename(shellPath);
  if (name === "bash" || name === "zsh" || name === "fish") return name;
  return "bash"; // safe default
}

// ---------------------------------------------------------------------------
// Registry-driven completion helpers
// ---------------------------------------------------------------------------

/** Extract short name from compound name: "tasks list" → "list" */
function cmdShortName(cmd: CommandDef): string {
  return cmd.name.includes(" ") ? cmd.name.split(" ").pop()! : cmd.name;
}

/** Get the description for shell completion menus */
function completionDesc(cmd: CommandDef): string {
  return cmd.completionSummary ?? cmd.summary;
}

/** Get alias hint string like " (l)" for descriptions */
function aliasHint(cmd: CommandDef): string {
  if (!cmd.aliases?.length) return "";
  return ` (${cmd.aliases.join(", ")})`;
}

/** Get all flag tokens (--name and -alias) for a command's flags */
function flagTokens(flags: FlagDef[]): string[] {
  const tokens: string[] = [];
  for (const f of flags) {
    tokens.push(f.name);
    if (f.alias) tokens.push(f.alias);
  }
  return tokens;
}

/** Commands that have subcommands (tasks, quest, wishlist) */
function parentCommands(): CommandDef[] {
  return COMMAND_REGISTRY.filter((c) => c.subcommands?.length);
}

/** Collect unique enum flag value completions across all commands */
function collectEnumFlags(): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  function walk(cmds: CommandDef[]) {
    for (const cmd of cmds) {
      for (const flag of getCommandFlags(cmd)) {
        if (flag.enum?.length) {
          map.set(flag.name, flag.enum);
          if (flag.alias) map.set(flag.alias, flag.enum);
        }
      }
      if (cmd.subcommands) walk(cmd.subcommands);
    }
  }
  walk(COMMAND_REGISTRY);
  return map;
}

/** Collect free-form flags (take a value but no enum) — suppress completions */
function collectFreeFormFlags(): string[] {
  const flags = new Set<string>();
  function walk(cmds: CommandDef[]) {
    for (const cmd of cmds) {
      for (const flag of getCommandFlags(cmd)) {
        if (flag.type !== "boolean" && !flag.enum?.length) {
          flags.add(flag.name);
          if (flag.alias) flags.add(flag.alias);
        }
      }
      if (cmd.subcommands) walk(cmd.subcommands);
    }
  }
  walk(COMMAND_REGISTRY);
  return [...flags];
}

/** All canonical command names (for describe completions) */
function allCommandNames(): string[] {
  return COMMAND_REGISTRY.map((c) => c.name);
}

// ---------------------------------------------------------------------------
// Bash completion (generated from COMMAND_REGISTRY)
// ---------------------------------------------------------------------------

function bashScript(): string {
  // Alias resolution cases
  const aliasCases = COMMAND_REGISTRY
    .filter((c) => c.aliases?.length)
    .map((c) => `        ${c.aliases!.join("|")}) cmd="${c.name}" ;;`)
    .join("\n");

  // Enum flag value cases
  const enumFlags = collectEnumFlags();
  const enumCases = [...enumFlags]
    .map(([flag, values]) =>
      `        ${flag})\n            COMPREPLY=(\$(compgen -W "${values.join(" ")}" -- "\$cur")); return ;;`,
    )
    .join("\n");

  // Free-form flag tokens (suppress completions)
  const freeFormList = collectFreeFormFlags().join("|");

  // Command word list (canonical names + aliases — bash has no descriptions so aliases are harmless)
  const cmdWordList = COMMAND_REGISTRY
    .flatMap((c) => [c.name, ...(c.aliases ?? [])])
    .join(" ");

  // Parent command sections (tasks, quest, wishlist)
  let parentSections = "";
  for (const parent of parentCommands()) {
    const subs = parent.subcommands!;

    // Subcommand alias resolution
    const subAliasCases = subs
      .filter((sc) => sc.aliases?.length)
      .map((sc) => `            ${sc.aliases!.join("|")}) subcmd="${cmdShortName(sc)}" ;;`)
      .join("\n");

    // Subcommand word list
    const subWordList = subs
      .flatMap((sc) => [cmdShortName(sc), ...(sc.aliases ?? [])])
      .concat(["help"])
      .join(" ");

    // Per-subcommand flags
    const subFlagCases = subs
      .map((sc) => {
        const tokens = flagTokens(getCommandFlags(sc)).join(" ");
        if (!tokens) return null;
        return `            ${cmdShortName(sc)})\n                COMPREPLY=(\$(compgen -W "${tokens}" -- "\$cur")) ;;`;
      })
      .filter(Boolean)
      .join("\n");

    parentSections += `
    # ${parent.name} → subcommands
    if [[ "\$cmd" == "${parent.name}" ]]; then
        for ((j=i+1; j < COMP_CWORD; j++)); do
            if [[ "\${COMP_WORDS[j]}" != -* ]]; then
                subcmd="\${COMP_WORDS[j]}"
                break
            fi
        done
        case "\$subcmd" in
${subAliasCases}
        esac
        if [[ -z "\$subcmd" ]]; then
            COMPREPLY=(\$(compgen -W "${subWordList}" -- "\$cur"))
            return
        fi
        case "\$subcmd" in
${subFlagCases}
        esac
        return
    fi
`;
  }

  // Per-command flags (non-parent commands only)
  const cmdFlagCases = COMMAND_REGISTRY
    .filter((c) => !c.subcommands?.length)
    .map((c) => {
      const tokens = flagTokens(getCommandFlags(c)).join(" ");
      if (!tokens) return null;
      return `        ${c.name})\n            COMPREPLY=(\$(compgen -W "${tokens}" -- "\$cur")) ;;`;
    })
    .filter(Boolean)
    .join("\n");

  const describeWords = allCommandNames().join(" ");

  return `# woco (wombo-combo) bash completion
# Generated by: woco completion bash
# Install: eval "$(woco completion bash)"  — add to ~/.bashrc

_woco_completions() {
    local cur prev cmd subcmd i j
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    cmd=""
    subcmd=""

    # Find the main command (first non-flag arg after woco)
    for ((i=1; i < COMP_CWORD; i++)); do
        if [[ "\${COMP_WORDS[i]}" != -* ]]; then
            cmd="\${COMP_WORDS[i]}"
            break
        fi
    done

    # Resolve top-level aliases
    case "\$cmd" in
${aliasCases}
    esac

    # Flag value completions (context-independent)
    case "\$prev" in
${enumCases}
        ${freeFormList})
            return ;;  # free-form / numeric — no completions, let readline handle it
    esac

    # No command yet → complete commands
    if [[ -z "\$cmd" ]]; then
        COMPREPLY=(\$(compgen -W "${cmdWordList}" -- "\$cur"))
        return
    fi
${parentSections}
    # completion → shell names
    if [[ "\$cmd" == "completion" ]]; then
        COMPREPLY=(\$(compgen -W "bash zsh fish install uninstall" -- "\$cur"))
        return
    fi

    # describe → command names (for introspection)
    if [[ "\$cmd" == "describe" ]]; then
        COMPREPLY=(\$(compgen -W "${describeWords}" -- "\$cur"))
        return
    fi

    # Flags per top-level command
    case "\$cmd" in
${cmdFlagCases}
    esac
}

complete -o default -F _woco_completions woco
`;
}

// ---------------------------------------------------------------------------
// Zsh completion (generated from COMMAND_REGISTRY)
// ---------------------------------------------------------------------------

function zshScript(): string {
  // _describe array: canonical commands only, with alias hint in description
  const cmdEntries = COMMAND_REGISTRY
    .map((c) => `            '${c.name}:${completionDesc(c)}${aliasHint(c)}'`)
    .join("\n");

  // All alias tokens for bare compadd (hidden from menu, but tab-completable)
  const allAliases = COMMAND_REGISTRY
    .flatMap((c) => c.aliases ?? [])
    .join(" ");

  // Alias resolution cases
  const aliasCases = COMMAND_REGISTRY
    .filter((c) => c.aliases?.length)
    .map((c) => `        ${c.aliases!.join("|")}) cmd=${c.name} ;;`)
    .join("\n");

  // Enum flag value cases
  const enumFlags = collectEnumFlags();
  const enumCases = [...enumFlags]
    .map(([flag, values]) => `        ${flag})    compadd ${values.join(" ")}; return ;;`)
    .join("\n");

  // Parent command sections
  let parentSections = "";
  for (const parent of parentCommands()) {
    const subs = parent.subcommands!;

    // Subcommand _describe entries (canonical only, with alias hint)
    const subEntries = subs
      .map((sc) => `                '${cmdShortName(sc)}:${completionDesc(sc)}${aliasHint(sc)}'`)
      .join("\n");

    // Subcommand aliases for bare compadd
    const subAliases = subs
      .flatMap((sc) => sc.aliases ?? [])
      .join(" ");

    // Subcommand alias resolution
    const subAliasCases = subs
      .filter((sc) => sc.aliases?.length)
      .map((sc) => `            ${sc.aliases!.join("|")}) subcmd=${cmdShortName(sc)} ;;`)
      .join("\n");

    // Per-subcommand flags
    const subFlagCases = subs
      .map((sc) => {
        const tokens = flagTokens(getCommandFlags(sc)).join(" ");
        if (!tokens) return null;
        return `            ${cmdShortName(sc)})\n                compadd -- ${tokens} ;;`;
      })
      .filter(Boolean)
      .join("\n");

    parentSections += `
    # ${parent.name} → subcommands
    if [[ "\$cmd" == "${parent.name}" ]]; then
        if (( CURRENT == 3 )); then
            local -a subcmds
            subcmds=(
${subEntries}
                'help:Show help'
            )
            _describe 'subcommand' subcmds
${subAliases ? `            compadd -Q -- ${subAliases}` : ""}
            return
        fi

        subcmd="\${words[3]}"
        case "\$subcmd" in
${subAliasCases}
        esac

        case "\$subcmd" in
${subFlagCases}
        esac
        return
    fi
`;
  }

  // Per-command flags (non-parent commands)
  const cmdFlagCases = COMMAND_REGISTRY
    .filter((c) => !c.subcommands?.length)
    .map((c) => {
      const tokens = flagTokens(getCommandFlags(c)).join(" ");
      if (!tokens) return null;
      return `        ${c.name})   compadd -- ${tokens} ;;`;
    })
    .filter(Boolean)
    .join("\n");

  const describeWords = allCommandNames().join(" ");

  return `#compdef woco
# woco (wombo-combo) zsh completion
# Generated by: woco completion zsh
# Install: eval "$(woco completion zsh)"  — add to ~/.zshrc

_woco() {
    local cmd subcmd

    # Position 2 → completing the main command
    if (( CURRENT == 2 )); then
        local -a cmds
        cmds=(
${cmdEntries}
        )
        _describe 'command' cmds
        # Aliases: complete when typed but don't clutter the menu
${allAliases ? `        compadd -Q -- ${allAliases}` : ""}
        return
    fi

    cmd="\${words[2]}"

    # Resolve top-level aliases
    case "\$cmd" in
${aliasCases}
    esac

    # Flag value completions
    case "\${words[CURRENT-1]}" in
${enumCases}
    esac
${parentSections}
    # completion → shell names
    if [[ "\$cmd" == "completion" ]]; then
        if (( CURRENT == 3 )); then
            compadd bash zsh fish install uninstall
        fi
        return
    fi

    # describe → command names
    if [[ "\$cmd" == "describe" ]]; then
        compadd -- ${describeWords}
        return
    fi

    # Flags per command
    case "\$cmd" in
${cmdFlagCases}
    esac
}

compdef _woco woco
`;
}

// ---------------------------------------------------------------------------
// Fish completion (generated from COMMAND_REGISTRY)
// ---------------------------------------------------------------------------

function fishScript(): string {
  const lines: string[] = [];

  lines.push("# woco (wombo-combo) fish completion");
  lines.push("# Generated by: woco completion fish");
  lines.push("# Install: woco completion fish | source");
  lines.push("# Persist: woco completion fish > ~/.config/fish/completions/woco.fish");
  lines.push("");

  // Generate helper functions for each parent command
  for (const parent of parentCommands()) {
    const names = [parent.name, ...(parent.aliases ?? [])].join(" ");

    lines.push(`# Helper: true when the ${parent.name} subcommand has a specific sub-subcommand`);
    lines.push(`function __woco_${parent.name}_subcmd`);
    lines.push("    set -l tokens (commandline -opc)");
    lines.push("    if test (count $tokens) -ge 3");
    lines.push("        switch $tokens[2]");
    lines.push(`            case ${names}`);
    lines.push("                for sub in $argv");
    lines.push('                    if test "$tokens[3]" = "$sub"');
    lines.push("                        return 0");
    lines.push("                    end");
    lines.push("                end");
    lines.push("        end");
    lines.push("    end");
    lines.push("    return 1");
    lines.push("end");
    lines.push("");

    lines.push(`# Helper: true when we need a ${parent.name} subcommand`);
    lines.push(`function __woco_needs_${parent.name}_subcmd`);
    lines.push("    set -l tokens (commandline -opc)");
    lines.push("    if test (count $tokens) -eq 2");
    lines.push("        switch $tokens[2]");
    lines.push(`            case ${names}`);
    lines.push("                return 0");
    lines.push("        end");
    lines.push("    end");
    lines.push("    return 1");
    lines.push("end");
    lines.push("");
  }

  lines.push("# Disable file completions by default");
  lines.push("for cmd in woco");
  lines.push("    complete -c $cmd -f");
  lines.push("");

  // --- Top-level commands (canonical only, no alias entries) ---
  lines.push("    # --- Top-level commands ---");
  for (const cmd of COMMAND_REGISTRY) {
    const desc = completionDesc(cmd);
    const hint = aliasHint(cmd);
    const pad = " ".repeat(Math.max(1, 14 - cmd.name.length));
    lines.push(`    complete -c $cmd -n '__fish_use_subcommand' -a '${cmd.name}'${pad}-d '${desc}${hint}'`);
  }
  lines.push("");

  // --- Subcommands for parent commands ---
  for (const parent of parentCommands()) {
    const subs = parent.subcommands!;

    lines.push(`    # --- ${parent.name} subcommands ---`);
    for (const sc of subs) {
      const name = cmdShortName(sc);
      const desc = completionDesc(sc);
      const hint = aliasHint(sc);
      const pad = " ".repeat(Math.max(1, 16 - name.length));
      lines.push(`    complete -c $cmd -n '__woco_needs_${parent.name}_subcmd' -a '${name}'${pad}-d '${desc}${hint}'`);
    }
    lines.push(`    complete -c $cmd -n '__woco_needs_${parent.name}_subcmd' -a 'help'            -d 'Show help'`);
    lines.push("");
  }

  // --- Special: completion subcommand ---
  const completionParents = ["completion", ...(COMMAND_REGISTRY.find((c) => c.name === "completion")?.aliases ?? [])].join(" ");
  lines.push(`    # --- completion subcommand ---`);
  lines.push(`    complete -c $cmd -n '__fish_seen_subcommand_from ${completionParents}' -a 'bash zsh fish install uninstall'`);
  lines.push("");

  // --- Special: describe subcommand ---
  const describeParents = ["describe", ...(COMMAND_REGISTRY.find((c) => c.name === "describe")?.aliases ?? [])].join(" ");
  lines.push(`    # --- describe subcommand ---`);
  lines.push(`    complete -c $cmd -n '__fish_seen_subcommand_from ${describeParents}' -a '${allCommandNames().join(" ")}'`);
  lines.push("");

  // --- Per-command flags ---
  for (const cmd of COMMAND_REGISTRY) {
    if (cmd.subcommands?.length) continue; // parent flags handled via subcommands

    const flags = getCommandFlags(cmd);
    if (flags.length === 0) continue;

    const seenFrom = [cmd.name, ...(cmd.aliases ?? [])].join(" ");
    lines.push(`    # --- Flags: ${cmd.name} ---`);

    for (const flag of flags) {
      const longName = flag.name.replace(/^--/, "");
      const desc = flag.description;
      const needsValue = flag.type !== "boolean";
      const enumVals = flag.enum?.length ? ` -xa '${flag.enum.join(" ")}'` : "";
      const valueFlag = needsValue && !flag.enum?.length ? " -x" : "";

      lines.push(`    complete -c $cmd -n '__fish_seen_subcommand_from ${seenFrom}' -l ${longName}${" ".repeat(Math.max(1, 16 - longName.length))}-d '${desc}'${valueFlag}${enumVals}`);

      if (flag.alias) {
        const shortChar = flag.alias.replace(/^-/, "");
        lines.push(`    complete -c $cmd -n '__fish_seen_subcommand_from ${seenFrom}' -s ${shortChar}${" ".repeat(Math.max(1, 18 - shortChar.length))}-d '${desc}'${valueFlag}${enumVals}`);
      }
    }
    lines.push("");
  }

  // --- Per-subcommand flags ---
  for (const parent of parentCommands()) {
    const subs = parent.subcommands!;

    lines.push(`    # --- Flags: ${parent.name} subcommand-specific ---`);
    for (const sc of subs) {
      const flags = getCommandFlags(sc);
      if (flags.length === 0) continue;

      const scName = cmdShortName(sc);
      const scAliases = sc.aliases ?? [];
      const condition = `'__woco_${parent.name}_subcmd ${[scName, ...scAliases].join(" ")}'`;

      for (const flag of flags) {
        const longName = flag.name.replace(/^--/, "");
        const desc = flag.description;
        const needsValue = flag.type !== "boolean";
        const enumVals = flag.enum?.length ? ` -xa '${flag.enum.join(" ")}'` : "";
        const valueFlag = needsValue && !flag.enum?.length ? " -x" : "";

        lines.push(`    complete -c $cmd -n ${condition} -l ${longName}${" ".repeat(Math.max(1, 16 - longName.length))}-d '${desc}'${valueFlag}${enumVals}`);

        if (flag.alias) {
          const shortChar = flag.alias.replace(/^-/, "");
          lines.push(`    complete -c $cmd -n ${condition} -s ${shortChar}${" ".repeat(Math.max(1, 18 - shortChar.length))}-d '${desc}'${valueFlag}${enumVals}`);
        }
      }
    }
    lines.push("");
  }

  lines.push("end");

  return lines.join("\n") + "\n";
}
