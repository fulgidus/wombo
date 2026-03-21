## Context

The daemon holds a single `Scheduler` instance. When `handleStart()` receives a `cmd:start` payload containing a `questId` or explicit `taskIds`, it shuts down the current Scheduler and constructs a new one so the fresh instance picks up the correct task filter. The new instance starts with `concurrencyPinned = false`. When `Scheduler.start()` runs, it detects the unpinned state and calls `state.setMaxConcurrent(config.defaults.maxConcurrent)`, overwriting whatever the user had set.

`state.maxConcurrent` is the single source of truth for concurrency at runtime. It persists across `Scheduler.start()` calls within a daemon session (the `concurrencyPinned` flag is only an in-memory guard on the Scheduler object itself). Rebuilding the Scheduler loses the guard.

## Goals / Non-Goals

**Goals:**
- Carry the current `state.maxConcurrent` value into any rebuilt Scheduler so it survives reconstruction
- Ensure `Scheduler.start()` does not re-apply `config.defaults.maxConcurrent` when a prior value was already active

**Non-Goals:**
- Persisting concurrency across daemon restarts (already out of scope per `scheduler-concurrency-pinning` spec)
- Changing how `cmd:set-concurrency` or `cmd:start { maxConcurrent }` payloads are handled (no behaviour change for explicit overrides)
- Refactoring away the Scheduler reconstruction pattern entirely (larger scope, different change)

## Decisions

### D1: Pass `initialMaxConcurrent` in `SchedulerConfig`, not as a constructor argument

Adding it to the existing `SchedulerConfig` struct keeps the call sites clean and consistent (daemon already spreads `schedConfig` from a shared builder). Alternative: a separate `Scheduler.setConcurrency()` call right after construction — this works but is easy to forget, creates a two-step init, and the scheduler could theoretically tick once between construction and the set call.

### D2: Mark `concurrencyPinned = true` when `initialMaxConcurrent` is supplied

When `handleStart()` carries a non-undefined `initialMaxConcurrent`, the scheduler should treat it as a user-established value — same semantics as `cmd:set-concurrency`. This means a subsequent automatic `start()` re-trigger (watcher) won't overwrite it. Rationale: the daemon never passes `initialMaxConcurrent` on a fresh cold-start; it only passes it during reconstruction, so the pinned treatment is always correct in that path.

### D3: Read `state.getMaxConcurrent()` in `handleStart()` before destroying the old Scheduler

The current live value is in `state`, so it survives the `scheduler.shutdown()` call. Reading from state (not from the old scheduler object) avoids a dependency on internal scheduler fields and works even if the scheduler is already idle/null.

## Risks / Trade-offs

- **Risk**: `state.getMaxConcurrent()` could return `undefined` if the daemon never ran a start cycle. → Mitigation: treat `undefined` as "not yet set" and let the new Scheduler apply the config default as normal (no `initialMaxConcurrent` passed).
- **Trade-off**: The fix patches the rebuild path rather than eliminating it. If another code path also reconstructs the Scheduler in future, the same bug could recur. Acceptable for now; a note in design + spec makes it visible.

## Migration Plan

No migration needed. Change is purely in-process daemon memory; no stored state format changes.
