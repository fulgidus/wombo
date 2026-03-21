## Why

Two separate scheduler bugs cause: (1) dep-free tasks to not all launch at once even at infinite concurrency, and (2) the `maxConcurrent` value to silently reset to the config default whenever `Scheduler.start()` is re-invoked — which happens automatically on task-file changes when the scheduler is idle, and on every TUI connect when the scheduler was stopped.

## What Changes

- `Scheduler.start()` will no longer unconditionally overwrite `maxConcurrent` with the config value; it will only apply the config value if no value has been set during the current daemon session (i.e., on first start, not on restarts/re-triggers).
- The scheduler tick will submit **all** dep-free candidate tasks in a single pass when `maxConcurrent=0` (infinite), rather than being gated by a slot calculation that was designed for finite concurrency.
- `availableSlots()` will correctly return `MAX_SAFE_INTEGER` for `maxConcurrent=0` regardless of queued-ready agent count.

## Capabilities

### New Capabilities

- `scheduler-concurrency-pinning`: The runtime `maxConcurrent` value, once set (via `cmd:set-concurrency`, `cmd:start` with explicit payload, or first `scheduler.start()`), is **pinned** for the lifetime of the daemon process. Subsequent `scheduler.start()` re-invocations (from task-file watchers, idle restart, etc.) do not silently overwrite it.
- `infinite-concurrency-burst`: When `maxConcurrent=0`, all dep-free tasks are submitted and queued in a single tick pass (no slot gating), so they can be launched on the immediately following tick — the entire ready frontier springs to life within one tick interval.

### Modified Capabilities

<!-- none — no existing specs to delta -->

## Impact

- `src/daemon/scheduler.ts`: `start()` method concurrency-apply logic; tick loop `slotsForNew` calculation for `maxConcurrent=0`
- `src/daemon/state.ts`: `availableSlots()` already handles `maxConcurrent=0` correctly; no change needed there
- `tests/daemon-scheduler.test.ts`: new tests for concurrency pinning and infinite-burst behaviour
