/**
 * onboarding-utils.test.ts — Tests for pure utility functions extracted
 * from tui-onboarding.ts for the Ink onboarding wizard migration.
 *
 * These functions parse raw user input text into structured ProjectProfile data.
 */

import { describe, test, expect } from "bun:test";
import {
  parseObjectives,
  parseTechStack,
  parseConventions,
  parseRules,
  parseRulesRich,
  structureRawInputs,
  serializeSectionForEdit,
  parseSectionEdit,
  formatSectionForDisplay,
  summarizeSection,
  type RawInputs,
  INPUT_STEPS,
  SECTION_NAMES,
} from "./onboarding-utils";
import {
  createBlankProfile,
  type ProjectProfile,
} from "../../lib/project-store";

// ---------------------------------------------------------------------------
// parseObjectives
// ---------------------------------------------------------------------------

describe("parseObjectives", () => {
  test("returns empty array for empty input", () => {
    expect(parseObjectives("")).toEqual([]);
    expect(parseObjectives("   ")).toEqual([]);
  });

  test("parses simple objectives without priority", () => {
    const result = parseObjectives("Build the UI\nFix the API");
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Build the UI");
    expect(result[0].priority).toBe("medium");
    expect(result[0].id).toBe("obj-1");
    expect(result[1].text).toBe("Fix the API");
    expect(result[1].id).toBe("obj-2");
  });

  test("parses objectives with priority prefixes", () => {
    const result = parseObjectives("[high] Critical thing\n[low] Nice to have");
    expect(result[0].priority).toBe("high");
    expect(result[0].text).toBe("Critical thing");
    expect(result[1].priority).toBe("low");
    expect(result[1].text).toBe("Nice to have");
  });

  test("handles mixed priorities and case-insensitive", () => {
    const result = parseObjectives("[HIGH] First\nSecond\n[Low] Third");
    expect(result[0].priority).toBe("high");
    expect(result[1].priority).toBe("medium");
    expect(result[2].priority).toBe("low");
  });

  test("skips blank lines", () => {
    const result = parseObjectives("First\n\n\nSecond");
    expect(result).toHaveLength(2);
  });

  test("sets default status to pending", () => {
    const result = parseObjectives("Something");
    expect(result[0].status).toBe("pending");
    expect(result[0].quest_ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseTechStack
// ---------------------------------------------------------------------------

describe("parseTechStack", () => {
  test("returns empty stack for empty input", () => {
    const result = parseTechStack("");
    expect(result.runtime).toBe("");
    expect(result.language).toBe("");
    expect(result.frameworks).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.notes).toBe("");
  });

  test("parses labeled fields", () => {
    const result = parseTechStack(
      "runtime: Bun\nlanguage: TypeScript\nframeworks: React, Vue\ntools: eslint, prettier"
    );
    expect(result.runtime).toBe("Bun");
    expect(result.language).toBe("TypeScript");
    expect(result.frameworks).toEqual(["React", "Vue"]);
    expect(result.tools).toEqual(["eslint", "prettier"]);
  });

  test("puts unmatched lines into notes", () => {
    const result = parseTechStack("runtime: Node\nSome extra note\nAnother note");
    expect(result.runtime).toBe("Node");
    expect(result.notes).toBe("Some extra note\nAnother note");
  });
});

// ---------------------------------------------------------------------------
// parseConventions
// ---------------------------------------------------------------------------

describe("parseConventions", () => {
  test("returns empty conventions for empty input", () => {
    const result = parseConventions("");
    expect(result.commits).toBe("");
    expect(result.branches).toBe("");
    expect(result.testing).toBe("");
    expect(result.coding_style).toBe("");
    expect(result.naming).toBe("");
  });

  test("parses labeled convention fields", () => {
    const result = parseConventions(
      "commits: conventional\nbranches: feature/<id>\ntesting: bun test\ncoding_style: strict TS\nnaming: kebab-case"
    );
    expect(result.commits).toBe("conventional");
    expect(result.branches).toBe("feature/<id>");
    expect(result.testing).toBe("bun test");
    expect(result.coding_style).toBe("strict TS");
    expect(result.naming).toBe("kebab-case");
  });

  test("puts unmatched lines into coding_style", () => {
    const result = parseConventions("commits: conventional\nSome extra style note");
    expect(result.commits).toBe("conventional");
    expect(result.coding_style).toBe("Some extra style note");
  });
});

// ---------------------------------------------------------------------------
// parseRules
// ---------------------------------------------------------------------------

describe("parseRules", () => {
  test("returns empty array for empty input", () => {
    expect(parseRules("")).toEqual([]);
  });

  test("parses simple rules with defaults", () => {
    const result = parseRules("Always use Bun\nKeep deps minimal");
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Always use Bun");
    expect(result[0].scope).toBe("general");
    expect(result[0].rigidity).toBe("soft");
    expect(result[0].id).toBe("rule-1");
    expect(result[1].id).toBe("rule-2");
  });
});

// ---------------------------------------------------------------------------
// parseRulesRich
// ---------------------------------------------------------------------------

describe("parseRulesRich", () => {
  test("returns empty array for empty input", () => {
    expect(parseRulesRich("")).toEqual([]);
  });

  test("parses rich format with rigidity, scope, and consequences", () => {
    const result = parseRulesRich(
      "[hard] runtime: Always use Bun (consequences: build breaks)"
    );
    expect(result).toHaveLength(1);
    expect(result[0].rigidity).toBe("hard");
    expect(result[0].scope).toBe("runtime");
    expect(result[0].text).toBe("Always use Bun");
    expect(result[0].consequences).toBe("build breaks");
  });

  test("falls back to plain parsing for unmatched lines", () => {
    const result = parseRulesRich("Just a plain rule");
    expect(result[0].rigidity).toBe("soft");
    expect(result[0].scope).toBe("general");
    expect(result[0].text).toBe("Just a plain rule");
  });

  test("handles mixed rich and plain lines", () => {
    const result = parseRulesRich(
      "[soft] testing: Run tests before commit\nPlain rule"
    );
    expect(result).toHaveLength(2);
    expect(result[0].rigidity).toBe("soft");
    expect(result[0].scope).toBe("testing");
    expect(result[1].rigidity).toBe("soft");
    expect(result[1].scope).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// structureRawInputs
// ---------------------------------------------------------------------------

describe("structureRawInputs", () => {
  test("creates a full profile from raw inputs", () => {
    const raw: RawInputs = {
      name: "  my-project  ",
      description: "A test project",
      type: "greenfield",
      vision: "World domination",
      objectives: "[high] Build UI\nFix API",
      techStack: "runtime: Bun\nlanguage: TypeScript",
      conventions: "commits: conventional",
      rules: "Always test",
    };

    const profile = structureRawInputs(raw);
    expect(profile.name).toBe("my-project");
    expect(profile.description).toBe("A test project");
    expect(profile.type).toBe("greenfield");
    expect(profile.vision).toBe("World domination");
    expect(profile.objectives).toHaveLength(2);
    expect(profile.objectives[0].priority).toBe("high");
    expect(profile.tech_stack.runtime).toBe("Bun");
    expect(profile.conventions.commits).toBe("conventional");
    expect(profile.rules).toHaveLength(1);
  });

  test("defaults to brownfield for unknown type", () => {
    const raw: RawInputs = {
      name: "test",
      description: "",
      type: "unknown",
      vision: "",
      objectives: "",
      techStack: "",
      conventions: "",
      rules: "",
    };
    expect(structureRawInputs(raw).type).toBe("brownfield");
  });
});

// ---------------------------------------------------------------------------
// serializeSectionForEdit
// ---------------------------------------------------------------------------

describe("serializeSectionForEdit", () => {
  test("serializes identity section", () => {
    const profile = createBlankProfile("test-project");
    profile.type = "brownfield";
    profile.description = "A test project";
    const result = serializeSectionForEdit("identity", profile);
    expect(result).toContain("name: test-project");
    expect(result).toContain("type: brownfield");
    expect(result).toContain("description: A test project");
  });

  test("serializes vision section", () => {
    const profile = createBlankProfile();
    profile.vision = "World domination";
    expect(serializeSectionForEdit("vision", profile)).toBe("World domination");
  });

  test("serializes objectives section", () => {
    const profile = createBlankProfile();
    profile.objectives = [
      { id: "obj-1", text: "Build UI", priority: "high", status: "pending", quest_ids: [] },
    ];
    const result = serializeSectionForEdit("objectives", profile);
    expect(result).toContain("[high] Build UI");
  });

  test("serializes tech stack section", () => {
    const profile = createBlankProfile();
    profile.tech_stack = {
      runtime: "Bun",
      language: "TypeScript",
      frameworks: ["React"],
      tools: ["eslint"],
      notes: "",
    };
    const result = serializeSectionForEdit("tech_stack", profile);
    expect(result).toContain("runtime: Bun");
    expect(result).toContain("frameworks: React");
  });

  test("serializes conventions section", () => {
    const profile = createBlankProfile();
    profile.conventions = {
      commits: "conventional",
      branches: "feature/<id>",
      testing: "bun test",
      coding_style: "strict",
      naming: "kebab",
    };
    const result = serializeSectionForEdit("conventions", profile);
    expect(result).toContain("commits: conventional");
    expect(result).toContain("testing: bun test");
  });

  test("serializes rules section", () => {
    const profile = createBlankProfile();
    profile.rules = [
      {
        id: "rule-1",
        text: "Always test",
        scope: "general",
        rigidity: "hard",
        consequences: "build breaks",
        tags: [],
      },
    ];
    const result = serializeSectionForEdit("rules", profile);
    expect(result).toContain("[hard] general: Always test");
    expect(result).toContain("(consequences: build breaks)");
  });
});

// ---------------------------------------------------------------------------
// parseSectionEdit
// ---------------------------------------------------------------------------

describe("parseSectionEdit", () => {
  test("parses identity section edit", () => {
    const profile = createBlankProfile();
    const patch = parseSectionEdit(
      "identity",
      "name: new-name\ntype: greenfield\ndescription: new desc",
      profile
    );
    expect(patch.name).toBe("new-name");
    expect(patch.type).toBe("greenfield");
    expect(patch.description).toBe("new desc");
  });

  test("parses vision section edit", () => {
    const profile = createBlankProfile();
    const patch = parseSectionEdit("vision", "New vision here", profile);
    expect(patch.vision).toBe("New vision here");
  });

  test("parses objectives section edit", () => {
    const profile = createBlankProfile();
    const patch = parseSectionEdit(
      "objectives",
      "[high] First\nSecond",
      profile
    );
    expect(patch.objectives).toHaveLength(2);
    expect(patch.objectives![0].priority).toBe("high");
  });

  test("parses tech_stack section edit", () => {
    const profile = createBlankProfile();
    const patch = parseSectionEdit(
      "tech_stack",
      "runtime: Deno\nframeworks: Express, Koa",
      profile
    );
    expect(patch.tech_stack!.runtime).toBe("Deno");
    expect(patch.tech_stack!.frameworks).toEqual(["Express", "Koa"]);
  });

  test("parses conventions section edit", () => {
    const profile = createBlankProfile();
    const patch = parseSectionEdit(
      "conventions",
      "commits: gitmoji\ntesting: vitest",
      profile
    );
    expect(patch.conventions!.commits).toBe("gitmoji");
    expect(patch.conventions!.testing).toBe("vitest");
  });

  test("parses rules section edit", () => {
    const profile = createBlankProfile();
    const patch = parseSectionEdit(
      "rules",
      "[hard] runtime: Always use Bun (consequences: breaks)\nPlain rule",
      profile
    );
    expect(patch.rules).toHaveLength(2);
    expect(patch.rules![0].rigidity).toBe("hard");
    expect(patch.rules![1].rigidity).toBe("soft");
  });
});

// ---------------------------------------------------------------------------
// formatSectionForDisplay
// ---------------------------------------------------------------------------

describe("formatSectionForDisplay", () => {
  test("formats identity section", () => {
    const profile = createBlankProfile("test");
    profile.description = "desc";
    const result = formatSectionForDisplay("identity", profile);
    expect(result).toContain("test");
    expect(result).toContain("desc");
  });

  test("formats vision section", () => {
    const profile = createBlankProfile();
    profile.vision = "My vision";
    expect(formatSectionForDisplay("vision", profile)).toContain("My vision");
  });

  test("formats empty vision", () => {
    const profile = createBlankProfile();
    expect(formatSectionForDisplay("vision", profile)).toContain("(no vision set)");
  });

  test("formats objectives section", () => {
    const profile = createBlankProfile();
    profile.objectives = [
      { id: "obj-1", text: "Build UI", priority: "high", status: "pending", quest_ids: [] },
    ];
    const result = formatSectionForDisplay("objectives", profile);
    expect(result).toContain("high");
    expect(result).toContain("Build UI");
  });

  test("formats tech stack section", () => {
    const profile = createBlankProfile();
    profile.tech_stack.runtime = "Bun";
    const result = formatSectionForDisplay("tech_stack", profile);
    expect(result).toContain("Bun");
  });

  test("formats conventions section", () => {
    const profile = createBlankProfile();
    profile.conventions.commits = "conventional";
    const result = formatSectionForDisplay("conventions", profile);
    expect(result).toContain("conventional");
  });

  test("formats rules section", () => {
    const profile = createBlankProfile();
    profile.rules = [
      {
        id: "rule-1",
        text: "Always test",
        scope: "general",
        rigidity: "hard",
        consequences: "build breaks",
        tags: [],
      },
    ];
    const result = formatSectionForDisplay("rules", profile);
    expect(result).toContain("Always test");
    expect(result).toContain("hard");
  });
});

// ---------------------------------------------------------------------------
// summarizeSection
// ---------------------------------------------------------------------------

describe("summarizeSection", () => {
  test("summarizes identity section", () => {
    const profile = createBlankProfile("my-app");
    profile.type = "brownfield";
    expect(summarizeSection("identity", profile)).toContain("my-app");
    expect(summarizeSection("identity", profile)).toContain("brownfield");
  });

  test("summarizes vision section", () => {
    const profile = createBlankProfile();
    expect(summarizeSection("vision", profile)).toContain("(no vision set)");
    profile.vision = "A".repeat(100);
    expect(summarizeSection("vision", profile).length).toBeLessThan(70);
  });

  test("summarizes objectives section", () => {
    const profile = createBlankProfile();
    expect(summarizeSection("objectives", profile)).toContain("(no objectives)");
    profile.objectives = [
      { id: "obj-1", text: "Thing", priority: "high", status: "pending", quest_ids: [] },
      { id: "obj-2", text: "Other", priority: "low", status: "pending", quest_ids: [] },
    ];
    expect(summarizeSection("objectives", profile)).toContain("2 objectives");
    expect(summarizeSection("objectives", profile)).toContain("1 high");
  });

  test("summarizes tech stack section", () => {
    const profile = createBlankProfile();
    expect(summarizeSection("tech_stack", profile)).toContain("(not set)");
    profile.tech_stack.runtime = "Bun";
    profile.tech_stack.language = "TypeScript";
    expect(summarizeSection("tech_stack", profile)).toContain("Bun");
  });

  test("summarizes conventions section", () => {
    const profile = createBlankProfile();
    expect(summarizeSection("conventions", profile)).toContain("(no conventions set)");
    profile.conventions.commits = "conventional";
    expect(summarizeSection("conventions", profile)).toContain("1/5");
  });

  test("summarizes rules section", () => {
    const profile = createBlankProfile();
    expect(summarizeSection("rules", profile)).toContain("(no rules)");
    profile.rules = [
      { id: "r1", text: "t", scope: "g", rigidity: "soft", consequences: "", tags: [] },
    ];
    expect(summarizeSection("rules", profile)).toContain("1 rule");
  });
});

// ---------------------------------------------------------------------------
// INPUT_STEPS and SECTION_NAMES constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("INPUT_STEPS has 8 steps", () => {
    expect(INPUT_STEPS).toHaveLength(8);
  });

  test("INPUT_STEPS first step is type selection", () => {
    expect(INPUT_STEPS[0].field).toBe("type");
    expect(INPUT_STEPS[0].selection).toBe(true);
  });

  test("SECTION_NAMES has all 6 sections", () => {
    expect(Object.keys(SECTION_NAMES)).toHaveLength(6);
    expect(SECTION_NAMES.identity).toBe("Identity");
    expect(SECTION_NAMES.rules).toBe("Rules");
  });
});
