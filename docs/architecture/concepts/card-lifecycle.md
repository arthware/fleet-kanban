# Card lifecycle / columns

**Importance:** high  ·  **Lives in:** `src/core/task-lifecycle.ts`, `src/core/api-contract.ts`, `src/core/task-board-mutations.ts`

The fixed column set a card moves through: backlog → in_progress → review → done, plus trash.

## Domain model
Columns enum = `["backlog","in_progress","review","done","trash"]`. Trash is archive, NOT delete
(cards stay in the trash column). Each move appends a `transitions` entry (`{column, at}`), backfilled
for legacy cards; `done` cards sort by completion time. Legacy boards with a trash-but-no-done shape
are migrated (trash→done + fresh trash) at parse time.

## Reuse / do-not-duplicate
- Relates to [Task card](task-card.md), [Auto-review / PR mode](auto-review-pr-mode.md),
  [Dependency links](dependency-links.md).
- **Do not duplicate:** reuse `BoardLifecycleColumnId`; don't re-enumerate column strings.
