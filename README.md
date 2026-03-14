# wombo-combo

AI agent orchestration for parallel feature development.

## Install

```sh
# bun
bun a -g wombo-combo
# npm
npm i -g wombo-combo

# bun (from GitHub)
bun a -g github:fulgidus/wombo-combo
# npm (from GitHub)
npm i -g github:fulgidus/wombo-combo
```

## Quick start

```sh
# Initialize project (generates .wombo-combo/config.json and .wombo-combo/tasks.yml)
woco init

# Edit .wombo-combo/tasks.yml to define your features, then launch the TUI
woco
```

Running `woco` with no arguments opens the interactive TUI — a full-screen
task browser where you can evaluate tasks, select them, adjust priorities,
and launch waves of agents. When a wave is running, the TUI switches to a
live monitor showing agent status, activity logs, and build output.

You can also drive everything from the CLI:

```sh
woco launch --all-ready    # launch all tasks with met dependencies
woco status                # show wave status
woco verify                # run build verification
woco merge                 # merge verified branches
```

## Commands

| Command                               | Description                                       |
| ------------------------------------- | ------------------------------------------------- |
| `woco`                                | Open interactive TUI (default, no args needed)    |
| `woco init`                           | Generate config in the current project             |
| `woco launch`                         | Launch a wave of agents                            |
| `woco resume`                         | Resume a stopped wave                              |
| `woco status`                         | Show wave status                                   |
| `woco verify`                         | Run build verification                             |
| `woco merge`                          | Merge verified branches                            |
| `woco retry <id>`                     | Retry a failed agent                               |
| `woco abort <id>`                     | Kill a running agent (--requeue to return to queue)|
| `woco logs <id>`                      | View agent logs (--tail N, --follow)               |
| `woco cleanup`                        | Remove worktrees and sessions                      |
| `woco history`                        | List/view past wave results                        |
| `woco usage`                          | Show token usage statistics                        |
| `woco tasks list`                     | List tasks                                         |
| `woco tasks add <id> <title>`         | Add a task                                         |
| `woco tasks set-status <id> <status>` | Update task status                                 |
| `woco tasks set-priority <id> <p>`    | Update task priority                               |
| `woco tasks check`                    | Validate tasks file                                |
| `woco tasks show <id>`               | Show task details                                  |
| `woco tasks graph`                    | Visualize dependency graph (--ascii, --mermaid)    |
| `woco upgrade`                        | Check for updates and upgrade                      |
| `woco help`                           | Show full help (also: -h, --help)                  |

Every command has a short alias (e.g. `woco l` = `woco launch`,
`woco t ls` = `woco tasks list`). Run `woco help` for the full list.

## TUI

The interactive TUI has two views:

**Task Browser** — browse all tasks organized by dependency streams.

| Key       | Action                              |
| --------- | ----------------------------------- |
| Space     | Toggle task selection               |
| S         | Toggle entire dependency stream     |
| a         | Select / deselect all               |
| +/-       | Change priority of selected task    |
| d         | Hide / show done tasks              |
| c         | Cycle max concurrency               |
| F5        | Cycle sort field                    |
| L         | Launch selected tasks as a new wave |
| q         | Quit (session is saved)             |

**Wave Monitor** — shown automatically when a wave is running.

| Key       | Action                              |
| --------- | ----------------------------------- |
| Up/Down   | Navigate agent list                 |
| Enter     | Attach to agent session / view log  |
| r         | Retry a failed agent                |
| b         | Show build log                      |
| p         | Toggle auto-scroll                  |
| q         | Quit                                |

Session state (selections, sort, concurrency) is persisted to
`.wombo-combo/tui-session.json` so you can close and reopen without
losing work.

## Token Usage Tracking

wombo-combo automatically tracks token consumption during agent runs. Every
agent step that includes token data is recorded to `.wombo-combo/usage.jsonl`
as an append-only log. Use the `usage` command (alias: `us`) to view
aggregated statistics.

```sh
woco usage                              # show total token usage
woco usage --by task                    # group by task
woco usage --by model                   # group by model
woco usage --by provider                # group by provider
woco usage --by quest                   # group by quest
woco usage --by harness                 # group by agent harness
woco usage --since 2026-01-01           # filter from date (inclusive)
woco usage --until 2026-03-01           # filter until date (inclusive)
woco usage --format json                # JSON output (default: table)
```

Token data is collected automatically when agents run via `woco launch`.
Each record includes input/output tokens, cache read/write tokens,
reasoning tokens, cost, model, provider, and harness information.

In the TUI, press **U** in the Task Browser to open the token usage overlay,
which shows overall totals and per-group breakdowns with Tab to cycle grouping.

## Launch options

```sh
woco launch --all-ready              # all features with met dependencies
woco launch --top-priority 3         # top 3 by priority
woco launch --quickest-wins 3        # 3 lowest-effort features
woco launch --tasks "id1,id2"        # specific tasks
woco launch --interactive            # tmux TUI mode
woco launch --dry-run                # preview without launching
```

## License

MIT
