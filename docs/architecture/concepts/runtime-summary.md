# Runtime summary

**Importance:** high  ·  **Lives in:** `src/core/api-contract.ts`, `src/terminal/session-manager.ts`

The small product-shaped state object telling the board whether a session is idle, running, awaiting review, failed, or interrupted.

## Domain model
`runtimeTaskSessionSummarySchema`; state enum = `["idle","running","awaiting_review","failed","interrupted"]`
plus an attention/reason enum and fields like `agentSessionId` and checkpoints. It's the bridge
between long-running agent PTY process execution and the UI; held in runtime memory, streamed live, and persisted in `sessions.json`.

**The hot/cold rule invariant:** Persisted summaries in `sessions.json` are strictly scoped to their workspace and pruned as soon as their card is gone. Summaries are liveness-reconciled for active cards and overseers alike. All narrative/historical fields inside the summary are strictly bounded to prevent write-latency bottlenecks (such as from massive hook output). Long-lived history is harvested off the hot path and stored in the [Session ledger](session-ledger.md).

## Reuse / do-not-duplicate
- Relates to [Runtime state fanout](runtime-state-fanout.md), [Task session](task-session.md), [Session ledger](session-ledger.md).
- **Do not duplicate:** Keep summary fields lean, bounded, and focused on active hot-path execution. Do not use the summary to store complete transcript narrative history or cumulative costs across execution generations.
