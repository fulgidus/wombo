## ADDED Requirements

### Requirement: maxConcurrent is preserved when Scheduler is reconstructed
When `handleStart()` reconstructs the Scheduler (e.g. on `cmd:start { questId }`), the new Scheduler instance SHALL be initialised with the `maxConcurrent` value that was active in the previous instance, and SHALL treat that value as pinned.

#### Scenario: Quest selection preserves user-set infinite concurrency
- **WHEN** the user has set `maxConcurrent` to `0` (infinite) via `cmd:set-concurrency`
- **AND** `cmd:start { questId: "q1" }` is received, causing Scheduler reconstruction
- **THEN** `state.maxConcurrent` remains `0` after the new Scheduler starts
- **THEN** the new Scheduler does not call `state.setMaxConcurrent(config.defaults.maxConcurrent)`

#### Scenario: Quest selection preserves config-applied concurrency
- **WHEN** the daemon started fresh and applied `config.defaults.maxConcurrent = 4`
- **AND** no explicit `cmd:set-concurrency` was issued
- **AND** `cmd:start { questId: "q2" }` causes Scheduler reconstruction
- **THEN** `state.maxConcurrent` remains `4` after the new Scheduler starts

#### Scenario: Fresh cold-start still applies config default
- **WHEN** the daemon starts for the first time
- **AND** `state.maxConcurrent` is undefined (never set)
- **AND** the Scheduler is constructed with no `initialMaxConcurrent`
- **THEN** `Scheduler.start()` applies `config.defaults.maxConcurrent` as usual
