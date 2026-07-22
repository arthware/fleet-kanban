# Workspace

**Importance:** high  ·  **Lives in:** `src/server/workspace-registry.ts`, `src/state/workspace-state.ts`, `src/server/architect-workspace.ts`

An indexed git repository that Kanban has opened; the top-level scope for almost all board and
runtime state.

## Domain model
Everything (board, sessions, worktrees, streams, tRPC clients) is keyed by a `workspaceId`. Each
workspace has one board, one session map, and one on-disk state dir. A workspace may be classified as
an "architect" workspace (outermost container wins) that hosts the home/sidebar agent.

## Reuse / do-not-duplicate
- Relates to [Task card](task-card.md), [Persistence / CLINE_HOME](persistence-cline-home.md),
  [Home / architect agent session](home-agent-session.md).
- **Do not duplicate:** don't invent a second workspace-keying scheme; the registry is the single
  map.
