# Home / architect agent session

**Importance:** medium  ·  **Lives in:** `src/core/home-agent-session.ts`, `src/server/architect-workspace.ts`, `web-ui/src/hooks/use-home-agent-session.ts`

A synthetic, project-scoped session for the sidebar agent that reuses task-session primitives without
a real card or worktree.

## Domain model
Identified by a minted synthetic id `__home_agent__:<workspaceId>:<agentId>` (deterministic so
refreshes reconnect). No task card, no worktree, no implement/PR directive. Rotates when the project
or material agent config changes, but not when merely toggling sidebar tabs. Cline agent → native
chat; other agents → terminal panel. The raw prefix must not be duplicated in app code
(lint-enforced).

## Reuse / do-not-duplicate
- Relates to [Workspace](workspace.md), [Task session](task-session.md),
  [Skill injection & directives](skill-injection.md).
- **Do not duplicate:** don't treat the sidebar as a normal task with a worktree.
