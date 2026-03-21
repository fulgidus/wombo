## ADDED Requirements

### Requirement: Concurrency limit is enforced through the full agent lifecycle
The scheduler SHALL count an agent as consuming a concurrency slot from initial launch until the agent reaches a terminal state (`merged` or `failed`). The `verified` status SHALL be treated as active (slot-consuming), not terminal.

#### Scenario: Verified agent holds its concurrency slot
- **WHEN** an agent transitions to `verified` status
- **THEN** `getActiveAgents()` SHALL include that agent
- **AND** `availableSlots()` SHALL NOT increase

#### Scenario: No over-subscription when verified agent enters conflict resolution
- **WHEN** an agent in `verified` status enters the merge pipeline and transitions to `resolving_conflict`
- **THEN** the total active agent count SHALL NOT exceed `maxConcurrent`

#### Scenario: New agents are not launched to fill slots held by verified agents
- **WHEN** all `maxConcurrent` slots are occupied by agents in any combination of `installing`, `running`, `resolving_conflict`, or `verified` states
- **THEN** the scheduler SHALL NOT launch additional agents

### Requirement: Scheduler remains active while verified agents await merge
The scheduler SHALL NOT transition to idle status while any agent is in `verified` status, since those agents have pending merge work that may require scheduler intervention (e.g. retry after merge failure).

#### Scenario: allComplete does not return true with verified agents present
- **WHEN** all agents are in `merged`, `failed`, or `verified` status
- **AND** at least one agent is in `verified` status
- **THEN** `allComplete()` SHALL return `false`

#### Scenario: Scheduler tick continues while agents are verifying
- **WHEN** one or more agents are in `verified` status
- **THEN** the scheduler tick loop SHALL remain active

### Requirement: Retry after merge failure is picked up by the scheduler
If a merge fails and an agent is re-queued for retry, the scheduler tick loop SHALL be active to pick it up.

#### Scenario: Merge failure retry is not stranded
- **WHEN** a `verified` agent's merge attempt fails and the agent transitions to `queued` for retry
- **THEN** the scheduler tick loop SHALL still be running
- **AND** the agent SHALL be launched on the next tick

### Requirement: Downstream task unblocking is unaffected by this change
Downstream tasks that depend on a `verified` agent SHALL still be unblocked for scheduling. The `verified` status SHALL remain in `DEP_SATISFIED_STATUSES`.

#### Scenario: Downstream task proceeds when dependency reaches verified
- **WHEN** a dependency agent transitions to `verified` status
- **THEN** tasks that depend on it SHALL be eligible for scheduling
