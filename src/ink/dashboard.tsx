/**
 * dashboard.tsx — Default TUI screen: live wave status overview.
 *
 * Replaces the SharedStore/DaemonStore polling hack with a proper React
 * context. Callers (InkWomboTUI / InkDaemonTUI) push updates by calling
 * their `notify()` refs, which call `setStore()` — the state flows
 * reactively with no polling interval required.
 *
 * Components:
 *   DashboardScreen      — the main dashboard screen component
 *   DashboardAgentRow    — a single agent row in the agent table
 *
 * Context:
 *   DashboardStoreContext — React context holding the live wave state
 *   useDashboardStore()   — hook to read the dashboard store
 *
 * Usage (in ScreenRouter):
 *   const SCREENS: ScreenMap = {
 *     splash: SplashScreen,
 *     dashboard: DashboardScreen,
 *     settings: SettingsScreen,
 *   };
 *
 *   // Outer wrapper provides the context:
 *   <DashboardStoreContext.Provider value={liveStore}>
 *     <ScreenRouter screens={SCREENS} initialScreen="splash" />
 *   </DashboardStoreContext.Provider>
 */

import React, { createContext, useContext } from "react";
import { Box, Text } from "ink";
import { t } from "./i18n";
import type { AgentStatus } from "../lib/state";

// ---------------------------------------------------------------------------
// DashboardStore type
// ---------------------------------------------------------------------------

/** A single agent row displayed in the dashboard. */
export interface DashboardAgent {
  id: string;
  status: AgentStatus;
  branch?: string;
}

/** The live wave state fed into DashboardStoreContext. */
export interface DashboardStore {
  agents: DashboardAgent[];
  running: number;
  done: number;
  failed: number;
  total: number;
}

const DEFAULT_STORE: DashboardStore = {
  agents: [],
  running: 0,
  done: 0,
  failed: 0,
  total: 0,
};

// ---------------------------------------------------------------------------
// DashboardStoreContext
// ---------------------------------------------------------------------------

export const DashboardStoreContext = createContext<DashboardStore>(DEFAULT_STORE);

/**
 * Hook to read the current live wave state from anywhere inside the TUI tree.
 */
export function useDashboardStore(): DashboardStore {
  return useContext(DashboardStoreContext);
}

// ---------------------------------------------------------------------------
// DashboardAgentRow
// ---------------------------------------------------------------------------

const STATUS_COLOR: Partial<Record<AgentStatus, string>> = {
  queued: "gray",
  installing: "cyan",
  running: "blue",
  completed: "yellow",
  verified: "green",
  failed: "red",
  merged: "magenta",
  retry: "yellow",
  resolving_conflict: "cyan",
};

const STATUS_ICON: Partial<Record<AgentStatus, string>> = {
  queued: "·",
  installing: "⟳",
  running: "●",
  completed: "○",
  verified: "✓",
  failed: "✗",
  merged: "◆",
  retry: "↻",
  resolving_conflict: "⚡",
};

export interface DashboardAgentRowProps {
  agent: DashboardAgent;
}

export function DashboardAgentRow({ agent }: DashboardAgentRowProps): React.ReactElement {
  const color = STATUS_COLOR[agent.status] ?? "white";
  const icon = STATUS_ICON[agent.status] ?? "?";
  const label = t(`status.${agent.status}`) ?? agent.status;

  return (
    <Box flexDirection="row" gap={1} paddingLeft={2}>
      <Text color={color}>{icon}</Text>
      <Text color={color} bold={agent.status === "running"}>
        {agent.id}
      </Text>
      {agent.branch && (
        <Text dimColor>({agent.branch})</Text>
      )}
      <Text dimColor>{label}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// DashboardScreen
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface DashboardScreenProps {
  // No props required: all data comes from DashboardStoreContext
}

/**
 * DashboardScreen — the default TUI screen after splash.
 *
 * Reads live state from DashboardStoreContext (no polling).
 * Register as "dashboard" in the SCREEN_MAP.
 */
export function DashboardScreen(_props: DashboardScreenProps): React.ReactElement {
  const store = useDashboardStore();

  if (store.agents.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {t("screen.dashboard")}
          </Text>
        </Box>
        <Text dimColor>{t("wave.noWave")}</Text>
        <Box marginTop={1}>
          <Text dimColor>Press ESC to open the menu.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Title + summary */}
      <Box flexDirection="row" gap={2} marginBottom={1}>
        <Text bold color="cyan">
          {t("screen.dashboard")}
        </Text>
        <Text color="blue">
          {t("wave.running")} {store.running}
        </Text>
        <Text color="green">
          {t("wave.completed")} {store.done}
        </Text>
        <Text color="red">
          {t("wave.failed")} {store.failed}
        </Text>
        <Text dimColor>
          / {store.total} {t("wave.agents")}
        </Text>
      </Box>

      {/* Agent rows */}
      <Box flexDirection="column">
        {store.agents.map((agent) => (
          <DashboardAgentRow key={agent.id} agent={agent} />
        ))}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>ESC menu  q quit</Text>
      </Box>
    </Box>
  );
}
