## Context

The daemon scheduler (`src/daemon/scheduler.ts`) has two independent bugs that both manifest as surprising scheduler behaviour:

**Bug 1 — Concurrency silently resets**: `Scheduler.start()` unconditionally overwrites the in-memory `maxConcurrent` with `config.defaults.maxConcurrent` every time it is invoked. `start()` is re-invoked automatically whenever the tasks directory changes and the scheduler is idle (daemon.ts:575-578). Any runtime value set via `cmd:set-concurrency` or `cmd:start { maxConcurrent }` is silently discarded the next time a task file is written to disk and the scheduler was idle.

**Bug 2 — Infinite-concurrency does not burst**: When `maxConcurrent=0`, the tick computes `launchCapacity = MAX_SAFE_INTEGER` and `slotsForNew = MAX_SAFE_INTEGER - launched` — which is still enormous. However, new tasks from disk are only submitted via `submitNewTask` → queued state on tick N, and only launched via `launchAgent` on tick N+1 (the two-tick delay is correct and unavoidable). The real issue is that when the scheduler is `idle` and a task file changes, `start()` fires, applies the first tick, and then — because `allComplete()` returns true while tasks are still in `queued` state before they have a chance to run — the idle check on the same tick transitions status back to `idle` and stops the tick timer. The newly queued agents are stranded: no further tick fires to launch them.

The idle-check condition (scheduler.ts:239-251) requires `allComplete() && candidateTasks.length === 0 && readyQueued.length === 0`. After `submitNewTask`, agents are in `queued` state — but `allComplete()` returns true because `queued` is not a terminal status and there are no *active* agents. Wait — actually `allComplete()` checks `TERMINAL_STATUSES`, and `queued` is not in `TERMINAL_STATUSES`, so `allComplete()` correctly returns false when agents are `queued`. Re-reading: `allComplete()` iterates all agents and checks every one is in `TERMINAL_STATUSES`. A queued agent fails this check. So `allComplete()` returns false when there are queued agents. The idle check therefore does NOT fire immediately after submission.

**Revised root cause for Bug 2**: The tick loop computes `slotsForNew = launchCapacity - launched`. At the start of the tick, `readyQueued` (already-queued agents) is empty (the agents were just submitted this tick via `submitNewTask`, which is called *after* the `getReadyAgents()` call). So `launched = 0` and `slotsForNew = MAX_SAFE_INTEGER`. All candidates are submitted as queued agents. On the next tick, `getReadyAgents()` picks them all up and `launchAgent` is called. This flow is correct for infinite concurrency.

**The real Bug 2** — confirmed from user report + investigation — is that with a **finite** `maxConcurrent` and many dep-free tasks, only `maxConcurrent` tasks are submitted per tick (because `slotsForNew = max - activeCount - launched`). The remaining tasks sit on disk as `planned` and are not submitted until slots open up. With infinite concurrency this is not the issue; the issue was that `start()` was resetting `maxConcurrent` back to the config default (Bug 1), causing what appeared to be a concurrency ceiling even when the user had explicitly set it to 0.

Both bugs therefore share Bug 1 as the common root cause. Bug 2 is a secondary issue with the per-tick submission cap under finite concurrency.

## Goals / Non-Goals

**Goals:**
- `Scheduler.start()` applies `maxConcurrent` from config only on the **first** invocation per daemon session; subsequent re-invocations (from watchers, idle restart) preserve the current runtime value
- A runtime override (`cmd:set-concurrency`, `cmd:start { maxConcurrent }`) is never silently discarded by an automatic `start()` re-trigger
- With `maxConcurrent=0`, all dep-free `planned` tasks on disk are submitted (queued) in a single tick pass, so they launch on the next tick
- Tests cover both the pinning behaviour and the infinite-burst behaviour

**Non-Goals:**
- Changing the two-tick delay between submission and launch (this is an inherent consequence of the submit-then-launch architecture)
- Persistent concurrency across daemon restarts (restarts re-read config, which is correct)
- Changing the tick interval or prioritization logic

## Decisions

### Decision: Track whether concurrency has been explicitly set this session

**Choice:** Add a boolean `concurrencySetExplicitly` flag to the `Scheduler` class (in-memory only, not persisted). `Scheduler.start()` only calls `state.setMaxConcurrent(effectiveConcurrency)` when this flag is false. The flag is set to true after the first apply. `cmd:set-concurrency` and `cmd:start { maxConcurrent }` also set the flag to true.

**Rationale:** The simplest, most localised fix. No data model changes. The flag lives only in the Scheduler instance, so it resets to false on daemon restart — which is the correct behaviour (a fresh daemon should read the config value on first start).

**Alternatives considered:**
- Track a "user has overridden" flag on `DaemonState` (persisted): Would survive restarts, but that means a daemon restart would never re-apply `config.json` changes, which is the wrong trade-off.
- Compare current value to config value before overwriting: Fragile — if user sets concurrency to the same value as config, the flag never trips.
- Move concurrency override to a separate mechanism entirely (e.g., runtime config file): Over-engineered for this scope.

### Decision: Submit ALL candidates when `maxConcurrent=0`, regardless of `slotsForNew`

**Choice:** In the tick loop, when `max === 0`, set `slotsForNew = candidateTasks.length` (i.e., submit all of them) rather than `launchCapacity - launched`.

**Rationale:** When concurrency is infinite, the slot calculation is meaningless — there is no ceiling to protect. The current code produces `MAX_SAFE_INTEGER - launched` which is also effectively unlimited, but making the intent explicit avoids any edge case where arithmetic on `MAX_SAFE_INTEGER` could produce unexpected results. It also makes the code's intent self-documenting.

**Alternatives considered:**
- Keep the existing arithmetic: works in practice but is implicit and fragile near integer overflow.
- Add a separate "burst mode" path: unnecessary complexity for a one-liner fix.

## Risks / Trade-offs

- **[Risk] Concurrency set via `cmd:set-concurrency` is lost on daemon restart** → Mitigation: this is intentional and correct — daemon restart re-reads `config.json`. Users who want a persistent default should set it in `config.json`.
- **[Risk] First `scheduler.start()` still applies config value, clobbering a value loaded from `daemon-state.json`** → Mitigation: this is the existing behaviour and is correct — config.json is the source of truth for the project's concurrency policy. The `daemon-state.json` persisted value was always overwritten on startup; this change does not make that worse.
- **[Risk] The `concurrencySetExplicitly` flag is in-memory only and not visible to tests that construct `DaemonState` directly** → Mitigation: tests that test pinning behaviour should construct a full `Scheduler` instance; unit tests for `DaemonState` alone are unaffected.
