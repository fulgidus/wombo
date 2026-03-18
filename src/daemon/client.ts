/**
 * client.ts -- WebSocket client library for connecting to the daemon.
 *
 * Used by CLI commands and the TUI to communicate with the daemon process.
 * Provides:
 * - Automatic connect/reconnect with backoff
 * - Typed command sending with sequence tracking
 * - Event subscription by type
 * - Connection state management
 * - Promise-based command/response pattern for request-reply commands
 */

import {
  DEFAULT_WS_PORT,
  PROTOCOL_VERSION,
  makeCommand,
  parseMessage,
} from "./protocol";
import type {
  CommandType,
  CommandMap,
  EventType,
  EventMap,
  EventMessage,
  EvtStateSnapshot,
} from "./protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export type EventHandler<T extends EventType = EventType> = (payload: EventMap[T]) => void;

export interface DaemonClientOptions {
  /** WebSocket port. Defaults to DEFAULT_WS_PORT (19420). */
  port?: number;
  /** Host. Defaults to localhost. */
  host?: string;
  /** Client identifier (e.g. "tui", "cli"). */
  clientId: string;
  /** Whether to automatically reconnect on disconnect. Defaults to true. */
  autoReconnect?: boolean;
  /** Max reconnect attempts. 0 = infinite. Defaults to 10. */
  maxReconnectAttempts?: number;
  /** Base reconnect delay in ms. Defaults to 500. */
  reconnectDelayMs?: number;
  /** Max reconnect delay in ms (caps exponential backoff). Defaults to 10000. */
  maxReconnectDelayMs?: number;
  /** Connection timeout in ms. Defaults to 5000. */
  connectTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// DaemonClient
// ---------------------------------------------------------------------------

export class DaemonClient {
  private opts: Required<DaemonClientOptions>;
  private ws: WebSocket | null = null;
  private commandSeq = 0;
  private state: ConnectionState = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Per-event-type handlers. */
  private handlers: Map<EventType, Set<EventHandler<any>>> = new Map();
  /** Wildcard handlers — receive all events. */
  private wildcardHandlers: Set<(type: EventType, payload: unknown) => void> = new Set();
  /** Connection state change handlers. */
  private stateHandlers: Set<(state: ConnectionState) => void> = new Set();
  /** One-shot resolve callbacks keyed by expected event type + seq. */
  private pendingReplies: Map<string, { resolve: (payload: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();

  /** Cached latest state snapshot. */
  private _lastSnapshot: EvtStateSnapshot | null = null;

  constructor(opts: DaemonClientOptions) {
    this.opts = {
      port: opts.port ?? DEFAULT_WS_PORT,
      host: opts.host ?? "localhost",
      clientId: opts.clientId,
      autoReconnect: opts.autoReconnect ?? true,
      maxReconnectAttempts: opts.maxReconnectAttempts ?? 10,
      reconnectDelayMs: opts.reconnectDelayMs ?? 500,
      maxReconnectDelayMs: opts.maxReconnectDelayMs ?? 10000,
      connectTimeoutMs: opts.connectTimeoutMs ?? 5000,
    };
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /** Connect to the daemon. Returns a promise that resolves on successful handshake. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state === "connected") {
        resolve();
        return;
      }

      this.connectResolved = false;
      this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

      const url = `ws://${this.opts.host}:${this.opts.port}/ws`;

      // Connection timeout
      const timeoutTimer = setTimeout(() => {
        reject(new Error(`Connection timeout after ${this.opts.connectTimeoutMs}ms`));
        this.ws?.close();
      }, this.opts.connectTimeoutMs);

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        clearTimeout(timeoutTimer);
        this.setState("disconnected");
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.ws.onopen = () => {
        clearTimeout(timeoutTimer);
        this.reconnectAttempts = 0;

        // Send handshake
        this.sendCommand("cmd:handshake", {
          protocolVersion: PROTOCOL_VERSION,
          clientId: this.opts.clientId,
        });
      };

      this.ws.onmessage = (event: MessageEvent) => {
        const text = typeof event.data === "string" ? event.data : String(event.data);
        this.handleMessage(text, resolve);
      };

      this.ws.onclose = () => {
        this.ws = null;
        const wasConnected = this.state === "connected";
        this.setState("disconnected");

        clearTimeout(timeoutTimer);

        if (wasConnected && this.opts.autoReconnect) {
          this.scheduleReconnect();
        } else if (!this.connectResolved) {
          // Connection closed before handshake completed — reject the
          // connect() promise so the caller doesn't hang indefinitely.
          reject(new Error("Connection closed before handshake completed"));
        }
      };

      this.ws.onerror = () => {
        // Error is handled by onclose
      };
    });
  }

  /** Disconnect from the daemon. */
  disconnect(): void {
    this.cancelReconnect();
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this.setState("disconnected");

    // Reject all pending replies
    for (const [key, pending] of this.pendingReplies) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Client disconnected"));
    }
    this.pendingReplies.clear();
  }

  /** Get current connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Whether the client is currently connected and handshaked. */
  isConnected(): boolean {
    return this.state === "connected";
  }

  /** Get the last received state snapshot (if any). */
  getLastSnapshot(): EvtStateSnapshot | null {
    return this._lastSnapshot;
  }

  // -------------------------------------------------------------------------
  // Command sending
  // -------------------------------------------------------------------------

  /** Send a command to the daemon. */
  sendCommand<T extends CommandType>(type: T, payload: CommandMap[T]): number {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to daemon");
    }

    const seq = ++this.commandSeq;
    const envelope = makeCommand(type, payload, seq);
    this.ws.send(JSON.stringify(envelope));
    return seq;
  }

  // -------------------------------------------------------------------------
  // Convenience command methods
  // -------------------------------------------------------------------------

  /** Start the scheduler. */
  start(opts?: CommandMap["cmd:start"]): number {
    return this.sendCommand("cmd:start", opts ?? {});
  }

  /** Pause the scheduler. */
  pause(): number {
    return this.sendCommand("cmd:pause", {});
  }

  /** Resume the scheduler. */
  resume(): number {
    return this.sendCommand("cmd:resume", {});
  }

  /** Stop the scheduler (graceful). */
  stop(): number {
    return this.sendCommand("cmd:stop", {});
  }

  /** Kill all agents (force). */
  kill(): number {
    return this.sendCommand("cmd:kill", {});
  }

  /** Pin a task. */
  pinTask(taskId: string): number {
    return this.sendCommand("cmd:pin-task", { taskId });
  }

  /** Skip a task. */
  skipTask(taskId: string): number {
    return this.sendCommand("cmd:skip-task", { taskId });
  }

  /** Retry a failed agent. */
  retryAgent(featureId: string): number {
    return this.sendCommand("cmd:retry-agent", { featureId });
  }

  /** Cancel an agent. */
  cancelAgent(featureId: string): number {
    return this.sendCommand("cmd:cancel-agent", { featureId });
  }

  /** Answer a HITL question. */
  answerHitl(featureId: string, questionId: string, answer: string): number {
    return this.sendCommand("cmd:hitl-answer", { featureId, questionId, answer });
  }

  /** Request a state snapshot. Returns the snapshot via promise. */
  async requestState(timeoutMs = 5000): Promise<EvtStateSnapshot> {
    return new Promise((resolve, reject) => {
      const key = `snapshot-${Date.now()}`;
      const timer = setTimeout(() => {
        this.pendingReplies.delete(key);
        reject(new Error("State request timed out"));
      }, timeoutMs);

      this.pendingReplies.set(key, { resolve, reject, timer });

      // Also register a one-shot handler for the snapshot
      const unsub = this.on("evt:state-snapshot", (payload) => {
        const pending = this.pendingReplies.get(key);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingReplies.delete(key);
          pending.resolve(payload);
        }
        unsub();
      });

      this.sendCommand("cmd:get-state", {});
    });
  }

