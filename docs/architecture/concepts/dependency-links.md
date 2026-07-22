# Dependency links between cards

**Importance:** medium  ·  **Lives in:** `src/core/api-contract.ts`, `src/core/task-board-mutations.ts`, `web-ui/src/components/kanban-board.tsx`

Directed prerequisite edges between cards, stored on the board and used to gate/unblock work.

## Domain model
`runtimeBoardDependencySchema` = `{id, fromTaskId, toTaskId, createdAt}`; the board carries a
`dependencies` array (defaults to `[]`). When a card enters review, dependents still in backlog become
"ready". Edges are validated/deduped against real endpoints in the mutation helpers.

## Reuse / do-not-duplicate
- Relates to [Card lifecycle](card-lifecycle.md), [Task card](task-card.md).
- **Do not duplicate:** dependencies are board-level edges, not a card field.
