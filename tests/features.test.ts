/**
 * features.test.ts — Unit tests for tasks YAML parsing, validation,
 * duration parsing, and dependency resolution.
 *
 * Coverage:
 *   - loadFeatures with null tasks, empty arrays, valid data
 *   - parseDurationMinutes for ISO 8601 durations
 *   - formatDuration for human-readable output
 *   - Dependency resolution (areDependenciesMet, getReadyFeatures)
 *   - normalizeTask defaults
 *   - createBlankFeature
 *   - findFeatureById (recursive search)
 *   - selectFeatures strategies
 *   - YAML schema edge cases
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WomboConfig } from "../src/config";
import {
  loadFeatures,
  parseDurationMinutes,
  formatDuration,
  areDependenciesMet,
  getReadyFeatures,
  getDoneFeatureIds,
  selectFeatures,
  createBlankFeature,
  findFeatureById,
  allFeatureIds,
  featureSummary,
  PRIORITY_ORDER,
  DIFFICULTY_ORDER,
} from "../src/lib/tasks";
import type {
  Feature,
  FeaturesFile,
  Subtask,
  Priority,
  Difficulty,
} from "../src/lib/tasks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<WomboConfig>): WomboConfig {
  return {
    tasksDir: "tasks",
    archiveDir: "archive",
    baseBranch: "main",
    build: { command: "bun run build", timeout: 300_000, artifactDir: "dist" },
    install: { command: "bun install", timeout: 120_000 },
    git: {
      branchPrefix: "feature/",
      worktreePrefix: "wombo-",
      remote: "origin",
      mergeStrategy: "--no-ff",
    },
    agent: {
      bin: null,
      name: "generalist-agent",
      configFiles: [],
      tmuxPrefix: "wombo",
      multiplexer: "auto",
    },
    portless: {
      enabled: true,
      bin: null,
      proxyPort: 1355,
      https: false,
    },
    backup: { maxBackups: 5 },
    defaults: { maxConcurrent: 6, maxRetries: 2 },
    browser: {
      enabled: false,
      bin: null,
      headless: true,
      testCommand: null,
      launchTimeout: 30_000,
      testTimeout: 60_000,
      defaultViewport: { width: 1280, height: 720 },
    },
    agentRegistry: {
      mode: "auto",
      source: "msitarzewski/agency-agents",
      cacheDir: "agents-cache",
      cacheTTL: 24 * 60 * 60 * 1000,
    },
    tdd: {
      enabled: false,
      testCommand: "bun test",
    },
    ...overrides,
  };
}

function makeFeature(overrides?: Partial<Feature>): Feature {
  return {
    id: "test-feature",
    title: "Test Feature",
    description: "A test feature",
    status: "planned",
    completion: 0,
    difficulty: "medium",
    priority: "medium",
    depends_on: [],
    effort: "PT1H",
    started_at: null,
    ended_at: null,
    constraints: [],
    forbidden: [],
    references: [],
    notes: [],
    subtasks: [],
    ...overrides,
  };
}

function makeFeaturesFile(
  tasks: Feature[] = [],
  archive: Feature[] = []
): FeaturesFile {
  return {
    version: "1",
    meta: {
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
      project: "test-project",
      generator: "test",
      maintainer: "tester",
    },
    tasks,
    archive,
  };
}

/**
 * Write a YAML string to the .wombo-combo/tasks.yml inside the given tmpDir.
 * Also creates the .wombo-combo directory.
 */
function writeTasksYaml(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".wombo-combo"), { recursive: true });
  writeFileSync(join(dir, ".wombo-combo", "tasks.yml"), yaml);
}

/**
 * Write archive YAML to .wombo-combo/archive.yml.
 */
function writeArchiveYaml(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".wombo-combo"), { recursive: true });
  writeFileSync(join(dir, ".wombo-combo", "archive.yml"), yaml);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wombo-test-features-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ISO 8601 Duration Parsing
// ---------------------------------------------------------------------------

