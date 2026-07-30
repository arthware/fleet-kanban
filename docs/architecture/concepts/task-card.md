# Task card

**Importance:** high  ·  **Lives in:** `src/core/api-contract.ts`, `src/core/task-board-mutations.ts`, `web-ui/src/state/board-state.ts`

A board item carrying a prompt, base ref, agent selection, and review settings — the unit of work the board tracks.

## Domain model
Defined by `runtimeBoardCardSchema`; key fields include `id`, `prompt`, `baseRef`, `startInPlanMode`,
`agentId`, `agentModel` (CLI model override), `skill`, `autoReviewEnabled`/`autoReviewMode`, `externalIssue`, `prUrl`/`prState`/`prNumber`, `transitions`.
Legacy fields such as `clineSettings`, `clineProviderId`, and `clineModelId` are parsed for backward compatibility but stripped out during parsing.

Schema changes are both wire AND on-disk (`board.json`) compatibility — keep additive/optional. Pure mutation helpers live separately from the schema.

## Reuse / do-not-duplicate
- Relates to [Card lifecycle](card-lifecycle.md), [Worktree](worktree.md),
  [Task session](task-session.md), [Dependency links](dependency-links.md),
  [External-issue correlation](external-issue.md).
- **Do not duplicate:** Keep card schema and parsing rules defined exclusively inside `api-contract.ts`. Do not replicate card fields or create ad hoc parsers in client or other server modules.
