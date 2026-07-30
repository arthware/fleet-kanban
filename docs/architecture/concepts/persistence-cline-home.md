# Persistence / CLINE_HOME on-disk layout

**Importance:** medium  ·  **Lives in:** `src/state/workspace-state.ts`, `src/fs/locked-file-system.ts`, `src/config/cline-home.ts`

The on-disk home (`$CLINE_HOME`, default `~/.cline`) holding board, session, index, and metadata JSON, worktrees, and durable session ledgers.

## Domain model
Per-workspace files under `$CLINE_HOME/kanban/workspaces/<workspaceId>/`:
- `board.json` — cards, columns, and prerequisite links.
- `sessions.json` — liveness and temporary execution summaries for active card sessions and overseer sessions.
- `index.json` — workspace metadata and project references.
- `meta.json` — workspace details.
- `worktrees/` — git worktrees checked out per active card.
- `sessions/<taskId>/` — generation-based durable [Session ledger](session-ledger.md) entries.

All writes go through atomic write and lockfile operations via `lockedFileSystem`; mutations use revision-based optimistic concurrency (`WorkspaceStateConflictError`).

**The hot/cold invariant rule:** Persisted session state in `sessions.json` is scoped strictly to active board cards. It is pruned when its corresponding card is gone/trashed, liveness-reconciled for active cards and overseers alike, and all hot-path narrative state fields are strictly bounded to prevent write-latency bottlenecks. Historical conversation pointers and cumulative token metrics are harvested off the hot path into the [Session ledger](session-ledger.md) before active session state is pruned.

## Reuse / do-not-duplicate
- Relates to [Workspace](workspace.md), [Task card](task-card.md), [Session ledger](session-ledger.md).
- **Do not duplicate:** Do not persist long-running transcript bodies or cumulative cost histories inside `sessions.json`. Keep hot state bounded and rely on the Session Ledger for all historical query paths.