describe("parseDurationMinutes", () => {
  test("parses hours only", () => {
    expect(parseDurationMinutes("PT1H")).toBe(60);
    expect(parseDurationMinutes("PT2H")).toBe(120);
    expect(parseDurationMinutes("PT0H")).toBe(0);
  });

  test("parses minutes only", () => {
    expect(parseDurationMinutes("PT30M")).toBe(30);
    expect(parseDurationMinutes("PT1M")).toBe(1);
    expect(parseDurationMinutes("PT90M")).toBe(90);
  });

  test("parses days only", () => {
    expect(parseDurationMinutes("P1D")).toBe(1440);
    expect(parseDurationMinutes("P2D")).toBe(2880);
  });

  test("parses combined durations", () => {
    expect(parseDurationMinutes("PT1H30M")).toBe(90);
    expect(parseDurationMinutes("P1DT4H")).toBe(1680);
    expect(parseDurationMinutes("P2DT4H")).toBe(3120);
    expect(parseDurationMinutes("P1DT2H30M")).toBe(1590);
  });

  test("parses seconds (rounds up to minutes)", () => {
    expect(parseDurationMinutes("PT30S")).toBe(1); // ceil(30/60) = 1
    expect(parseDurationMinutes("PT60S")).toBe(1); // ceil(60/60) = 1
    expect(parseDurationMinutes("PT61S")).toBe(2); // ceil(61/60) = 2
    expect(parseDurationMinutes("PT1H30S")).toBe(61); // 60 + ceil(30/60)
  });

  test("returns Infinity for unparseable strings", () => {
    expect(parseDurationMinutes("")).toBe(Infinity);
    expect(parseDurationMinutes("invalid")).toBe(Infinity);
    expect(parseDurationMinutes("1H")).toBe(Infinity); // missing P
    expect(parseDurationMinutes("hello world")).toBe(Infinity);
  });

  test("handles edge case: PT alone parses as zero duration", () => {
    // "PT" matches the regex: P with T but all time groups are optional
    expect(parseDurationMinutes("PT")).toBe(0);
  });

  test("handles P alone (zero duration)", () => {
    // P with no components - the regex should handle this
    const result = parseDurationMinutes("P");
    // P alone matches /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
    // All groups are undefined, defaults to 0
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Duration Formatting
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  test("formats minutes only", () => {
    expect(formatDuration(30)).toBe("30m");
    expect(formatDuration(1)).toBe("1m");
    expect(formatDuration(59)).toBe("59m");
  });

  test("formats hours only", () => {
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(120)).toBe("2h");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(90)).toBe("1h 30m");
    expect(formatDuration(150)).toBe("2h 30m");
  });

  test("formats days", () => {
    expect(formatDuration(1440)).toBe("1d");
    expect(formatDuration(2880)).toBe("2d");
  });

  test("formats days and hours", () => {
    expect(formatDuration(1500)).toBe("1d 1h");
    expect(formatDuration(1560)).toBe("1d 2h");
  });

  test("formats days, hours, and minutes", () => {
    expect(formatDuration(1530)).toBe("1d 1h 30m");
  });

  test("formats Infinity as unknown", () => {
    expect(formatDuration(Infinity)).toBe("unknown");
  });

  test("formats zero", () => {
    expect(formatDuration(0)).toBe("0m");
  });
});

// ---------------------------------------------------------------------------
// loadFeatures — YAML parsing edge cases
// ---------------------------------------------------------------------------

