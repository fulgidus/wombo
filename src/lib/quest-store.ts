/**
 * quest-store.ts — Folder-based quest storage.
 *
 * Layout inside .wombo-combo/:
 *   quests/
 *     <quest-id>.yml       — one file per quest
 *
 * Each quest file is a plain YAML mapping of a single Quest object.
 * Unlike the task store, quests have no _meta.yml — each quest file
 * is self-contained with its own timestamps.
 *
 * Quests also support a knowledge file per quest:
 *   quests/<quest-id>/knowledge.md
 * This is a shared read-only file seeded by the planner with
 * architectural decisions, API contracts, and shared types.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { WOMBO_DIR } from "../config";
import type { Quest } from "./quest";
import { normalizeQuest, validateQuest } from "./quest";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory name for quests inside .wombo-combo/ */
const QUESTS_DIR = "quests";

/** Directory name for archived quests inside .wombo-combo/ */
const QUEST_ARCHIVE_DIR = "quest-archive";

const YAML_OPTS = {
  lineWidth: 120,
  defaultKeyType: "PLAIN" as const,
  defaultStringType: "PLAIN" as const,
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function questsDir(projectRoot: string): string {
  return resolve(projectRoot, WOMBO_DIR, QUESTS_DIR);
}

function questFilePath(projectRoot: string, questId: string): string {
  return join(questsDir(projectRoot), `${questId}.yml`);
}

function knowledgeDir(projectRoot: string, questId: string): string {
  return join(questsDir(projectRoot), questId);
}

function knowledgeFilePath(projectRoot: string, questId: string): string {
  return join(knowledgeDir(projectRoot, questId), "knowledge.md");
}

function questArchiveDir(projectRoot: string): string {
  return resolve(projectRoot, WOMBO_DIR, QUEST_ARCHIVE_DIR);
}

function archivedQuestFilePath(projectRoot: string, questId: string): string {
  return join(questArchiveDir(projectRoot), `${questId}.yml`);
}

function archivedKnowledgeDir(projectRoot: string, questId: string): string {
  return join(questArchiveDir(projectRoot), questId);
}

function archivedKnowledgeFilePath(projectRoot: string, questId: string): string {
  return join(archivedKnowledgeDir(projectRoot, questId), "knowledge.md");
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

// ---------------------------------------------------------------------------
// Public API — Load
// ---------------------------------------------------------------------------

/**
 * Check if the quests directory exists.
 */
export function questsStoreExists(projectRoot: string): boolean {
  return existsSync(questsDir(projectRoot));
}

/**
 * Load a single quest by ID. Returns null if not found.
 */
export function loadQuest(
  projectRoot: string,
  questId: string
): Quest | null {
  const filePath = questFilePath(projectRoot, questId);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw);
    if (!parsed || typeof parsed !== "object") return null;

    normalizeQuest(parsed as Quest);

    // Validate and warn
    const issues = validateQuest(parsed);
    for (const issue of issues) {
      if (issue.level === "error") {
        console.error(`  [quest-schema] ${issue.questId}: ${issue.message}`);
      } else {
        console.warn(`  [quest-schema] ${issue.questId}: ${issue.message}`);
      }
    }

    return parsed as Quest;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`Failed to parse quest ${questId}: ${reason}`);
    return null;
  }
}

/**
 * List all quest IDs in the store (sorted alphabetically).
 */
export function listQuestIds(projectRoot: string): string[] {
  const dir = questsDir(projectRoot);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => f.replace(/\.yml$/, ""))
    .sort();
}

/**
 * Load all quests from the store.
 */
export function loadAllQuests(projectRoot: string): Quest[] {
  const ids = listQuestIds(projectRoot);
  const quests: Quest[] = [];

  for (const id of ids) {
    const quest = loadQuest(projectRoot, id);
    if (quest) quests.push(quest);
  }

  return quests;
}

// ---------------------------------------------------------------------------
// Public API — Save
// ---------------------------------------------------------------------------

/**
 * Save a quest to the store. Creates the quests directory if needed.
 * Updates the quest's updated_at timestamp.
 */
export function saveQuest(
  projectRoot: string,
  quest: Quest
): void {
  const dir = questsDir(projectRoot);
  ensureDir(dir);

  quest.updated_at = new Date().toISOString();

  const yaml = stringifyYaml(quest, YAML_OPTS);
  const filePath = questFilePath(projectRoot, quest.id);
  atomicWrite(filePath, yaml);
}

