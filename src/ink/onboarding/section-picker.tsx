/**
 * section-picker.tsx — Profile section picker Ink component.
 *
 * Shows a list of 6 profile sections (identity, vision, objectives,
 * tech_stack, conventions, rules) plus a "Re-run LLM synthesis" option.
 * Each section displays its name and a one-line summary from the profile.
 *
 * Navigation:
 *   - Arrow keys to move cursor
 *   - Enter/Space to select
 *   - Esc to go back
 *
 * Actions:
 *   - Selecting a section calls onSelect(section)
 *   - Selecting "Re-run LLM synthesis" calls onResynthesize()
 *   - Esc calls onBack()
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { PROFILE_SECTIONS, type ProfileSection, type ProjectProfile } from "../../lib/project-store";
import { SECTION_NAMES, summarizeSection } from "./onboarding-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SectionPickerProps {
  /** The current project profile (used to display summaries). */
  profile: ProjectProfile;
  /** Called when a section is selected for editing. */
  onSelect: (section: ProfileSection) => void;
  /** Called when "Re-run LLM synthesis" is selected. */
  onResynthesize: () => void;
  /** Called when the user presses Esc to go back. */
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// SectionPicker
// ---------------------------------------------------------------------------

/** Total menu items: 6 sections + 1 resynthesize */
const TOTAL_ITEMS = PROFILE_SECTIONS.length + 1;

/**
 * SectionPicker — profile section menu for edit mode.
 *
 * Displays all 6 profile sections with one-line summaries, plus a
 * "Re-run LLM synthesis" option at the bottom. Arrow keys navigate,
 * Enter/Space selects, Esc goes back.
 */
export function SectionPicker({
  profile,
  onSelect,
  onResynthesize,
  onBack,
}: SectionPickerProps): React.ReactElement {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((prev) => Math.min(TOTAL_ITEMS - 1, prev + 1));
      return;
    }
    if (key.return || input === " ") {
      if (cursor < PROFILE_SECTIONS.length) {
        onSelect(PROFILE_SECTIONS[cursor]);
      } else {
        onResynthesize();
      }
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="magenta">
          Edit Profile
        </Text>
      </Box>

      {/* Instructions */}
      <Box marginBottom={1}>
        <Text dimColor>
          Select a section to edit. Use arrow keys to navigate, Enter to select.
        </Text>
      </Box>

      {/* Section list */}
      <Box flexDirection="column">
        {PROFILE_SECTIONS.map((section, idx) => {
          const name = SECTION_NAMES[section];
          const summary = summarizeSection(section, profile);
          const isSelected = idx === cursor;

          return (
            <Box key={section}>
              <Text
                bold={isSelected}
                color={isSelected ? "cyan" : undefined}
              >
                {isSelected ? "❯ " : "  "}
                {name}
              </Text>
              <Text dimColor> — {summary}</Text>
            </Box>
          );
        })}

        {/* Re-run LLM synthesis option */}
        <Box>
          <Text
            bold={cursor === PROFILE_SECTIONS.length}
            color={cursor === PROFILE_SECTIONS.length ? "magenta" : undefined}
          >
            {cursor === PROFILE_SECTIONS.length ? "❯ " : "  "}
            Re-run LLM synthesis
          </Text>
          <Text dimColor> — regenerate profile from scratch</Text>
        </Box>
      </Box>

      {/* Navigation hint */}
      <Box marginTop={1}>
        <Text dimColor>
          Enter: select  |  Esc: back
        </Text>
      </Box>
    </Box>
  );
}