describe("loadFeatures", () => {
  const config = makeConfig();

  test("loads valid tasks file", () => {
    const yaml = `
version: "1"
meta:
  created_at: "2025-01-01T00:00:00Z"
  updated_at: "2025-01-01T00:00:00Z"
  project: test
  generator: test
  maintainer: tester
tasks:
  - id: feat-a
    title: Feature A
    description: Description of A
    status: backlog
    completion: 0
    difficulty: medium
    priority: high
    depends_on: []
    effort: PT2H
    started_at: null
    ended_at: null
    constraints: []
    forbidden: []
    references: []
    notes: []
    subtasks: []
`;
    writeTasksYaml(tmpDir, yaml);
    const data = loadFeatures(tmpDir, config);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe("feat-a");
    expect(data.tasks[0].priority).toBe("high");
    expect(data.archive).toHaveLength(0);
  });

  test("handles null tasks (empty YAML key)", () => {
    const yaml = `
version: "1"
meta:
  created_at: "2025-01-01T00:00:00Z"
  updated_at: "2025-01-01T00:00:00Z"
  project: test
  generator: test
  maintainer: tester
tasks:
`;
    writeTasksYaml(tmpDir, yaml);
    const data = loadFeatures(tmpDir, config);
    expect(data.tasks).toBeArray();
    expect(data.tasks).toHaveLength(0);
    expect(data.archive).toBeArray();
    expect(data.archive).toHaveLength(0);
  });

  test("handles tasks with null depends_on and arrays", () => {
    const yaml = `
version: "1"
meta:
  created_at: "2025-01-01T00:00:00Z"
  updated_at: "2025-01-01T00:00:00Z"
  project: test
  generator: test
  maintainer: tester
tasks:
  - id: feat-a
    title: Feature A
    description: ""
    status: backlog
    completion: 0
    difficulty: medium
    priority: medium
    effort: PT1H
    started_at: null
    ended_at: null
`;
    writeTasksYaml(tmpDir, yaml);
    const data = loadFeatures(tmpDir, config);
    expect(data.tasks).toHaveLength(1);
    // normalizeTask should default null arrays to []
    const f = data.tasks[0];
    expect(f.depends_on).toBeArray();
    expect(f.depends_on).toHaveLength(0);
    expect(f.constraints).toBeArray();
    expect(f.forbidden).toBeArray();
    expect(f.references).toBeArray();
    expect(f.notes).toBeArray();
    expect(f.subtasks).toBeArray();
  });

  test("handles nested subtasks normalization (flattened by migration)", () => {
    // With folder-based storage, subtasks are flattened to top-level tasks
    // during migration. The parent task gains a depends_on reference to its
    // former subtask, and the subtask becomes a standalone top-level task.
    const yaml = `
version: "1"
meta:
  created_at: "2025-01-01T00:00:00Z"
  updated_at: "2025-01-01T00:00:00Z"
  project: test
  generator: test
  maintainer: tester
tasks:
  - id: feat-a
    title: Feature A
    description: ""
    status: backlog
    completion: 0
    difficulty: medium
    priority: medium
    effort: PT1H
    started_at: null
    ended_at: null
    subtasks:
      - id: sub-1
        title: Subtask 1
        description: ""
        status: backlog
        completion: 0
        difficulty: easy
        priority: medium
        effort: PT30M
        started_at: null
        ended_at: null
`;
    writeTasksYaml(tmpDir, yaml);
    const data = loadFeatures(tmpDir, config);
    // After migration, both feat-a and sub-1 are top-level tasks
    const ids = data.tasks.map((t) => t.id).sort();
    expect(ids).toContain("feat-a");
    expect(ids).toContain("sub-1");
    // The parent's subtasks array is empty (flattened)
    const parent = data.tasks.find((t) => t.id === "feat-a")!;
    expect(parent.subtasks).toBeArray();
    expect(parent.subtasks).toHaveLength(0);
    // The parent now depends on its former subtask
    expect(parent.depends_on).toContain("sub-1");
    // The former subtask is a top-level task with normalized arrays
    const subtask = data.tasks.find((t) => t.id === "sub-1")!;
    expect(subtask.depends_on).toBeArray();
    expect(subtask.constraints).toBeArray();
    expect(subtask.subtasks).toBeArray();
  });

  test("returns empty tasks on corrupted YAML (graceful degradation)", () => {
    // With folder-based storage, corrupted legacy YAML is caught during
    // migration and the store returns an empty TasksFile instead of throwing.
    writeTasksYaml(tmpDir, "{{{{not valid yaml::::");
    const data = loadFeatures(tmpDir, config);
    expect(data.tasks).toBeArray();
    expect(data.tasks).toHaveLength(0);
  });

  test("returns empty tasks on missing path (graceful degradation)", () => {
    // With folder-based storage, a missing path returns an empty TasksFile
    // instead of throwing (the store creates default meta on demand).
    const data = loadFeatures("/nonexistent/path", config);
    expect(data.tasks).toBeArray();
    expect(data.tasks).toHaveLength(0);
  });

  test("handles custom tasks file path", () => {
    const customConfig = makeConfig({ tasksFile: "custom-tasks.yml" });
    const yaml = `
version: "1"
meta:
  created_at: "2025-01-01T00:00:00Z"
  updated_at: "2025-01-01T00:00:00Z"
  project: test
  generator: test
  maintainer: tester
tasks: []
`;
    mkdirSync(join(tmpDir, ".wombo-combo"), { recursive: true });
    writeFileSync(join(tmpDir, ".wombo-combo", "custom-tasks.yml"), yaml);
    const data = loadFeatures(tmpDir, customConfig);
    expect(data.tasks).toHaveLength(0);
  });

  test("supports legacy 'features' YAML key", () => {
    const yaml = `
version: "1"
meta:
  created_at: "2025-01-01T00:00:00Z"
  updated_at: "2025-01-01T00:00:00Z"
  project: test
  generator: test
  maintainer: tester
features:
  - id: legacy-feat
    title: Legacy Feature
    description: Loaded via features key
    status: backlog
    completion: 0
    difficulty: medium
    priority: medium
    depends_on: []
    effort: PT1H
    started_at: null
    ended_at: null
    constraints: []
    forbidden: []
    references: []
    notes: []
    subtasks: []
`;
    writeTasksYaml(tmpDir, yaml);
    const data = loadFeatures(tmpDir, config);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe("legacy-feat");
  });
});

