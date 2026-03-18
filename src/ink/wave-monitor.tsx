/**
 * wave-monitor.tsx — Ink WaveMonitorView component.
 *
 * Replaces the neo-blessed WomboTUI class with a declarative React
 * component. The parent manages state polling, monitor data, console
 * interception, and tmux attachment; this component handles rendering
 * and keybind dispatch.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────┐
 *   │ Header: Wave ID, base branch, mode, model       │
 *   ├──────────────────────────┬──────────────────────┤
 *   │ Agent Table              │ Preview Pane         │
 *   │ (selectable rows with    │ (parsed activity     │
 *   │  status, activity,       │  stream for the      │
 *   │  progress bars, elapsed) │  selected agent)     │
 *   ├──────────────────────────┴──────────────────────┤
 *   │ Status bar: keybinds + summary counts           │
 *   └─────────────────────────────────────────────────┘
 *
 * Keybinds are dispatched via callback props — the parent decides
 * what each action does (attach tmux, retry, read logs, etc.).
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import type { AgentStatus } from "../lib/state";
import type { ActivityEntry } from "../lib/monitor";
import { formatTokenCount, formatCost } from "./usage-overlay";
import {
  AGENT_STATUS_COLORS,
  AGENT_STATUS_ICONS,
  elapsed,
  progressBar,
} from "./tui-constants";
import { useTerminalSize } from "./use-terminal-size";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lightweight agent info for the view. Extracted from AgentState
 * by the parent/adapter so the view doesn't depend on the full type.
 */
export interface AgentInfo {
  featureId: string;
  status: AgentStatus;
  activity: string | null;
  startedAt: string | null;
  retries: number;
  effortEstimateMs: number | null;
  buildPassed: boolean | null;
  buildOutput: string | null;
}

/**
 * Agent counts by status, matching the shape from agentCounts().
 */
export type AgentCounts = Record<AgentStatus, number>;

export interface WaveMonitorViewProps {
  // -- Wave metadata --
  /** Unique wave identifier. */
  waveId: string;
  /** Base branch the wave was forked from. */
  baseBranch: string;
  /** Whether the wave is running in interactive (tmux) mode. */
  interactive: boolean;
  /** Model name, if set. */
  model: string | null;

  // -- Agent data --
  /** Agent info for all agents in the wave. */
  agents: AgentInfo[];
  /** Counts by status. */
  counts: AgentCounts;
  /** Currently selected agent index. */
  selectedIndex: number;

  // -- Display state --
  /** Whether auto-scroll is enabled. */
  autoScroll: boolean;
  /** Whether the wave has completed. */
  waveComplete: boolean;

  // -- Activity data --
  /** Activity log entries for the currently selected agent. */
  activityLog: ActivityEntry[];
  /** System messages relevant to the selected agent. */
  systemMessages: ActivityEntry[];

  // -- Token usage --
  /** Total tokens across all agents. */
  totalTokens?: number;
  /** Total cost across all agents. */
  totalCost?: number;
  /** Per-agent token counts (featureId → total tokens). */
  agentTokens?: Map<string, number>;

  // -- HITL --
  /** Number of pending HITL questions. */
  pendingQuestionCount: number;

  // -- Overlays --
  /** Whether to show the build log overlay. */
  showBuildLog?: boolean;
  /** Log file content for the log overlay (null = hidden). */
  logFileContent?: string | null;
  /** Agent ID for the log file overlay label. */
  logFileAgentId?: string | null;

