## Context

The `AgentRunner` in `src/daemon/agent-runner.ts` serializes all agent launches through a single `launchQueue`. Between each launch it waits `LAUNCH_STAGGER_MS` (250ms) to prevent concurrent SQLite session database initialization races in the opencode/claude agent binary. This stagger is correct for real agents but is wasteful for fake-agent tasks, which spawn a deterministic `bun` script (`fake-agent-runner.ts`) that never touches SQLite.

When a user presses "A" in the TUI to bulk-plan 10+ tasks from a quest and then starts the wave with `maxConcurrent=0` (infinite concurrency), the visible effect is that agents appear one at a time in the monitor at 250ms intervals rather than all at once. For 20 fake tasks this is a 4.75s serial startup sequence before any meaningful parallelism is visible.

A secondary inefficiency exists in `handleToggleAll` (`src/ink/run-task-browser.tsx`): it calls `saveTaskToStore` once per task, which reads and rewrites `_meta.yml` on every iteration. `saveAllTasksToStore` already exists in `task-store.ts` and performs the same work with a single `_meta.yml` write.

## Goals / Non-Goals

**Goals:**
- Fake-agent tasks submitted in the same scheduler tick all begin their `doLaunch` pipelines concurrently, with no inter-launch stagger delay between them.
- Real-agent launches continue to be staggered at 250ms to protect SQLite session DB initialization.
- `handleToggleAll` batches all task writes into a single `saveAllTasksToStore` call, eliminating N redundant `_meta.yml` rewrites.

**Non-Goals:**
- Changing the stagger value for real agents.
- Eliminating the stagger queue architecture entirely.
- Parallelizing the git worktree creation steps themselves (they already run concurrently via fire-and-forget).
- Addressing dependency-blocked task wave latency (3s tick interval between dep-unblocked waves — a separate concern).

## Decisions

### Decision 1: Skip stagger for fake agents at the queue-processing level

**Choice:** In `processLaunchQueue`, instead of a flat 250ms pause between every launch, each item in the queue carries a `skipStagger: boolean` flag. When the flag is set, the timeout between that item and the next is 0ms (or the `await` is omitted entirely).

**Alternative considered:** A separate `enqueueFastLaunch` method that bypasses the queue entirely and calls `doLaunch` directly. Rejected because it duplicates the re-entrancy protection logic and makes the concurrency accounting harder to reason about.

**Alternative considered:** Detecting `isFake` inside `processLaunchQueue` by checking the in-flight agent's `agentName`. Rejected because it adds a state lookup in the hot path and couples the queue processor to domain knowledge. Passing the flag at enqueue time is cleaner.

**Implementation:** `enqueueLaunch(fn, skipStagger?: boolean)` — the optional flag defaults to `false`. `submitTask` passes `agent.agentName === FAKE_AGENT_SENTINEL`. `processLaunchQueue` stores `{ fn, skipStagger }` tuples.

### Decision 2: Batch task writes in `handleToggleAll`

**Choice:** Replace the `for` loop that calls `saveTaskToStore` per task with a single `saveAllTasksToStore` call that writes all modified tasks plus one `_meta.yml` in a single pass.

**Risk:** `saveAllTasksToStore` also deletes orphaned task files (tasks present on disk but missing from the provided list). We must pass the complete current task set — not just the toggled subset — to avoid unintentional deletions.

**Implementation:** Load the full tasks data via `loadAllTasksFromStore`, mutate the toggled tasks' statuses in memory, then call `saveAllTasksToStore` with the complete updated set.

## Risks / Trade-offs

- **[Risk] `saveAllTasksToStore` deletes orphaned files** → Pass the complete task list, not just the toggled subset. Add a unit test to confirm no unintended deletions.
- **[Risk] Zero-stagger fake launches overwhelm the filesystem** → `git worktree add` serializes on the `.git` lock internally; N concurrent calls will queue at the OS level. This is already the behavior for worktrees created after the stagger window closes, so no new risk is introduced.
- **[Trade-off] Slightly more complex queue item type** → Tuples `{ fn, skipStagger }` instead of plain functions. Small complexity cost, isolated to `agent-runner.ts`.

## Migration Plan

Both changes are purely additive / behavioral. No migration required. No config changes. The stagger remains unchanged for all real-agent workflows.
