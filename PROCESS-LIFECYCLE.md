# Agent Process Lifecycle Audit

> **Audit ID:** `wave-detach-audit`
> **Date:** 2026-03-14
> **Scope:** Headless & interactive agent process lifecycle, monitor teardown, TUI screen destruction

---

## Summary

Agents spawned in **headless mode** are tied to the parent process (`detached: false`, no `unref()`). They die when the parent exits. This is intentional — piped stdio is required for real-time JSON event parsing by `ProcessMonitor`.

Agents spawned in **interactive mode** run inside tmux sessions and survive parent death naturally.

**No changes are required.** The current design is correct for both modes. Recovery from ungraceful parent death is handled by `woco resume`.

---

## Findings

### 1. Are agents spawned with `detached: true` and `unref()`?

**No.** All headless launch functions use:

```typescript
spawn(agentBin, args, {
  stdio: ["pipe", "pipe", "pipe"],
  detached: false,
  // unref() is never called
});
```

| Function | File | `detached` | `unref()` | `stdio` |
|---|---|---|---|---|
| `launchHeadless()` | `lib/launcher.ts` | `false` | No | piped |
| `retryHeadless()` | `lib/launcher.ts` | `false` | No | piped |
| `launchConflictResolver()` | `lib/launcher.ts` | `false` | No | piped |
| `launchInteractive()` | `lib/launcher.ts` | N/A (mux session) | N/A | N/A |

**Why `detached: false` is correct:**

Headless agents MUST have stdout piped to the parent for `ProcessMonitor` to parse JSON events in real-time (session ID extraction, completion detection, activity tracking). Using `detached: true` + `unref()` would allow agents to outlive the parent, but the piped stdio streams would break when the parent exits, causing agent crashes or lost output.

If agent persistence across parent restarts is needed, the interactive (mux) mode should be used instead.

### 2. Does `ProcessMonitor.killAll()` kill child processes?

**Yes, selectively.**

- **Non-reconnected processes** (spawned by this parent): `remove()` sends `SIGTERM` to each child. This is the primary teardown path called from the `onQuit` callback and SIGINT/SIGTERM signal handlers.
- **Reconnected processes** (PID-only, from `reconnectProcess()`): NOT killed — they are independent agents (typically in mux sessions) that should survive the parent's exit. They are simply removed from the monitor map so polling stops.

There is no `stop()` method on `ProcessMonitor`. Callers invoke `killAll()` directly.

The `remove()` method:
- Sends `SIGTERM` (not `SIGKILL`) to allow graceful shutdown
- For reconnected processes (no ChildProcess handle), uses `process.kill(pid, 'SIGTERM')` directly
- Deletes the process map entry immediately — subsequent events from the dying process are ignored

### 3. Does `screen.destroy()` affect agent processes?

**No.** `WomboTUI.stop()` only:

1. Restores intercepted `console.log/error/warn` methods
2. Clears the 2-second refresh timer
3. Calls `onBeforeDestroy()` callback (flushes state to disk)
4. Calls `screen.destroy()` (tears down the blessed terminal UI)

Agent process termination is handled by the `onQuit` callback, which is set by `launch.ts`/`resume.ts` to call `monitor.killAll()` + state save + `process.exit(0)`.

The separation is intentional:
- `stop()` is also called before mux attach (the `muxAttach` method) where the TUI is temporarily destroyed and recreated after detach — agents must NOT be killed in this case.
- `onQuit()` is only called when the user intends to exit the entire wave.

---

## Shutdown Flows

### Graceful Shutdown (SIGINT / TUI quit / SIGTERM / SIGHUP)

```
User presses q / Ctrl+C
  → TUI.stop()              # clears refresh timer, flushes state, destroys screen
  → onQuit() callback
    → monitor.killAll()      # SIGTERM to all non-reconnected children
    → flushState()           # persist wave state to disk
    → process.exit(0)        # parent exits; OS cleans up remaining children
```

### Ungraceful Shutdown (SIGKILL / crash / OOM)

```
Parent killed with SIGKILL
  → All child processes die immediately (detached: false)
  → No state is saved
  → Recovery via `woco resume`:
    - Detects dead-but-productive agents (worktree exists with commits)
    - Runs build verification on existing work
    - Re-launches agents that died without producing code
```

### Interactive Mode Shutdown

```
User presses q / Ctrl+C
  → Parent exits
  → Mux sessions continue running independently
  → `woco status` shows agent progress
  → `woco verify` checks builds
  → `woco cleanup` kills mux sessions when done
```

---

## Files with Audit Annotations

All inline annotations are tagged with `(audit: wave-detach-audit)`:

| File | Location | What's documented |
|---|---|---|
| `src/lib/launcher.ts` | Module header (lines 12-45) | Full lifecycle analysis for all spawn modes |
| `src/lib/monitor.ts` | Module header (lines 12-38) | ProcessMonitor lifecycle and teardown behavior |
| `src/lib/tui.ts` | `start()`/`stop()` section (lines 388-405) | TUI lifecycle vs agent processes |
| `src/commands/launch.ts` | `onQuit` callback, `gracefulShutdown` | SIGINT/SIGTERM handler behavior |
| `src/commands/launch.ts` | `launchWaveInteractive` | Interactive agents survive parent death |
| `src/commands/resume.ts` | Module header (lines 11-28) | Agent recovery triage logic |
| `src/commands/resume.ts` | `gracefulShutdown`, `onQuit` | Same pattern as launch.ts |
| `src/commands/cleanup.ts` | Module header | Cleanup kills mux sessions only |
| `src/commands/retry.ts` | Module header | Retry lifecycle for both modes |

---

## Recommendations

The current design is sound. No immediate changes are needed. However, if future requirements emerge:

1. **If agents need to survive parent death in headless mode**: Switch to interactive (mux) mode. Do NOT use `detached: true` with piped stdio — the broken pipes will crash agents.

2. **If headless agents need recovery without `woco resume`**: Consider having agents write periodic checkpoints to disk (e.g., session state files) that a new parent can read to reconstruct monitoring state.

3. **If SIGKILL resilience is critical**: The only robust approach is interactive (mux) mode, where agents are fully independent of the parent process.