  // -- Callbacks --
  /** Called when the user navigates the agent list. */
  onSelectionChange: (index: number) => void;
  /** Called when the user presses Enter (attach/view log). */
  onAttach: () => void;
  /** Called when the user presses R to retry. */
  onRetry: () => void;
  /** Called when the user presses B to toggle build log. */
  onToggleBuildLog: () => void;
  /** Called when the user presses P to toggle auto-scroll. */
  onToggleAutoScroll: () => void;
  /** Called when the user presses H to open HITL questions. */
  onOpenQuestions: () => void;
  /** Called when the user presses Q or Ctrl-C to quit. */
  onQuit: () => void;
  /** Called when the user presses Escape (close overlay). */
  onEscape?: () => void;
  /** Called when user presses Tab to switch to browser. */
  onSwitchToBrowser?: () => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Header({
  waveId,
  baseBranch,
  interactive,
  model,
  waveComplete,
  counts,
  totalAgents,
  totalTokens,
  totalCost,
}: {
  waveId: string;
  baseBranch: string;
  interactive: boolean;
  model: string | null;
  waveComplete: boolean;
  counts: AgentCounts;
  totalAgents: number;
  totalTokens?: number;
  totalCost?: number;
}): React.ReactElement {
  const done = counts.verified + counts.merged;

  return (
    <Box flexDirection="column" height={3}>
      {/* Line 1: branding + metadata */}
      <Box>
        <Text bold>wombo-combo</Text>
        <Text> </Text>
        <Text dimColor>{waveId}</Text>
        {waveComplete && (
          <>
            <Text dimColor>  │  </Text>
            <Text bold color="green">WAVE COMPLETE</Text>
          </>
        )}
        <Text dimColor>  │  </Text>
        <Text>Base: </Text>
        <Text color="cyan">{baseBranch}</Text>
        <Text dimColor>  │  </Text>
        <Text>Mode: </Text>
        {interactive ? (
          <Text color="green">interactive</Text>
        ) : (
          <Text color="blue">headless</Text>
        )}
        {model && (
          <>
            <Text dimColor>  │  </Text>
            <Text>Model: </Text>
            <Text color="yellow">{model}</Text>
          </>
        )}
        {totalTokens !== undefined && totalTokens > 0 && (
          <>
            <Text dimColor>  │  </Text>
            <Text color="yellow">{formatTokenCount(totalTokens)} tok</Text>
            {totalCost !== undefined && totalCost > 0 && (
              <Text color="yellow"> {formatCost(totalCost)}</Text>
            )}
          </>
        )}
      </Box>

      {/* Line 2: progress */}
      <Box>
        <Text> Progress: </Text>
        <Text color="green">{done}</Text>
        <Text>/</Text>
        <Text>{totalAgents}</Text>
        {counts.running > 0 && (
          <Text>  <Text color="blue">{counts.running} running</Text></Text>
        )}
        {counts.failed > 0 && (
          <Text>  <Text color="red">{counts.failed} failed</Text></Text>
        )}
        {counts.queued > 0 && (
          <Text>  <Text dimColor>{counts.queued} queued</Text></Text>
        )}
        {counts.retry > 0 && (
          <Text>  <Text color="yellow">{counts.retry} retrying</Text></Text>
        )}
        {counts.resolving_conflict > 0 && (
          <Text>  <Text color="cyan">{counts.resolving_conflict} resolving</Text></Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * A single row in the agent list.
 */
function AgentListItem({
  agent,
  isSelected,
  tokenCount,
}: {
  agent: AgentInfo;
  isSelected: boolean;
  tokenCount?: number;
}): React.ReactElement {
  const color = AGENT_STATUS_COLORS[agent.status];
  const icon = AGENT_STATUS_ICONS[agent.status];

  // Feature ID — truncate if too long
  const maxFidLen = 24;
  const fid =
    agent.featureId.length > maxFidLen
      ? agent.featureId.slice(0, maxFidLen - 1) + "…"
      : agent.featureId;

  // Progress bar
  let pbar: React.ReactElement | null = null;
  if (
    (agent.status === "running" || agent.status === "resolving_conflict") &&
    agent.startedAt
  ) {
    const elapsedMs = Date.now() - new Date(agent.startedAt).getTime();
    const estimateMs = agent.effortEstimateMs ?? 60 * 60 * 1000;
    pbar = <Text color="cyan"> {progressBar(elapsedMs, estimateMs, 8)}</Text>;
  } else if (agent.status === "verified" || agent.status === "merged") {
    pbar = <Text color="green"> {"█".repeat(8)}</Text>;
  } else if (agent.status === "failed") {
    pbar = <Text color="red"> {"█".repeat(8)}</Text>;
  }

  // Activity snippet
  let actSnippet: React.ReactElement | null = null;
  if (
    (agent.status === "running" || agent.status === "resolving_conflict") &&
    agent.activity
  ) {
    const maxActLen = 25;
    const rawAct =
      agent.activity.length > maxActLen
        ? agent.activity.slice(0, maxActLen - 1) + "…"
        : agent.activity;
    actSnippet = <Text color="cyan"> {rawAct}</Text>;
  } else if (agent.status === "installing") {
    actSnippet = <Text color="cyan"> setting up…</Text>;
  }

  // Retries
  const retriesEl =
    agent.retries > 0 ? (
      <Text color="yellow"> ↻{agent.retries}</Text>
    ) : null;

  // Per-agent token count
  const tokenEl =
    tokenCount !== undefined ? (
      <Text color="yellow"> {formatTokenCount(tokenCount)}</Text>
    ) : null;

  // Elapsed
  const el = elapsed(agent.startedAt);

  return (
    <Text>
      {isSelected ? <Text bold color="blue">&gt; </Text> : <Text>  </Text>}
      <Text>{fid.padEnd(maxFidLen)} </Text>
      <Text color={color}>{icon} {agent.status.padEnd(10)}</Text>
      {pbar}
      {actSnippet}
      {retriesEl}
      {tokenEl}
      <Text dimColor> {el}</Text>
    </Text>
  );
}

/**
 * Activity preview pane for the selected agent.
 */
function ActivityPreview({
  agentId,
  activityLog,
  systemMessages,
}: {
  agentId: string | null;
  activityLog: ActivityEntry[];
  systemMessages: ActivityEntry[];
}): React.ReactElement {
  if (!agentId) {
    return <Text dimColor>No agent selected</Text>;
  }

  if (activityLog.length === 0 && systemMessages.length === 0) {
    return (
      <Text dimColor>No activity yet. Waiting for agent output…</Text>
    );
  }

  return (
    <Box flexDirection="column">
      {activityLog.map((entry, i) => (
        <ActivityLine key={`act-${entry.timestamp}-${i}`} entry={entry} />
      ))}
      {systemMessages.length > 0 && (
        <>
          <Text> </Text>
          <Text color="yellow">-- system --</Text>
          {systemMessages.map((entry, i) => (
            <Text key={`sys-${entry.timestamp}-${i}`}>
              <Text dimColor>{entry.timestamp} </Text>
              <Text color="yellow">{entry.text}</Text>
            </Text>
          ))}
        </>
      )}
    </Box>
  );
}

/**
 * A single activity log line with color-coding based on prefix.
 */
function ActivityLine({
  entry,
}: {
  entry: ActivityEntry;
}): React.ReactElement {
  const text = entry.text;

  // Color-code different line types (matching original WomboTUI)
  let color: string | undefined;
  if (text.startsWith(">>")) {
    color = "cyan";
  } else if (text.startsWith("!!")) {
    color = "red";
  } else if (text.startsWith("--")) {
    color = "green";
  } else if (text.startsWith("[stderr]")) {
    color = "red";
  } else if (text.startsWith("[raw]")) {
    color = "gray";
  }

  return (
    <Box>
      <Text dimColor>{entry.timestamp} </Text>
      {color ? (
        <Text color={color}>{text}</Text>
      ) : (
        <Text>{text}</Text>
      )}
    </Box>
  );
}

/**
 * Build log overlay.
 */
function BuildLogOverlay({
  agentId,
  buildPassed,
  buildOutput,
}: {
  agentId: string;
  buildPassed: boolean | null;
  buildOutput: string | null;
}): React.ReactElement {
  let content: React.ReactElement;
  if (buildOutput) {
    content = <Text>{buildOutput}</Text>;
  } else if (buildPassed === true) {
    content = <Text color="green">Build passed — no errors.</Text>;
  } else if (buildPassed === false) {
    content = <Text color="red">Build failed — no output captured.</Text>;
  } else {
    content = <Text dimColor>No build has been run yet.</Text>;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="yellow"
      width="80%"
      paddingX={1}
    >
      <Text bold> Build Log — {agentId} </Text>
      <Text> </Text>
      {content}
    </Box>
  );
}

/**
 * Log file overlay.
 */
function LogFileOverlay({
  agentId,
  content,
}: {
  agentId: string;
  content: string;
}): React.ReactElement {
  // Truncate to last 200 lines
  const lines = content.split("\n");
  const truncated =
    lines.length > 200 ? lines.slice(-200).join("\n") : content;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="cyan"
      width="90%"
      paddingX={1}
    >
      <Text bold> Log — {agentId} (Esc to close) </Text>
      <Text> </Text>
      <Text>{truncated}</Text>
    </Box>
  );
}

function StatusBar({
  interactive,
  autoScroll,
  waveComplete,
  pendingQuestionCount,
  selectedAgentId,
}: {
  interactive: boolean;
  autoScroll: boolean;
  waveComplete: boolean;
  pendingQuestionCount: number;
  selectedAgentId: string | null;
}): React.ReactElement {
  const enterHint = interactive ? "attach session" : "view log";

  return (
    <Box flexDirection="column" height={3}>
      <Box flexWrap="wrap">
        {waveComplete ? (
          <>
            <Text bold color="green">Wave complete.</Text>
            <Text>  </Text>
          </>
        ) : (
          <>
            <Text bold>Keys:</Text>
            <Text>  </Text>
          </>
        )}
        <Text dimColor>↑↓</Text>
        <Text> navigate</Text>
        <Text>  </Text>
        <Text dimColor>Enter</Text>
        <Text> {enterHint}</Text>
        <Text>  </Text>
        <Text dimColor>R</Text>
        <Text> retry</Text>
        <Text>  </Text>
        <Text dimColor>B</Text>
        <Text> build log</Text>
        <Text>  </Text>
        <Text dimColor>P</Text>
        <Text> {autoScroll ? (
          <Text color="green">auto-scroll</Text>
        ) : (
          <Text color="yellow">paused</Text>
        )}</Text>
        {pendingQuestionCount > 0 && (
          <>
            <Text>  </Text>
            <Text bold color="yellow">? {pendingQuestionCount} pending</Text>
            <Text>  </Text>
            <Text dimColor>H</Text>
            <Text> answer</Text>
          </>
        )}
        <Text>  </Text>
        {waveComplete ? (
          <>
            <Text bold color="yellow">Q</Text>
            <Text bold> exit</Text>
          </>
        ) : (
          <>
            <Text dimColor>Q</Text>
            <Text> quit</Text>
          </>
        )}
      </Box>
      <Box>
        {selectedAgentId ? (
          <Text>
            <Text dimColor>Selected: </Text>
            <Text>{selectedAgentId}</Text>
          </Text>
        ) : (
          <Text dimColor> </Text>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * WaveMonitorView — a declarative wave monitoring dashboard component.
 *
 * Pure view: all data is passed in via props, all actions dispatched
 * via callbacks. The parent is responsible for state polling, monitor
 * data collection, console interception, and tmux management.
 */
export function WaveMonitorView(props: WaveMonitorViewProps): React.ReactElement {
  const {
    waveId,
    baseBranch,
    interactive,
    model,
    agents,
    counts,
    selectedIndex,
    autoScroll,
    waveComplete,
    activityLog,
    systemMessages,
    totalTokens,
    totalCost,
    agentTokens,
    pendingQuestionCount,
    showBuildLog,
    logFileContent,
    logFileAgentId,
    onSelectionChange,
    onAttach,
    onRetry,
    onToggleBuildLog,
    onToggleAutoScroll,
    onOpenQuestions,
    onQuit,
    onEscape,
    onSwitchToBrowser,
  } = props;

  // Keyboard handling
  useInput((input, key) => {
    // Quit
    if (input === "q" || (key.ctrl && input === "c")) {
      onQuit();
      return;
    }

    // Navigate
    if ((key.downArrow || input === "j") && agents.length > 0) {
      const next = Math.min(selectedIndex + 1, agents.length - 1);
      onSelectionChange(next);
      return;
    }
    if ((key.upArrow || input === "k") && agents.length > 0) {
      const prev = Math.max(selectedIndex - 1, 0);
      onSelectionChange(prev);
      return;
    }

    // Enter — attach/view log
    if (key.return) {
      onAttach();
      return;
    }

    // b — toggle build log
    if (input === "b") {
      onToggleBuildLog();
      return;
    }

    // p — toggle auto-scroll
    if (input === "p") {
      onToggleAutoScroll();
      return;
    }

    // r — retry
    if (input === "r") {
      onRetry();
      return;
    }

    // h — open HITL questions
    if (input === "h") {
      onOpenQuestions();
      return;
    }

    // Escape — close overlays
    if (key.escape) {
      onEscape?.();
      return;
    }

    // Tab — switch to browser
    if (key.tab) {
      onSwitchToBrowser?.();
      return;
    }
  });

  // Selected agent
  const selectedAgent = agents[selectedIndex] ?? null;

  // Fill the entire terminal height so Ink's fullscreen detection kicks in
  const { rows } = useTerminalSize();

  return (
    <Box flexDirection="column" width="100%" height={rows}>
      {/* Header */}
      <Header
        waveId={waveId}
        baseBranch={baseBranch}
        interactive={interactive}
        model={model}
        waveComplete={waveComplete}
        counts={counts}
        totalAgents={agents.length}
        totalTokens={totalTokens}
        totalCost={totalCost}
      />

      {/* Main body: agent list + preview */}
      <Box flexGrow={1}>
        {/* Agent list (left pane, 55%) */}
        <Box
          flexDirection="column"
          width="55%"
          borderStyle="single"
          borderColor="gray"
        >
          {agents.map((agent, i) => (
            <AgentListItem
              key={agent.featureId}
              agent={agent}
              isSelected={selectedIndex === i}
              tokenCount={agentTokens?.get(agent.featureId)}
            />
          ))}
          {agents.length === 0 && (
            <Text dimColor>  No agents</Text>
          )}
        </Box>

        {/* Preview pane (right pane, 45%) */}
        <Box
          flexDirection="column"
          width="45%"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          {selectedAgent && (
            <Text bold dimColor> {selectedAgent.featureId} — Activity </Text>
          )}
          <ActivityPreview
            agentId={selectedAgent?.featureId ?? null}
            activityLog={activityLog}
            systemMessages={systemMessages}
          />
        </Box>
      </Box>

      {/* Build log overlay */}
      {showBuildLog && selectedAgent && (
        <BuildLogOverlay
          agentId={selectedAgent.featureId}
          buildPassed={selectedAgent.buildPassed}
          buildOutput={selectedAgent.buildOutput}
        />
      )}

      {/* Log file overlay */}
      {logFileContent != null && logFileAgentId && (
        <LogFileOverlay
          agentId={logFileAgentId}
          content={logFileContent}
        />
      )}

      {/* Status bar */}
      <StatusBar
        interactive={interactive}
        autoScroll={autoScroll}
        waveComplete={waveComplete}
        pendingQuestionCount={pendingQuestionCount}
        selectedAgentId={selectedAgent?.featureId ?? null}
      />
    </Box>
  );
}
