/**
 * settings-screen.tsx — Interactive settings screen for the TUI.
 *
 * SettingsScreen is a full TUI screen that shows config.json values grouped
 * by category. Users can navigate fields, edit values inline, cycle theme
 * presets, select locale, and reset to defaults.
 *
 * Components:
 *   SettingsField    — a single label + value row
 *   SettingsSection  — a titled group of fields
 *   SettingsScreen   — the full screen (register in SCREEN_MAP as "settings")
 *
 * Integration:
 *   Register in your SCREEN_MAP:
 *     { settings: SettingsScreen }
 *   Navigate to it from EscMenu via:
 *     onNavigate("settings") → push("settings", { config, onSave })
 */

import React, {
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { Box, Text, useInput } from "ink";
import { t } from "./i18n";
import type { ThemeName } from "./theme";

// ---------------------------------------------------------------------------
// Partial config shape (only TUI-editable fields for now)
// ---------------------------------------------------------------------------

export interface SettingsScreenConfig {
  tui?: {
    theme?: string;
    locale?: string;
  };
  devMode?: boolean;
}

// ---------------------------------------------------------------------------
// SettingsField
// ---------------------------------------------------------------------------

export interface SettingsFieldProps {
  label: string;
  value: string;
  selected: boolean;
  onEdit: () => void;
  /** Optional hint shown below the value when selected */
  hint?: string;
}

/**
 * A single label / value row in the settings screen.
 * Shows ">" cursor when selected.
 */
export function SettingsField({
  label,
  value,
  selected,
  hint,
}: SettingsFieldProps): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1} marginLeft={1}>
      <Text color={selected ? "cyan" : undefined}>{selected ? ">" : " "}</Text>
      <Box flexDirection="row" minWidth={20}>
        <Text color={selected ? "cyan" : undefined} bold={selected}>
          {label}
        </Text>
      </Box>
      <Text color={selected ? "white" : "gray"}>{value}</Text>
      {selected && hint ? (
        <Text dimColor> ({hint})</Text>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// SettingsSection
// ---------------------------------------------------------------------------

export interface SettingsSectionProps {
  title: string;
  children?: ReactNode;
}

/**
 * A titled group of settings fields.
 */
export function SettingsSection({
  title,
  children,
}: SettingsSectionProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingX={1}>
        <Text bold underline color="yellow">
          {title}
        </Text>
      </Box>
      {children}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// SettingsScreen
// ---------------------------------------------------------------------------

const THEME_OPTIONS: ThemeName[] = ["default", "high-contrast", "minimal"];
const LOCALE_OPTIONS = ["en"];

export interface SettingsScreenProps {
  /** Partial (or full) current config — only TUI-relevant fields used */
  config: SettingsScreenConfig;
  /** Called with the patched config object when user saves */
  onSave: (patched: SettingsScreenConfig) => void;
  /** Called when user presses Back / Escape */
  onBack: () => void;
}

type FieldId = "theme" | "locale" | "devMode" | "reset";

interface FieldDef {
  id: FieldId;
  label: string;
  getValue: (cfg: SettingsScreenConfig) => string;
}

const FIELDS: FieldDef[] = [
  {
    id: "theme",
    label: t("settings.theme"),
    getValue: (cfg) => cfg.tui?.theme ?? "default",
  },
  {
    id: "locale",
    label: t("settings.locale"),
    getValue: (cfg) => cfg.tui?.locale ?? "en",
  },
  {
    id: "devMode",
    label: t("settings.devMode"),
    getValue: (cfg) => (cfg.devMode ? "on" : "off"),
  },
  {
    id: "reset",
    label: "Reset to defaults",
    getValue: () => "",
  },
];

/**
 * Full settings TUI screen.
 *
 * Navigation: arrow keys to move cursor, Enter to edit / cycle value,
 * Escape or "b" to go back.
 */
export function SettingsScreen({
  config: initialConfig,
  onSave,
  onBack,
}: SettingsScreenProps): React.ReactElement {
  const [cfg, setCfg] = useState<SettingsScreenConfig>(initialConfig);
  const [cursor, setCursor] = useState(0);
  const [saved, setSaved] = useState(false);

  const handleInput = useCallback(
    (_input: string, key: { upArrow: boolean; downArrow: boolean; return: boolean; escape: boolean }) => {
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(FIELDS.length - 1, c + 1));
        return;
      }
      if (key.escape) {
        onBack();
        return;
      }
      if (key.return) {
        const field = FIELDS[cursor];
        if (field.id === "reset") {
          setCfg({});
          setSaved(false);
          return;
        }
        if (field.id === "theme") {
          const current = cfg.tui?.theme ?? "default";
          const idx = THEME_OPTIONS.indexOf(current as ThemeName);
          const next = THEME_OPTIONS[(idx + 1) % THEME_OPTIONS.length];
          const patched = { ...cfg, tui: { ...cfg.tui, theme: next } };
          setCfg(patched);
          onSave(patched);
          setSaved(true);
          return;
        }
        if (field.id === "locale") {
          const current = cfg.tui?.locale ?? "en";
          const idx = LOCALE_OPTIONS.indexOf(current);
          const next = LOCALE_OPTIONS[(idx + 1) % LOCALE_OPTIONS.length];
          const patched = { ...cfg, tui: { ...cfg.tui, locale: next } };
          setCfg(patched);
          onSave(patched);
          setSaved(true);
          return;
        }
        if (field.id === "devMode") {
          const patched = { ...cfg, devMode: !cfg.devMode };
          setCfg(patched);
          onSave(patched);
          setSaved(true);
          return;
        }
      }
    },
    [cursor, cfg, onSave, onBack]
  );

  useInput(handleInput);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {t("settings.title")}
        </Text>
        {saved && (
          <Text color="green">  {t("settings.saved")}</Text>
        )}
      </Box>

      {/* TUI / Appearance section */}
      <SettingsSection title="TUI / Appearance">
        {FIELDS.filter((f) => f.id === "theme" || f.id === "locale").map((field, i) => (
          <SettingsField
            key={field.id}
            label={field.label}
            value={field.getValue(cfg)}
            selected={cursor === i}
            onEdit={() => {}}
            hint="Enter to cycle"
          />
        ))}
      </SettingsSection>

      {/* General section */}
      <SettingsSection title="General">
        {FIELDS.filter((f) => f.id === "devMode").map((field) => (
          <SettingsField
            key={field.id}
            label={field.label}
            value={field.getValue(cfg)}
            selected={cursor === 2}
            onEdit={() => {}}
            hint="Enter to toggle"
          />
        ))}
      </SettingsSection>

      {/* Reset option */}
      <Box marginTop={1} marginLeft={2}>
        <Box flexDirection="row" gap={1}>
          <Text color={cursor === 3 ? "red" : undefined}>{cursor === 3 ? ">" : " "}</Text>
          <Text color={cursor === 3 ? "red" : "gray"} bold={cursor === 3}>
            Reset to defaults
          </Text>
        </Box>
      </Box>

      {/* Footer hint */}
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate  Enter edit/cycle  ESC back</Text>
      </Box>
    </Box>
  );
}
