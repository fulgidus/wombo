/**
 * validate.test.ts — Unit tests for input validation functions.
 *
 * Coverage:
 *   - validateId: kebab-case, empty, control chars, path traversal, query params,
 *     percent-encoding, length limits
 *   - validateText: control chars, allows newlines/tabs
 *   - validateBranchName: empty, control chars, "..", special chars
 *   - validateDuration: ISO 8601 patterns, invalid formats
 *   - validateEnum: allowed values, rejected values
 *   - assertValid: exits on invalid (not directly testable without mocking process.exit)
 */

import { describe, test, expect } from "bun:test";
import {
  validateId,
  validateText,
  validateBranchName,
  validateDuration,
  validateEnum,
} from "../src/lib/validate.js";

// ---------------------------------------------------------------------------
// validateId
// ---------------------------------------------------------------------------

describe("validateId", () => {
  test("accepts valid kebab-case ids", () => {
    expect(validateId("my-task").valid).toBe(true);
    expect(validateId("task-1").valid).toBe(true);
    expect(validateId("a").valid).toBe(true);
    expect(validateId("abc-def-ghi").valid).toBe(true);
    expect(validateId("123").valid).toBe(true);
    expect(validateId("a1b2c3").valid).toBe(true);
  });

  test("rejects empty string", () => {
    const result = validateId("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("rejects uppercase letters", () => {
    const result = validateId("MyTask");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("kebab-case");
  });

  test("rejects spaces", () => {
    const result = validateId("my task");
    expect(result.valid).toBe(false);
  });

  test("rejects underscores", () => {
    const result = validateId("my_task");
    expect(result.valid).toBe(false);
  });

  test("rejects dots", () => {
    const result = validateId("my.task");
    expect(result.valid).toBe(false);
  });

  test("rejects path traversal", () => {
    const result = validateId("../etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("path traversal");
  });

  test("rejects query params", () => {
    const result = validateId("task?id=1");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("query");
  });

  test("rejects fragment", () => {
    const result = validateId("task#section");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("query");
  });

  test("rejects percent-encoded characters", () => {
    const result = validateId("task%20name");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("percent-encoded");
  });

  test("rejects control characters", () => {
    const result = validateId("task\x00name");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("control");
  });

  test("rejects id starting with hyphen", () => {
    const result = validateId("-task");
    expect(result.valid).toBe(false);
  });

  test("rejects id longer than 128 characters", () => {
    const longId = "a" + "-b".repeat(64); // 129 chars
    const result = validateId(longId);
    expect(result.valid).toBe(false);
  });

  test("accepts id at max 128 characters", () => {
    const maxId = "a" + "-b".repeat(63) + "c"; // exactly 128 chars
    // Note: 1 + 63*2 + 1 = 128
    const result = validateId(maxId);
    expect(result.valid).toBe(true);
  });

  test("uses custom label in error message", () => {
    const result = validateId("", "Feature ID");
    expect(result.error).toContain("Feature ID");
  });
});

// ---------------------------------------------------------------------------
// validateText
// ---------------------------------------------------------------------------

describe("validateText", () => {
  test("accepts normal text", () => {
    expect(validateText("Hello, world!").valid).toBe(true);
  });

  test("accepts text with newlines and tabs", () => {
    expect(validateText("Line 1\nLine 2\tTabbed").valid).toBe(true);
  });

  test("accepts empty string", () => {
    expect(validateText("").valid).toBe(true);
  });

  test("accepts unicode text", () => {
    expect(validateText("こんにちは世界 🌍").valid).toBe(true);
  });

  test("rejects null bytes", () => {
    const result = validateText("text\x00more");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("control");
  });

  test("rejects bell character", () => {
    const result = validateText("text\x07beep");
    expect(result.valid).toBe(false);
  });

  test("rejects escape character", () => {
    const result = validateText("text\x1bmore");
    expect(result.valid).toBe(false);
  });

  test("rejects DEL character", () => {
    const result = validateText("text\x7fmore");
    expect(result.valid).toBe(false);
  });

  test("uses custom label in error message", () => {
    const result = validateText("bad\x00text", "description");
    expect(result.error).toContain("description");
  });
});

// ---------------------------------------------------------------------------
// validateBranchName
// ---------------------------------------------------------------------------

describe("validateBranchName", () => {
  test("accepts valid branch names", () => {
    expect(validateBranchName("feature/my-branch").valid).toBe(true);
    expect(validateBranchName("main").valid).toBe(true);
    expect(validateBranchName("release/v1.0.0").valid).toBe(true);
    expect(validateBranchName("hotfix/fix-bug").valid).toBe(true);
  });

  test("rejects empty string", () => {
    const result = validateBranchName("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("rejects double dots", () => {
    const result = validateBranchName("feature..branch");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("..");
  });

  test("rejects spaces", () => {
    const result = validateBranchName("my branch");
    expect(result.valid).toBe(false);
  });

  test("rejects tilde", () => {
    const result = validateBranchName("branch~1");
    expect(result.valid).toBe(false);
  });

  test("rejects caret", () => {
    const result = validateBranchName("branch^2");
    expect(result.valid).toBe(false);
  });

  test("rejects colon", () => {
    const result = validateBranchName("branch:name");
    expect(result.valid).toBe(false);
  });

  test("rejects backslash", () => {
    const result = validateBranchName("branch\\name");
    expect(result.valid).toBe(false);
  });

  test("rejects question mark", () => {
    const result = validateBranchName("branch?name");
    expect(result.valid).toBe(false);
  });

  test("rejects asterisk", () => {
    const result = validateBranchName("branch*name");
    expect(result.valid).toBe(false);
  });

  test("rejects open bracket", () => {
    const result = validateBranchName("branch[0]");
    expect(result.valid).toBe(false);
  });

  test("rejects control characters", () => {
    const result = validateBranchName("branch\x00name");
    expect(result.valid).toBe(false);
  });

  test("uses custom label in error message", () => {
    const result = validateBranchName("", "base branch");
    expect(result.error).toContain("base branch");
  });
});

// ---------------------------------------------------------------------------
// validateDuration
// ---------------------------------------------------------------------------

describe("validateDuration", () => {
  test("accepts valid ISO 8601 durations", () => {
    expect(validateDuration("PT1H").valid).toBe(true);
    expect(validateDuration("PT30M").valid).toBe(true);
    expect(validateDuration("PT2H30M").valid).toBe(true);
    expect(validateDuration("P1D").valid).toBe(true);
    expect(validateDuration("P1DT4H").valid).toBe(true);
    expect(validateDuration("P1Y2M3DT4H5M6S").valid).toBe(true);
    expect(validateDuration("PT0S").valid).toBe(true);
  });

  test("rejects empty string", () => {
    const result = validateDuration("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  test("rejects plain numbers", () => {
    const result = validateDuration("60");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("ISO 8601");
  });

  test("rejects human-readable durations", () => {
    expect(validateDuration("2 hours").valid).toBe(false);
    expect(validateDuration("1h30m").valid).toBe(false);
    expect(validateDuration("90 minutes").valid).toBe(false);
  });

  test("rejects lowercase p", () => {
    const result = validateDuration("pt1h");
    expect(result.valid).toBe(false);
  });

  test("rejects missing P prefix", () => {
    const result = validateDuration("T1H");
    expect(result.valid).toBe(false);
  });

  test("uses custom label in error message", () => {
    const result = validateDuration("bad", "effort estimate");
    expect(result.error).toContain("effort estimate");
  });
});

// ---------------------------------------------------------------------------
// validateEnum
// ---------------------------------------------------------------------------

describe("validateEnum", () => {
  const allowed = ["alpha", "beta", "gamma"] as const;

  test("accepts allowed values", () => {
    expect(validateEnum("alpha", allowed).valid).toBe(true);
    expect(validateEnum("beta", allowed).valid).toBe(true);
    expect(validateEnum("gamma", allowed).valid).toBe(true);
  });

  test("rejects disallowed values", () => {
    const result = validateEnum("delta", allowed);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("delta");
    expect(result.error).toContain("alpha");
  });

  test("rejects empty string", () => {
    const result = validateEnum("", allowed);
    expect(result.valid).toBe(false);
  });

  test("is case-sensitive", () => {
    const result = validateEnum("Alpha", allowed);
    expect(result.valid).toBe(false);
  });

  test("uses custom label in error message", () => {
    const result = validateEnum("bad", allowed, "status");
    expect(result.error).toContain("status");
  });
});
