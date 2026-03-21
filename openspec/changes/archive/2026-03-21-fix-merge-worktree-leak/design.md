## Context

The merger (`src/lib/merger.ts`) creates temporary git worktrees to perform merges without disturbing the user's current checkout. Two functions are affected:

- `mergeBranch()` (line 151): creates `.wombo-combo/.tmp-merge-${Date.now()}`
- `syncQuestBranch()` (line 393): creates `.wombo-combo/.tmp-quest-sync` (static name)

Both paths land inside `.wombo-combo/`, the daemon's runtime directory. While `finally` blocks clean up these worktrees on success, a process crash during a merge leaves orphaned worktrees inside the project's own tracking directory. The static name in `syncQuestBranch` is also a latent collision risk.

## Goals / Non-Goals

**Goals:**
- Tmp worktrees are created outside `.wombo-combo/` and outside the project repo directory
- Tmp paths are always unique (timestamped) to prevent collisions
- Cleanup behaviour is unchanged

**Non-Goals:**
- Changing the merge logic itself
- Adding crash-recovery cleanup (orphan sweeping on daemon start) — separate concern
- Moving any other runtime artifacts out of `.wombo-combo/`

## Decisions

### Decision: Sibling directory next to the project root

**Choice:** `${projectRoot}/../.wombo-tmp/${basename(projectRoot)}-merge-${Date.now()}`

**Rationale:**
- A sibling path is guaranteed to be on the same filesystem as the repo, which is required for `git worktree add` to use hard links efficiently. `/tmp` may be a separate tmpfs on Linux, breaking hard-link optimisation.
- Stays out of the repo entirely — no git-tracked or gitignored path is touched.
- The `${basename(projectRoot)}` prefix namespaces by project, so multiple wombo instances running in different projects don't collide.

**Alternatives considered:**
- `os.tmpdir()`: Clean but may be a separate filesystem (tmpfs on Linux), losing hard-link efficiency. Also requires importing `os` for a one-liner change.
- `${projectRoot}/.wombo-combo/tmp/`: Still inside `.wombo-combo/`, only marginally better.
- A fixed parent like `${projectRoot}/../.wombo-tmp/`: Chosen approach — predictable, on same FS, easy to sweep manually if needed.

### Decision: Apply the same pattern to both `mergeBranch` and `syncQuestBranch`

Both functions create worktrees for the same reason (non-destructive merge). Consistent placement simplifies reasoning and any future orphan-sweep logic.

## Risks / Trade-offs

- **[Risk] Parent of project root may not be writable** → Mitigation: same risk exists today for `.wombo-combo/` itself; if the project root is writable, its parent typically is too. No additional guard needed.
- **[Risk] Orphaned `.wombo-tmp/` dir persists after all merges complete** → Mitigation: `git worktree remove --force` in the `finally` block removes the specific dir. The parent `.wombo-tmp/` is left behind but is empty and harmless. A future cleanup command could sweep it.
- **[Risk] Existing orphaned `.tmp-merge-*` dirs inside `.wombo-combo/`** → Mitigation: one-time manual `git worktree prune` clears them; document in commit message.
