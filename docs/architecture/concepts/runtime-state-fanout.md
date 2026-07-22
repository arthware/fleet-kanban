# Runtime state fanout

**Importance:** high  ·  **Lives in:** `src/server/runtime-state-hub.ts`, `web-ui/src/runtime/use-runtime-state-stream.ts`

The central hub that streams contract-typed board/session/chat deltas to the browser.

## Domain model
Listens to terminal summaries, Cline summaries + messages, and workspace metadata/state changes, then
broadcasts stream messages (`snapshot`, `workspace_state_updated`, `task_sessions_updated`,
`task_chat_message`, …). Kanban is push-based, not poll-based; the browser folds these into one
reducer. Stream message shapes are part of the contract union.

## Reuse / do-not-duplicate
- Relates to [Runtime summary](runtime-summary.md),
  [tRPC contract & runtime-api chokepoint](trpc-contract.md).
- **Do not duplicate:** don't add polling or a second summary-derivation path; route live state
  through the hub.