// ---------------------------------------------------------------------------
// Public API — Delete
// ---------------------------------------------------------------------------

/**
 * Delete a quest from the store. Also removes its knowledge directory.
 */
export function deleteQuest(
  projectRoot: string,
  questId: string
): void {
  const filePath = questFilePath(projectRoot, questId);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }

  // Clean up knowledge directory if it exists
  const kDir = knowledgeDir(projectRoot, questId);
  if (existsSync(kDir)) {
    // Remove knowledge.md
    const kFile = knowledgeFilePath(projectRoot, questId);
    if (existsSync(kFile)) unlinkSync(kFile);
    // Try to remove the directory (only works if empty)
    try {
      rmdirSync(kDir);
    } catch {
      // Not critical — leave it if non-empty
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — Knowledge file
// ---------------------------------------------------------------------------

/**
 * Load the knowledge file for a quest. Returns null if not found.
 */
export function loadQuestKnowledge(
  projectRoot: string,
  questId: string
): string | null {
  const filePath = knowledgeFilePath(projectRoot, questId);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

/**
 * Save or update the knowledge file for a quest.
 */
export function saveQuestKnowledge(
  projectRoot: string,
  questId: string,
  content: string
): void {
  const dir = knowledgeDir(projectRoot, questId);
  ensureDir(dir);
  const filePath = knowledgeFilePath(projectRoot, questId);
  atomicWrite(filePath, content);
}

// ---------------------------------------------------------------------------
// Public API — Archive
// ---------------------------------------------------------------------------

/**
 * Archive a quest — moves it from quests/ to quest-archive/,
 * including its knowledge directory if present.
 * The quest must be in a terminal state (completed or abandoned).
 */
export function archiveQuest(
  projectRoot: string,
  questId: string
): void {
  const srcFile = questFilePath(projectRoot, questId);
  if (!existsSync(srcFile)) {
    throw new Error(`Quest "${questId}" not found in active quests`);
  }

  const destDir = questArchiveDir(projectRoot);
  ensureDir(destDir);

  // Move quest file
  const destFile = archivedQuestFilePath(projectRoot, questId);
  renameSync(srcFile, destFile);

  // Move knowledge directory if it exists
  const srcKDir = knowledgeDir(projectRoot, questId);
  if (existsSync(srcKDir)) {
    const destKDir = archivedKnowledgeDir(projectRoot, questId);
    ensureDir(destKDir);
    // Move knowledge.md
    const srcKFile = knowledgeFilePath(projectRoot, questId);
    if (existsSync(srcKFile)) {
      const destKFile = archivedKnowledgeFilePath(projectRoot, questId);
      renameSync(srcKFile, destKFile);
    }
    // Remove the now-empty source knowledge dir
    try {
      rmdirSync(srcKDir);
    } catch {
      // Not critical — leave if non-empty
    }
  }
}

/**
 * Load a single archived quest by ID. Returns null if not found.
 */
export function loadArchivedQuest(
  projectRoot: string,
  questId: string
): Quest | null {
  const filePath = archivedQuestFilePath(projectRoot, questId);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw);
    if (!parsed || typeof parsed !== "object") return null;
    normalizeQuest(parsed as Quest);
    return parsed as Quest;
  } catch {
    return null;
  }
}

/**
 * List all archived quest IDs (sorted alphabetically).
 */
export function listArchivedQuestIds(projectRoot: string): string[] {
  const dir = questArchiveDir(projectRoot);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => f.replace(/\.yml$/, ""))
    .sort();
}

/**
 * Load all archived quests.
 */
export function loadAllArchivedQuests(projectRoot: string): Quest[] {
  const ids = listArchivedQuestIds(projectRoot);
  const quests: Quest[] = [];
  for (const id of ids) {
    const quest = loadArchivedQuest(projectRoot, id);
    if (quest) quests.push(quest);
  }
  return quests;
}

// ---------------------------------------------------------------------------
// Public API — Quest directory path (for external consumers)
// ---------------------------------------------------------------------------

/**
 * Get the quests directory path.
 */
export function getQuestsDir(projectRoot: string): string {
  return questsDir(projectRoot);
}
