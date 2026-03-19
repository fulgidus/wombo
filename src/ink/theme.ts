/**
 * theme.ts — Swappable theme token system for the Ink TUI.
 *
 * Lifts all hardcoded color/icon values out of tui-constants.ts into a
 * typed ThemeTokens object. Three presets are shipped:
 *
 *   'default'       — current colors (same as tui-constants.ts values)
 *   'high-contrast' — bold/bright variants for visibility
 *   'minimal'       — no color, ASCII-only icons (for basic terminals)
 *
 * Usage:
 *   // In a component
 *   const theme = useTheme();
 *   <Text color={theme.statusColors.running}>●</Text>
 *
 *   // Wrap at TUI root
 *   <ThemeContext.Provider value={getTheme(config.tui.theme)}>
 *     <ScreenRouter ... />
 *   </ThemeContext.Provider>
 */

import { createContext, useContext } from "react";
import type { AgentStatus } from "../lib/state";

// ---------------------------------------------------------------------------
// ThemeTokens
// ---------------------------------------------------------------------------

export interface ThemeTokens {
  /** Colors for each agent status. Empty string = no color (minimal theme). */
  statusColors: Record<AgentStatus, string>;
  /** Single-character icons for each agent status. */
  statusIcons: Record<AgentStatus, string>;
  /** Filled block character for progress bars (e.g. "█"). */
  progressFilled: string;
  /** Empty block character for progress bars (e.g. "░"). */
  progressEmpty: string;
  /**
   * Ink border style token.
   * @see https://github.com/vadimdemedes/ink#borderStyle
   */
  borderStyle: "single" | "double" | "round" | "bold" | "classic" | "none";
  /** Spinner animation frames (cycled by index). */
  spinnerFrames: string[];
}

// ---------------------------------------------------------------------------
// Preset: default
// ---------------------------------------------------------------------------

const DEFAULT_THEME: ThemeTokens = {
  statusColors: {
    queued: "gray",
    installing: "cyan",
    running: "blue",
    completed: "yellow",
    verified: "green",
    failed: "red",
    merged: "magenta",
    retry: "yellow",
    resolving_conflict: "cyan",
  },
  statusIcons: {
    queued: "·",
    installing: "⟳",
    running: "●",
    completed: "○",
    verified: "✓",
    failed: "✗",
    merged: "◆",
    retry: "↻",
    resolving_conflict: "⚡",
  },
  progressFilled: "█",
  progressEmpty: "░",
  borderStyle: "single",
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

// ---------------------------------------------------------------------------
// Preset: high-contrast
// ---------------------------------------------------------------------------

const HIGH_CONTRAST_THEME: ThemeTokens = {
  statusColors: {
    queued: "white",
    installing: "cyanBright",
    running: "blueBright",
    completed: "yellowBright",
    verified: "greenBright",
    failed: "redBright",
    merged: "magentaBright",
    retry: "yellowBright",
    resolving_conflict: "cyanBright",
  },
  statusIcons: {
    queued: "·",
    installing: "⟳",
    running: "●",
    completed: "○",
    verified: "✓",
    failed: "✗",
    merged: "◆",
    retry: "↻",
    resolving_conflict: "⚡",
  },
  progressFilled: "▓",
  progressEmpty: "░",
  borderStyle: "bold",
  spinnerFrames: ["◐", "◓", "◑", "◒"],
};

// ---------------------------------------------------------------------------
// Preset: minimal (ASCII only, no color)
// ---------------------------------------------------------------------------

const MINIMAL_THEME: ThemeTokens = {
  statusColors: {
    queued: "",
    installing: "",
    running: "",
    completed: "",
    verified: "",
    failed: "",
    merged: "",
    retry: "",
    resolving_conflict: "",
  },
  statusIcons: {
    queued: ".",
    installing: "~",
    running: "*",
    completed: "o",
    verified: "+",
    failed: "!",
    merged: "#",
    retry: "r",
    resolving_conflict: "?",
  },
  progressFilled: "=",
  progressEmpty: "-",
  borderStyle: "classic",
  spinnerFrames: ["-", "\\", "|", "/"],
};

// ---------------------------------------------------------------------------
// Theme registry
// ---------------------------------------------------------------------------

export type ThemeName = "default" | "high-contrast" | "minimal";

/** All available theme presets, keyed by name. */
export const THEMES: Record<ThemeName, ThemeTokens> = {
  default: DEFAULT_THEME,
  "high-contrast": HIGH_CONTRAST_THEME,
  minimal: MINIMAL_THEME,
};

/**
 * Get a theme by name, falling back to the default theme for unknown names.
 */
export function getTheme(name: string): ThemeTokens {
  return (THEMES as Record<string, ThemeTokens>)[name] ?? THEMES["default"];
}

// ---------------------------------------------------------------------------
// ThemeContext and useTheme()
// ---------------------------------------------------------------------------

export const ThemeContext = createContext<ThemeTokens>(DEFAULT_THEME);

/**
 * Hook to access the active theme tokens from anywhere in the TUI tree.
 *
 * Returns the default theme if used outside a ThemeContext.Provider.
 */
export function useTheme(): ThemeTokens {
  return useContext(ThemeContext);
}
