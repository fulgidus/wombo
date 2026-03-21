## ADDED Requirements

### Requirement: Launch stagger applies only to real-agent launches
The `AgentRunner` launch queue SHALL support a per-entry `skipStagger` flag. When a launch entry has `skipStagger: true`, the queue processor SHALL NOT wait `LAUNCH_STAGGER_MS` before starting the next entry. When `skipStagger` is absent or `false`, the 250ms stagger SHALL be applied as before.

#### Scenario: Default behavior preserves existing stagger
- **WHEN** `enqueueLaunch` is called without the `skipStagger` flag
- **THEN** the queue processor waits 250ms between consecutive launch starts

#### Scenario: skipStagger flag removes the wait
- **WHEN** `enqueueLaunch` is called with `skipStagger: true`
- **THEN** the queue processor does NOT wait before starting the next queued launch

#### Scenario: submitTask sets skipStagger for fake agents
- **WHEN** `submitTask` is called for a task whose agent is `FAKE_AGENT_SENTINEL`
- **THEN** the resulting `enqueueLaunch` call is made with `skipStagger: true`

#### Scenario: submitTask does not set skipStagger for real agents
- **WHEN** `submitTask` is called for a task with a real agent name (or no agent name)
- **THEN** the resulting `enqueueLaunch` call is made without `skipStagger` (default false)
