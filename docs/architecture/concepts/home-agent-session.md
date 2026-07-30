# Home / architect agent session

**Importance:** medium  ·  **Lives in:** `src/core/home-agent-session.ts`, `src/server/architect-workspace.ts`, `web-ui/src/hooks/use-home-agent-session.ts`

A synthetic, project-scoped session for the sidebar agent that reuses task-session primitives without
a real card or worktree.

## Domain model
Identified by a minted synthetic id `__home_agent__:<workspaceId>` (deterministic so refreshes
reconnect; legacy `:<agentId>` ids still parse). No task card, no worktree, no implement/PR directive.
Terminal-backed home agents also carry a persisted session generation; within a generation the agent
CLI session id stays deterministic/resumable, and "Start fresh Session" bumps the generation so the
next launch starts a new conversation while old transcripts remain on disk. All supported harnesses run as terminal-backed sessions, rendered in the terminal panel. The raw prefix must not be duplicated in app code (lint-enforced).

## Reuse / do-not-duplicate
- Relates to [Workspace](workspace.md), [Task session](task-session.md),
  [Skill injection & directives](skill-injection.md).
- **Do not duplicate:** don't treat the sidebar as a normal task with a worktree.
