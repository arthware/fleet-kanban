# Worktree

**Importance:** high  ·  **Lives in:** `src/workspace/task-worktree.ts`, `src/workspace/task-worktree-path.ts`, `src/workspace/turn-checkpoints.ts`

A per-task git worktree giving each card an isolated working directory and deterministic branch.

## Domain model
Created lazily (`ensureTaskWorktreeIfDoesntExist` = `git worktree add --detach`), removed via
`git worktree remove/prune`. Path = `$CLINE_HOME/worktrees/<normalizedTaskId>/<repoLabel>/`. On
creation the runtime symlinks `.agents/skills` into the worktree (skill injection). Per-turn
checkpoints are separate. The home/architect agent deliberately has NO worktree.

## Reuse / do-not-duplicate
- Relates to [Task session](task-session.md), [Skill injection & directives](skill-injection.md),
  [Persistence / CLINE_HOME](persistence-cline-home.md).
- **Do not duplicate:** worktree lifecycle is a Kanban concept (not the SDK's) — one owner here.
