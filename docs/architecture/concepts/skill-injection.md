# Skill injection & card directives

**Importance:** medium  ·  **Lives in:** `src/prompts/implement-card-directive.ts`, `src/prompts/pr-card-directive.ts`, `src/prompts/plan-card-directive.ts`, `src/prompts/append-system-prompt.ts`, `src/workspace/task-worktree.ts`

The mechanism that makes agent skills available in each worktree and prepends one-line directives
naming which skill to use.

## Domain model
On worktree creation, the canonical `.agents/skills` dir is symlinked into the worktree so agents load
skill bodies natively. The runtime injects only a one-line directive (never restating skill internals,
to avoid drift): build cards get the fleet-implement directive, PR cards the fleet-pr directive, plan
cards the plan directive. A card's `skill` field points to an optional extra skill. Home agent and
plan-mode cards are exempt from the implement directive.

## Reuse / do-not-duplicate
- Relates to [Worktree](worktree.md), [Auto-review / PR mode](auto-review-pr-mode.md),
  [Home / architect agent session](home-agent-session.md).
- **Do not duplicate:** directives name a skill only — put behavior in the skill body, not the
  directive string.
