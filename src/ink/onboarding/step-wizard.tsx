/**
 * step-wizard.tsx — Multi-step onboarding wizard Ink component.
 *
 * Collects raw inputs from the user across 8 steps (type, name, description,
 * vision, objectives, techStack, conventions, rules). Each step shows a label,
 * prompt, and either a selection list, text input, or multi-line textarea.
 *
 * Navigation:
 *   - Esc on the first step cancels the wizard
 *   - Esc on subsequent steps goes back one step
 *   - Enter/Space on selection items advances
 *   - Enter on single-line text inputs advances
 *   - Ctrl+S on multi-line textareas advances
 *
 * On completion, calls onComplete(rawInputs).
 * On cancel, calls onCancel().
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "../text-input";
import { INPUT_STEPS, type RawInputs, type InputStep } from "./onboarding-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepWizardProps {
  /** Called when all steps are completed with the collected raw inputs. */
  onComplete: (inputs: RawInputs) => void;
  /** Called when the user cancels the wizard (Esc on first step). */
  onCancel: () => void;
  /** Optional initial values to pre-populate fields. */
  initialValues?: Partial<RawInputs>;
}

// ---------------------------------------------------------------------------
// SelectionList — internal component for selection steps
// ---------------------------------------------------------------------------

interface SelectionListProps {
  items: string[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onBack: () => void;
}

function SelectionList({
  items,
  selectedIndex,
  onSelect,
  onBack,
}: SelectionListProps): React.ReactElement {
  const [cursor, setCursor] = useState(selectedIndex);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((prev) => Math.min(items.length - 1, prev + 1));
      return;
    }
    if (key.return || input === " ") {
      onSelect(cursor);
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((item, idx) => (
        <Box key={idx}>
          <Text
            bold={idx === cursor}
            color={idx === cursor ? "cyan" : undefined}
          >
            {idx === cursor ? "❯ " : "  "}
            {item}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// SingleLineInput — internal component wrapping TextInput for single-line steps
// ---------------------------------------------------------------------------

interface SingleLineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onBack: () => void;
  optional: boolean;
}

function SingleLineInput({
  value,
  onChange,
  onSubmit,
  onBack,
  optional,
}: SingleLineInputProps): React.ReactElement {
  const [error, setError] = useState("");

  const handleSubmit = useCallback(
    (val: string) => {
      const trimmed = val.trim();
      if (!trimmed && !optional) {
        setError("This field cannot be empty");
        return;
      }
      setError("");
      onSubmit(trimmed);
    },
    [optional, onSubmit],
  );

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return) {
      handleSubmit(value);
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <TextInput value={value} onChange={onChange} focus={true} />
      {error && (
        <Text color="red">{error}</Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// MultiLineInput — internal component wrapping TextInput for multi-line steps
// ---------------------------------------------------------------------------

interface MultiLineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onBack: () => void;
  optional: boolean;
}

function MultiLineInput({
  value,
  onChange,
  onSubmit,
  onBack,
  optional,
}: MultiLineInputProps): React.ReactElement {
  const [error, setError] = useState("");

  const handleSubmit = useCallback(
    (val: string) => {
      const trimmed = val.trim();
      if (!trimmed && !optional) {
        setError("This field cannot be empty");
        return;
      }
      setError("");
      onSubmit(trimmed);
    },
    [optional, onSubmit],
  );

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={handleSubmit}
        multiline={true}
        focus={true}
      />
      {error && (
        <Text color="red">{error}</Text>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {optional
            ? "Ctrl+S to save and continue | Leave empty to skip"
            : "Ctrl+S to save and continue"}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// StepWizard — main exported component
// ---------------------------------------------------------------------------

const DEFAULT_RAW_INPUTS: RawInputs = {
  type: "brownfield",
  name: "",
  description: "",
  vision: "",
  objectives: "",
  techStack: "",
  conventions: "",
  rules: "",
};

/**
 * StepWizard — multi-step onboarding wizard.
 *
 * Walks the user through INPUT_STEPS (8 steps), collecting one RawInputs
 * field per step. Supports selection lists, single-line text inputs, and
 * multi-line textareas. Esc navigates back; on the first step, Esc cancels.
 */
export function StepWizard({
  onComplete,
  onCancel,
  initialValues,
}: StepWizardProps): React.ReactElement {
  const [stepIndex, setStepIndex] = useState(0);
  const [data, setData] = useState<RawInputs>({
    ...DEFAULT_RAW_INPUTS,
    ...initialValues,
  });

  const step = INPUT_STEPS[stepIndex];
  const stepCount = INPUT_STEPS.length;
  const isFirstStep = stepIndex === 0;

  // Navigation helpers
  const goBack = useCallback(() => {
    if (isFirstStep) {
      onCancel();
    } else {
      setStepIndex((prev) => prev - 1);
    }
  }, [isFirstStep, onCancel]);

  const advance = useCallback(
    (field: keyof RawInputs, value: string) => {
      const updated = { ...data, [field]: value };
      setData(updated);

      if (stepIndex + 1 >= stepCount) {
        // All steps completed
        onComplete(updated);
      } else {
        setStepIndex((prev) => prev + 1);
      }
    },
    [data, stepIndex, stepCount, onComplete],
  );

  // Selection handler
  const handleSelect = useCallback(
    (index: number) => {
      const value = index === 0 ? "brownfield" : "greenfield";
      advance(step.field, value);
    },
    [advance, step.field],
  );

  // Text input change handler
  const handleChange = useCallback(
    (value: string) => {
      setData((prev) => ({ ...prev, [step.field]: value }));
    },
    [step.field],
  );

  // Text input submit handler
  const handleTextSubmit = useCallback(
    (value: string) => {
      advance(step.field, value);
    },
    [advance, step.field],
  );

  // Render step input
  const renderInput = (): React.ReactElement => {
    if (step.selection) {
      const currentIdx = data.type === "brownfield" ? 0 : 1;
      return (
        <SelectionList
          items={step.selectionItems ?? []}
          selectedIndex={currentIdx}
          onSelect={handleSelect}
          onBack={goBack}
        />
      );
    }

    if (step.multiline) {
      return (
        <MultiLineInput
          value={data[step.field]}
          onChange={handleChange}
          onSubmit={handleTextSubmit}
          onBack={goBack}
          optional={step.optional ?? false}
        />
      );
    }

    return (
      <SingleLineInput
        value={data[step.field]}
        onChange={handleChange}
        onSubmit={handleTextSubmit}
        onBack={goBack}
        optional={step.optional ?? false}
      />
    );
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="magenta">
          Project Onboarding
        </Text>
      </Box>

      {/* Step counter and label */}
      <Box marginBottom={1}>
        <Text bold>
          Step {stepIndex + 1}/{stepCount} — {step.label}
        </Text>
      </Box>

      {/* Prompt */}
      <Box marginBottom={1}>
        <Text dimColor>{step.prompt}</Text>
      </Box>

      {/* Navigation hint */}
      <Box marginBottom={1}>
        <Text dimColor>
          {isFirstStep ? "Esc to cancel" : "Esc to go back"}
        </Text>
      </Box>

      {/* Input area */}
      {renderInput()}
    </Box>
  );
}
