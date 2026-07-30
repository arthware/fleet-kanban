# Session ledger

**Importance:** high  ·  **Lives in:** `src/core/session-ledger.ts`

A durable per-card record of session pointers, metrics, and metadata harvested before pruning, kept deliberately off the hot path.

## Domain model
The session ledger records critical history for task cards such as `agentSessionId`, `openedAt`, `closedAt`, total token `usage`, and source artifact metrics. Ledgers are organized by task ID and incremented by execution generation. They ensure that card conversation history and cumulative costs remain fully queryable even after active card state has been pruned or trashed.

## Reuse / do-not-duplicate
- Relates to [Task session](task-session.md), [Persistence / CLINE_HOME on-disk layout](persistence-cline-home.md).
- **Do not duplicate:** Do not load or save ledger entries on the hot path of board operations or `sessions.json` mutations. Keep ledger queries localized to cost and transcript history requests.
