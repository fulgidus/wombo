/**
 * output.test.ts — Unit tests for output helpers.
 *
 * Coverage:
 *   - resolveOutputFormat: explicit flag, env var, defaults
 *   - filterFields: field selection, empty fields, missing fields
 *   - filterFieldsArray: array variant
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  resolveOutputFormat,
  filterFields,
  filterFieldsArray,
} from "../src/lib/output.js";

// ---------------------------------------------------------------------------
// resolveOutputFormat
// ---------------------------------------------------------------------------

describe("resolveOutputFormat", () => {
  const originalEnv = process.env.WOMBO_OUTPUT;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WOMBO_OUTPUT;
    } else {
      process.env.WOMBO_OUTPUT = originalEnv;
    }
  });

  test("returns 'json' when explicit flag is 'json'", () => {
    expect(resolveOutputFormat("json")).toBe("json");
  });

  test("returns 'text' when explicit flag is 'text'", () => {
    expect(resolveOutputFormat("text")).toBe("text");
  });

  test("returns 'toon' when explicit flag is 'toon'", () => {
    expect(resolveOutputFormat("toon")).toBe("toon");
  });

  test("returns 'text' when no explicit flag and no env var", () => {
    delete process.env.WOMBO_OUTPUT;
    expect(resolveOutputFormat()).toBe("text");
  });

  test("returns 'text' when explicit flag is undefined and no env var", () => {
    delete process.env.WOMBO_OUTPUT;
    expect(resolveOutputFormat(undefined)).toBe("text");
  });

  test("returns 'json' from WOMBO_OUTPUT env var", () => {
    process.env.WOMBO_OUTPUT = "json";
    expect(resolveOutputFormat()).toBe("json");
  });

  test("returns 'toon' from WOMBO_OUTPUT env var", () => {
    process.env.WOMBO_OUTPUT = "toon";
    expect(resolveOutputFormat()).toBe("toon");
  });

  test("explicit flag takes priority over env var", () => {
    process.env.WOMBO_OUTPUT = "json";
    expect(resolveOutputFormat("text")).toBe("text");
  });

  test("returns 'text' for unknown explicit values", () => {
    expect(resolveOutputFormat("xml")).toBe("text");
    expect(resolveOutputFormat("csv")).toBe("text");
  });

  test("returns 'text' for unknown env values", () => {
    process.env.WOMBO_OUTPUT = "xml";
    expect(resolveOutputFormat()).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// filterFields
// ---------------------------------------------------------------------------

describe("filterFields", () => {
  const obj = {
    id: "task-1",
    title: "My Task",
    status: "backlog",
    priority: "high",
    description: "A task",
  };

  test("returns full object when fields is undefined", () => {
    expect(filterFields(obj)).toEqual(obj);
  });

  test("returns full object when fields is empty array", () => {
    expect(filterFields(obj, [])).toEqual(obj);
  });

  test("filters to specified fields", () => {
    const result = filterFields(obj, ["id", "status"]);
    expect(result).toEqual({ id: "task-1", status: "backlog" });
  });

  test("ignores fields not present in object", () => {
    const result = filterFields(obj, ["id", "nonexistent"]);
    expect(result).toEqual({ id: "task-1" });
    expect("nonexistent" in result).toBe(false);
  });

  test("returns empty object when no fields match", () => {
    const result = filterFields(obj, ["foo", "bar"]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("preserves field values including null and empty string", () => {
    const objWithNull = { a: null, b: "", c: 0, d: false } as Record<string, unknown>;
    const result = filterFields(objWithNull, ["a", "b", "c", "d"]);
    expect(result).toEqual({ a: null, b: "", c: 0, d: false });
  });
});

// ---------------------------------------------------------------------------
// filterFieldsArray
// ---------------------------------------------------------------------------

describe("filterFieldsArray", () => {
  const arr = [
    { id: "t1", title: "Task 1", status: "done" },
    { id: "t2", title: "Task 2", status: "backlog" },
  ];

  test("returns full array when fields is undefined", () => {
    expect(filterFieldsArray(arr)).toEqual(arr);
  });

  test("returns full array when fields is empty", () => {
    expect(filterFieldsArray(arr, [])).toEqual(arr);
  });

  test("filters each object to specified fields", () => {
    const result = filterFieldsArray(arr, ["id", "status"]);
    expect(result).toEqual([
      { id: "t1", status: "done" },
      { id: "t2", status: "backlog" },
    ]);
  });

  test("handles empty array", () => {
    expect(filterFieldsArray([], ["id"])).toEqual([]);
  });
});
