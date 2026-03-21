## 1. Concurrency Pinning — Scheduler.start()

- [x] 1.1 Add a private `concurrencyPinned: boolean = false` field to the `Scheduler` class in `src/daemon/scheduler.ts`
- [x] 1.2 In `Scheduler.start()`, wrap the `state.setMaxConcurrent(effectiveConcurrency)` call so it only executes when `this.concurrencyPinned === false`, then set `this.concurrencyPinned = true`
- [x] 1.3 In `Scheduler.setConcurrency()` (`src/daemon/scheduler.ts`), set `this.concurrencyPinned = true` after calling `state.setMaxConcurrent(n)`, so explicit runtime overrides are also pinned
- [x] 1.4 In `daemon.ts`, where `cmd:start` applies `payload.maxConcurrent`, set `scheduler.concurrencyPinned = true` (or expose a method on Scheduler) after the explicit override is applied

## 2. Infinite-Concurrency Burst — Tick Loop

- [x] 2.1 In the tick loop in `src/daemon/scheduler.ts`, change the `slotsForNew` calculation: when `max === 0`, set `slotsForNew = candidateTasks.length` instead of `launchCapacity - launched`

## 3. Unit Tests

- [x] 3.1 In `tests/daemon-scheduler.test.ts`, add a test: after setting `maxConcurrent=0` and calling `scheduler.start()` a second time (simulating watcher re-trigger), assert `getMaxConcurrent()` is still 0
- [x] 3.2 In `tests/daemon-scheduler.test.ts`, add a test: after calling `setConcurrency(8)`, trigger a `start()` re-invocation, assert `getMaxConcurrent()` is still 8
- [x] 3.3 In `tests/daemon-scheduler.test.ts`, add a test: verify that on the very first `start()` call with no prior override, the config value is applied (pinning does not prevent the initial apply)
- [x] 3.4 In `tests/daemon-scheduler.test.ts`, add a test: with `maxConcurrent=0` and N candidate tasks, after one tick all N tasks are submitted as queued agents

## 4. Verification

- [x] 4.1 Run `bun run typecheck` and confirm no type errors
- [x] 4.2 Run `bun test tests/daemon-scheduler.test.ts tests/daemon-state.test.ts` and confirm all pass
