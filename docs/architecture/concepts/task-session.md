# Task session

**Importance:** high  ·  **Lives in:** `src/terminal/session-manager.ts`, `src/cline-sdk/cline-task-session-service.ts`, `src/terminal/agent-session-launch.ts`

The live runtime attached to a card — either a PTY-backed CLI process or a native Cline SDK session.

## Domain model
Two execution paths behind one runtime surface: CLI agents run as PTY processes (process-oriented,
live-only); Cline runs as a session (session-oriented, with persisted-message hydration surviving
session end). Keyed by task id; lifecycle classified `attached`/`resumable`/`gone`. The browser is
never the source of truth for session lifecycle.

## Reuse / do-not-duplicate
- Relates to [Runtime summary](runtime-summary.md), [Worktree](worktree.md),
  [Cline SDK boundary](cline-sdk-boundary.md), [Agent catalog](agent-catalog.md).
- **Do not duplicate:** don't push Cline toward "just another CLI"; keep the two paths distinct.
