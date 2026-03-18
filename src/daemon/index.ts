/**
 * index.ts -- Barrel exports for the daemon module.
 *
 * Re-exports the public API for the daemon subsystem.
 */

// Protocol types and constants
export {
  PROTOCOL_VERSION,
  DEFAULT_WS_PORT,
  PID_FILE,
  DEFAULT_IDLE_TIMEOUT_MS,
  makeCommand,
  makeEvent,
  parseMessage,
} from "./protocol";
export type {
  Envelope,
  CommandType,
  EventType,
  CommandMap,
  EventMap,
  CommandMessage,
  EventMessage,
  Message,
  DaemonAgentState,
  SchedulerState,
  SchedulerStatus,
  EvtStateSnapshot,
  EvtAgentStatusChange,
  EvtSchedulerStatus,
  EvtBuildResult,
  EvtMergeResult,
  EvtHitlQuestion,
  EvtAgentActivity,
  EvtAgentOutput,
  EvtTaskPicked,
  EvtTokenUsage,
  EvtLog,
  EvtShutdown,
  EvtError,
} from "./protocol";

// PID file utilities (lightweight — no heavy daemon imports)
export { isDaemonRunning } from "./pid-utils";

// State management
export { DaemonState, createDaemonAgentState } from "./state";
export type { InternalAgentState, PersistedDaemonState, StateListener } from "./state";

// Scheduler
export { Scheduler } from "./scheduler";
export type { SchedulerConfig, SchedulerDeps } from "./scheduler";

// Agent runner
export { AgentRunner } from "./agent-runner";
export type { AgentRunnerConfig } from "./agent-runner";

// Daemon process
export { Daemon } from "./daemon";
export type { DaemonOptions } from "./daemon";

// Client
export { DaemonClient } from "./client";
export type { DaemonClientOptions, ConnectionState, EventHandler } from "./client";

// Launcher (daemon lifecycle from CLI side)
export {
  startDaemon,
  stopDaemon,
  ensureDaemonRunning,
  getDaemonStatus,
  getDaemonHealthStatus,
} from "./launcher";
export type { DaemonStatus, StartDaemonOptions } from "./launcher";
