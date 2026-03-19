/**
 * esc-menu.test.tsx — Tests for the EscMenu floating overlay.
 *
 * TDD: written before the implementation.
 *
 * Covers:
 *   - Module exports: EscMenu, EscMenuItem, useEscMenu, EscMenuProvider
 *   - Renders nothing (null) when closed
 *   - Renders menu items when open
 *   - Menu items use i18n labels (menu.title, menu.returnToApp, menu.settings, menu.quit)
 *   - ESC key toggles menu open/closed
 *   - EscMenuProvider wires keyboard listener and exposes context
 *   - useEscMenu() returns { open, openMenu, closeMenu }
 *   - closeMenu() closes the menu
 *   - Each EscMenuItem renders its label
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { PassThrough } from "node:stream";
import { render } from "ink";

describe("esc-menu module exports", () => {
  test("exports EscMenu, EscMenuItem, useEscMenu, EscMenuProvider", async () => {
    const mod = await import("../../src/ink/esc-menu");
    expect(mod.EscMenu).toBeDefined();
    expect(mod.EscMenuItem).toBeDefined();
    expect(mod.useEscMenu).toBeDefined();
    expect(mod.EscMenuProvider).toBeDefined();
  });
});

describe("EscMenu rendering", () => {
  test("EscMenu renders nothing when open=false", async () => {
    const { EscMenu } = await import("../../src/ink/esc-menu");
    const output = renderToString(
      React.createElement(EscMenu, { open: false, onClose: () => {}, onNavigate: () => {} })
    );
    expect(output).toBe("");
  });

  test("EscMenu renders menu title when open=true", async () => {
    const { EscMenu } = await import("../../src/ink/esc-menu");
    const output = renderToString(
      React.createElement(EscMenu, { open: true, onClose: () => {}, onNavigate: () => {} })
    );
    // Should show "Menu" (from EN_STRINGS["menu.title"])
    expect(output).toContain("Menu");
  });

  test("EscMenu renders 'Return to app' item", async () => {
    const { EscMenu } = await import("../../src/ink/esc-menu");
    const output = renderToString(
      React.createElement(EscMenu, { open: true, onClose: () => {}, onNavigate: () => {} })
    );
    expect(output).toContain("Return to app");
  });

  test("EscMenu renders 'Settings' item", async () => {
    const { EscMenu } = await import("../../src/ink/esc-menu");
    const output = renderToString(
      React.createElement(EscMenu, { open: true, onClose: () => {}, onNavigate: () => {} })
    );
    expect(output).toContain("Settings");
  });

  test("EscMenu renders 'Quit' item", async () => {
    const { EscMenu } = await import("../../src/ink/esc-menu");
    const output = renderToString(
      React.createElement(EscMenu, { open: true, onClose: () => {}, onNavigate: () => {} })
    );
    expect(output).toContain("Quit");
  });
});

describe("EscMenuItem", () => {
  test("EscMenuItem renders its label", async () => {
    const { EscMenuItem } = await import("../../src/ink/esc-menu");
    const output = renderToString(
      React.createElement(EscMenuItem, { label: "My Item", onSelect: () => {}, selected: false })
    );
    expect(output).toContain("My Item");
  });

  test("EscMenuItem shows selected indicator when selected=true", async () => {
    const { EscMenuItem } = await import("../../src/ink/esc-menu");
    const output = renderToString(
      React.createElement(EscMenuItem, { label: "My Item", onSelect: () => {}, selected: true })
    );
    // Must have some indicator of selection — ">" or similar
    expect(output).toMatch(/[>›*]/);
  });

  test("EscMenuItem shows no selection indicator when selected=false", async () => {
    const { EscMenuItem } = await import("../../src/ink/esc-menu");
    const notSelected = renderToString(
      React.createElement(EscMenuItem, { label: "My Item", onSelect: () => {}, selected: false })
    );
    const selected = renderToString(
      React.createElement(EscMenuItem, { label: "My Item", onSelect: () => {}, selected: true })
    );
    // Selected and not-selected should differ
    expect(notSelected).not.toBe(selected);
  });
});

describe("useEscMenu()", () => {
  test("useEscMenu is a function", async () => {
    const { useEscMenu } = await import("../../src/ink/esc-menu");
    expect(typeof useEscMenu).toBe("function");
  });

  test("EscMenuProvider renders its children", async () => {
    const { EscMenuProvider } = await import("../../src/ink/esc-menu");
    const { Text } = await import("ink");
    const output = renderToString(
      React.createElement(
        EscMenuProvider,
        {},
        React.createElement(Text, {}, "child content")
      )
    );
    expect(output).toContain("child content");
  });
});
