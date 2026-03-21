## ADDED Requirements

### Requirement: Fake-agent tasks bypass inter-launch stagger
When multiple fake-agent tasks are submitted in the same scheduler tick, the `AgentRunner` SHALL begin all their `doLaunch` pipelines concurrently, without inserting the `LAUNCH_STAGGER_MS` (250ms) delay between consecutive fake-agent launch starts.

#### Scenario: All fake-agent tasks start concurrently
- **WHEN** N fake-agent tasks are submitted to the launch queue in the same tick
- **THEN** all N `doLaunch` calls are enqueued and begin executing without any inter-call pause

#### Scenario: Real-agent launches are unaffected
- **WHEN** real-agent tasks are submitted to the launch queue
- **THEN** consecutive real-agent launch starts are still separated by `LAUNCH_STAGGER_MS` (250ms)

#### Scenario: Mixed queue preserves stagger only for real agents
- **WHEN** a mix of fake-agent and real-agent tasks are in the launch queue
- **THEN** fake-agent entries do not introduce a 250ms wait before the next entry, but real-agent entries do
