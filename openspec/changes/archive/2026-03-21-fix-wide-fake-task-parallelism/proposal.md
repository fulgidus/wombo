## Why

When a user presses "A" to bulk-plan all tasks in a quest with infinite concurrency (`maxConcurrent=0`), the tasks don't all launch simultaneously — they stagger visibly due to a 250ms per-task delay in the launch queue. For fake-agent tasks (used in load testing and quest development), this stagger is entirely unnecessary because the only race condition the stagger was designed to prevent (concurrent SQLite session DB creation in real agent processes) does not apply.

## What Changes

- The launch stagger (250ms between each `doLaunch` start) is bypassed for fake-agent tasks, so all N fake tasks begin launching simultaneously instead of serially.
- The `handleToggleAll` function in the TUI is updated to use `saveAllTasksToStore` (a single-pass bulk write) instead of calling `saveTaskToStore` in a per-task loop, reducing N × 2 filesystem writes to 1 + N writes and avoiding N redundant `_meta.yml` rewrites.

## Capabilities

### New Capabilities
- `fake-agent-parallel-burst`: Fake-agent tasks submitted in the same tick all begin launching concurrently (no inter-launch stagger), enabling true burst parallelism for load testing and quest-based fake-task workflows.

### Modified Capabilities
- `scheduler-launch-stagger`: The stagger applies only to real agent launches; fake-agent launches bypass it.

## Impact

- `src/daemon/agent-runner.ts`: `processLaunchQueue` modified to skip the stagger delay between fake-agent launches; or `enqueueLaunch` gains an optional `skipStagger` parameter.
- `src/ink/run-task-browser.tsx`: `handleToggleAll` switches from per-task `saveTaskToStore` loop to `saveAllTasksToStore` batch call.
- No public API changes, no breaking changes, no config changes required.
