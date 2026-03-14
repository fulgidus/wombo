/**
 * token-collector.ts — Parse and collect token usage data from agent events.
 *
 * Responsibilities:
 *   - Define the UsageRecord type for structured token usage data
 *   - Parse step_finish events to extract per-step token counts
 *   - Accumulate usage records per agent (task_id)
 *   - Emit parsed records via callback (storage is handled elsewhere)
 *
 * OpenCode emits step_finish events with this token structure:
 *   {
 *     type: "step_finish",
 *     part: {
 *       reason: "tool-calls" | "stop",
 *       cost: number,
 *       tokens: {
 *         total: number,
 *         input: number,
 *         output: number,
 *         reasoning: number,
 *         cache: { read: number, write: number }
 *       }
 *     }
 *   }
 */

import type { OpenCodeEvent } from "./monitor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single token usage record extracted from an agent's step_finish event.
 *
 * Each record represents one step's token consumption. Multiple records
 * are emitted per agent session (one per step_finish event).
 */
export interface UsageRecord {
  /** The task/feature ID this usage belongs to */
  task_id: string;
  /** Optional quest ID if the agent is working within a quest */
  quest_id: string | null;
  /** Model identifier (e.g. "claude-sonnet-4-20250514") — from launch context */
  model: string | null;
  /** Provider name (e.g. "anthropic", "openai") — from launch context */
  provider: string | null;
  /** Agent harness name (e.g. "opencode") — from launch context */
  harness: string | null;
  /** Input tokens consumed in this step */
  input_tokens: number;
  /** Output tokens generated in this step */
  output_tokens: number;
  /** Tokens read from cache in this step */
  cache_read: number;
  /** Tokens written to cache in this step */
  cache_write: number;
  /** Reasoning tokens used in this step (e.g. for o1-style models) */
  reasoning_tokens: number;
  /** Total tokens for this step (input + output + reasoning) */
  total_tokens: number;
  /** Cost reported by the agent harness (may be 0 if not available) */
  cost: number;
  /** Whether this was the final step (reason === "stop") */
  is_final_step: boolean;
  /** ISO 8601 timestamp when this usage was recorded */
  timestamp: string;
}

/**
 * Aggregated usage summary for a single agent session.
 */
