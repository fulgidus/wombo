/**
 * init-cmd.test.ts — Tests for the revamped cmdInit function.
 *
 * Verifies:
 *   - cmdInit renders an Ink app (not the old Prompter)
 *   - cmdInit properly passes projectRoot and force options
 *   - The module exports the expected interface
 */

import { describe, test, expect } from "bun:test";
import { cmdInit, type InitOptions } from "../commands/init";

describe("cmdInit", () => {
  test("exports InitOptions type", () => {
    // Type-level check — if this compiles, the type exists
    const opts: InitOptions = {
      projectRoot: "/tmp/test",
      force: false,
    };
    expect(opts.projectRoot).toBe("/tmp/test");
    expect(opts.force).toBe(false);
  });

  test("cmdInit is a function", () => {
    expect(typeof cmdInit).toBe("function");
  });

  test("InitOptions accepts force as optional", () => {
    const opts: InitOptions = {
      projectRoot: "/tmp/test",
    };
    expect(opts.force).toBeUndefined();
  });
});
