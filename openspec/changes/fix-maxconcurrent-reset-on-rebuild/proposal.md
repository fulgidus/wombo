## Why

When a TUI client sends `cmd:start { questId }`, the daemon's `handleStart()` destroys and recreates the `Scheduler` object. The new instance has `concurrencyPinned = false`, so its `start()` method overwrites the in-memory `maxConcurrent` with `config.defaults.maxConcurrent` (hardcoded `3`). Any concurrency value the user set — including infinite burst mode (`0`) — is silently reset every time a quest is selected or a new wave is started.

## What Changes

- `handleStart()` in `daemon.ts`: when rebuilding the `Scheduler`, carry forward the current `state.maxConcurrent` so the new instance sees it as pre-pinned and does not overwrite it with the config default.
- `Scheduler.start()` / constructor: accept an optional `initialMaxConcurrent` that, when provided, is applied and marks `concurrencyPinned = true` — preventing the config-default path from running.

## Capabilities

### New Capabilities
- `scheduler-concurrency-rebuild-preservation`: When the Scheduler is reconstructed at runtime (e.g. on `cmd:start` with a new questId), the previously active `maxConcurrent` value is preserved in the new instance.

### Modified Capabilities
- `scheduler-concurrency-pinning`: Extend the pinning guarantee to cover Scheduler reconstruction triggered by `handleStart()`, not just `start()` re-triggers from the task-file watcher.

## Impact

- `src/daemon/daemon.ts` — `handleStart()` (~line 479–521): pass current concurrency when rebuilding Scheduler
- `src/daemon/scheduler.ts` — `start()` (~line 84), constructor: honour carried-forward `maxConcurrent`
- `src/daemon/state.ts` — `getMaxConcurrent()` used to read current value before rebuild
- Tests: `tests/daemon-scheduler.test.ts` — add scenarios for concurrency surviving scheduler rebuild