// ---------------------------------------------------------------------------
// Dependency Resolution
// ---------------------------------------------------------------------------

describe("areDependenciesMet", () => {
  test("returns true when feature has no dependencies", () => {
    const feature = makeFeature({ depends_on: [] });
    const doneIds = new Set<string>();
    expect(areDependenciesMet(feature, doneIds)).toBe(true);
  });

  test("returns true when all dependencies are done", () => {
    const feature = makeFeature({ depends_on: ["dep-a", "dep-b"] });
    const doneIds = new Set(["dep-a", "dep-b", "dep-c"]);
    expect(areDependenciesMet(feature, doneIds)).toBe(true);
  });

  test("returns false when some dependencies are not done", () => {
    const feature = makeFeature({ depends_on: ["dep-a", "dep-b"] });
    const doneIds = new Set(["dep-a"]);
    expect(areDependenciesMet(feature, doneIds)).toBe(false);
  });

  test("returns false when no dependencies are done", () => {
    const feature = makeFeature({ depends_on: ["dep-a", "dep-b"] });
    const doneIds = new Set<string>();
    expect(areDependenciesMet(feature, doneIds)).toBe(false);
  });
});

describe("getDoneFeatureIds", () => {
  test("identifies features with done status", () => {
    const data = makeFeaturesFile([
      makeFeature({ id: "feat-done", status: "done", completion: 100 }),
      makeFeature({ id: "feat-wip", status: "in_progress", completion: 50 }),
    ]);
    const doneIds = getDoneFeatureIds(data);
    expect(doneIds.has("feat-done")).toBe(true);
    expect(doneIds.has("feat-wip")).toBe(false);
  });

  test("identifies features with 100% completion as done", () => {
    const data = makeFeaturesFile([
      makeFeature({
        id: "feat-complete",
        status: "in_review",
        completion: 100,
      }),
    ]);
    const doneIds = getDoneFeatureIds(data);
    expect(doneIds.has("feat-complete")).toBe(true);
  });

  test("includes archived features as done", () => {
    const data = makeFeaturesFile(
      [],
      [makeFeature({ id: "archived-feat", status: "done", completion: 100 })]
    );
    const doneIds = getDoneFeatureIds(data);
    expect(doneIds.has("archived-feat")).toBe(true);
  });

  test("includes done subtasks", () => {
    const data = makeFeaturesFile([
      makeFeature({
        id: "parent",
        status: "in_progress",
        subtasks: [
          {
            id: "sub-done",
            title: "Done sub",
            description: "",
            status: "done",
            completion: 100,
            difficulty: "easy",
            priority: "medium",
            depends_on: [],
            effort: "PT30M",
            started_at: null,
            ended_at: null,
            constraints: [],
            forbidden: [],
            references: [],
            notes: [],
            subtasks: [],
          },
        ],
      }),
    ]);
    const doneIds = getDoneFeatureIds(data);
    expect(doneIds.has("sub-done")).toBe(true);
    expect(doneIds.has("parent")).toBe(false);
  });
});

