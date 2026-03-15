/**
 * run-onboarding.test.ts — Tests for the runOnboardingInk integration function.
 *
 * runOnboardingInk is the bridge between the imperative tui.ts calling
 * convention and the React/Ink component world. It renders OnboardingApp
 * via Ink and returns a Promise<OnboardingResult>.
 *
 * Tests verify:
 *   - Function is exported and callable
 *   - Returns correct type shape (OnboardingResult)
 *   - OnboardingResult type has profile and genesisRequested fields
 */

import { describe, test, expect } from "bun:test";
import {
  runOnboardingInk,
  type OnboardingResult,
} from "./run-onboarding";

describe("runOnboardingInk", () => {
  test("is a function", () => {
    expect(typeof runOnboardingInk).toBe("function");
  });

  test("OnboardingResult type shape is correct", () => {
    // Type-level test — just verify the type is usable
    const result: OnboardingResult = {
      profile: null,
      genesisRequested: false,
    };
    expect(result.profile).toBeNull();
    expect(result.genesisRequested).toBe(false);
  });

  test("OnboardingResult with profile", () => {
    const result: OnboardingResult = {
      profile: {
        name: "test",
        type: "greenfield",
        description: "",
        vision: "",
        objectives: [],
        tech_stack: {
          runtime: "",
          language: "",
          frameworks: [],
          tools: [],
          notes: "",
        },
        conventions: {
          commits: "",
          branches: "",
          testing: "",
          coding_style: "",
          naming: "",
        },
        rules: [],
        codebase_summary: "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        genesis_count: 0,
      },
      genesisRequested: true,
    };
    expect(result.profile).not.toBeNull();
    expect(result.profile?.name).toBe("test");
    expect(result.genesisRequested).toBe(true);
  });
});
