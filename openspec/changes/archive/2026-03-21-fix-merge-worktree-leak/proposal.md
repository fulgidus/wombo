## Why

The merger creates temporary git worktrees inside `.wombo-combo/` for merge operations, but this directory is the daemon's runtime home. If the process dies mid-merge, orphaned worktrees accumulate inside the project's own tracking directory, polluting it and potentially confusing git. Additionally, `syncQuestBranch` uses a static tmp path (`.tmp-quest-sync`) that would collide if concurrent syncs ever ran.

## What Changes

- `mergeBranch()`: change `tmpDir` from `${projectRoot}/.wombo-combo/.tmp-merge-${Date.now()}` to a sibling directory outside the project root
- `syncQuestBranch()`: change static `tmpDir` from `${projectRoot}/.wombo-combo/.tmp-quest-sync` to a unique sibling path
- Both cleanup paths (`git worktree remove`) are unchanged — they already run in `finally` blocks

## Capabilities

### New Capabilities

- `safe-tmp-worktree-placement`: Temporary merge worktrees are created as siblings to the project root, outside the repo's `.wombo-combo/` directory, with unique timestamped names to prevent collisions.

### Modified Capabilities

(none — no existing spec files)

## Impact

- `src/lib/merger.ts`: two `tmpDir` constant assignments
- No API or config changes
- No test changes required (merger tests mock `runSafe`; path is not asserted)
- Orphaned worktrees from old path may need one-time manual cleanup
