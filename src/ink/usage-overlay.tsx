/**
 * usage-overlay.tsx — Ink UsageOverlayView component for token usage stats.
 *
 * Replaces the neo-blessed UsageOverlay class with a declarative React
 * component. The parent manages data loading, grouping state, and selected
 * index; this component handles rendering and keybind dispatch.
 *
 * Features:
 *   - Overall usage summary (input, output, cache, reasoning, total, cost)
 *   - Grouped item list with key, token counts, cost, steps
 *   - Tab to cycle grouping (task_id → quest_id → model → provider)
 *   - Up/Down to navigate the group list
 *   - Escape/U to close
 *
 * Usage:
 *   <UsageOverlayView
 *     overall={overallTotals}
 *     groups={groupedData}
 *     groupField="task_id"
 *     selectedIndex={selectedIdx}
 *     onClose={() => setShowUsage(false)}
 *     onCycleGrouping={() => cycleGrouping()}
 *     onSelectIndex={(idx) => setSelectedIdx(idx)}
 *   />
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./modal";
import type { UsageTotals, GroupableField } from "../lib/token-usage";

// ---------------------------------------------------------------------------
// Format Helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Format a token count with k/M suffixes for compact display.
 */
export function formatTokenCount(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Format a cost value as a dollar string.
 */
export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The grouping fields available for cycling */
const GROUPING_FIELDS: GroupableField[] = [
  "task_id",
  "quest_id",
  "model",
  "provider",
];

/** Human-readable labels for grouping fields */
const GROUPING_LABELS: Record<GroupableField, string> = {
  task_id: "Task",
  quest_id: "Quest",
  model: "Model",
  provider: "Provider",
  harness: "Harness",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageOverlayViewProps {
  /** Overall usage totals, or null if no data. */
  overall: UsageTotals | null;
  /** Grouped usage data, sorted by total_tokens descending. */
  groups: Array<{ key: string; totals: UsageTotals }>;
  /** Current grouping field. */
  groupField: GroupableField;
  /** Currently selected index in the group list. */
  selectedIndex: number;
  /** Called when the overlay should be closed (Escape or U). */
  onClose: () => void;
  /** Called when Tab is pressed to cycle grouping. */
  onCycleGrouping: () => void;
  /** Called when Up/Down changes the selected index. */
  onSelectIndex: (index: number) => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function OverallSummary({ overall }: { overall: UsageTotals }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold color="yellow">Overall Usage:</Text>
      <Box>
        <Text>  Input: </Text>
        <Text color="cyan">{formatTokenCount(overall.input_tokens)}</Text>
        <Text>    Output: </Text>
        <Text color="cyan">{formatTokenCount(overall.output_tokens)}</Text>
        {overall.cache_read > 0 && (
          <>
            <Text>    Cache: </Text>
            <Text dimColor>{formatTokenCount(overall.cache_read)}</Text>
          </>
        )}
      </Box>
      <Box>
        {overall.reasoning_tokens > 0 && (
          <>
            <Text>  Reasoning: </Text>
            <Text color="magenta">{formatTokenCount(overall.reasoning_tokens)}</Text>
            <Text>    </Text>
          </>
        )}
        {overall.reasoning_tokens === 0 && <Text>  </Text>}
        <Text>Total: </Text>
        <Text>{formatTokenCount(overall.total_tokens)}</Text>
        {overall.total_cost > 0 && (
          <>
            <Text>    Cost: </Text>
            <Text color="yellow">{formatCost(overall.total_cost)}</Text>
          </>
        )}
        <Text>    Steps: {overall.record_count}</Text>
      </Box>
    </Box>
  );
}

function GroupItem({
  item,
  isSelected,
}: {
  item: { key: string; totals: UsageTotals };
  isSelected: boolean;
}): React.ReactElement {
  const maxKeyLen = 24;
  const displayKey =
    item.key.length > maxKeyLen
      ? item.key.slice(0, maxKeyLen - 1) + "…"
      : item.key.padEnd(maxKeyLen);

  const input = `In: ${formatTokenCount(item.totals.input_tokens)}`.padEnd(12);
  const output = `Out: ${formatTokenCount(item.totals.output_tokens)}`.padEnd(13);
  const cost =
    item.totals.total_cost > 0 ? formatCost(item.totals.total_cost) : "";
  const steps = `${item.totals.record_count}st`;

  return (
    <Box>
      <Text color={isSelected ? "blue" : undefined} bold={isSelected}>
        {isSelected ? "▸ " : "  "}
      </Text>
      <Text color={isSelected ? "blue" : undefined} bold={isSelected}>
        {displayKey}
      </Text>
      <Text>  </Text>
      <Text color="cyan">{input}</Text>
      <Text> </Text>
      <Text color="cyan">{output}</Text>
      <Text> </Text>
      <Text color="yellow">{cost}</Text>
      <Text>  </Text>
      <Text dimColor>{steps}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * UsageOverlayView — a declarative token usage overlay component.
 */
export function UsageOverlayView({
  overall,
  groups,
  groupField,
  selectedIndex,
  onClose,
  onCycleGrouping,
  onSelectIndex,
}: UsageOverlayViewProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "u" || input === "U") {
      onClose();
      return;
    }

    if (key.tab) {
      onCycleGrouping();
      return;
    }

    if ((key.downArrow || input === "j") && groups.length > 0) {
      const next = Math.min(selectedIndex + 1, groups.length - 1);
      onSelectIndex(next);
      return;
    }

    if ((key.upArrow || input === "k") && groups.length > 0) {
      const prev = Math.max(selectedIndex - 1, 0);
      onSelectIndex(prev);
      return;
    }
  });

  // Next grouping label for footer
  const nextIdx =
    (GROUPING_FIELDS.indexOf(groupField) + 1) % GROUPING_FIELDS.length;
  const nextLabel = GROUPING_LABELS[GROUPING_FIELDS[nextIdx]];

  const titleStr = overall
    ? `Token Usage  Total: ${formatCost(overall.total_cost)}`
    : "Token Usage";

  return (
    <Modal
      title={titleStr}
      borderColor="yellow"
      footer={
        <Box>
          <Text dimColor>Tab</Text>
          <Text> group by {nextLabel}  </Text>
          <Text dimColor>Esc/U</Text>
          <Text> close  </Text>
          <Text dimColor>|  Grouped by: </Text>
          <Text color="yellow">{GROUPING_LABELS[groupField]}</Text>
        </Box>
      }
    >
      {/* Overall summary */}
      {overall ? (
        <OverallSummary overall={overall} />
      ) : (
        <Box flexDirection="column">
          <Text dimColor>
            No token usage data found.
          </Text>
          <Text dimColor>
            Usage data is recorded when agents run and produce step_finish events.
          </Text>
        </Box>
      )}

      {/* Group list */}
      {groups.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box marginBottom={1}>
            <Text bold dimColor>
              By {GROUPING_LABELS[groupField]}:
            </Text>
          </Box>
          {groups.map((item, i) => (
            <GroupItem
              key={`${item.key}-${i}`}
              item={item}
              isSelected={i === selectedIndex}
            />
          ))}
        </Box>
      )}

      {groups.length === 0 && overall && (
        <Box marginTop={1}>
          <Text dimColor>No usage data to group.</Text>
        </Box>
      )}
    </Modal>
  );
}
