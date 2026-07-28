# Worktree

**Importance:** high  ·  **Lives in:** `src/workspace/task-worktree.ts`, `src/workspace/task-worktree-path.ts`, `src/workspace/turn-checkpoints.ts`

A per-task git worktree giving each card an isolated working directory and deterministic branch.

## Domain model
Created lazily (`ensureTaskWorktreeIfDoesntExist` = `git worktree add --detach`), removed via
`git worktree remove/prune`. Path = `$CLINE_HOME/worktrees/<normalizedTaskId>/<repoLabel>/`. On
creation, the runtime merges and symlinks individual active skills into `.agents/skills` inside the
worktree (see [Skill injection & directives](skill-injection.md) for the precise resolution order and merged mount details).
Per-turn checkpoints are separate. The home/architect agent deliberately has NO worktree.

Git-ignored paths are mirrored in as absolute symlinks, decided by **structure, not artifact name**
(`task-worktree-unshared-paths.ts`): shared only at the repo root or in a subtree git tracks nothing
in, so nothing escaping ever lands inside a tracked source tree. See
`docs/design/171-worktree-mirroring-structural-rule.md`.

## Reuse / do-not-duplicate
- Relates to [Task session](task-session.md), [Skill injection & directives](skill-injection.md),
  [Persistence / CLINE_HOME](persistence-cline-home.md).
- **Do not duplicate:** worktree lifecycle is a Kanban concept (not the SDK's) — one owner here.
