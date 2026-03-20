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

### 2. Never publish manually — use the release workflow

Publishing is handled by the GitHub Actions release workflow, which triggers on
git tag pushes. **Never run `npm publish` manually** — always let the workflow
handle it.

To release: bump `package.json` version, commit, tag (`v<version>`), push with
`--tags`. The workflow takes care of the rest.

Users install via:

```sh
bun a -g wombo-combo
```

### 3. Keep bun.lock committed

The lockfile is committed for reproducible installs from GitHub. Always commit
`bun.lock` after adding/removing/updating dependencies.

### 4. Commit project artifacts, ignore runtime artifacts

Wombo-combo is dogfooded — we develop it using itself. Project definition files
under `.wombo-combo/` **are tracked in git**:

- `config.json`, `project.yml` — project configuration and profile
- `tasks/`, `tasks.yml` — active tasks
- `archive/`, `archive.yml` — completed/cancelled tasks
- `quests/` — quest definitions
- `wishlist.yml` — wishlist items

**Runtime artifacts are gitignored** (ephemeral, regenerated each run):

- `state.json` — wave state
- `logs/` — agent log files
- `history/` — wave history records
- `tui-session.json` — TUI session state
- `usage.jsonl` — token usage data

### 5. Never silently work around bugs

When you encounter unexpected behavior, errors, or bugs in the codebase or
tooling during your work, you must either:

1. **Fix it** immediately if the fix is straightforward, or
2. **Track it** — create a task (`bun dev tasks add`) or wishlist item before
   proceeding with a workaround.

Silent workarounds are forbidden. A workaround without a tracking item means the
bug is invisible and will never be fixed.

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
- **Modules:** ESM only (`"type": "module"` in package.json). Use **no file
  extensions** in relative import paths (`import { foo } from "./foo"`, not
  `"./foo.js"`). The tsconfig uses `"moduleResolution": "bundler"` which
  resolves extensionless imports to `.ts` files automatically. The `.js`
  extension convention is legacy and should not be used.
- **CLI framework:** [citty](https://github.com/unjs/citty). All command
  definitions live in `src/commands/citty/`. The router in
  `src/commands/citty/router.ts` maps command names and aliases to citty
  command definitions. Schema introspection (`woco describe`) uses the
  separate `COMMAND_REGISTRY` in `src/lib/schema.ts`.
- **YAML library:** `yaml` (v2). Use `YAML.parse()` / `YAML.stringify()`.

## Testing and verification

```sh
# Type check (no emit)
bun run typecheck

# Build (outputs to dist/)
bun run build

# Run tests
bun test

# Run any command via dev
bun dev help
bun dev tasks check
```

Tests use Bun's built-in test runner (`bun test`). Test files live in `tests/`
and use `*.test.ts` naming.

## Known quirks

- **Bun readline + piped stdin:** `rl.question()` silently fails after readline
  emits `close`. The `Prompter` class in `src/commands/init.ts` works around
  this using `rl[Symbol.asyncIterator]()` with `process.stdout.write()`.
- **YAML null vs empty array:** `yaml` parses `tasks:` (no items) as `null`,
  not `[]`. `loadTasks()` normalizes this: `parsed.tasks ?? parsed.features ?? null`.
- **`import.meta.dir`:** Gives the directory of the current source file in Bun.
  Used in `src/lib/tasks.ts` to resolve the template path.

## Feature backlog

The active backlog lives in `.wombo-combo/tasks.yml`. Use
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
- Git tags must match: tag `v0.1.0` ↔ `"version": "0.1.0"`.
- **When creating a git tag, ALWAYS update `package.json` `"version"` first,
  commit the bump, then tag that commit.** Never tag without bumping the
  version — they must stay in sync.
- Release workflow (when implemented) triggers on `v*` tag push to main.
- **Never run `npm publish` manually** — always let the GitHub Actions workflow
  handle publishing. Just bump, commit, tag, push.