describe("getReadyFeatures", () => {
  test("returns planned features with deps met", () => {
    const data = makeFeaturesFile([
      makeFeature({ id: "ready", status: "planned", depends_on: [] }),
      makeFeature({
        id: "blocked",
        status: "planned",
        depends_on: ["not-done"],
      }),
      makeFeature({ id: "in-progress", status: "in_progress" }),
    ]);
    const ready = getReadyFeatures(data);
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe("ready");
  });

  test("backlog features are NOT picked (must be planned)", () => {
    const data = makeFeaturesFile([
      makeFeature({ id: "parked", status: "backlog", depends_on: [] }),
    ]);
    const ready = getReadyFeatures(data);
    expect(ready).toHaveLength(0);
  });

  test("considers archived deps as met", () => {
    const data = makeFeaturesFile(
      [
        makeFeature({
          id: "waiting",
          status: "planned",
          depends_on: ["archived-dep"],
        }),
      ],
      [
        makeFeature({
          id: "archived-dep",
          status: "done",
          completion: 100,
        }),
      ]
    );
    const ready = getReadyFeatures(data);
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe("waiting");
  });

  test("excludes features with non-zero completion", () => {
    const data = makeFeaturesFile([
      makeFeature({ id: "partial", status: "planned", completion: 50 }),
    ]);
    const ready = getReadyFeatures(data);
    expect(ready).toHaveLength(0);
  });

  test("returns empty array when no features are ready", () => {
    const data = makeFeaturesFile([
      makeFeature({
        id: "blocked",
        status: "planned",
        depends_on: ["missing"],
      }),
    ]);
    const ready = getReadyFeatures(data);
    expect(ready).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// selectFeatures strategies
// ---------------------------------------------------------------------------

describe("selectFeatures", () => {
  const highPriority = makeFeature({
    id: "high-pri",
    priority: "high",
    effort: "PT2H",
  });
  const criticalSmall = makeFeature({
    id: "critical-small",
    priority: "critical",
    effort: "PT30M",
  });
  const mediumLong = makeFeature({
    id: "medium-long",
    priority: "medium",
    effort: "P1D",
  });
  const lowQuick = makeFeature({
    id: "low-quick",
    priority: "low",
    effort: "PT15M",
    difficulty: "easy",
  });

  const data = makeFeaturesFile([highPriority, criticalSmall, mediumLong, lowQuick]);

  test("allReady returns all ready features sorted by priority", () => {
    const selected = selectFeatures(data, { allReady: true });
    expect(selected).toHaveLength(4);
    expect(selected[0].id).toBe("critical-small");
    expect(selected[1].id).toBe("high-pri");
  });

  test("topPriority selects top N by priority", () => {
    const selected = selectFeatures(data, { topPriority: 2 });
    expect(selected).toHaveLength(2);
    expect(selected[0].id).toBe("critical-small");
    expect(selected[1].id).toBe("high-pri");
  });

  test("quickestWins selects N lowest effort", () => {
    const selected = selectFeatures(data, { quickestWins: 2 });
    expect(selected).toHaveLength(2);
    // Sorted by effort: 15m, 30m, 2h, 1d
    expect(selected[0].id).toBe("low-quick");
    expect(selected[1].id).toBe("critical-small");
  });

  test("priority filter selects matching priority", () => {
    const selected = selectFeatures(data, { priority: "high" });
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("high-pri");
  });

  test("difficulty filter selects matching difficulty", () => {
    const selected = selectFeatures(data, { difficulty: "easy" });
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("low-quick");
  });

  test("featureIds selects specific features (backward compat)", () => {
    const selected = selectFeatures(data, {
      featureIds: ["high-pri", "low-quick"],
    });
    expect(selected).toHaveLength(2);
  });

  test("featureIds with nonexistent IDs still returns valid ones", () => {
    const selected = selectFeatures(data, {
      featureIds: ["high-pri", "nonexistent"],
    });
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("high-pri");
  });

  test("default returns all ready sorted by priority", () => {
    const selected = selectFeatures(data, {});
    expect(selected).toHaveLength(4);
    expect(selected[0].id).toBe("critical-small");
  });
});

// ---------------------------------------------------------------------------
// createBlankFeature
// ---------------------------------------------------------------------------

describe("createBlankFeature", () => {
  test("creates feature with default values", () => {
    const f = createBlankFeature("my-feat", "My Feature");
    expect(f.id).toBe("my-feat");
    expect(f.title).toBe("My Feature");
    expect(f.status).toBe("backlog");
    expect(f.completion).toBe(0);
    expect(f.difficulty).toBe("medium");
    expect(f.priority).toBe("medium");
    expect(f.effort).toBe("PT1H");
    expect(f.depends_on).toEqual([]);
    expect(f.subtasks).toEqual([]);
  });

  test("creates feature with custom options", () => {
    const f = createBlankFeature("my-feat", "My Feature", "Description", {
      priority: "critical",
      difficulty: "hard",
      effort: "P2D",
    });
    expect(f.priority).toBe("critical");
    expect(f.difficulty).toBe("hard");
    expect(f.effort).toBe("P2D");
    expect(f.description).toBe("Description");
  });
});

// ---------------------------------------------------------------------------
// findFeatureById
// ---------------------------------------------------------------------------

describe("findFeatureById", () => {
  test("finds top-level feature", () => {
    const data = makeFeaturesFile([makeFeature({ id: "target" })]);
    const found = findFeatureById(data, "target");
    expect(found).toBeDefined();
    expect(found!.id).toBe("target");
  });

  test("finds feature in archive", () => {
    const data = makeFeaturesFile(
      [],
      [makeFeature({ id: "archived" })]
    );
    const found = findFeatureById(data, "archived");
    expect(found).toBeDefined();
    expect(found!.id).toBe("archived");
  });

  test("finds nested subtask", () => {
    const data = makeFeaturesFile([
      makeFeature({
        id: "parent",
        subtasks: [
          {
            id: "nested-sub",
            title: "Nested",
            description: "",
            status: "backlog",
            completion: 0,
            difficulty: "easy",
            priority: "medium",
            depends_on: [],
            effort: "PT30M",
            started_at: null,
            ended_at: null,
            constraints: [],
            forbidden: [],
            references: [],
            notes: [],
            subtasks: [],
          },
        ],
      }),
    ]);
    const found = findFeatureById(data, "nested-sub");
    expect(found).toBeDefined();
    expect(found!.id).toBe("nested-sub");
  });

  test("returns undefined for nonexistent ID", () => {
    const data = makeFeaturesFile([makeFeature({ id: "exists" })]);
    const found = findFeatureById(data, "nonexistent");
    expect(found).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// allFeatureIds
// ---------------------------------------------------------------------------

describe("allFeatureIds", () => {
  test("collects all IDs including subtasks and archive", () => {
    const data = makeFeaturesFile(
      [
        makeFeature({
          id: "feat-a",
          subtasks: [
            {
              id: "sub-1",
              title: "Sub",
              description: "",
              status: "backlog",
              completion: 0,
              difficulty: "easy",
              priority: "medium",
              depends_on: [],
              effort: "PT30M",
              started_at: null,
              ended_at: null,
              constraints: [],
              forbidden: [],
              references: [],
              notes: [],
              subtasks: [],
            },
          ],
        }),
      ],
      [makeFeature({ id: "archived" })]
    );
    const ids = allFeatureIds(data);
    expect(ids).toContain("feat-a");
    expect(ids).toContain("sub-1");
    expect(ids).toContain("archived");
  });
});

// ---------------------------------------------------------------------------
// featureSummary
// ---------------------------------------------------------------------------

describe("featureSummary", () => {
  test("produces formatted summary string", () => {
    const f = makeFeature({
      id: "auth-flow",
      title: "Auth Flow",
      priority: "high",
      difficulty: "medium",
      effort: "PT2H",
    });
    const summary = featureSummary(f);
    expect(summary).toContain("[high/medium]");
    expect(summary).toContain("auth-flow");
    expect(summary).toContain("Auth Flow");
    expect(summary).toContain("2h");
  });
});

// ---------------------------------------------------------------------------
// Priority and Difficulty orderings
// ---------------------------------------------------------------------------

describe("PRIORITY_ORDER", () => {
  test("critical < high < medium < low < wishlist", () => {
    expect(PRIORITY_ORDER.critical).toBeLessThan(PRIORITY_ORDER.high);
    expect(PRIORITY_ORDER.high).toBeLessThan(PRIORITY_ORDER.medium);
    expect(PRIORITY_ORDER.medium).toBeLessThan(PRIORITY_ORDER.low);
    expect(PRIORITY_ORDER.low).toBeLessThan(PRIORITY_ORDER.wishlist);
  });
});

describe("DIFFICULTY_ORDER", () => {
  test("trivial < easy < medium < hard < very_hard", () => {
    expect(DIFFICULTY_ORDER.trivial).toBeLessThan(DIFFICULTY_ORDER.easy);
    expect(DIFFICULTY_ORDER.easy).toBeLessThan(DIFFICULTY_ORDER.medium);
    expect(DIFFICULTY_ORDER.medium).toBeLessThan(DIFFICULTY_ORDER.hard);
    expect(DIFFICULTY_ORDER.hard).toBeLessThan(DIFFICULTY_ORDER.very_hard);
  });
});
