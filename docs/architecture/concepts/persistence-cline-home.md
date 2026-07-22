# Persistence / CLINE_HOME on-disk layout

**Importance:** medium  ·  **Lives in:** `src/state/workspace-state.ts`, `src/fs/locked-file-system.ts`, `src/config/cline-home.ts`

The on-disk home (`$CLINE_HOME`, default `~/.cline`) holding board/session/index/meta JSON and
worktrees, written atomically with optimistic concurrency.

## Domain model
Per-workspace files: `index.json`, `board.json`, `sessions.json`, `meta.json`, plus a `worktrees/`
tree. All writes go through atomic write + lockfile; mutations use revision-based optimistic
concurrency (`WorkspaceStateConflictError`). This is a SEPARATE store from the Cline SDK's own message
data dir.

## Reuse / do-not-duplicate
- Relates to [Workspace](workspace.md), [Task card](task-card.md),
  [Cline SDK boundary](cline-sdk-boundary.md).
- **Do not duplicate:** `board.json`/`sessions.json` do NOT hold Cline raw messages (those live in the
  SDK data dir); don't conflate the two stores.
