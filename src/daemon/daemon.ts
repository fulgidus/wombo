/**
 * daemon.ts -- Main daemon process.
 *
 * Runs as a persistent background process managing the continuous task pipeline.
 * Exposes a WebSocket server for CLI/TUI clients to connect and send commands.
 *
 * Lifecycle:
 *   1. Start: load config, initialize state/scheduler/runner, start WS server.
 *   2. Run: tick loop picks tasks, agents run, events broadcast to clients.
 *   3. Idle timeout: if no active agents and no clients for N minutes, auto-shutdown.
 *   4. Shutdown: drain agents, close connections, remove PID file.
 *
 * This file is the entry point when the daemon is spawned as a child process.
 * It can also be imported and started programmatically.
 */

import { resolve } from "node:path";
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from "node:fs";
import { loadConfig, validateConfig, WOMBO_DIR } from "../config";
import type { WomboConfig } from "../config";
import { DaemonState } from "./state";
import type { StateListener } from "./state";
import { Scheduler } from "./scheduler";
import type { SchedulerConfig } from "./scheduler";
import { AgentRunner } from "./agent-runner";
import type { AgentRunnerConfig } from "./agent-runner";
import { submitAnswer, getPendingQuestions } from "../lib/hitl-channel";
import { isDaemonRunning } from "./pid-utils";
import {
  DEFAULT_WS_PORT,
  DEFAULT_IDLE_TIMEOUT_MS,
  PID_FILE,
  PROTOCOL_VERSION,
  makeEvent,
  parseMessage,
} from "./protocol";
import type {
  CommandType,
  CommandMap,
  EventType,
  EventMap,
  EventMessage,
  CommandMessage,
} from "./protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  /** Project root directory. Defaults to cwd. */
  projectRoot?: string;
  /** WebSocket port. Defaults to DEFAULT_WS_PORT (19420). */
  port?: number;
  /** Idle timeout in ms before auto-shutdown. 0 = no timeout. */
  idleTimeoutMs?: number;
  /** Tick interval for the scheduler in ms. */
  tickIntervalMs?: number;
  /** If true, log to stderr. */
  verbose?: boolean;
}

interface ConnectedClient {
  /** Client-provided identifier */
  clientId: string;
  /** Whether handshake has been completed */
  handshaked: boolean;
  /** WebSocket instance */
  ws: ServerWebSocket<ClientData>;
  /** When this client connected */
  connectedAt: number;
}

interface ClientData {
  /** Internal connection ID */
  id: string;
}

/** Bun's ServerWebSocket type — import from the global Bun types. */
type ServerWebSocket<T> = import("bun").ServerWebSocket<T>;

// ---------------------------------------------------------------------------
// Daemon class
// ---------------------------------------------------------------------------

export class Daemon {
  private projectRoot: string;
  private config: WomboConfig;
  private port: number;
  private idleTimeoutMs: number;
  private verbose: boolean;

  private state: DaemonState;
  private scheduler: Scheduler;
  private runner: AgentRunner;

  private server: ReturnType<typeof Bun.serve> | null = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private eventSeq = 0;
  private startedAt = Date.now();

  /** Timer for idle auto-shutdown. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Timer for HITL question polling. */
  private hitlPollTimer: ReturnType<typeof setInterval> | null = null;

  /** Set of known question IDs (to avoid re-emitting events). */
  private knownQuestionIds: Set<string> = new Set();

  /** State change listener unsubscribe fn. */
  private unsubscribeState: (() => void) | null = null;

