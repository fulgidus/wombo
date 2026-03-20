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
    index.ts                # CLI entry point, global flag extraction, citty routing
    config.ts               # WomboConfig type, defaults, loader, validator
    commands/
      citty/                # All citty command definitions
        router.ts           # isCittyCommand / runCittyCommand / resolveGlobalFlagsAndCommand
        global-flags.ts     # extractGlobalFlags helper
        init.ts, launch.ts, resume.ts, status.ts, verify.ts, merge.ts
        retry.ts, abort.ts, cleanup.ts, history.ts, logs.ts, usage.ts
        upgrade.ts, completion.ts, tasks.ts, quest.ts, genesis.ts
        wishlist.ts, tui.ts, daemon.ts, describe.ts, help.ts, version.ts
      # Legacy shim files (delegate to citty/ equivalents):
      init.ts, launch.ts, resume.ts, status.ts, verify.ts, merge.ts
      retry.ts, abort.ts, cleanup.ts, history.ts, logs.ts, usage.ts
      upgrade.ts, completion.ts, genesis.ts, quest.ts, tui.ts
      tasks/                # Task subcommand shims
    lib/
      tasks.ts              # Task file I/O, filtering, selection strategies
      task-store.ts         # Per-file task persistence (tasks/ directory)
      task-schema.ts        # Task type definitions and schema validation
      state.ts              # Wave state persistence
      prompt.ts             # Agent prompt generation
      prompt-compress.ts    # Prompt compression utilities
      launcher.ts           # Process spawning
      monitor.ts            # ProcessMonitor (activity stream parsing)
      interactive-monitor.ts # Interactive wave monitor logic
      worktree.ts           # Git worktree management
      merger.ts             # Git merge operations
      verifier.ts           # Build verification logic
      tdd-verifier.ts       # TDD file coverage verification
      test-detection.ts     # Detects test files for TDD checks
      test-runner.ts        # Runs bun test, captures results
      ui.ts                 # Console dashboard (ANSI, non-Ink fallback)
      schema.ts             # Declarative command registry for introspection
      schema-types.ts       # CommandDef / FlagDef types (no circular deps)
      citty-bridge.ts       # Maps citty arg definitions → CommandDef
      citty-registry.ts     # Builds COMMAND_REGISTRY from citty definitions
      history.ts            # Wave history records I/O
      token-usage.ts        # Token usage tracking
      token-collector.ts    # Aggregates usage across agents
      hitl-channel.ts       # Human-in-the-loop messaging channel
      hitl-ask.ts           # HITL ask utility
      output.ts             # Structured output formatting (json/table)
      quest.ts              # Quest type definitions and helpers
      quest-store.ts        # Quest file persistence
      quest-planner.ts      # Quest-to-task planning logic
      genesis-planner.ts    # Genesis vision-to-task planning
      errand-planner.ts     # Errand planning utilities
      agent-registry.ts     # Agent registry for multi-agent coordination
      project-store.ts      # .wombo-combo/ project config persistence
      wishlist-store.ts     # Wishlist item persistence
      validate.ts           # Input validation helpers
      templates.ts          # Template file loading
      tmux.ts               # Tmux session management
      tui-session.ts        # TUI session state persistence
      onboarding-helpers.ts # Init/onboarding shared logic
      portless.ts           # Portless server URL helpers
      browser.ts            # Browser automation for verifier
      browser-verifier.ts   # Browser-based build verification
      conflict-hunks.ts     # Git conflict hunk parsing
      dependency-graph.ts   # Task dependency graph utilities
      format-converter.ts   # Format conversion utilities
      fake-agent-runner.ts  # Fake agent for dry-run/testing
      toon.ts               # Toon animation system
      toon-spec.ts          # Toon animation specs
      subagents/
        scout.ts            # Scout subagent for codebase exploration
    ink/                    # Ink (React) TUI components
      router.tsx            # ScreenRouter — stack-based screen navigator
      app.tsx               # Minimal App shell component (proof-of-concept)
      shell.tsx             # Full shell with header, keybind handler, clean exit
      chrome.tsx            # Persistent chrome bar overlay
      dashboard.tsx         # Live wave dashboard screen
      wave-monitor.tsx      # WaveMonitorView — agent table + preview pane
      run-wave-monitor.tsx  # Mounts wave monitor with state polling
      run-daemon-monitor.tsx # Mounts daemon monitor screen
      run-tui-app.tsx       # Top-level TUI app entry (ScreenRouter + screens)
      run-app.tsx           # inkRender() wrapper for generic app
      run-review.tsx        # Review screen runner
      run-progress.tsx      # Progress screen runner
      run-preflight.tsx     # Preflight check screen runner
      run-quest-picker.tsx  # Quest picker runner
      run-quest-wizard.tsx  # Quest creation wizard runner
      run-errand-wizard.tsx # Errand wizard runner
      run-task-browser.tsx  # Task browser screen runner
      run-wishlist-picker.tsx # Wishlist picker runner
      task-browser.tsx      # Interactive task browser component
      task-graph.ts         # Task dependency graph renderer
      quest-picker.tsx      # Quest selection UI
      quest-wizard.tsx      # Quest creation wizard UI
      plan-review.tsx       # Plan review screen
      review-list.tsx       # Review list component
      genesis-review.tsx    # Genesis plan review screen
      errand-wizard.tsx     # Errand wizard UI
      progress.tsx          # Progress indicator component
      status-view.tsx       # Status display component
      settings-screen.tsx   # Settings screen
      splash-screen.tsx     # Splash screen
      esc-menu.tsx          # Escape menu overlay
      modal.tsx             # Modal dialog component
      confirm.tsx           # Confirmation dialog
      question-popup.tsx    # Inline question popup
      text-input.tsx        # Text input component
      text-buffer.ts        # Text buffer for input handling
      text-input-harness.tsx # Test harness for text input
      select-input.tsx      # Selectable list component
      usage-overlay.tsx     # Token usage overlay
      wishlist-overlay.tsx  # Wishlist quick-add overlay
      wishlist-picker.tsx   # Wishlist item picker
      use-text-input.ts     # useTextInput hook
      use-spinner.ts        # useSpinner hook
      use-review-list.ts    # useReviewList hook
      use-wishlist-store.ts # useWishlistStore hook
      use-terminal-size.ts  # useTerminalSize hook
      tui-constants.ts      # Shared TUI constants (colors, icons, helpers)
      tui-session.ts        # TUI session state hook/utilities
      alt-screen.ts         # Alt-screen enter/exit helpers
      bun-stdin.ts          # Bun stdin compatibility shim
      open-editor.ts        # Open $EDITOR for file editing
      theme.ts              # Color theme definitions
      i18n.ts               # Internationalisation strings
      strings/              # Localised string tables
      init-app.tsx          # Init wizard app component
      init-form.tsx         # Init form fields
      init-detect.ts        # Project type detection for init
      init-writer.ts        # Writes .wombo-combo/ config from init form
      init-cmd.test.ts      # Init command integration tests
      onboarding/           # Onboarding wizard components
        onboarding-app.tsx
        onboarding-wizard.tsx
        onboarding-utils.ts
        step-wizard.tsx
        section-picker.tsx
        field-editor.tsx
        profile-review.tsx
        progress-view.tsx
        confirm-dialog.tsx
        run-onboarding.ts
    daemon/                 # Background daemon for async agent scheduling
      daemon.ts             # Daemon process main loop
      launcher.ts           # Daemon process spawning
      scheduler.ts          # Task scheduling logic
      agent-runner.ts       # Runs agents inside the daemon
      client.ts             # Daemon IPC client
      protocol.ts           # IPC message protocol types
      state.ts              # Daemon state persistence
      pid-utils.ts          # PID file management
      index.ts              # Daemon entry point
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
- **TUI framework:** [Ink](https://github.com/vadimdemedes/ink) (React for
  terminals). All interactive terminal UI lives in `src/ink/`. The TUI uses
  a stack-based `ScreenRouter` (see `src/ink/router.tsx`) that is mounted
  once per session — do NOT spawn separate `inkRender()` calls to switch
  screens; instead use `push`, `pop`, `replace`, or `reset` from
  `useNavigation()`. Each `run-*.tsx` file is an entry point that calls
  `inkRender()` exactly once. Screens are registered in the `ScreenMap`
  passed to `ScreenRouter`.
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
- **Ink raw-mode errors:** Ink throws recoverable raw-mode errors as uncaught
  exceptions when stdin loses TTY status or during React re-render cycles.
  These are non-fatal — the global `uncaughtException` handler in `index.ts`
  silently swallows them (see the `"Raw mode is not supported"` guard).
- **ScreenRouter is a singleton per session:** The `ScreenRouter` in
  `src/ink/router.tsx` must be mounted exactly once. Do NOT unmount and
  remount it to switch screens. Use `push`/`pop`/`replace`/`reset` from
  `useNavigation()` to navigate between screens instead.

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
