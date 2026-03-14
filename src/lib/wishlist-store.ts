/**
 * wishlist-store.ts — Flat YAML-based wishlist storage.
 *
 * Storage: .wombo-combo/wishlist.yml
 * Format: A flat YAML array of WishlistItem objects.
 *
 * Provides simple CRUD operations:
 *   - loadWishlist()  — Load all items from the YAML file
 *   - addItem()       — Add a new item with auto-generated ID
 *   - deleteItem()    — Remove an item by ID
 *   - listItems()     — Return all items (alias for loadWishlist)
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { WOMBO_DIR } from "../config.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single wishlist item.
 */
export interface WishlistItem {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Description of the wishlist item */
  text: string;
  /** ISO 8601 timestamp of when the item was created */
  created_at: string;
  /** Optional tags for categorization */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename for the wishlist store inside .wombo-combo/ */
const WISHLIST_FILE = "wishlist.yml";

const YAML_OPTS = {
  lineWidth: 120,
  defaultKeyType: "PLAIN" as const,
  defaultStringType: "PLAIN" as const,
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the full path to the wishlist YAML file.
 */
function wishlistPath(projectRoot: string): string {
  return resolve(projectRoot, WOMBO_DIR, WISHLIST_FILE);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

/**
 * Normalize a parsed item to ensure all fields are present.
 */
function normalizeItem(item: Partial<WishlistItem>): WishlistItem {
  return {
    id: item.id ?? randomUUID(),
    text: item.text ?? "",
    created_at: item.created_at ?? new Date().toISOString(),
    tags: item.tags ?? [],
  };
}

// ---------------------------------------------------------------------------
// Public API — Load
// ---------------------------------------------------------------------------

/**
 * Load all wishlist items from .wombo-combo/wishlist.yml.
 * Returns an empty array if the file does not exist or is empty.
 */
export function loadWishlist(projectRoot: string): WishlistItem[] {
  const filePath = wishlistPath(projectRoot);
  if (!existsSync(filePath)) return [];

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw);

    // YAML parses empty files / `null` as null
    if (!parsed) return [];
    if (!Array.isArray(parsed)) {
      console.error(`wishlist.yml: expected a YAML array, got ${typeof parsed}`);
      return [];
    }

    return parsed.map((item: unknown) => normalizeItem(item as Partial<WishlistItem>));
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`Failed to parse ${WISHLIST_FILE}: ${reason}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API — Save (internal, used by mutating operations)
// ---------------------------------------------------------------------------

/**
 * Save the full wishlist array to .wombo-combo/wishlist.yml.
 */
function saveWishlist(projectRoot: string, items: WishlistItem[]): void {
  const filePath = wishlistPath(projectRoot);
  ensureDir(dirname(filePath));

  const yaml = stringifyYaml(items, YAML_OPTS);
  atomicWrite(filePath, yaml);
}

// ---------------------------------------------------------------------------
// Public API — CRUD
// ---------------------------------------------------------------------------

/**
 * Add a new item to the wishlist.
 *
 * @param projectRoot — The project root directory.
 * @param text — Description of the wishlist item.
 * @param tags — Optional tags for categorization.
 * @returns The newly created WishlistItem.
 */
export function addItem(
  projectRoot: string,
  text: string,
  tags: string[] = []
): WishlistItem {
  const items = loadWishlist(projectRoot);

  const newItem: WishlistItem = {
    id: randomUUID(),
    text,
    created_at: new Date().toISOString(),
    tags,
  };

  items.push(newItem);
  saveWishlist(projectRoot, items);
  return newItem;
}

/**
 * Delete an item from the wishlist by ID.
 *
 * @param projectRoot — The project root directory.
 * @param id — The UUID of the item to delete.
 * @returns true if the item was found and removed, false otherwise.
 */
export function deleteItem(projectRoot: string, id: string): boolean {
  const items = loadWishlist(projectRoot);
  const index = items.findIndex((item) => item.id === id);

  if (index === -1) return false;

  items.splice(index, 1);
  saveWishlist(projectRoot, items);
  return true;
}

/**
 * List all items in the wishlist.
 * This is a convenience alias for loadWishlist().
 *
 * @param projectRoot — The project root directory.
 * @returns Array of all WishlistItem objects.
 */
export function listItems(projectRoot: string): WishlistItem[] {
  return loadWishlist(projectRoot);
}
