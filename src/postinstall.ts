#!/usr/bin/env bun
/**
 * postinstall.ts — Runs after `bun add -g` to check shell completions
 * and source the user's rc file so the new version's completions are
 * available immediately.
 */

import { execSync } from "node:child_process";
import { checkShellCompletions } from "./commands/upgrade.js";

try {
  const { shell, rcPath } = checkShellCompletions();

  // If completions are already wired up, source the rc file so the
  // current shell picks up any changes from the new version.
  if (rcPath && shell && shell !== "fish") {
    try {
      // Spawn a child that sources the rc — won't affect the parent shell,
      // but we can at least regenerate any cached completions.
      const shellBin = process.env.SHELL || `/usr/bin/${shell}`;
      execSync(`${shellBin} -c "source '${rcPath}'"`, {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      // Non-critical — the user can source manually
    }
  }
} catch {
  // postinstall must never fail the install
}
