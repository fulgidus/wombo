/**
 * help.ts — Citty command definition for `woco help`.
 *
 * Proof-of-concept citty command definition that replaces the
 * hand-rolled help handling in index.ts. Uses the existing
 * renderGlobalHelp() from schema.ts for output consistency.
 */

import { defineCommand } from "citty";
import { renderGlobalHelp } from "../../lib/schema.js";

export const helpCommand = defineCommand({
  meta: {
    name: "help",
    description: "Show help text",
  },
  run() {
    console.log(renderGlobalHelp());
  },
});
