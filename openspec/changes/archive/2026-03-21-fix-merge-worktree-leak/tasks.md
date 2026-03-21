## 1. Fix Temporary Worktree Paths

- [x] 1.1 In `src/lib/merger.ts`, update `mergeBranch()` to compute `tmpDir` as a sibling to the project root: `path.resolve(projectRoot, '..', '.wombo-tmp', `${path.basename(projectRoot)}-merge-${Date.now()}`)` (import `path` from `node:path` if not already present)
- [x] 1.2 In `src/lib/merger.ts`, update `syncQuestBranch()` to use the same sibling pattern with a unique timestamp: `path.resolve(projectRoot, '..', '.wombo-tmp', `${path.basename(projectRoot)}-quest-sync-${Date.now()}`)` replacing the static `.tmp-quest-sync` path

## 2. Verification

- [x] 2.1 Run `bun run typecheck` and confirm no type errors
- [x] 2.2 Run `bun test` and confirm all existing merger/worktree tests pass
- [x] 2.3 Manually verify: start a merge operation and confirm no `.tmp-merge-*` or `.tmp-quest-sync` directories appear inside `.wombo-combo/`
