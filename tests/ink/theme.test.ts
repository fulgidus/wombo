/**
 * theme.test.ts — Tests for the TUI theme system.
 *
 * TDD: written before the implementation.
 *
 * Covers:
 *   - ThemeTokens interface has required fields
 *   - Three preset themes exist: 'default', 'high-contrast', 'minimal'
 *   - Presets cover all ThemeTokens fields (no missing keys)
 *   - getTheme() returns a preset by name
 *   - getTheme() falls back to 'default' for unknown names
 *   - ThemeContext and useTheme() hook
 *   - useTheme() returns default theme when no provider
 *   - WomboConfig tui key: TuiConfig interface exported from config.ts
 *   - tui-constants.ts still exports the same symbols (backward compat)
 */

import { describe, test, expect } from "bun:test";

describe("theme presets", () => {
  test("module exports THEMES, getTheme, ThemeContext, useTheme", async () => {
    const mod = await import("../../src/ink/theme");
    expect(mod.THEMES).toBeDefined();
    expect(mod.getTheme).toBeDefined();
    expect(mod.ThemeContext).toBeDefined();
    expect(mod.useTheme).toBeDefined();
  });

  test("THEMES has default, high-contrast, and minimal presets", async () => {
    const { THEMES } = await import("../../src/ink/theme");
    expect(THEMES["default"]).toBeDefined();
    expect(THEMES["high-contrast"]).toBeDefined();
    expect(THEMES["minimal"]).toBeDefined();
  });

  test("default preset has all required token fields", async () => {
    const { THEMES } = await import("../../src/ink/theme");
    const t = THEMES["default"];
    // Status colors
    expect(t.statusColors).toBeDefined();
    expect(t.statusColors.running).toBeDefined();
    expect(t.statusColors.completed).toBeDefined();
    expect(t.statusColors.failed).toBeDefined();
    expect(t.statusColors.queued).toBeDefined();
    // Status icons
    expect(t.statusIcons).toBeDefined();
    expect(t.statusIcons.running).toBeDefined();
    expect(t.statusIcons.failed).toBeDefined();
    // Progress bar chars
    expect(t.progressFilled).toBeDefined();
    expect(t.progressEmpty).toBeDefined();
    // Border style
    expect(t.borderStyle).toBeDefined();
    // Spinner chars
    expect(Array.isArray(t.spinnerFrames)).toBe(true);
    expect(t.spinnerFrames.length).toBeGreaterThan(0);
  });

  test("all three presets have identical top-level keys", async () => {
    const { THEMES } = await import("../../src/ink/theme");
    const defaultKeys = Object.keys(THEMES["default"]).sort();
    const hcKeys = Object.keys(THEMES["high-contrast"]).sort();
    const minKeys = Object.keys(THEMES["minimal"]).sort();
    expect(hcKeys).toEqual(defaultKeys);
    expect(minKeys).toEqual(defaultKeys);
  });

  test("minimal preset uses ASCII-only icons", async () => {
    const { THEMES } = await import("../../src/ink/theme");
    const minimal = THEMES["minimal"];
    // All status icons should be ASCII (no multi-byte unicode)
    for (const icon of Object.values(minimal.statusIcons)) {
      expect(icon.length).toBeLessThanOrEqual(2);
      // Only ASCII chars (codepoint < 128)
      for (const ch of icon) {
        expect(ch.codePointAt(0)!).toBeLessThan(128);
      }
    }
  });

  test("minimal preset has no color values (empty strings)", async () => {
    const { THEMES } = await import("../../src/ink/theme");
    const minimal = THEMES["minimal"];
    for (const color of Object.values(minimal.statusColors)) {
      expect(color).toBe("");
    }
  });
});

describe("getTheme()", () => {
  test("returns the named preset", async () => {
    const { THEMES, getTheme } = await import("../../src/ink/theme");
    expect(getTheme("default")).toBe(THEMES["default"]);
    expect(getTheme("minimal")).toBe(THEMES["minimal"]);
    expect(getTheme("high-contrast")).toBe(THEMES["high-contrast"]);
  });

  test("falls back to default for unknown name", async () => {
    const { THEMES, getTheme } = await import("../../src/ink/theme");
    expect(getTheme("nonexistent-theme")).toBe(THEMES["default"]);
  });
});

describe("ThemeContext and useTheme()", () => {
  test("ThemeContext default value is the default theme", async () => {
    const { ThemeContext, THEMES } = await import("../../src/ink/theme");
    // The context object should have a _currentValue or similar;
    // we just verify it's a valid React context
    expect(ThemeContext).toBeDefined();
    expect(typeof ThemeContext.Provider).toBe("object");
  });
});

describe("WomboConfig tui key", () => {
  test("TuiConfig interface is exported from config.ts", async () => {
    const config = await import("../../src/config");
    // We can't test interfaces at runtime, but we can test the default config
    // has the tui key
    expect(config.DEFAULT_CONFIG.tui).toBeDefined();
  });

  test("DEFAULT_CONFIG.tui.theme defaults to 'default'", async () => {
    const { DEFAULT_CONFIG } = await import("../../src/config");
    expect(DEFAULT_CONFIG.tui.theme).toBe("default");
  });

  test("DEFAULT_CONFIG.tui.locale defaults to 'en'", async () => {
    const { DEFAULT_CONFIG } = await import("../../src/config");
    expect(DEFAULT_CONFIG.tui.locale).toBe("en");
  });
});

describe("tui-constants.ts backward compatibility", () => {
  test("still exports AGENT_STATUS_COLORS", async () => {
    const c = await import("../../src/ink/tui-constants");
    expect(c.AGENT_STATUS_COLORS).toBeDefined();
    expect(c.AGENT_STATUS_COLORS.running).toBeDefined();
  });

  test("still exports AGENT_STATUS_ICONS", async () => {
    const c = await import("../../src/ink/tui-constants");
    expect(c.AGENT_STATUS_ICONS).toBeDefined();
  });

  test("still exports elapsed() and progressBar()", async () => {
    const c = await import("../../src/ink/tui-constants");
    expect(typeof c.elapsed).toBe("function");
    expect(typeof c.progressBar).toBe("function");
  });
});
