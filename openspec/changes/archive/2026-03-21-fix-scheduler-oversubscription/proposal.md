## Why

The daemon scheduler allows more concurrent agents than `maxConcurrent` permits. When an agent finishes its work and transitions to `verified` status, the scheduler treats the slot as free and launches a new agent. But the `verified` agent immediately re-enters active work (merge pipeline, potential `resolving_conflict`), reclaiming the slot — resulting in `maxConcurrent + 1` active agents. The root cause is that `verified` is classified as a terminal status (slot freed) when it should be active (slot held) until the merge fully lands.

## What Changes

- Remove `"verified"` from `TERMINAL_STATUSES` in `src/daemon/state.ts`
- Add `"verified"` to `ACTIVE_STATUSES` in `src/daemon/state.ts`
- Update affected unit tests to reflect the corrected slot accounting

## Capabilities

### New Capabilities

- `scheduler-concurrency-accounting`: The scheduler correctly holds a concurrency slot for an agent from initial launch through the full merge pipeline, preventing over-subscription when agents enter the post-build merge/conflict-resolution phase.

### Modified Capabilities

(none — no existing spec files)

## Impact

- `src/daemon/state.ts`: two set literal changes (`TERMINAL_STATUSES`, `ACTIVE_STATUSES`)
- `tests/daemon-state.test.ts`: tests asserting `getActiveAgents()` count and `allComplete()` behaviour with `verified` agents need updating
- `tests/daemon-scheduler.test.ts`: `availableSlots()` tests that use `verified` agents need updating
- Health endpoint `activeAgents` count will now include agents in `verified` state — semantically more accurate (they are in-flight), no interface change needed
- `allComplete()` will no longer return `true` while verified agents await merge — scheduler correctly stays active until merges land
