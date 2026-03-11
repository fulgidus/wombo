# wombo-combo

AI agent orchestration for parallel feature development.

## Install

```sh
# npm
npm install -g wombo-combo

# bun (from GitHub)
bun add -g github:fulgidus/wombo-combo
```

## Quick start

```sh
# Initialize project (generates wombo.json and .features.yml)
woco init

# Edit .features.yml to define your features, then launch agents
woco launch --all-ready

# Monitor, verify, merge
woco status
woco verify
woco merge
```

## Commands

| Command | Description |
|---------|-------------|
| `woco init` | Generate config in the current project |
| `woco launch` | Launch a wave of agents |
| `woco resume` | Resume a stopped wave |
| `woco status` | Show wave status |
| `woco verify` | Run build verification |
| `woco merge` | Merge verified branches |
| `woco retry <id>` | Retry a failed agent |
| `woco cleanup` | Remove worktrees and sessions |
| `woco features list` | List features |
| `woco features add` | Add a feature |
| `woco features set-status <id> <status>` | Update feature status |
| `woco features check` | Validate features file |
| `woco features show <id>` | Show feature details |
| `woco upgrade` | Check for updates and upgrade |

## Launch options

```sh
woco launch --all-ready              # all features with met dependencies
woco launch --top-priority 3         # top 3 by priority
woco launch --quickest-wins 3        # 3 lowest-effort features
woco launch --features "id1,id2"     # specific features
woco launch --interactive            # tmux TUI mode
woco launch --dry-run                # preview without launching
```

## License

MIT
