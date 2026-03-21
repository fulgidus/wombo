## ADDED Requirements

### Requirement: All dep-free tasks are submitted in a single tick at infinite concurrency
When `maxConcurrent` is 0 (infinite), the scheduler tick SHALL submit all candidate `planned` tasks whose dependencies are satisfied in a single pass, without applying any slot ceiling.

#### Scenario: Ten dep-free tasks spring to life within two ticks
- **WHEN** `maxConcurrent` is 0
- **AND** 10 `planned` tasks exist on disk with no `depends_on` entries
- **AND** none have been submitted yet
- **THEN** all 10 tasks are submitted (status → `queued`) on the first tick
- **AND** all 10 agents are launched (status → `installing`/`running`) on the second tick

#### Scenario: Finite concurrency still caps per-tick submission
- **WHEN** `maxConcurrent` is 3
- **AND** 10 `planned` dep-free tasks exist
- **THEN** at most 3 tasks are submitted per tick (slots for new = maxConcurrent - active)

#### Scenario: Infinite concurrency burst does not exceed candidate count
- **WHEN** `maxConcurrent` is 0
- **AND** only 5 candidate tasks exist
- **THEN** exactly 5 tasks are submitted on the first tick (not an unbounded loop)
