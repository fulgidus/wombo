/**
 * prompt.test.ts — Unit tests for prompt.ts
 *
 * Coverage:
 *   - generatePrompt: basic structure, TDD section injection, browser section,
 *     portless section, commit guidelines, subtask formatting
 *   - TDD prompt content: red-green-refactor cycle, test command inclusion,
 *     rules about never skipping red step, commit at green
 *   - generateConflictResolutionPrompt: basic structure
 */

import { describe, test, expect } from "bun:test";
import {
  generatePrompt,
  generateConflictResolutionPrompt,
} from "../src/lib/prompt.js";
import type { Feature } from "../src/lib/tasks.js";
import type { WomboConfig } from "../src/config.js";

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
      enabled: false,
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
      strictTdd: false,
      testTimeout: 120_000,
    },
    ...overrides,
  } as WomboConfig;
}

function makeFeature(overrides?: Partial<Feature>): Feature {
  return {
    id: "test-feature",
    title: "Test Feature",
    description: "A test feature description",
    status: "backlog",
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

// ---------------------------------------------------------------------------
// generatePrompt — Basic structure
// ---------------------------------------------------------------------------

describe("generatePrompt — basic structure", () => {
  test("includes feature title and ID", () => {
    const feature = makeFeature();
    const config = makeConfig();
    const prompt = generatePrompt(feature, "main", config);
    expect(prompt).toContain("Test Feature");
    expect(prompt).toContain("test-feature");
  });

  test("includes feature description", () => {
    const feature = makeFeature({ description: "Implement login flow" });
    const config = makeConfig();
    const prompt = generatePrompt(feature, "main", config);
    expect(prompt).toContain("Implement login flow");
  });

  test("includes branch information", () => {
    const feature = makeFeature({ id: "auth-flow" });
    const config = makeConfig();
    const prompt = generatePrompt(feature, "main", config);
    expect(prompt).toContain("feature/auth-flow");
    expect(prompt).toContain("main");
  });

  test("includes build command", () => {
    const config = makeConfig({ build: { command: "npm run build", timeout: 300_000, artifactDir: "dist" } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain("npm run build");
  });

  test("includes constraints when present", () => {
    const feature = makeFeature({
      constraints: ["Must use TypeScript", "Must pass linting"],
    });
    const config = makeConfig();
    const prompt = generatePrompt(feature, "main", config);
    expect(prompt).toContain("Must use TypeScript");
    expect(prompt).toContain("Must pass linting");
    expect(prompt).toContain("## Constraints");
  });

  test("includes forbidden when present", () => {
    const feature = makeFeature({
      forbidden: ["Do not use eval", "Do not add dependencies"],
    });
    const config = makeConfig();
    const prompt = generatePrompt(feature, "main", config);
    expect(prompt).toContain("Do not use eval");
    expect(prompt).toContain("## Forbidden");
  });

  test("includes references when present", () => {
    const feature = makeFeature({
      references: ["src/lib/auth.ts", "src/config.ts"],
    });
    const config = makeConfig();
    const prompt = generatePrompt(feature, "main", config);
    expect(prompt).toContain("src/lib/auth.ts");
    expect(prompt).toContain("src/config.ts");
    expect(prompt).toContain("Key Files");
  });

  test("includes notes when present", () => {
    const feature = makeFeature({
      notes: ["Consider edge cases for empty input"],
    });
    const config = makeConfig();
    const prompt = generatePrompt(feature, "main", config);
    expect(prompt).toContain("Consider edge cases for empty input");
    expect(prompt).toContain("Planning Notes");
  });

  test("includes commit guidelines", () => {
    const prompt = generatePrompt(makeFeature(), "main", makeConfig());
    expect(prompt).toContain("Commit Guidelines");
    expect(prompt).toContain("conventional commits");
    expect(prompt).toContain("feat(scope):");
  });

  test("includes execution instructions", () => {
    const prompt = generatePrompt(makeFeature(), "main", makeConfig());
    expect(prompt).toContain("## Execution");
  });
});

// ---------------------------------------------------------------------------
// generatePrompt — TDD section
// ---------------------------------------------------------------------------

describe("generatePrompt — TDD section", () => {
  test("does NOT include TDD section when TDD is disabled", () => {
    const config = makeConfig({ tdd: { enabled: false, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).not.toContain("Test-Driven Development");
    expect(prompt).not.toContain("red-green-refactor");
  });

  test("includes TDD section when TDD is enabled", () => {
    const config = makeConfig({ tdd: { enabled: true, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain("Test-Driven Development");
    expect(prompt).toContain("TDD");
  });

  test("includes red-green-refactor workflow steps", () => {
    const config = makeConfig({ tdd: { enabled: true, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain("Red");
    expect(prompt).toContain("Green");
    expect(prompt).toContain("Refactor");
  });

  test("includes the configured test command", () => {
    const config = makeConfig({ tdd: { enabled: true, testCommand: "npm test", strictTdd: false, testTimeout: 120_000 } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain("npm test");
  });

  test("includes red phase instruction to write failing test first", () => {
    const config = makeConfig({ tdd: { enabled: true, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain("failing test");
    expect(prompt).toContain("confirm it fails");
  });

  test("includes green phase instruction to make test pass", () => {
    const config = makeConfig({ tdd: { enabled: true, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain("make the test pass");
  });

  test("includes rule about never skipping red step", () => {
    const config = makeConfig({ tdd: { enabled: true, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain("Never skip the red step");
  });

  test("includes rule about committing at green", () => {
    const config = makeConfig({ tdd: { enabled: true, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain("Commit at green");
  });

  test("includes rule about running tests frequently", () => {
    const config = makeConfig({ tdd: { enabled: true, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain("Run tests frequently");
  });

  test("includes test file placement guidance", () => {
    const config = makeConfig({ tdd: { enabled: true, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain(".test.ts");
  });

  test("uses bun:test import in guidance", () => {
    const config = makeConfig({ tdd: { enabled: true, testCommand: "bun test", strictTdd: false, testTimeout: 120_000 } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain("bun:test");
  });
});

// ---------------------------------------------------------------------------
// generatePrompt — Subtasks
// ---------------------------------------------------------------------------

describe("generatePrompt — subtasks", () => {
  test("includes subtask section when subtasks exist", () => {
    const feature = makeFeature({
      subtasks: [
        {
          id: "sub-1",
          title: "First Step",
          description: "Do the first thing",
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
    });
    const prompt = generatePrompt(feature, "main", makeConfig());
    expect(prompt).toContain("## Subtasks");
    expect(prompt).toContain("First Step");
    expect(prompt).toContain("sub-1");
  });

  test("omits subtask section when no subtasks", () => {
    const feature = makeFeature({ subtasks: [] });
    const prompt = generatePrompt(feature, "main", makeConfig());
    expect(prompt).not.toContain("## Subtasks");
  });
});

// ---------------------------------------------------------------------------
// generatePrompt — Browser section
// ---------------------------------------------------------------------------

describe("generatePrompt — browser section", () => {
  test("does NOT include browser section when disabled", () => {
    const config = makeConfig({ browser: { enabled: false, bin: null, headless: true, testCommand: null, launchTimeout: 30_000, testTimeout: 60_000, defaultViewport: { width: 1280, height: 720 } } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).not.toContain("## Browser Testing");
  });

  test("includes browser section when enabled", () => {
    const config = makeConfig({ browser: { enabled: true, bin: null, headless: true, testCommand: null, launchTimeout: 30_000, testTimeout: 60_000, defaultViewport: { width: 1280, height: 720 } } });
    const prompt = generatePrompt(makeFeature(), "main", config);
    expect(prompt).toContain("Browser Testing");
    expect(prompt).toContain("browser-based verification");
  });
});

// ---------------------------------------------------------------------------
// generateConflictResolutionPrompt
// ---------------------------------------------------------------------------

describe("generateConflictResolutionPrompt", () => {
  test("includes merge conflict resolution title", () => {
    const feature = makeFeature({ title: "Auth Flow" });
    const config = makeConfig();
    const prompt = generateConflictResolutionPrompt(
      feature,
      "main",
      "CONFLICT: merge conflict in src/auth.ts",
      config
    );
    expect(prompt).toContain("Merge Conflict Resolution");
    expect(prompt).toContain("Auth Flow");
  });

  test("includes merge error output", () => {
    const feature = makeFeature();
    const config = makeConfig();
    const prompt = generateConflictResolutionPrompt(
      feature,
      "main",
      "CONFLICT (content): Merge conflict in src/index.ts",
      config
    );
    expect(prompt).toContain("CONFLICT (content)");
  });

  test("includes rules about not aborting merge", () => {
    const feature = makeFeature();
    const config = makeConfig();
    const prompt = generateConflictResolutionPrompt(
      feature,
      "main",
      "conflict",
      config
    );
    expect(prompt).toContain("Do NOT abort the merge");
  });

  test("includes build command", () => {
    const config = makeConfig({ build: { command: "make build", timeout: 300_000, artifactDir: "build" } });
    const prompt = generateConflictResolutionPrompt(
      makeFeature(),
      "main",
      "conflict",
      config
    );
    expect(prompt).toContain("make build");
  });
});
