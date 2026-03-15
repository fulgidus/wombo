/**
 * global-flags.test.ts — Tests for global flag extraction in citty.
 *
 * TDD: Tests that global flags (--output, --force, --dev, -h/--help)
 * work correctly as pre-command flags, verifying:
 *   - All global flags are extracted from any position
 *   - --dev sets devMode correctly
 *   - --output/-o extracts format value correctly
 *   - --force is extracted as boolean
 *   - -h/--help is extracted as boolean
 *   - Help routing is correct for all command levels
 *   - Remaining args are returned correctly (global flags stripped)
 *   - Edge cases: no args, only global flags, mixed positions
 */

import { describe, test, expect } from "bun:test";
import {
  extractGlobalFlags,
  type GlobalFlags,
  type ExtractResult,
} from "../src/commands/citty/global-flags.js";

// ---------------------------------------------------------------------------
// Basic extraction
// ---------------------------------------------------------------------------

describe("extractGlobalFlags — basic extraction", () => {
  test("returns empty flags and original args when no global flags present", () => {
    const result = extractGlobalFlags(["launch", "--dry-run"]);
    expect(result.flags.dev).toBe(false);
    expect(result.flags.force).toBe(false);
    expect(result.flags.help).toBe(false);
    expect(result.flags.output).toBeUndefined();
    expect(result.remaining).toEqual(["launch", "--dry-run"]);
  });

  test("extracts --dev flag", () => {
    const result = extractGlobalFlags(["--dev", "launch"]);
    expect(result.flags.dev).toBe(true);
    expect(result.remaining).toEqual(["launch"]);
  });

  test("extracts --force flag", () => {
    const result = extractGlobalFlags(["--force", "init"]);
    expect(result.flags.force).toBe(true);
    expect(result.remaining).toEqual(["init"]);
  });

  test("extracts -h flag", () => {
    const result = extractGlobalFlags(["-h"]);
    expect(result.flags.help).toBe(true);
    expect(result.remaining).toEqual([]);
  });

  test("extracts --help flag", () => {
    const result = extractGlobalFlags(["--help"]);
    expect(result.flags.help).toBe(true);
    expect(result.remaining).toEqual([]);
  });

  test("extracts --output with value", () => {
    const result = extractGlobalFlags(["--output", "json", "launch"]);
    expect(result.flags.output).toBe("json");
    expect(result.remaining).toEqual(["launch"]);
  });

  test("extracts -o with value", () => {
    const result = extractGlobalFlags(["-o", "toon", "launch"]);
    expect(result.flags.output).toBe("toon");
    expect(result.remaining).toEqual(["launch"]);
  });

  test("returns empty remaining when only global flags present", () => {
    const result = extractGlobalFlags(["--dev"]);
    expect(result.flags.dev).toBe(true);
    expect(result.remaining).toEqual([]);
  });

  test("handles empty args array", () => {
    const result = extractGlobalFlags([]);
    expect(result.flags.dev).toBe(false);
    expect(result.flags.force).toBe(false);
    expect(result.flags.help).toBe(false);
    expect(result.flags.output).toBeUndefined();
    expect(result.remaining).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --dev flag positions
// ---------------------------------------------------------------------------

describe("extractGlobalFlags — --dev flag positions", () => {
  test("--dev before command: 'woco --dev launch'", () => {
    const result = extractGlobalFlags(["--dev", "launch"]);
    expect(result.flags.dev).toBe(true);
    expect(result.remaining).toEqual(["launch"]);
  });

  test("--dev after command: 'woco launch --dev'", () => {
    const result = extractGlobalFlags(["launch", "--dev"]);
    expect(result.flags.dev).toBe(true);
    expect(result.remaining).toEqual(["launch"]);
  });

  test("--dev bare (no command): 'woco --dev'", () => {
    const result = extractGlobalFlags(["--dev"]);
    expect(result.flags.dev).toBe(true);
    expect(result.remaining).toEqual([]);
  });

  test("--dev between command and subcommand", () => {
    const result = extractGlobalFlags(["tasks", "--dev", "list"]);
    expect(result.flags.dev).toBe(true);
    expect(result.remaining).toEqual(["tasks", "list"]);
  });

  test("--dev after subcommand and flags", () => {
    const result = extractGlobalFlags(["tasks", "list", "--status", "ready", "--dev"]);
    expect(result.flags.dev).toBe(true);
    expect(result.remaining).toEqual(["tasks", "list", "--status", "ready"]);
  });
});

// ---------------------------------------------------------------------------
// --output flag positions
// ---------------------------------------------------------------------------

describe("extractGlobalFlags — --output flag positions", () => {
  test("--output json before command", () => {
    const result = extractGlobalFlags(["--output", "json", "launch"]);
    expect(result.flags.output).toBe("json");
    expect(result.remaining).toEqual(["launch"]);
  });

  test("--output json after command", () => {
    const result = extractGlobalFlags(["launch", "--output", "json"]);
    expect(result.flags.output).toBe("json");
    expect(result.remaining).toEqual(["launch"]);
  });

  test("-o json before command", () => {
    const result = extractGlobalFlags(["-o", "json", "tasks", "list"]);
    expect(result.flags.output).toBe("json");
    expect(result.remaining).toEqual(["tasks", "list"]);
  });

  test("-o toon after command", () => {
    const result = extractGlobalFlags(["tasks", "list", "-o", "toon"]);
    expect(result.flags.output).toBe("toon");
    expect(result.remaining).toEqual(["tasks", "list"]);
  });

  test("--output text works", () => {
    const result = extractGlobalFlags(["--output", "text", "status"]);
    expect(result.flags.output).toBe("text");
    expect(result.remaining).toEqual(["status"]);
  });

  test("--output without value (at end) leaves output undefined", () => {
    const result = extractGlobalFlags(["launch", "--output"]);
    expect(result.flags.output).toBeUndefined();
    expect(result.remaining).toEqual(["launch"]);
  });

  test("--output followed by flag (not value) leaves output undefined", () => {
    const result = extractGlobalFlags(["--output", "--dev", "launch"]);
    expect(result.flags.output).toBeUndefined();
    expect(result.flags.dev).toBe(true);
    expect(result.remaining).toEqual(["launch"]);
  });
});

// ---------------------------------------------------------------------------
// --force flag positions
// ---------------------------------------------------------------------------

describe("extractGlobalFlags — --force flag positions", () => {
  test("--force before command", () => {
    const result = extractGlobalFlags(["--force", "init"]);
    expect(result.flags.force).toBe(true);
    expect(result.remaining).toEqual(["init"]);
  });

  test("--force after command", () => {
    const result = extractGlobalFlags(["init", "--force"]);
    expect(result.flags.force).toBe(true);
    expect(result.remaining).toEqual(["init"]);
  });

  test("--force with other flags", () => {
    const result = extractGlobalFlags(["--force", "--dev", "init"]);
    expect(result.flags.force).toBe(true);
    expect(result.flags.dev).toBe(true);
    expect(result.remaining).toEqual(["init"]);
  });
});

// ---------------------------------------------------------------------------
// Help flag routing
// ---------------------------------------------------------------------------

describe("extractGlobalFlags — help flag routing", () => {
  test("-h bare (no command) for global help", () => {
    const result = extractGlobalFlags(["-h"]);
    expect(result.flags.help).toBe(true);
    expect(result.remaining).toEqual([]);
  });

  test("--help bare (no command) for global help", () => {
    const result = extractGlobalFlags(["--help"]);
    expect(result.flags.help).toBe(true);
    expect(result.remaining).toEqual([]);
  });

  test("-h after command for per-command help: 'woco launch -h'", () => {
    const result = extractGlobalFlags(["launch", "-h"]);
    expect(result.flags.help).toBe(true);
    expect(result.remaining).toEqual(["launch"]);
  });

  test("--help after command for per-command help: 'woco launch --help'", () => {
    const result = extractGlobalFlags(["launch", "--help"]);
    expect(result.flags.help).toBe(true);
    expect(result.remaining).toEqual(["launch"]);
  });

  test("-h before command: 'woco -h launch'", () => {
    const result = extractGlobalFlags(["-h", "launch"]);
    expect(result.flags.help).toBe(true);
    expect(result.remaining).toEqual(["launch"]);
  });

  test("-h with subcommand: 'woco tasks list -h'", () => {
    const result = extractGlobalFlags(["tasks", "list", "-h"]);
    expect(result.flags.help).toBe(true);
    expect(result.remaining).toEqual(["tasks", "list"]);
  });

  test("--help between command and subcommand", () => {
    const result = extractGlobalFlags(["tasks", "--help", "list"]);
    expect(result.flags.help).toBe(true);
    expect(result.remaining).toEqual(["tasks", "list"]);
  });
});

// ---------------------------------------------------------------------------
// Multiple global flags combined
// ---------------------------------------------------------------------------

describe("extractGlobalFlags — multiple flags combined", () => {
  test("--dev --force before command", () => {
    const result = extractGlobalFlags(["--dev", "--force", "init"]);
    expect(result.flags.dev).toBe(true);
    expect(result.flags.force).toBe(true);
    expect(result.remaining).toEqual(["init"]);
  });

  test("--dev --output json before command", () => {
    const result = extractGlobalFlags(["--dev", "--output", "json", "launch"]);
    expect(result.flags.dev).toBe(true);
    expect(result.flags.output).toBe("json");
    expect(result.remaining).toEqual(["launch"]);
  });

  test("--dev -h for dev mode + help", () => {
    const result = extractGlobalFlags(["--dev", "-h"]);
    expect(result.flags.dev).toBe(true);
    expect(result.flags.help).toBe(true);
    expect(result.remaining).toEqual([]);
  });

  test("all global flags at once before command", () => {
    const result = extractGlobalFlags(["--dev", "--force", "--output", "json", "-h", "launch"]);
    expect(result.flags.dev).toBe(true);
    expect(result.flags.force).toBe(true);
    expect(result.flags.output).toBe("json");
    expect(result.flags.help).toBe(true);
    expect(result.remaining).toEqual(["launch"]);
  });

  test("global flags scattered throughout args", () => {
    const result = extractGlobalFlags([
      "--dev", "launch", "--output", "json", "--dry-run", "--force",
    ]);
    expect(result.flags.dev).toBe(true);
    expect(result.flags.force).toBe(true);
    expect(result.flags.output).toBe("json");
    expect(result.remaining).toEqual(["launch", "--dry-run"]);
  });
});

// ---------------------------------------------------------------------------
// Non-global flags preserved
// ---------------------------------------------------------------------------

describe("extractGlobalFlags — non-global flags preserved", () => {
  test("command-specific flags are preserved in remaining", () => {
    const result = extractGlobalFlags(["launch", "--dry-run", "--no-tui", "--max-concurrent", "4"]);
    expect(result.remaining).toEqual(["launch", "--dry-run", "--no-tui", "--max-concurrent", "4"]);
  });

  test("positional args are preserved in remaining", () => {
    const result = extractGlobalFlags(["tasks", "add", "my-feat", "My Title"]);
    expect(result.remaining).toEqual(["tasks", "add", "my-feat", "My Title"]);
  });

  test("mixed global and command-specific flags", () => {
    const result = extractGlobalFlags([
      "--dev", "launch", "--dry-run", "--output", "json", "--max-concurrent", "3",
    ]);
    expect(result.flags.dev).toBe(true);
    expect(result.flags.output).toBe("json");
    expect(result.remaining).toEqual(["launch", "--dry-run", "--max-concurrent", "3"]);
  });
});
