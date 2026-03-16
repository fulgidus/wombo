#!/usr/bin/env bun
/**
 * index.ts — CLI entry point for the wombo-combo agent orchestration system.
 *
 * All command routing is handled by citty. This file is responsible for:
 *   1. Dev-mode guard (warn if running global binary inside the repo)
 *   2. Global flag extraction and command resolution
 *   3. Routing to the citty command router
 *   4. Global error handlers
 *
 * Every command has a short alias (e.g., woco i = woco init, woco t ls = woco tasks list).
 *
 * Usage:
 *   woco init                                         (alias: i)
 *   woco launch --top-priority 3                      (alias: l)
 *   woco launch --quickest-wins 5
 *   woco launch --priority high
 *   woco launch --difficulty easy
 *   woco launch --tasks "feat-a,feat-b"
 *   woco launch --all-ready
 *   woco launch ... --max-concurrent 3 --model "anthropic/claude-sonnet-4-20250514"
 *   woco launch ... --interactive
 *   woco resume                                       (alias: r)
 *   woco status                                       (alias: s)
 *   woco verify [feature-id]                          (alias: v)
 *   woco merge [feature-id]                           (alias: m)
 *   woco retry <feature-id>                           (alias: re)
 *   woco abort <feature-id> [--requeue] [--output json]  (alias: a)
 *   woco logs <feature-id> [--tail N] [--follow]      (alias: lo)
 *   woco cleanup                                      (alias: c)
 *   woco history [wave-id] [--output json]            (alias: h)
 *   woco usage [--by <key>] [--since <date>] [--until <date>] [--format table|json]  (alias: us)
 *   woco tasks list [--status <s>] [--priority <p>]   (alias: t ls)
 *   woco tasks add <id> <title> [options]             (alias: t a)
 *   woco tasks set-status <task-id> <status>          (alias: t ss)
 *   woco tasks set-priority <task-id> <priority>      (alias: t sp)
 *   woco tasks set-difficulty <task-id> <difficulty>   (alias: t sd)
 *   woco tasks check                                  (alias: t ch)
 *   woco tasks archive [task-id] [--dry-run]          (alias: t ar)
 *   woco tasks show <task-id>                         (alias: t sh)
 *   woco tasks graph [--ascii] [--mermaid]            (alias: t g)
 *   woco completion <bash|zsh|fish>                   (alias: comp)
 *   woco tui                                          (default when no args)
 *   woco wishlist add "idea" [--tag <t>]               (alias: w a, wl a)
 *   woco wishlist list                                 (alias: w ls, wl ls)
 *   woco wishlist delete <id>                          (alias: w rm, wl d)
 *   woco quest create <id> "Title" --goal "..."        (alias: q c)
 *   woco quest list                                    (alias: q ls)
 *   woco quest show <id>                               (alias: q sh)
 *   woco genesis "Vision text" [--tech-stack "..."]    (alias: g)
 *   woco help                                         (alias: -h, --help)
 *   woco version
 *   woco -v
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadState, saveState } from "./lib/state";

// ---------------------------------------------------------------------------
// Dev-mode guard: warn if running the global binary inside the wombo-combo repo
// ---------------------------------------------------------------------------

function checkDevModeGuard(): void {
  const cwd = process.cwd();
  const pkgPath = resolve(cwd, "package.json");

  // Are we inside the wombo-combo repo?
  if (!existsSync(pkgPath)) return;

  let pkgName: string | undefined;
  try {
    const raw = readFileSync(pkgPath, "utf-8");
    pkgName = JSON.parse(raw).name;
  } catch {
    return;
  }
  if (pkgName !== "wombo-combo") return;

  // We're in the wombo-combo repo. Is the source being run from a different location?
  // import.meta.dir = directory of THIS file (index.ts). If it's under cwd,
  // we're running local source (bun dev). If it's elsewhere (e.g. ~/.bun/install),
  // we're running the globally installed binary.
  const sourceDir = resolve(import.meta.dir);
  const projectSrc = resolve(cwd, "src");

  if (!sourceDir.startsWith(projectSrc)) {
    console.warn(
      "\x1b[33m[WARNING]\x1b[0m You are running the globally installed woco binary " +
      "inside the wombo-combo repo.\n" +
      "  Use \x1b[1mbun dev <command>\x1b[0m instead to run from local source.\n" +
      "  See AGENTS.md for details.\n"
    );
  }
}

import {
  isCittyCommand,
  runCittyCommand,
  resolveGlobalFlagsAndCommand,
} from "./commands/citty/router";
import { renderGlobalHelp, renderCommandHelp } from "./lib/schema";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  checkDevModeGuard();

  const rawArgs = process.argv.slice(2); // skip 'bun' and script path
  const { command, globalFlags, remaining } = resolveGlobalFlagsAndCommand(rawArgs);

  // -----------------------------------------------------------------------
  // Per-command help: `woco launch -h`, `woco tasks -h`, etc.
  // -----------------------------------------------------------------------
  if (globalFlags.help) {
    // If the default command (tui) and help was requested, show global help
    if (command === "tui") {
      console.log(renderGlobalHelp());
      return;
    }

    // Show command-specific help from the schema registry.
    // remaining[0] may be a subcommand (e.g. "woco tasks list -h" → "list")
    const subcommand = remaining.length > 0 ? remaining[0] : undefined;
    const helpText = renderCommandHelp(command, subcommand);
    if (helpText) {
      console.log(helpText);
    } else {
      console.error(`No help available for: ${command}${subcommand ? ` ${subcommand}` : ""}`);
      console.log(renderGlobalHelp());
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Route ALL commands through citty
  // -----------------------------------------------------------------------
  if (isCittyCommand(command)) {
    // Re-add --dev if it was present (stripped by extractGlobalFlags but
    // needed by citty commands that define --dev as an arg)
    const cittyArgs = [...remaining];
    if (globalFlags.dev && !cittyArgs.includes("--dev")) {
      cittyArgs.push("--dev");
    }
    if (globalFlags.force && !cittyArgs.includes("--force")) {
      cittyArgs.push("--force");
    }

    await runCittyCommand(command, cittyArgs);
    return;
  }

  // -----------------------------------------------------------------------
  // Unknown command
  // -----------------------------------------------------------------------
  console.error(`Unknown command: ${command}`);
  console.log(renderGlobalHelp());
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Error Handlers & Entry
// ---------------------------------------------------------------------------

// Global error handlers — prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error(`\n[FATAL] Uncaught exception: ${err.message}`);
  console.error(err.stack);
  try {
    const state = loadState(process.cwd());
    if (state) saveState(process.cwd(), state);
  } catch {}
  process.exit(1);
});

process.on("unhandledRejection", (reason: any) => {
  console.error(`\n[FATAL] Unhandled rejection: ${reason?.message || reason}`);
  if (reason?.stack) console.error(reason.stack);
  try {
    const state = loadState(process.cwd());
    if (state) saveState(process.cwd(), state);
  } catch {}
  process.exit(1);
});

// Only run main() when executed directly, not when imported as a module
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
}
