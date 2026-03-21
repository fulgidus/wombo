## ADDED Requirements

### Requirement: Temporary worktrees are created outside the project repository
The system SHALL create all temporary merge worktrees in a directory that is a sibling to the project root, not inside `.wombo-combo/` or any other path within the repository.

#### Scenario: mergeBranch creates tmp worktree outside the repo
- **WHEN** `mergeBranch()` is called
- **THEN** the temporary worktree path SHALL be outside the project root directory

#### Scenario: syncQuestBranch creates tmp worktree outside the repo
- **WHEN** `syncQuestBranch()` is called
- **THEN** the temporary worktree path SHALL be outside the project root directory

### Requirement: Temporary worktree paths are unique per invocation
The system SHALL generate a unique path for each temporary worktree to prevent collisions between concurrent or sequential merge operations.

#### Scenario: Concurrent mergeBranch calls do not collide
- **WHEN** two `mergeBranch()` calls are made close together in time
- **THEN** each SHALL use a distinct temporary directory path

#### Scenario: syncQuestBranch no longer uses a static path
- **WHEN** `syncQuestBranch()` is called multiple times
- **THEN** each invocation SHALL use a path containing a unique timestamp or identifier

### Requirement: Temporary worktrees are cleaned up after merge operations
The system SHALL remove temporary worktrees after merge operations complete, whether the merge succeeded or failed.

#### Scenario: Cleanup on successful merge
- **WHEN** a merge operation completes successfully
- **THEN** the temporary worktree directory SHALL be removed via `git worktree remove --force`

#### Scenario: Cleanup on failed merge
- **WHEN** a merge operation fails or throws an error
- **THEN** the temporary worktree directory SHALL still be removed (via `finally` block)
