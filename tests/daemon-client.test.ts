/**
 * daemon-client.test.ts -- Unit tests for DaemonClient class.
 *
 * Strategy: Spin up a lightweight Bun WebSocket server in beforeEach, connect
 * the DaemonClient to it, and verify command sending, event handling, and
 * reconnection behavior. Also test internal logic (handlers, state caching)
 * through the public API.
 *
 * Coverage:
 *   - Constructor sets defaults
 *   - connect() resolves after handshake-ack
 *   - sendCommand increments seq, formats envelope
 *   - on() registers per-type handlers, returns unsubscribe
 *   - onAny() registers wildcard handlers
 *   - onStateChange() registers connection state handlers
 *   - handleMessage dispatches to correct handlers
 *   - State snapshot caching via getLastSnapshot()
 *   - disconnect() rejects pending replies
 *   - Convenience methods call sendCommand correctly
 *   - isConnected / getState
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { DaemonClient } from "../src/daemon/client";
import type { ConnectionState } from "../src/daemon/client";
import { makeEvent, PROTOCOL_VERSION, DEFAULT_WS_PORT } from "../src/daemon/protocol";
import type {
  EventType,
  EvtStateSnapshot,
  EvtAgentStatusChange,
  SchedulerState,
} from "../src/daemon/protocol";

// ---------------------------------------------------------------------------
// Lightweight test WebSocket server
// ---------------------------------------------------------------------------

/** Messages received by the server from clients. */
let serverReceived: any[] = [];
/** WebSocket connections held by the server. */
let serverSockets: Set<any> = new Set();
let server: ReturnType<typeof Bun.serve> | null = null;
let testPort: number;

function startTestServer(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const success = server.upgrade(req, { data: {} });
        if (!success) return new Response("Upgrade failed", { status: 400 });
        return new Response(null, { status: 101 });
      }
      return new Response("OK");
    },
    websocket: {
      open(ws: any) {
        serverSockets.add(ws);
      },
      message(ws: any, message: any) {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        const parsed = JSON.parse(text);
        serverReceived.push(parsed);

        // Auto-respond to handshake with handshake-ack
        if (parsed.type === "cmd:handshake") {
          const ack = makeEvent("evt:handshake-ack", {
            protocolVersion: PROTOCOL_VERSION,
            daemonPid: process.pid,
            uptime: 1000,
          }, 1);
          ws.send(JSON.stringify(ack));
        }
      },
      close(ws) {
        serverSockets.delete(ws);
      },
    },
  });
}

/** Send an event from the server to all connected clients. */
function serverBroadcast(type: EventType, payload: any, seq = 1): void {
  const envelope = makeEvent(type, payload, seq);
  const json = JSON.stringify(envelope);
  for (const ws of serverSockets) {
    ws.send(json);
  }
}

// Use a random high port to avoid collisions
function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  serverReceived = [];
  serverSockets = new Set();
  testPort = getRandomPort();
  server = startTestServer(testPort);
});

