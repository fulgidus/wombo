/**
 * wishlist.ts — Citty command definition for `woco wishlist`.
 *
 * Parent command with 3 subcommands: add, list, delete.
 *
 * Each subcommand delegates to the wishlist-store API directly
 * (addItem, listItems, deleteItem). The parent command defaults to
 * `list` when invoked without a subcommand.
 */

import { defineCommand } from "citty";
import { resolve } from "node:path";
import { loadConfig, validateConfig, isProjectInitialized, WOMBO_DIR } from "../../config.js";
import { resolveOutputFormat, output, outputError } from "../../lib/output.js";
import {
  addItem as addWishlistItem,
  listItems as listWishlistItems,
  deleteItem as deleteWishlistItem,
  moveItem as moveWishlistItem,
} from "../../lib/wishlist-store.js";

// ---------------------------------------------------------------------------
// Shared: load config + ensure project is initialized
// ---------------------------------------------------------------------------

async function loadProjectContext() {
  const projectRoot = resolve(process.cwd());

  if (!isProjectInitialized(projectRoot)) {
    console.error(
      `\nThis project hasn't been initialized yet.\n` +
        `Run \`woco init\` to set up ${WOMBO_DIR}/ with config, tasks, and archive stores.\n`
    );
    process.exit(1);
  }

  const config = loadConfig(projectRoot);
  validateConfig(config);

  return { projectRoot, config };
}

// ---------------------------------------------------------------------------
// Subcommand: add
// ---------------------------------------------------------------------------

const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Add a wishlist item (also: a)",
  },
  args: {
    text: {
      type: "positional",
      description: "Idea text",
      required: true,
    },
    tag: {
      type: "string",
      description: "Categorization tag (can be repeated)",
      required: false,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    if (!args.text) {
      outputError(fmt, 'Usage: woco wishlist add "Your idea here" [--tag <tag>]');
      return;
    }

    // Parse tags: support comma-separated or repeated --tag flags
    const tags: string[] = args.tag
      ? args.tag.split(",").map((s: string) => s.trim()).filter(Boolean)
      : [];

    try {
      const item = addWishlistItem(projectRoot, args.text, tags);
      output(
        fmt,
        item,
        () => {
          console.log(`Added wishlist item: ${item.text}`);
          console.log(`  ID: ${item.id}`);
          if (item.tags.length > 0) {
            console.log(`  Tags: ${item.tags.join(", ")}`);
          }
        }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      outputError(fmt, `Failed to add wishlist item: ${msg}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all wishlist items (also: ls)",
  },
  args: {
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    const items = listWishlistItems(projectRoot);
    output(
      fmt,
      items,
      () => {
        if (items.length === 0) {
          console.log("No wishlist items yet. Add one with: woco wishlist add \"Your idea\"");
          return;
        }
        console.log(`Wishlist (${items.length} item${items.length === 1 ? "" : "s"}):\n`);
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const pos = String(i + 1).padStart(3);
          const tags = item.tags.length > 0 ? ` [${item.tags.join(", ")}]` : "";
          const date = new Date(item.created_at).toLocaleDateString();
          console.log(`  ${pos}. ${item.id.slice(0, 8)}  ${item.text}${tags}  (${date})`);
        }
      }
    );
  },
});

// ---------------------------------------------------------------------------
// Subcommand: move
// ---------------------------------------------------------------------------

const moveCommand = defineCommand({
  meta: {
    name: "move",
    description: "Move a wishlist item to a new position (also: mv)",
  },
  args: {
    id: {
      type: "positional",
      description: "Wishlist item ID (or prefix)",
      required: true,
    },
    position: {
      type: "positional",
      description: "Target position (1-indexed)",
      required: true,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    if (!args.id || !args.position) {
      outputError(fmt, "Usage: woco wishlist move <id> <position>");
      return;
    }

    const newPos = parseInt(args.position, 10);
    if (isNaN(newPos) || newPos < 1) {
      outputError(fmt, "Position must be a positive integer (1-indexed).");
      return;
    }

    // Support both full UUIDs and short prefixes
    const items = listWishlistItems(projectRoot);
    const match = items.find(
      (item) => item.id === args.id || item.id.startsWith(args.id!)
    );

    if (!match) {
      outputError(fmt, `No wishlist item found matching: ${args.id}`);
      return;
    }

    const moved = moveWishlistItem(projectRoot, match.id, newPos);
    if (moved) {
      output(
        fmt,
        { moved: true, id: moved.id, text: moved.text, order: moved.order },
        () => {
          console.log(`Moved "${moved.text}" to position ${moved.order}.`);
        }
      );
    } else {
      outputError(fmt, `Failed to move wishlist item: ${match.id}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Subcommand: delete
// ---------------------------------------------------------------------------

const deleteCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a wishlist item (also: rm, del, d)",
  },
  args: {
    id: {
      type: "positional",
      description: "Wishlist item ID (or prefix)",
      required: true,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output format: text, json, or toon",
      required: false,
    },
  },
  async run({ args }) {
    const { projectRoot } = await loadProjectContext();
    const fmt = resolveOutputFormat(args.output);

    if (!args.id) {
      outputError(fmt, "Usage: woco wishlist delete <id>");
      return;
    }

    // Support both full UUIDs and short prefixes
    const items = listWishlistItems(projectRoot);
    const match = items.find(
      (item) => item.id === args.id || item.id.startsWith(args.id!)
    );

    if (!match) {
      outputError(fmt, `No wishlist item found matching: ${args.id}`);
      return;
    }

    const deleted = deleteWishlistItem(projectRoot, match.id);
    if (deleted) {
      output(
        fmt,
        { deleted: true, id: match.id, text: match.text },
        () => {
          console.log(`Deleted wishlist item: ${match.text}`);
        }
      );
    } else {
      outputError(fmt, `Failed to delete wishlist item: ${match.id}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Parent command: wishlist
// ---------------------------------------------------------------------------

export const wishlistCommand = defineCommand({
  meta: {
    name: "wishlist",
    description: "Quick-capture ideas for later (also: w, wl)",
  },
  subCommands: {
    add: addCommand,
    list: listCommand,
    move: moveCommand,
    delete: deleteCommand,
  },
  // Default behavior: when invoked as bare `woco wishlist`, run `wishlist list`
  async run() {
    const { projectRoot } = await loadProjectContext();
    const fmt = resolveOutputFormat(undefined);

    const items = listWishlistItems(projectRoot);
    output(
      fmt,
      items,
      () => {
        if (items.length === 0) {
          console.log("No wishlist items yet. Add one with: woco wishlist add \"Your idea\"");
          return;
        }
        console.log(`Wishlist (${items.length} item${items.length === 1 ? "" : "s"}):\n`);
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const pos = String(i + 1).padStart(3);
          const tags = item.tags.length > 0 ? ` [${item.tags.join(", ")}]` : "";
          const date = new Date(item.created_at).toLocaleDateString();
          console.log(`  ${pos}. ${item.id.slice(0, 8)}  ${item.text}${tags}  (${date})`);
        }
      }
    );
  },
});
