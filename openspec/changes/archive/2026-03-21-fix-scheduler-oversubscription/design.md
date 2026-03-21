## Context

The daemon scheduler (`src/daemon/scheduler.ts`) enforces concurrency via `maxConcurrent`. It tracks which agents are "active" (consuming a slot) using `ACTIVE_STATUSES = { installing, running, resolving_conflict }` in `src/daemon/state.ts`.

When an agent finishes and transitions `running → completed → verified`, it exits `ACTIVE_STATUSES`. The scheduler sees a free slot and launches a new agent. However, `verified` immediately feeds into the merge pipeline — which can transition the agent to `resolving_conflict` (back into `ACTIVE_STATUSES`). The slot was freed and then reclaimed, resulting in `maxConcurrent + 1` active agents.

The secondary effect: `verified` is in `TERMINAL_STATUSES`, so `allComplete()` returns `true` while verified agents are still pending merge. This causes the scheduler to go idle and stop its tick loop. If a merge fails and the agent retries as `queued`, no tick ever fires to re-launch it — the agent is permanently stranded.

**Status set membership (current):**

| Status             | ACTIVE | TERMINAL | DEP_SATISFIED |
|--------------------|--------|----------|---------------|
| queued             |        |          |               |
| installing         | ✓      |          |               |
| running            | ✓      |          |               |
| resolving_conflict | ✓      |          |               |
| completed          |        | ✓        |               |
| verified           |        | ✓        | ✓             |
| retry              |        |          |               |
| failed             |        | ✓        |               |
| merged             |        | ✓        | ✓             |

## Goals / Non-Goals

**Goals:**
- `maxConcurrent` is never exceeded, including during the post-build merge pipeline
- Scheduler does not go idle while verified agents have pending merge work
- Retry after merge failure is picked up correctly by the tick loop
- `DEP_SATISFIED_STATUSES` is unchanged — downstream unblocking is unaffected

**Non-Goals:**
- Changing the scheduler's tick interval or prioritization logic
- Adding new concurrency controls or backpressure mechanisms
- Altering how `resolving_conflict` is counted (it is already correct)

## Decisions

### Decision: Add `verified` to `ACTIVE_STATUSES`, remove from `TERMINAL_STATUSES`

**Choice:** Move `verified` from `TERMINAL_STATUSES` to `ACTIVE_STATUSES`. Keep it in `DEP_SATISFIED_STATUSES` unchanged.

**Rationale:**
- `verified` agents are in-flight: they have work remaining (merge, potential conflict resolution). Holding their slot until `merged` or `failed` is semantically correct.
- Removing from `TERMINAL_STATUSES` means `allComplete()` waits for merges to land before declaring the scheduler idle, preventing the retry-stranding bug.
- `DEP_SATISFIED_STATUSES` stays unchanged: downstream tasks should still unblock when a dep reaches `verified` (the feature work is done, merge is a formality).

**Alternatives considered:**
- Add `verified` to `ACTIVE_STATUSES` but keep in `TERMINAL_STATUSES`: `allComplete()` would still return true prematurely, leaving the retry-stranding bug intact.
- Keep `verified` in `TERMINAL_STATUSES`, add a special case in `allComplete()` to exclude verified agents: more complex, same effect, less principled.
- Add `verified` to `ACTIVE_STATUSES` only: same problem as first alternative.

**Resulting status set membership (after fix):**

| Status             | ACTIVE | TERMINAL | DEP_SATISFIED |
|--------------------|--------|----------|---------------|
| queued             |        |          |               |
| installing         | ✓      |          |               |
| running            | ✓      |          |               |
| resolving_conflict | ✓      |          |               |
| completed          |        | ✓        |               |
| verified           | ✓      |          | ✓             |  ← changed
| retry              |        |          |               |
| failed             |        | ✓        |               |
| merged             |        | ✓        | ✓             |

## Risks / Trade-offs

- **[Risk] Health endpoint `activeAgents` count increases** → Mitigation: this is more accurate behaviour. A verified agent awaiting merge IS active. No interface change needed; consumers should treat this as a correctness improvement.
- **[Risk] Throughput reduction if many agents pile up in `verified`** → Mitigation: the merge pipeline is fast (seconds). The window where a slot is held in `verified` is short. The previous behaviour was incorrect, not fast — oversubscription has its own throughput costs (resource contention, git lock races).
- **[Risk] Tests asserting `getActiveAgents()` or `allComplete()` with `verified` agents fail** → Mitigation: update tests as part of this change. The old assertions encoded the wrong behaviour.

## Migration Plan

No migration needed. The change is a two-line edit to constant definitions in `state.ts`. No persisted state format changes. Existing `daemon-state.json` files with agents in `verified` status will be handled correctly on the next daemon start (the merge reconciliation path already handles this).
