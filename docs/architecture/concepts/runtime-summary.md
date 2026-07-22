# Runtime summary

**Importance:** high  ·  **Lives in:** `src/core/api-contract.ts`, `src/cline-sdk/cline-session-state.ts`

The small product-shaped state object telling the board whether a session is idle, running, awaiting
review, failed, or interrupted.

## Domain model
`runtimeTaskSessionSummarySchema`; state enum = `["idle","running","awaiting_review","failed","interrupted"]`
plus an attention/reason enum and fields like `agentSessionId` and checkpoints. It's the bridge
between long-running agent work and the UI; held in runtime memory + streamed, and persisted in
`sessions.json`. Cline's default summary is minted separately.

## Reuse / do-not-duplicate
- Relates to [Runtime state fanout](runtime-state-fanout.md), [Task session](task-session.md).
- **Do not duplicate:** add summary fields here + in `createDefaultSummary`, not ad hoc per surface.
