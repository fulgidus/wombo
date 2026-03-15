/**
 * select-input.tsx — Ink SelectInput component for choosing from a list.
 *
 * A reusable select/list component for Ink that replaces blessed's list widget
 * for enum field selection (priority, difficulty, HITL mode, etc.).
 *
 * Features:
 *   - Up/Down arrow key navigation
 *   - Enter or Space to select
 *   - Escape to cancel
 *   - Visual indicator for the highlighted item
 *   - Optional hint text per item
 *   - Wraps around at boundaries
 *   - Focus/blur support
 *
 * Usage:
 *   <SelectInput
 *     items={[
 *       { label: "High", value: "high", hint: "(recommended)" },
 *       { label: "Medium", value: "medium" },
 *       { label: "Low", value: "low" },
 *     ]}
 *     onSelect={(item) => console.log(item.value)}
 *     onCancel={() => console.log("cancelled")}
 *   />
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SelectInputItem<V = string> {
  /** Display label for the item. */
  label: string;
  /** The value associated with this item. */
  value: V;
  /** Optional hint text displayed after the label (dimmed). */
  hint?: string;
}

export interface SelectInputProps<V = string> {
  /** List of items to display. */
  items: SelectInputItem<V>[];
  /** Called when user presses Enter or Space on an item. */
  onSelect: (item: SelectInputItem<V>) => void;
  /** Called when user presses Escape. */
  onCancel?: () => void;
  /** Initial highlighted index. Default: 0. */
  initialIndex?: number;
  /** Whether the component is focused and accepting input. Default: true. */
  focus?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * SelectInput — a list selection component for Ink.
 *
 * Renders a vertical list of items with a highlight indicator.
 * Arrow keys navigate, Enter/Space selects, Escape cancels.
 */
export function SelectInput<V = string>({
  items,
  onSelect,
  onCancel,
  initialIndex = 0,
  focus = true,
}: SelectInputProps<V>): React.ReactElement {
  const [highlightedIndex, setHighlightedIndex] = useState(
    Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1))
  );

  const handleInput = useCallback(
    (input: string, key: import("ink").Key) => {
      if (items.length === 0) return;

      // Down arrow — move highlight down (wrap)
      if (key.downArrow) {
        setHighlightedIndex((prev) =>
          prev >= items.length - 1 ? 0 : prev + 1
        );
        return;
      }

      // Up arrow — move highlight up (wrap)
      if (key.upArrow) {
        setHighlightedIndex((prev) =>
          prev <= 0 ? items.length - 1 : prev - 1
        );
        return;
      }

      // Enter — select current item
      if (key.return) {
        onSelect(items[highlightedIndex]);
        return;
      }

      // Space — also select
      if (input === " ") {
        onSelect(items[highlightedIndex]);
        return;
      }

      // Escape — cancel
      if (key.escape) {
        onCancel?.();
        return;
      }
    },
    [items, highlightedIndex, onSelect, onCancel]
  );

  useInput(handleInput, { isActive: focus });

  // Empty state
  if (items.length === 0) {
    return (
      <Box>
        <Text dimColor>No items</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        const isHighlighted = index === highlightedIndex;
        return (
          <Box key={index}>
            <Text color={isHighlighted ? "cyan" : undefined}>
              {isHighlighted ? "❯ " : "  "}
            </Text>
            <Text bold={isHighlighted} color={isHighlighted ? "cyan" : undefined}>
              {item.label}
            </Text>
            {item.hint && (
              <Text dimColor> {item.hint}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