export interface UsageSummary {
  /** The task/feature ID */
  task_id: string;
  /** Total input tokens across all steps */
  total_input: number;
  /** Total output tokens across all steps */
  total_output: number;
  /** Total cache read tokens across all steps */
  total_cache_read: number;
  /** Total cache write tokens across all steps */
  total_cache_write: number;
  /** Total reasoning tokens across all steps */
  total_reasoning: number;
  /** Grand total tokens across all steps */
  total_tokens: number;
  /** Total cost across all steps */
  total_cost: number;
  /** Number of steps recorded */
  step_count: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Check if an OpenCode event is a step_finish with token data.
 */
export function isTokenEvent(event: OpenCodeEvent): boolean {
  return (
    event.type === "step_finish" &&
    event.part?.tokens != null &&
    typeof event.part.tokens.input === "number"
  );
}

/**
 * Extract a UsageRecord from a step_finish event.
 *
 * Returns null if the event doesn't contain valid token data.
 *
 * @param event     The OpenCode JSON event (must be type "step_finish")
 * @param taskId    The task/feature ID this agent is working on
 * @param context   Optional context from the launch environment
 */
export function parseUsageFromEvent(
  event: OpenCodeEvent,
  taskId: string,
  context?: {
    quest_id?: string | null;
    model?: string | null;
    provider?: string | null;
    harness?: string | null;
  }
): UsageRecord | null {
  if (!isTokenEvent(event)) return null;

  const tokens = event.part!.tokens!;
  const cache = tokens.cache ?? { read: 0, write: 0 };

  return {
    task_id: taskId,
    quest_id: context?.quest_id ?? null,
    model: context?.model ?? null,
    provider: context?.provider ?? null,
    harness: context?.harness ?? "opencode",
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cache_read: cache.read,
    cache_write: cache.write,
    reasoning_tokens: tokens.reasoning ?? 0,
    total_tokens: tokens.total,
    cost: event.part?.cost ?? 0,
    is_final_step: event.part?.reason === "stop",
    timestamp: new Date(event.timestamp ?? Date.now()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/** Callback invoked when a new usage record is parsed */
export type UsageCallback = (record: UsageRecord) => void;

/**
 * TokenCollector accumulates usage records for multiple agents.
 *
 * Usage:
 *   const collector = new TokenCollector((record) => {
 *     console.log("Usage:", record);
 *   });
 *
 *   // Register context for an agent before it starts
 *   collector.registerAgent("my-feature", {
 *     quest_id: "quest-1",
 *     model: "claude-sonnet-4-20250514",
 *   });
 *
 *   // Feed events as they arrive
 *   collector.ingestEvent("my-feature", event);
 *
 *   // Get aggregated summary
 *   const summary = collector.getSummary("my-feature");
 */
export class TokenCollector {
  /** Per-agent usage records */
  private records: Map<string, UsageRecord[]> = new Map();

  /** Per-agent context (model, provider, quest, etc.) */
  private contexts: Map<
    string,
    {
      quest_id?: string | null;
      model?: string | null;
      provider?: string | null;
      harness?: string | null;
    }
  > = new Map();

  /** Callback invoked for each new usage record */
  private onUsage: UsageCallback | null;

  constructor(onUsage?: UsageCallback) {
    this.onUsage = onUsage ?? null;
  }

  /**
   * Register context for an agent before events start flowing.
   * This context (model, provider, quest_id) is attached to every
   * UsageRecord emitted for this agent.
   */
  registerAgent(
    taskId: string,
    context?: {
      quest_id?: string | null;
      model?: string | null;
      provider?: string | null;
      harness?: string | null;
    }
  ): void {
    this.contexts.set(taskId, context ?? {});
    if (!this.records.has(taskId)) {
      this.records.set(taskId, []);
    }
  }

  /**
   * Feed an OpenCode event for a specific agent.
   * If the event is a step_finish with token data, a UsageRecord
   * is created and the onUsage callback is invoked.
   *
   * @returns The parsed UsageRecord, or null if the event had no token data
   */
  ingestEvent(taskId: string, event: OpenCodeEvent): UsageRecord | null {
    if (!isTokenEvent(event)) return null;

    const context = this.contexts.get(taskId);
    const record = parseUsageFromEvent(event, taskId, context);
    if (!record) return null;

    if (!this.records.has(taskId)) {
      this.records.set(taskId, []);
    }
    this.records.get(taskId)!.push(record);

    this.onUsage?.(record);

    return record;
  }

  /**
   * Get all usage records for an agent.
   */
  getRecords(taskId: string): UsageRecord[] {
    return this.records.get(taskId) ?? [];
  }

  /**
   * Get all usage records across all agents.
   */
  getAllRecords(): UsageRecord[] {
    const all: UsageRecord[] = [];
    for (const records of this.records.values()) {
      all.push(...records);
    }
    return all;
  }

  /**
   * Get an aggregated usage summary for an agent.
   * Returns null if no records exist for the agent.
   */
  getSummary(taskId: string): UsageSummary | null {
    const records = this.records.get(taskId);
    if (!records || records.length === 0) return null;

    return {
      task_id: taskId,
      total_input: records.reduce((sum, r) => sum + r.input_tokens, 0),
      total_output: records.reduce((sum, r) => sum + r.output_tokens, 0),
      total_cache_read: records.reduce((sum, r) => sum + r.cache_read, 0),
      total_cache_write: records.reduce((sum, r) => sum + r.cache_write, 0),
      total_reasoning: records.reduce((sum, r) => sum + r.reasoning_tokens, 0),
      total_tokens: records.reduce((sum, r) => sum + r.total_tokens, 0),
      total_cost: records.reduce((sum, r) => sum + r.cost, 0),
      step_count: records.length,
    };
  }

  /**
   * Get aggregated summaries for all tracked agents.
   */
  getAllSummaries(): UsageSummary[] {
    const summaries: UsageSummary[] = [];
    for (const taskId of this.records.keys()) {
      const summary = this.getSummary(taskId);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  /**
   * Remove all records for an agent (e.g. after archiving).
   */
  clear(taskId: string): void {
    this.records.delete(taskId);
    this.contexts.delete(taskId);
  }

  /**
   * Remove all records for all agents.
   */
  clearAll(): void {
    this.records.clear();
    this.contexts.clear();
  }
}
