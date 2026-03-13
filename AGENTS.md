# AGENTS.md — Instructions for AI agents working on wombo-combo

This file is for AI coding agents operating **on the wombo-combo codebase itself**.
If you are an agent **using** wombo as a tool in another project, see CONTEXT.md instead.

---

## HARD CONSTRAINTS

These are non-negotiable. Violating any of them will break the development workflow.

### 1. Always use `bun dev`, never the global binary

```
# CORRECT — runs local source directly
bun dev <command> [args...]

# WRONG — runs the globally installed (possibly stale) binary
wombo <command> [args...]
```

**Why:** wombo is dogfooded — we develop it using itself. The global binary is a
snapshot from the last release. If you use it, you're testing old code, not your
changes. `bun dev` runs `bun src/index.ts` which executes the current working tree.

**Examples:**
```sh
bun dev help
bun dev tasks list
bun dev tasks add my-feat "My Feature" --priority high
bun dev launch --dry-run --all-ready
bun dev init --force
```

### 2. Never publish to npm

Distribution is GitHub-only. Users install via:
```sh
bun install -g github:fulgidus/wombo
```
Do not add `publishConfig`, do not run `npm publish`, do not add `.npmrc`.

### 3. Keep bun.lock committed

The lockfile is committed for reproducible installs from GitHub. Always commit
`bun.lock` after adding/removing/updating dependencies.

### 4. Do not commit user artifacts

All wombo-combo user artifacts live under `.wombo-combo/` (config, tasks, archive,
state, logs, history). This directory is gitignored.

The template at `src/templates/tasks.yml` is the canonical source for the task
file schema. The root `.wombo-combo/` dir is for local development only.

---

## Project structure

```
wombo/
  package.json              # name: wombo-combo, version in sync with git tags
  src/
    index.ts                # CLI entry point, arg parsing, command routing
    config.ts               # WomboConfig type, defaults, loader, validator
    commands/
      init.ts               # Interactive guided setup (Prompter class)
      launch.ts             # Launch a wave of agents
      resume.ts             # Resume a stopped wave
      status.ts             # Show wave status
      verify.ts             # Build verification
      merge.ts              # Merge verified branches
      retry.ts              # Retry a failed agent
      cleanup.ts            # Remove worktrees and sessions
      tasks/
        list.ts, add.ts, set-status.ts, check.ts, archive.ts, show.ts
    lib/
      tasks.ts              # Task file I/O, types, ensureTasksFile guard
      state.ts              # Wave state persistence
      prompt.ts             # Agent prompt generation
      launcher.ts           # Process spawning
      monitor.ts            # ProcessMonitor
      worktree.ts           # Git worktree management
      merger.ts             # Git merge operations
      verifier.ts           # Build verification logic
      ui.ts                 # Console dashboard
      tui.ts                # neo-blessed TUI
    templates/
      tasks.yml             # Template with full schema docs
```

## User-facing file layout

All wombo-combo files live under `.wombo-combo/`:

```
.wombo-combo/
  config.json     # Project configuration (replaces wombo.json)
  tasks.yml       # Active tasks (replaces .features.yml)
  archive.yml     # Completed/cancelled tasks
  state.json      # Wave state
  logs/           # Agent log files
  history/        # Wave history records
```

## Coding conventions

- **Runtime:** Bun (not Node). Use Bun APIs where available (`Bun.file()`,
  `Bun.spawn()`, etc.), fall back to Node stdlib when Bun doesn't have a
  direct equivalent.
- **Language:** TypeScript, strict mode. Run `bun run typecheck` to verify.
- **Modules:** ESM only (`"type": "module"` in package.json). Use `.js`
  extensions in import paths (TypeScript resolves them to `.ts` at runtime in Bun).
- **No external CLI frameworks.** Arg parsing is hand-rolled in `index.ts`.
  This is intentional — it keeps the dependency tree minimal and gives full
  control for agent-readiness features (schema introspection, etc.).
- **YAML library:** `yaml` (v2). Use `YAML.parse()` / `YAML.stringify()`.
- **No npm registry dependencies** for core functionality. `neo-blessed` is
  the only large dependency (TUI). Keep it that way.

## Testing and verification

```sh
# Type check (no emit)
bun run typecheck

# Build (outputs to dist/)
bun run build

# Run any command via dev
bun dev help
bun dev tasks check
```

There is no test suite yet. When adding tests, use Bun's built-in test runner
(`bun test`).

## Known quirks

- **Bun readline + piped stdin:** `rl.question()` silently fails after readline
  emits `close`. The `Prompter` class in `src/commands/init.ts` works around
  this using `rl[Symbol.asyncIterator]()` with `process.stdout.write()`.
- **YAML null vs empty array:** `yaml` parses `tasks:` (no items) as `null`,
  not `[]`. `loadTasks()` normalizes this: `parsed.tasks ?? parsed.features ?? null`.
- **`import.meta.dir`:** Gives the directory of the current source file in Bun.
  Used in `src/lib/tasks.ts` to resolve the template path.

## Feature backlog

The active backlog lives in `.wombo-combo/tasks.yml` (local, gitignored). Use
`bun dev tasks list` to see it. The canonical template is at
`src/templates/tasks.yml`.

## Making changes

1. **Check the backlog:** `bun dev tasks list`
2. **Pick a feature/subtask:** `bun dev tasks show <id>`
3. **Mark it in-progress:** `bun dev tasks set-status <id> in_progress`
4. **Implement the change**
5. **Typecheck:** `bun run typecheck`
6. **Build:** `bun run build`
7. **Test manually:** `bun dev <relevant-command>`
8. **Mark done:** `bun dev tasks set-status <id> done`
9. **Commit** with a conventional commit message referencing the feature ID

## Version and release

- Current version is in `package.json` → `"version"` field.
- Git tags must match: tag `v0.0.1` ↔ `"version": "0.0.1"`.
- Release workflow (when implemented) triggers on `v*` tag push to main.
