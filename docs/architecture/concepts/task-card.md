# Task card

**Importance:** high  ·  **Lives in:** `src/core/api-contract.ts`, `src/core/task-board-mutations.ts`, `web-ui/src/state/board-state.ts`

A board item carrying a prompt, base ref, agent selection, and review settings — the unit of work the
board tracks.

## Domain model
Defined by `runtimeBoardCardSchema`; key fields include `id`, `prompt`, `baseRef`, `startInPlanMode`,
`agentId`, `agentModel` (CLI-path model override), `clineSettings` (Cline-SDK path), `skill`,
`autoReviewEnabled`/`autoReviewMode`, `externalIssue`, `prUrl`/`prState`/`prNumber`, `transitions`.
Schema changes are both wire AND on-disk (`board.json`) compatibility — keep additive/optional. Pure
mutation helpers live separately from the schema.

## Reuse / do-not-duplicate
- Relates to [Card lifecycle](card-lifecycle.md), [Worktree](worktree.md),
  [Task session](task-session.md), [Dependency links](dependency-links.md),
  [External-issue correlation](external-issue.md).
- **Do not duplicate:** `agentModel` (CLI) and `clineSettings` (Cline) are two distinct per-card
  model paths — don't merge them.
