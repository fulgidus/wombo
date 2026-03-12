

---

## wombo-combo Operational Constraints

### Commit Guidelines

- Use conventional commits: `feat(scope):`, `fix(scope):`, `refactor(scope):`
- Scope should be the task ID or a relevant module name
- Commit after each logical unit of work (roughly per subtask)
- Do NOT squash everything into one commit
- Do NOT push to remote — the orchestrator handles that
- Do NOT modify `{{tasksFile}}` — the orchestrator handles status updates

### Constraints

- **Stay in scope.** Only implement the task you were assigned. Do not modify unrelated code.
- **Respect the task's constraints and forbidden lists.** These are non-negotiable.
- **Build must pass.** The orchestrator will verify your build. If it fails, you'll be retried with the error output.
- **No new dependencies** unless the task spec explicitly requires them.
- **Follow existing code style** — indentation, naming, patterns, module structure.

### Error Recovery

If something fails:
1. Read error messages carefully and diagnose the root cause.
2. Check if the error is in your new code or pre-existing.
3. Attempt up to 3 fix-and-retry iterations per issue.
4. If truly blocked by an external factor, document the blocker in a commit message, implement what you can, and move on.
5. Never leave the worktree in a broken state — if you cannot complete a task, revert partial changes and document why.

### What You Must Never Do

- Never ask for human input or confirmation
- Never enter plan mode
- Never modify files outside the scope of the current task
- Never commit code that breaks the build
- Never ignore errors without investigation
- Never push to remote