  constructor(opts: DaemonOptions = {}) {
    this.projectRoot = resolve(opts.projectRoot ?? process.cwd());
    this.port = opts.port ?? DEFAULT_WS_PORT;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.verbose = opts.verbose ?? false;

    // Load config
    this.config = loadConfig(this.projectRoot);
    validateConfig(this.config);

    // Initialize state
    this.state = new DaemonState(this.projectRoot);
    this.state.load();

    // Initialize runner
    const runnerConfig: AgentRunnerConfig = {
      projectRoot: this.projectRoot,
      config: this.config,
    };
    this.runner = new AgentRunner(runnerConfig, this.state);

    // Initialize scheduler (not started yet — waits for a cmd:start)
    const schedConfig: SchedulerConfig = {
      projectRoot: this.projectRoot,
      config: this.config,
      tickIntervalMs: opts.tickIntervalMs,
    };
    this.scheduler = new Scheduler(schedConfig, {
      state: this.state,
      runner: this.runner,
    });
  }

  // -------------------------------------------------------------------------
  // Start / stop
  // -------------------------------------------------------------------------

  /** Start the daemon: write PID file, start WebSocket server, subscribe to state. */
  start(): void {
    this.log("info", `Starting daemon (pid=${process.pid}, port=${this.port})`);

    // Write PID file
    this.writePidFile();

    // Subscribe to state events to broadcast to clients
    this.unsubscribeState = this.state.subscribe(this.onStateEvent.bind(this));

    // Start WebSocket server using Bun.serve
    this.startServer();

    // Start idle timeout
    this.resetIdleTimer();

    // Start HITL question polling (filesystem-based detection)
    this.startHitlPolling();

    // Register signal handlers
    this.registerSignalHandlers();

    this.log("info", "Daemon ready");
  }

