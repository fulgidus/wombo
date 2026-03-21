## 1. Fix Status Set Membership in state.ts

- [x] 1.1 In `src/daemon/state.ts`, remove `"verified"` from the `TERMINAL_STATUSES` set
- [x] 1.2 In `src/daemon/state.ts`, add `"verified"` to the `ACTIVE_STATUSES` set
- [x] 1.3 Confirm `DEP_SATISFIED_STATUSES` still contains `"verified"` (no change needed — verify only)

## 2. Update Unit Tests

- [x] 2.1 In `tests/daemon-state.test.ts`, update the `"getActiveAgents returns only agents in active statuses"` test to include a `verified` agent and assert it appears in `getActiveAgents()`
- [x] 2.2 In `tests/daemon-state.test.ts`, update or add a test asserting `allComplete()` returns `false` when an agent is in `verified` status
- [x] 2.3 In `tests/daemon-state.test.ts`, update `"availableSlots reflects concurrency minus active and queued-ready"` (and related tests) to account for `verified` agents consuming a slot
- [x] 2.4 In `tests/daemon-scheduler.test.ts`, review and update any `availableSlots()` tests that place agents in `verified` status — they should now count against the limit

## 3. Verification

- [x] 3.1 Run `bun run typecheck` and confirm no type errors
- [x] 3.2 Run `bun test` and confirm all tests pass with the updated assertions
