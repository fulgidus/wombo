## 1. AgentRunner — Per-entry stagger flag

- [x] 1.1 In `src/daemon/agent-runner.ts`, change the `launchQueue` element type from `Array<() => Promise<void>>` to `Array<{ fn: () => Promise<void>; skipStagger: boolean }>`.
- [x] 1.2 Update `enqueueLaunch` signature to `enqueueLaunch(fn: () => Promise<void>, skipStagger = false): void` and store `{ fn, skipStagger }` in the queue.
- [x] 1.3 In `processLaunchQueue`, destructure `{ fn, skipStagger }` from each queue item. After calling `fn().catch(() => {})`, only `await` the `setTimeout(resolve, LAUNCH_STAGGER_MS)` when `skipStagger === false` (and `launchQueue.length > 0`).
- [x] 1.4 In `submitTask`, pass `skipStagger: agentState.agentName === FAKE_AGENT_SENTINEL` to `enqueueLaunch`.
- [x] 1.5 In `launchAgent`, pass `skipStagger: agent.agentName === FAKE_AGENT_SENTINEL` to `enqueueLaunch`.

## 2. TUI — Batch task writes in handleToggleAll

- [x] 2.1 In `src/ink/run-task-browser.tsx`, import `loadAllTasksFromStore` and `saveAllTasksToStore` from `../lib/task-store` (replacing or alongside `saveTaskToStore`).
- [x] 2.2 In `handleToggleAll`, replace the per-task `saveTaskToStore` loop with: load the full tasks data via `loadAllTasksFromStore`, mutate the toggled tasks' statuses in the loaded data, then call `saveAllTasksToStore` with the complete updated set.
- [x] 2.3 Remove the now-unused `saveTaskToStore` import from `run-task-browser.tsx` if it is no longer referenced anywhere else in the file.

## 3. Unit Tests

- [x] 3.1 In `tests/daemon-agent-runner.test.ts` (create if it does not exist), add a test: when `enqueueLaunch` is called N times consecutively with `skipStagger: true`, all N `fn` calls fire with no inter-call delay (assert elapsed time < 50ms for N=5).
- [x] 3.2 Add a test: when `enqueueLaunch` is called with `skipStagger: false` (default), the queue processor waits approximately 250ms between consecutive entries (assert elapsed time ≥ 200ms for N=2).
- [x] 3.3 Add a test: `submitTask` with a fake-agent task enqueues with `skipStagger: true`; `submitTask` with a real-agent task enqueues with `skipStagger: false`.

## 4. Verification

- [x] 4.1 Run `bun run typecheck` and confirm no type errors.
- [x] 4.2 Run `bun test tests/daemon-agent-runner.test.ts` and confirm all new tests pass.
- [x] 4.3 Manually test: in a repo with a quest containing 10+ fake-task entries, press "A" in the TUI, start the wave with `maxConcurrent=0`, and observe that all agents appear in the monitor as `installing` within the same second rather than staggering visibly at 250ms intervals.
