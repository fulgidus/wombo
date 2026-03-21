## MODIFIED Requirements

### Requirement: Concurrency value is pinned after first set
Once `maxConcurrent` has been set during a daemon session (either by the first `Scheduler.start()` applying the config value, or by an explicit `cmd:set-concurrency` / `cmd:start { maxConcurrent }` call, or by `SchedulerConfig.initialMaxConcurrent` being supplied during Scheduler reconstruction), subsequent automatic re-invocations of `Scheduler.start()` (e.g. triggered by task-file watcher events) SHALL NOT overwrite the current `maxConcurrent` value.

#### Scenario: Watcher re-triggers start after idle — concurrency preserved
- **WHEN** `maxConcurrent` has been set to 0 (infinite) via `cmd:set-concurrency`
- **AND** the scheduler transitions to idle (all tasks complete)
- **AND** a task file change causes the tasks-dir watcher to call `Scheduler.start()`
- **THEN** `maxConcurrent` remains 0 and is not reset to `config.defaults.maxConcurrent`

#### Scenario: Config value applied on first start
- **WHEN** the daemon starts fresh and `Scheduler.start()` is called for the first time
- **AND** `config.defaults.maxConcurrent` is 4
- **THEN** `maxConcurrent` is set to 4

#### Scenario: Explicit override preserved across start re-trigger
- **WHEN** a user calls `cmd:set-concurrency` with value 8
- **AND** the scheduler goes idle and `Scheduler.start()` is re-invoked automatically
- **THEN** `maxConcurrent` remains 8

#### Scenario: Explicit start payload takes precedence
- **WHEN** `cmd:start` is received with `{ maxConcurrent: 2 }`
- **THEN** `maxConcurrent` is set to 2 and pinned for the session

#### Scenario: Scheduler reconstruction carries forward pinned value
- **WHEN** `maxConcurrent` has been pinned to 5 (by any means)
- **AND** the Scheduler is reconstructed (e.g. `cmd:start { questId }`)
- **AND** `SchedulerConfig.initialMaxConcurrent` is set to 5 (carried from state)
- **THEN** the new Scheduler instance treats 5 as pinned and does not overwrite it with the config default
