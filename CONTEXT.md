# CONTEXT.md — For AI agents using wombo as a tool

This file is for AI coding agents that are **orchestrated by wombo** in another
project. If you are an agent working **on the wombo codebase itself**, see
AGENTS.md instead.

---

## What is wombo?

Wombo (wombo-combo) is an AI agent orchestration system for parallel feature
development. It manages multiple AI coding agents working on different features
simultaneously, handling:

- Feature tracking and prioritization (`.features.yml`)
- Git worktree management (isolated branches per feature)
- Agent launching and monitoring
- Build verification
- Branch merging

## How you were launched

You were likely launched by `wombo launch` into a git worktree. Your working
directory is an isolated copy of the repository, checked out to a feature branch.

Key things to know:

1. **You are in a worktree**, not the main repository clone. Your changes are
   on a feature branch (e.g., `feature/my-feature-id`).
2. **Your task** is described in the feature's `.features.yml` entry. The
   feature ID was passed to your agent session.
3. **Build verification** will run after you finish. Make sure your code builds
   and passes any existing tests.

## Configuration

The project using wombo has a `wombo.json` config file at its root. Key fields:

```json
{
  "featuresFile": ".features.yml",
  "baseBranch": "develop",
  "build": {
    "command": "bun run build",
    "timeout": 300000
  },
  "install": {
    "command": "bun install",
    "timeout": 120000
  },
  "git": {
    "branchPrefix": "feature/",
    "worktreePrefix": "wombo-"
  }
}
```

## Querying wombo for state

Use `--output json` for machine-readable output:

```sh
# List all features
wombo features list --output json

# Show a specific feature
wombo features show <feature-id> --output json

# Check feature file validity
wombo features check --output json
```

Set `WOMBO_OUTPUT=json` to default all output to JSON without the flag.

## Feature file schema

Features are tracked in `.features.yml`. Each feature has:

- `id` — Unique kebab-case identifier
- `title` — Human-readable name
- `description` — Detailed goal
- `status` — One of: backlog, planned, in_progress, blocked, in_review, done, cancelled
- `priority` — One of: critical, high, medium, low, wishlist
- `difficulty` — One of: trivial, easy, medium, hard, very_hard
- `depends_on` — List of feature IDs that must be done first
- `effort` — ISO 8601 duration (e.g., "PT2H", "P1D")
- `subtasks` — Recursive subtask list (same schema)
- `constraints` — Things you MUST do
- `forbidden` — Things you MUST NOT do
- `references` — URLs/paths for relevant docs
- `notes` — Chronological status updates

## Rules for agents

1. **Stay in scope.** Only implement the feature you were assigned. Do not
   modify unrelated code.
2. **Respect constraints and forbidden lists.** These are non-negotiable
   boundaries set by the project maintainer.
3. **Keep commits focused.** Use conventional commits. Reference the feature ID.
4. **Don't push directly.** Wombo handles branch management. Just commit locally.
5. **Don't modify `.features.yml` directly** unless your task explicitly
   requires it. Status updates are handled by wombo.
6. **Build must pass.** Wombo will run the build command after you finish.
   Verify your changes build before completing.

## Input validation

Wombo validates all inputs. Feature IDs must be:
- Kebab-case (lowercase letters, digits, hyphens)
- 1-128 characters
- No path traversals (`../`)
- No query parameters (`?`, `#`)
- No percent-encoded characters

If you're calling wombo commands programmatically, sanitize inputs accordingly.
