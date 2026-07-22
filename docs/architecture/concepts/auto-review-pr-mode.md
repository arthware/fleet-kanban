# Auto-review / PR mode

**Importance:** medium  ·  **Lives in:** `src/prompts/pr-card-directive.ts`, `src/core/api-contract.ts`, `src/server/workspace-metadata-monitor.ts`

A per-card mode where the agent commits, opens one idempotent PR against the card's base, and leaves
the card in Review.

## Domain model
Card fields `autoReviewEnabled` + `autoReviewMode` (only value `"pr"`; legacy modes normalized away).
When enabled, the PR-card directive is prepended to the prompt (via the fleet-pr skill). PR state
(`prUrl`/`prState` open|merged|closed/`prNumber`) is captured once when detected and persisted onto
the card. Orthogonal to build/plan cards — skills compose.

## Reuse / do-not-duplicate
- Relates to [Card lifecycle](card-lifecycle.md),
  [Skill injection & directives](skill-injection.md),
  [External-issue correlation](external-issue.md).
- **Do not duplicate:** PR state is persisted on the card — don't re-query `gh` at render time.
