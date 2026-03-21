## 1. Extend SchedulerConfig

- [ ] 1.1 Add optional `initialMaxConcurrent?: number` field to `SchedulerConfig` in `src/daemon/scheduler.ts`
- [ ] 1.2 In `Scheduler` constructor (or `start()`), when `config.initialMaxConcurrent` is defined: call `state.setMaxConcurrent(config.initialMaxConcurrent)` and set `this.concurrencyPinned = true`

## 2. Update handleStart in daemon.ts

- [ ] 2.1 Before calling `this.scheduler.shutdown()` in `handleStart()`, read `const currentMax = this.state.getMaxConcurrent()`
- [ ] 2.2 When building `schedConfig` for the new Scheduler, pass `initialMaxConcurrent: currentMax` if `currentMax !== undefined`

## 3. Tests

- [ ] 3.1 In `tests/daemon-scheduler.test.ts`, add a test: Scheduler reconstructed with `initialMaxConcurrent: 0` does not overwrite state with config default
- [ ] 3.2 Add a test: Scheduler reconstructed with `initialMaxConcurrent: 5` starts with `state.maxConcurrent === 5` and `concurrencyPinned === true`
- [ ] 3.3 Add a test: Scheduler constructed with no `initialMaxConcurrent` (cold start) still applies `config.defaults.maxConcurrent` on `start()`

## 4. Verification

- [ ] 4.1 Run `bun run typecheck` — zero new errors
- [ ] 4.2 Run `bun test` — all non-snapshot tests pass; existing 14 TUI snapshot failures acceptable