afterEach(() => {
  if (server) {
    server.stop(true);
    server = null;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(overrides: Record<string, any> = {}): DaemonClient {
  return new DaemonClient({
    clientId: "test",
    port: testPort,
    autoReconnect: false,
    connectTimeoutMs: 3000,
    ...overrides,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("DaemonClient constructor", () => {
  test("sets default options", () => {
    const client = new DaemonClient({ clientId: "test-client" });
    expect(client.getState()).toBe("disconnected");
    expect(client.isConnected()).toBe(false);
    expect(client.getLastSnapshot()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

describe("DaemonClient connection", () => {
  test("connect resolves after handshake-ack", async () => {
    const client = makeClient();
    await client.connect();

    expect(client.isConnected()).toBe(true);
    expect(client.getState()).toBe("connected");

    // Server should have received the handshake command
    await sleep(50);
    const handshakes = serverReceived.filter((m) => m.type === "cmd:handshake");
    expect(handshakes).toHaveLength(1);
    expect(handshakes[0].payload.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(handshakes[0].payload.clientId).toBe("test");

    client.disconnect();
  });

  // The connect() promise now correctly rejects when onclose fires before
  // the handshake completes (the onclose handler calls reject()).
  test("connect rejects if no server responds", async () => {
    const deadPort = getRandomPort();
    const client = new DaemonClient({
      clientId: "test",
      port: deadPort,
      autoReconnect: false,
      connectTimeoutMs: 500,
    });

    await expect(client.connect()).rejects.toThrow();
    client.disconnect();
  });

  test("disconnect sets state to disconnected", async () => {
    const client = makeClient();
    await client.connect();
    expect(client.isConnected()).toBe(true);

    client.disconnect();
    expect(client.isConnected()).toBe(false);
    expect(client.getState()).toBe("disconnected");
  });
});

// ---------------------------------------------------------------------------
// Command sending
// ---------------------------------------------------------------------------

describe("DaemonClient command sending", () => {
  test("sendCommand sends typed envelope", async () => {
    const client = makeClient();
    await client.connect();

    const seq = client.sendCommand("cmd:pause", {});
    expect(seq).toBeGreaterThan(0);

    await sleep(50);
    const pauseMessages = serverReceived.filter((m) => m.type === "cmd:pause");
    expect(pauseMessages).toHaveLength(1);
    expect(pauseMessages[0].seq).toBe(seq);
    expect(pauseMessages[0].ts).toBeDefined();

    client.disconnect();
  });

  test("sendCommand increments seq", async () => {
    const client = makeClient();
    await client.connect();

    const seq1 = client.sendCommand("cmd:pause", {});
    const seq2 = client.sendCommand("cmd:resume", {});
    expect(seq2).toBe(seq1 + 1);

    client.disconnect();
  });

  test("sendCommand throws when not connected", () => {
    const client = makeClient();
    expect(() => client.sendCommand("cmd:pause", {})).toThrow("Not connected");
  });
});

// ---------------------------------------------------------------------------
// Convenience methods
// ---------------------------------------------------------------------------

describe("DaemonClient convenience methods", () => {
  test("start sends cmd:start", async () => {
    const client = makeClient();
    await client.connect();

    client.start({ questId: "q1", maxConcurrent: 2 });
    await sleep(50);

    const msgs = serverReceived.filter((m) => m.type === "cmd:start");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.questId).toBe("q1");
    expect(msgs[0].payload.maxConcurrent).toBe(2);

    client.disconnect();
  });

  test("pause sends cmd:pause", async () => {
    const client = makeClient();
    await client.connect();
    client.pause();
    await sleep(50);
    expect(serverReceived.some((m) => m.type === "cmd:pause")).toBe(true);
    client.disconnect();
  });

  test("resume sends cmd:resume", async () => {
    const client = makeClient();
    await client.connect();
    client.resume();
    await sleep(50);
    expect(serverReceived.some((m) => m.type === "cmd:resume")).toBe(true);
    client.disconnect();
  });

  test("stop sends cmd:stop", async () => {
    const client = makeClient();
    await client.connect();
    client.stop();
    await sleep(50);
    expect(serverReceived.some((m) => m.type === "cmd:stop")).toBe(true);
    client.disconnect();
  });

  test("kill sends cmd:kill", async () => {
    const client = makeClient();
    await client.connect();
    client.kill();
    await sleep(50);
    expect(serverReceived.some((m) => m.type === "cmd:kill")).toBe(true);
    client.disconnect();
  });

  test("pinTask sends cmd:pin-task with taskId", async () => {
    const client = makeClient();
    await client.connect();
    client.pinTask("task-42");
    await sleep(50);
    const msgs = serverReceived.filter((m) => m.type === "cmd:pin-task");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.taskId).toBe("task-42");
    client.disconnect();
  });

  test("skipTask sends cmd:skip-task with taskId", async () => {
    const client = makeClient();
    await client.connect();
    client.skipTask("task-99");
    await sleep(50);
    const msgs = serverReceived.filter((m) => m.type === "cmd:skip-task");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.taskId).toBe("task-99");
    client.disconnect();
  });

  test("retryAgent sends cmd:retry-agent with featureId", async () => {
    const client = makeClient();
    await client.connect();
    client.retryAgent("feat-1");
    await sleep(50);
    const msgs = serverReceived.filter((m) => m.type === "cmd:retry-agent");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.featureId).toBe("feat-1");
    client.disconnect();
  });

  test("cancelAgent sends cmd:cancel-agent with featureId", async () => {
    const client = makeClient();
    await client.connect();
    client.cancelAgent("feat-2");
    await sleep(50);
    const msgs = serverReceived.filter((m) => m.type === "cmd:cancel-agent");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.featureId).toBe("feat-2");
    client.disconnect();
  });

  test("answerHitl sends cmd:hitl-answer", async () => {
    const client = makeClient();
    await client.connect();
    client.answerHitl("feat-1", "q-123", "Yes, proceed");
    await sleep(50);
    const msgs = serverReceived.filter((m) => m.type === "cmd:hitl-answer");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.featureId).toBe("feat-1");
    expect(msgs[0].payload.questionId).toBe("q-123");
    expect(msgs[0].payload.answer).toBe("Yes, proceed");
    client.disconnect();
  });

  test("setConcurrency sends cmd:set-concurrency", async () => {
    const client = makeClient();
    await client.connect();
    client.setConcurrency(8);
    await sleep(50);
    const msgs = serverReceived.filter((m) => m.type === "cmd:set-concurrency");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.maxConcurrent).toBe(8);
    client.disconnect();
  });

  test("shutdownDaemon sends cmd:shutdown", async () => {
    const client = makeClient();
    await client.connect();
    client.shutdownDaemon(true);
    await sleep(50);
    const msgs = serverReceived.filter((m) => m.type === "cmd:shutdown");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload.force).toBe(true);
    client.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Event subscription
// ---------------------------------------------------------------------------

describe("DaemonClient event subscription", () => {
  test("on() receives typed events", async () => {
    const client = makeClient();
    await client.connect();

    const received: any[] = [];
    client.on("evt:agent-status-change", (payload) => {
      received.push(payload);
    });

    // Server broadcasts an agent status change
    serverBroadcast("evt:agent-status-change", {
      featureId: "feat-1",
      previousStatus: "queued",
      newStatus: "running",
      detail: "Launched",
    } as EvtAgentStatusChange);

    await sleep(100);
    expect(received).toHaveLength(1);
    expect(received[0].featureId).toBe("feat-1");
    expect(received[0].newStatus).toBe("running");

    client.disconnect();
  });

  test("on() returns unsubscribe function", async () => {
    const client = makeClient();
    await client.connect();

    const received: any[] = [];
    const unsub = client.on("evt:agent-activity", (payload) => {
      received.push(payload);
    });

    serverBroadcast("evt:agent-activity", {
      featureId: "feat-1",
      activity: "first",
    });
    await sleep(100);
    expect(received).toHaveLength(1);

    unsub();

    serverBroadcast("evt:agent-activity", {
      featureId: "feat-1",
      activity: "second",
    });
    await sleep(100);
    // Should NOT have received the second event
    expect(received).toHaveLength(1);

    client.disconnect();
  });

  test("onAny() receives all events", async () => {
    const client = makeClient();
    await client.connect();

    const received: Array<{ type: EventType; payload: unknown }> = [];
    client.onAny((type, payload) => {
      received.push({ type, payload });
    });

    serverBroadcast("evt:log", {
      level: "info",
      message: "hello",
    });
    await sleep(100);

    // Should have received the handshake-ack (from connect) AND the log event
    expect(received.length).toBeGreaterThanOrEqual(1);
    const logEvents = received.filter((r) => r.type === "evt:log");
    expect(logEvents).toHaveLength(1);

    client.disconnect();
  });

  test("onAny() returns unsubscribe function", async () => {
    const client = makeClient();
    await client.connect();

    const received: any[] = [];
    const unsub = client.onAny((type) => {
      received.push(type);
    });

    unsub();

    serverBroadcast("evt:log", { level: "info", message: "test" });
    await sleep(100);

    // Should not have received anything after unsubscribe
    // (may have received handshake-ack before unsub though)
    const logEvents = received.filter((t) => t === "evt:log");
    expect(logEvents).toHaveLength(0);

    client.disconnect();
  });

  test("onStateChange() fires on connection state changes", async () => {
    const client = makeClient();
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push(s));

    await client.connect();
    // Should have gone through connecting -> connected
    expect(states).toContain("connecting");
    expect(states).toContain("connected");

    client.disconnect();
    expect(states).toContain("disconnected");
  });

  test("onStateChange() returns unsubscribe function", async () => {
    const client = makeClient();
    const states: ConnectionState[] = [];
    const unsub = client.onStateChange((s) => states.push(s));
    unsub();

    await client.connect();
    // Should not have captured any states
    expect(states).toHaveLength(0);

    client.disconnect();
  });
});

// ---------------------------------------------------------------------------
// State snapshot caching
// ---------------------------------------------------------------------------

describe("DaemonClient state snapshot caching", () => {
  test("caches state snapshots", async () => {
    const client = makeClient();
    await client.connect();

    expect(client.getLastSnapshot()).toBeNull();

    const snapshot: EvtStateSnapshot = {
      scheduler: {
        status: "running",
        maxConcurrent: 4,
        model: null,
        baseBranch: "main",
        questId: null,
        startedAt: null,
        pinnedTasks: [],
        skippedTasks: [],
        totalProcessed: 0,
        totalCompleted: 0,
        totalFailed: 0,
      },
      agents: [],
      uptime: 5000,
    };

    serverBroadcast("evt:state-snapshot", snapshot);
    await sleep(100);

    const cached = client.getLastSnapshot();
    expect(cached).not.toBeNull();
    expect(cached!.scheduler.status).toBe("running");
    expect(cached!.uptime).toBe(5000);

    client.disconnect();
  });
});

// ---------------------------------------------------------------------------
// requestState
// ---------------------------------------------------------------------------

describe("DaemonClient requestState", () => {
  test("requestState resolves with snapshot", async () => {
    const client = makeClient();
    await client.connect();

    const snapshot: EvtStateSnapshot = {
      scheduler: {
        status: "idle",
        maxConcurrent: 2,
        model: "gpt-4o",
        baseBranch: "main",
        questId: null,
        startedAt: null,
        pinnedTasks: [],
        skippedTasks: [],
        totalProcessed: 5,
        totalCompleted: 3,
        totalFailed: 1,
      },
      agents: [],
      uptime: 10000,
    };

    // The server needs to respond to cmd:get-state with a snapshot.
    // Our test server doesn't auto-respond to get-state, so we broadcast
    // the snapshot shortly after.
    const promise = client.requestState(3000);
    await sleep(50);
    serverBroadcast("evt:state-snapshot", snapshot);

    const result = await promise;
    expect(result.scheduler.status).toBe("idle");
    expect(result.scheduler.model).toBe("gpt-4o");
    expect(result.uptime).toBe(10000);

    client.disconnect();
  });

  test("requestState times out if no snapshot arrives", async () => {
    const client = makeClient();
    await client.connect();

    try {
      await client.requestState(200); // very short timeout
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain("timed out");
    }

    client.disconnect();
  });
});

// ---------------------------------------------------------------------------
// disconnect rejects pending replies
// ---------------------------------------------------------------------------

describe("DaemonClient disconnect behavior", () => {
  test("disconnect rejects pending requestState promises", async () => {
    const client = makeClient();
    await client.connect();

    const promise = client.requestState(5000);
    // Immediately disconnect
    client.disconnect();

    try {
      await promise;
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain("disconnected");
    }
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("DaemonClient error resilience", () => {
  test("bad handler does not break event dispatch", async () => {
    const client = makeClient();
    await client.connect();

    const received: any[] = [];
    // First handler throws
    client.on("evt:log", () => {
      throw new Error("bad handler");
    });
    // Second handler should still fire
    client.on("evt:log", (payload) => {
      received.push(payload);
    });

    serverBroadcast("evt:log", { level: "info", message: "test" });
    await sleep(100);

    expect(received).toHaveLength(1);
    expect(received[0].message).toBe("test");

    client.disconnect();
  });
});