  /** Graceful shutdown: stop scheduler, drain agents, close server, clean up. */
  async shutdown(reason: string, force = false): Promise<void> {
    this.log("info", `Shutting down: ${reason} (force=${force})`);

    // Broadcast shutdown event to clients
    this.broadcast("evt:shutdown", { reason, forced: force });

    // Stop the scheduler
    this.scheduler.shutdown();

    // Kill or wait for agents
    if (force) {
      await this.runner.killAll();
    }
    // Note: if not force, running agents will continue to completion
    // but the scheduler won't pick new ones.

    // Close the WebSocket server
    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    // Flush state to disk
    this.state.flush();

    // Unsubscribe from state events
    if (this.unsubscribeState) {
      this.unsubscribeState();
      this.unsubscribeState = null;
    }

    // Clean up runner
    this.runner.destroy();
    this.state.destroy();

    // Remove PID file
    this.removePidFile();

    // Clear idle timer
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Stop HITL polling
    if (this.hitlPollTimer) {
      clearInterval(this.hitlPollTimer);
      this.hitlPollTimer = null;
    }

    this.log("info", "Daemon stopped");

    // Exit the process
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // WebSocket server
  // -------------------------------------------------------------------------

  private startServer(): void {
    const daemon = this;

    this.server = Bun.serve({
      port: this.port,
      fetch(req, server) {
        // Upgrade HTTP requests to WebSocket
        const url = new URL(req.url);
        if (url.pathname === "/ws" || url.pathname === "/") {
          const id = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const ok = server.upgrade(req, { data: { id } });
          if (ok) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        // Health check endpoint
        if (url.pathname === "/health") {
          return new Response(
            JSON.stringify({
              status: "ok",
              pid: process.pid,
              uptime: Date.now() - daemon.startedAt,
              clients: daemon.clients.size,
              schedulerStatus: daemon.state.getSchedulerStatus(),
            }),
            { headers: { "content-type": "application/json" } }
          );
        }

        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(ws: ServerWebSocket<ClientData>) {
          const client: ConnectedClient = {
            clientId: ws.data.id,
            handshaked: false,
            ws,
            connectedAt: Date.now(),
          };
          daemon.clients.set(ws.data.id, client);
          daemon.log("info", `Client connected: ${ws.data.id}`);
          daemon.resetIdleTimer();
        },

        message(ws: ServerWebSocket<ClientData>, raw: string | Buffer) {
          const text = typeof raw === "string" ? raw : raw.toString();
          daemon.handleMessage(ws.data.id, text);
        },

        close(ws: ServerWebSocket<ClientData>, code: number, reason: string) {
          daemon.clients.delete(ws.data.id);
          daemon.log("info", `Client disconnected: ${ws.data.id} (code=${code})`);
          daemon.resetIdleTimer();
        },
      },
    });

    this.log("info", `WebSocket server listening on ws://localhost:${this.port}/ws`);
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private handleMessage(clientId: string, raw: string): void {
    const msg = parseMessage(raw);
    if (!msg) {
      this.sendTo(clientId, "evt:error", {
        commandType: "unknown",
        commandSeq: 0,
        message: "Invalid message format",
        code: "PARSE_ERROR",
      });
      return;
    }

    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      this.dispatchCommand(client, msg as CommandMessage);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.sendTo(clientId, "evt:error", {
        commandType: msg.type,
        commandSeq: msg.seq,
        message: errMsg,
        code: "COMMAND_ERROR",
      });
    }
  }

  private dispatchCommand(client: ConnectedClient, msg: CommandMessage): void {
    const type = msg.type;
    const payload = msg.payload;

    switch (type) {
      case "cmd:handshake":
        this.handleHandshake(client, payload as CommandMap["cmd:handshake"]);
        break;

      case "cmd:start":
        this.handleStart(payload as CommandMap["cmd:start"]);
        break;

      case "cmd:pause":
        this.scheduler.pause();
        break;

      case "cmd:resume":
        this.scheduler.resume();
        break;

      case "cmd:stop":
        this.scheduler.stop();
        break;

      case "cmd:kill":
        this.scheduler.kill();
        break;

      case "cmd:pin-task":
        this.scheduler.pinTask((payload as CommandMap["cmd:pin-task"]).taskId);
        break;

      case "cmd:skip-task":
        this.scheduler.skipTask((payload as CommandMap["cmd:skip-task"]).taskId);
        break;

      case "cmd:retry-agent":
        this.scheduler.retryAgent((payload as CommandMap["cmd:retry-agent"]).featureId);
        break;

      case "cmd:cancel-agent":
        this.scheduler.cancelAgent((payload as CommandMap["cmd:cancel-agent"]).featureId);
        break;

      case "cmd:hitl-answer":
        this.handleHitlAnswer(payload as CommandMap["cmd:hitl-answer"]);
        break;

      case "cmd:get-state":
        this.sendSnapshot(client);
        break;

      case "cmd:set-concurrency":
        this.scheduler.setConcurrency(
          (payload as CommandMap["cmd:set-concurrency"]).maxConcurrent
        );
        break;

      case "cmd:shutdown": {
        const shutdownPayload = payload as CommandMap["cmd:shutdown"];
        this.shutdown("Client requested shutdown", shutdownPayload.force ?? false);
        break;
      }

      default:
        this.sendTo(client.clientId, "evt:error", {
          commandType: type,
          commandSeq: 0,
          message: `Unknown command: ${type}`,
          code: "UNKNOWN_COMMAND",
        });
    }
  }

  // -------------------------------------------------------------------------
  // Command handlers
  // -------------------------------------------------------------------------

  private handleHandshake(
    client: ConnectedClient,
    payload: CommandMap["cmd:handshake"]
  ): void {
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      this.sendTo(client.clientId, "evt:error", {
        commandType: "cmd:handshake",
        commandSeq: 0,
        message: `Protocol version mismatch: client=${payload.protocolVersion}, daemon=${PROTOCOL_VERSION}`,
        code: "VERSION_MISMATCH",
      });
      return;
    }

    client.clientId = payload.clientId;
    client.handshaked = true;

    this.sendTo(client.clientId, "evt:handshake-ack", {
      protocolVersion: PROTOCOL_VERSION,
      daemonPid: process.pid,
      uptime: Date.now() - this.startedAt,
    });

    // Immediately send full state snapshot
    this.sendSnapshot(client);
  }

  private handleStart(payload: CommandMap["cmd:start"]): void {
    // Apply overrides from the start command
    if (payload.maxConcurrent !== undefined) {
      this.state.setMaxConcurrent(payload.maxConcurrent);
    }
    if (payload.model !== undefined) {
      this.state.setModel(payload.model);
    }
    if (payload.questId !== undefined) {
      this.state.setQuestId(payload.questId);
    }

    // Reconfigure the scheduler with task IDs if provided
    // (Scheduler uses a config object, so we create a new one)
    const schedConfig: SchedulerConfig = {
      projectRoot: this.projectRoot,
      config: this.config,
      taskIds: payload.taskIds,
      questId: payload.questId,
      maxConcurrent: payload.maxConcurrent,
      model: payload.model,
    };

    // Replace the scheduler with fresh config
    this.scheduler.shutdown();
    this.scheduler = new Scheduler(schedConfig, {
      state: this.state,
      runner: this.runner,
    });
    this.scheduler.start();
  }

  private handleHitlAnswer(payload: CommandMap["cmd:hitl-answer"]): void {
    const agent = this.state.getAgent(payload.featureId);
    if (!agent) return;

    // Remove the answered question from the pending list
    agent.pendingQuestions = agent.pendingQuestions.filter(
      (q) => q.questionId !== payload.questionId
    );

    // Deliver the answer to the agent process by writing an answer file.
    // The agent's hitl-ask script is polling the filesystem for this file.
    try {
      submitAnswer(this.projectRoot, payload.featureId, payload.questionId, payload.answer);
      // Remove from known set so we don't re-detect after hitl-ask cleans up
      this.knownQuestionIds.delete(payload.questionId);
      this.log("info", `HITL answer delivered for ${payload.featureId}`);
    } catch (err: any) {
      this.log("error", `HITL answer delivery failed for ${payload.featureId}: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // HITL question polling
  // -------------------------------------------------------------------------

  /** Poll frequency for filesystem-based HITL question detection (ms). */
  private static readonly HITL_POLL_MS = 3_000;

  /**
   * Start periodic polling of the HITL filesystem channel.
   * The hitl-ask script writes question files; we detect them here and
   * emit evt:hitl-question events for connected clients.
   */
  private startHitlPolling(): void {
    this.hitlPollTimer = setInterval(() => {
      this.pollHitlQuestions();
    }, Daemon.HITL_POLL_MS);
  }

  /** Scan for pending HITL questions and emit events for new ones. */
  private pollHitlQuestions(): void {
    try {
      const pending = getPendingQuestions(this.projectRoot);
      for (const q of pending) {
        // Skip questions we've already seen
        if (this.knownQuestionIds.has(q.id)) continue;

        this.knownQuestionIds.add(q.id);

        // Find the agent this question belongs to
        const agent = this.state.getAgent(q.agentId);
        if (!agent) continue;

        // Add to the agent's pending questions list (if not already there)
        const already = agent.pendingQuestions.some((pq) => pq.questionId === q.id);
        if (!already) {
          agent.pendingQuestions.push({
            questionId: q.id,
            questionText: q.text,
            askedAt: q.timestamp,
          });
        }

        // Emit event to all connected clients
        this.state.emit("evt:hitl-question", {
          featureId: q.agentId,
          questionId: q.id,
          questionText: q.text,
        });
      }
    } catch {
      // Non-fatal — HITL dir may not exist yet
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  private sendSnapshot(client: ConnectedClient): void {
    const snapshot = this.state.getSnapshot();
    snapshot.uptime = Date.now() - this.startedAt;
    this.sendTo(client.clientId, "evt:state-snapshot", snapshot);
  }

  // -------------------------------------------------------------------------
  // Event broadcasting
  // -------------------------------------------------------------------------

  /** State change listener — broadcasts every state event to all connected clients. */
  private onStateEvent: StateListener = (eventType, payload) => {
    this.broadcastRaw(eventType, payload);
    this.resetIdleTimer();
  };

  /** Broadcast a typed event to all connected clients. */
  private broadcast<T extends EventType>(type: T, payload: EventMap[T]): void {
    this.broadcastRaw(type, payload);
  }

  /** Broadcast raw event to all connected clients. */
  private broadcastRaw(type: EventType, payload: unknown): void {
    const seq = ++this.eventSeq;
    const envelope = makeEvent(type as any, payload as any, seq);
    const text = JSON.stringify(envelope);

    for (const client of this.clients.values()) {
      if (!client.handshaked) continue;
      try {
        client.ws.send(text);
      } catch {
        // Client disconnected — will be cleaned up on close
      }
    }
  }

  /** Send a typed event to a specific client. */
  private sendTo<T extends EventType>(
    clientId: string,
    type: T,
    payload: EventMap[T]
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const seq = ++this.eventSeq;
    const envelope = makeEvent(type, payload, seq);
    try {
      client.ws.send(JSON.stringify(envelope));
    } catch {
      // Client disconnected
    }
  }

  // -------------------------------------------------------------------------
  // Idle timeout
  // -------------------------------------------------------------------------

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.idleTimeoutMs <= 0) return;

    // Only start idle timer if no clients and no active agents
    if (this.clients.size > 0) return;
    if (this.state.getActiveAgents().length > 0) return;
    if (this.state.getSchedulerStatus() === "running") return;

    this.idleTimer = setTimeout(() => {
      // Double-check conditions before shutting down
      if (this.clients.size === 0 && this.state.getActiveAgents().length === 0) {
        this.shutdown("Idle timeout");
      }
    }, this.idleTimeoutMs);
  }

  // -------------------------------------------------------------------------
  // PID file
  // -------------------------------------------------------------------------

  private pidFilePath(): string {
    return resolve(this.projectRoot, WOMBO_DIR, PID_FILE);
  }

  private writePidFile(): void {
    const dir = resolve(this.projectRoot, WOMBO_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.pidFilePath(), String(process.pid), "utf-8");
  }

  private removePidFile(): void {
    try {
      unlinkSync(this.pidFilePath());
    } catch {
      // Already removed or never written
    }
  }

  // -------------------------------------------------------------------------
  // Signal handling
  // -------------------------------------------------------------------------

  private registerSignalHandlers(): void {
    process.on("SIGTERM", () => {
      this.shutdown("SIGTERM");
    });

    process.on("SIGINT", () => {
      this.shutdown("SIGINT");
    });

    process.on("uncaughtException", (err) => {
      this.log("error", `Uncaught exception: ${err.message}`);
      this.shutdown("Uncaught exception", true);
    });
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    if (level === "debug" && !this.verbose) return;

    const ts = new Date().toISOString();
    const line = `[${ts}] [daemon] [${level}] ${message}`;

    // Log to stderr (stdout might be piped for JSON output)
    if (level === "error" || level === "warn") {
      process.stderr.write(line + "\n");
    } else if (this.verbose) {
      process.stderr.write(line + "\n");
    }

    // Broadcast log event to clients
    this.broadcastRaw("evt:log", { level, message });
  }

  // -------------------------------------------------------------------------
  // Static helpers
  // -------------------------------------------------------------------------

  /** Check if a daemon is already running for the given project root. */
  static isRunning(projectRoot: string): { running: boolean; pid?: number } {
    // Delegate to standalone utility (avoids needing to import the full
    // Daemon class just for a PID-file check).
    return isDaemonRunning(projectRoot);
  }
}

// ---------------------------------------------------------------------------
// Entry point — when spawned as a child process
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // Parse args from environment or argv
  const projectRoot = process.env.WOMBO_DAEMON_PROJECT_ROOT ?? process.cwd();
  const port = parseInt(process.env.WOMBO_DAEMON_PORT ?? String(DEFAULT_WS_PORT), 10);
  const idleTimeoutMs = parseInt(
    process.env.WOMBO_DAEMON_IDLE_TIMEOUT ?? String(DEFAULT_IDLE_TIMEOUT_MS),
    10
  );
  const verbose = process.env.WOMBO_DAEMON_VERBOSE === "true";

  const daemon = new Daemon({
    projectRoot,
    port,
    idleTimeoutMs,
    verbose,
  });

  daemon.start();
}
