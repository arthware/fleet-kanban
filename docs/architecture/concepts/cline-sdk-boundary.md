# Cline SDK boundary layer

**Importance:** high  ·  **Lives in:** `src/cline-sdk/` (boundaries `sdk-provider-boundary.ts`, `sdk-runtime-boundary.ts`; facade `cline-task-session-service.ts`)

The integration layer that maps Kanban task semantics onto the native Cline SDK, keeping SDK internals
out of the rest of the codebase.

## Domain model
Only two modules may import `@clinebot/*` (lint-enforced): `sdk-provider-boundary.ts` (provider/OAuth)
and `sdk-runtime-boundary.ts` (session host + persisted sessions). Above them sit Kanban-facing
services (provider, task-session, session-runtime, message-repository, event-adapter, session-state).
Kanban thinks in task ids/summaries/chat messages; the SDK thinks in provider settings/session
ids/raw events/artifacts.

## Reuse / do-not-duplicate
- Relates to [Task session](task-session.md),
  [Persistence / CLINE_HOME](persistence-cline-home.md), [Agent catalog](agent-catalog.md).
- **Do not duplicate:** never import SDK packages outside the two boundary modules; don't mirror SDK
  settings/OAuth into Kanban config.