  /** Set concurrency. */
  setConcurrency(maxConcurrent: number): number {
    return this.sendCommand("cmd:set-concurrency", { maxConcurrent });
  }

  /** Request daemon shutdown. */
  shutdownDaemon(force = false): number {
    return this.sendCommand("cmd:shutdown", { force });
  }

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  on<T extends EventType>(type: T, handler: EventHandler<T>): () => void {
    let handlers = this.handlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(type, handlers);
    }
    handlers.add(handler);
    return () => handlers!.delete(handler);
  }

  /** Subscribe to all events. Returns an unsubscribe function. */
  onAny(handler: (type: EventType, payload: unknown) => void): () => void {
    this.wildcardHandlers.add(handler);
    return () => this.wildcardHandlers.delete(handler);
  }

  /** Subscribe to connection state changes. Returns an unsubscribe function. */
  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  // -------------------------------------------------------------------------
  // Internal message handling
  // -------------------------------------------------------------------------

  /** Whether the initial connect() promise has been resolved. */
  private connectResolved = false;

  private handleMessage(text: string, connectResolve?: (value: void) => void): void {
    const msg = parseMessage(text);
    if (!msg) return;

    const type = msg.type as EventType;
    const payload = msg.payload;

    // Handle handshake-ack — completes the connect() promise
    if (type === "evt:handshake-ack" && connectResolve && !this.connectResolved) {
      this.connectResolved = true;
      this.setState("connected");
      connectResolve();
    }

    // Cache state snapshots
    if (type === "evt:state-snapshot") {
      this._lastSnapshot = payload as EvtStateSnapshot;
    }

    // Fire typed handlers
    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch {
          // Don't let a bad handler break the client
        }
      }
    }

    // Fire wildcard handlers
    for (const handler of this.wildcardHandlers) {
      try {
        handler(type, payload);
      } catch {
        // Don't let a bad handler break the client
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (!this.opts.autoReconnect) return;
    if (this.opts.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.opts.maxReconnectAttempts) {
      return; // Give up
    }

    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const delay = Math.min(
      this.opts.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      this.opts.maxReconnectDelayMs
    );
    const jitter = delay * 0.1 * Math.random();

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectResolved = false;
      this.connect().catch(() => {
        // Reconnect failed — onclose will trigger another attempt
      });
    }, delay + jitter);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  private setState(newState: ConnectionState): void {
    if (this.state === newState) return;
    this.state = newState;
    for (const handler of this.stateHandlers) {
      try {
        handler(newState);
      } catch {
        // Don't let a bad handler break the client
      }
    }
  }
}
