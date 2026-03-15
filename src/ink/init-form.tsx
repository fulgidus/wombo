/**
 * init-form.tsx — Ink confirmation screen for `woco init`.
 *
 * Replaces the 20+ prompt interactive wizard with a minimal Ink form.
 * Shows auto-detected defaults in a confirmation screen with 3 editable
 * fields (baseBranch, buildCommand, installCommand).
 *
 * Navigation:
 *   - Tab / Up / Down to move between fields
 *   - Type to edit a field
 *   - Enter to confirm and write files
 *   - Escape to cancel
 *
 * The form uses the existing TextInput component from ink-input-system.
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitFormDefaults {
  baseBranch: string;
  buildCommand: string;
  installCommand: string;
}

export interface InitFormProps {
  /** Project name (auto-detected from folder). */
  projectName: string;
  /** Auto-detected default values. */
  defaults: InitFormDefaults;
  /** Called when the user confirms. Receives the final values. */
  onConfirm: (values: InitFormDefaults) => void;
  /** Called when the user cancels (Escape). */
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

export interface FieldDef {
  key: keyof InitFormDefaults;
  label: string;
}

export const FIELDS: FieldDef[] = [
  { key: "baseBranch", label: "Base Branch" },
  { key: "buildCommand", label: "Build Command" },
  { key: "installCommand", label: "Install Command" },
];

// ---------------------------------------------------------------------------
// EditableField — a single form row
// ---------------------------------------------------------------------------

interface EditableFieldProps {
  label: string;
  value: string;
  focused: boolean;
  onChange: (value: string) => void;
}

function EditableField({ label, value, focused, onChange }: EditableFieldProps): React.ReactElement {
  // When focused, we render a simple inline text input
  // For renderToString compatibility, we render the value directly
  return (
    <Box>
      <Box width={20}>
        <Text bold={focused} color={focused ? "cyan" : undefined}>
          {focused ? "▸ " : "  "}
          {label}:
        </Text>
      </Box>
      <Box>
        {focused ? (
          <Text inverse>{value || " "}</Text>
        ) : (
          <Text>{value}</Text>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// InitForm — the confirmation screen component
// ---------------------------------------------------------------------------

/**
 * InitForm — minimal Ink form for project initialization.
 *
 * Shows auto-detected project settings with 3 editable fields.
 * Uses Tab/arrows to navigate, Enter to confirm, Escape to cancel.
 */
export function InitForm({
  projectName,
  defaults,
  onConfirm,
  onCancel,
}: InitFormProps): React.ReactElement {
  const [values, setValues] = useState<InitFormDefaults>({ ...defaults });
  const [focusedField, setFocusedField] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState("");

  const handleConfirm = useCallback(() => {
    // If editing, merge the edit buffer into values before confirming.
    // We compute finalValues inline because setValues is async and the
    // state update won't have applied when onConfirm runs.
    let finalValues = values;
    if (editing) {
      const field = FIELDS[focusedField];
      finalValues = { ...values, [field.key]: editBuffer };
      setValues(finalValues);
      setEditing(false);
    }
    onConfirm(finalValues);
  }, [values, onConfirm, editing, editBuffer, focusedField]);

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  useInput((input, key) => {
    if (editing) {
      // In edit mode
      if (key.escape) {
        // Cancel edit, restore original value
        setEditing(false);
        return;
      }
      if (key.return) {
        // Apply edit
        const field = FIELDS[focusedField];
        const newValues = { ...values, [field.key]: editBuffer };
        setValues(newValues);
        setEditing(false);
        return;
      }
      if (key.backspace || key.delete) {
        setEditBuffer((prev) => prev.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input && input.length > 0) {
        setEditBuffer((prev) => prev + input);
        return;
      }
      return;
    }

    // Normal navigation mode
    if (key.escape) {
      handleCancel();
      return;
    }

    if (key.return) {
      // Start editing the focused field
      const field = FIELDS[focusedField];
      setEditBuffer(values[field.key]);
      setEditing(true);
      return;
    }

    // Tab or Down — move to next field, or confirm if at last field
    if (key.tab || key.downArrow) {
      setFocusedField((prev) => Math.min(prev + 1, FIELDS.length - 1));
      return;
    }

    // Shift+Tab or Up — move to previous field
    if (key.upArrow) {
      setFocusedField((prev) => Math.max(prev - 1, 0));
      return;
    }

    // Ctrl+S or Enter while at the end — confirm
    if (key.ctrl && input === "s") {
      handleConfirm();
      return;
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          wombo-combo
        </Text>
        <Text> — Project Setup</Text>
      </Box>

      {/* Project info (auto-detected, read-only) */}
      <Box marginBottom={1}>
        <Text dimColor>Project: </Text>
        <Text bold>{projectName}</Text>
        <Text dimColor> (auto-detected)</Text>
      </Box>

      {/* Editable fields */}
      <Box flexDirection="column" marginBottom={1}>
        <Box marginBottom={1}>
          <Text dimColor>─── Settings ───────────────────────────────────</Text>
        </Box>
        {FIELDS.map((field, idx) => (
          <EditableField
            key={field.key}
            label={field.label}
            value={
              editing && idx === focusedField
                ? editBuffer
                : values[field.key]
            }
            focused={idx === focusedField}
            onChange={(newValue) => {
              setValues((prev) => ({ ...prev, [field.key]: newValue }));
            }}
          />
        ))}
      </Box>

      {/* Key hints */}
      <Box>
        <Text dimColor>
          {editing
            ? "Enter to apply • Esc to cancel edit"
            : "Enter to edit • ↑↓ to navigate • Ctrl+S to confirm • Esc to cancel"}
        </Text>
      </Box>
    </Box>
  );
}
