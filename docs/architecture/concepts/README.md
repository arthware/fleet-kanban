# Concept map

The curated set of **core domain concepts** in this codebase — each with its one canonical home — so
that a change **reuses or extends** what exists instead of re-inventing a near-duplicate. This is the
concrete thing [Constitution Article 1](../constitution.md#article-1--concepts-first-reuse-extend-or-abstract-before-you-build)
checks against.

One file per concept (`<concept>.md`). This index is the *map*: the list, and the relationship /
**do-not-duplicate** edges you lose if you only read files in isolation.

## How it's used

- **Architect, at card-authoring time:** identify which concepts a card touches, name them in the card,
  and point at their canonical home. If the card would introduce something, walk Article 1: *fits →
  use · close → extend · converging → abstract · genuinely new → new concept file.*
- **Card agent, at start:** read the concepts your card names before writing code; extend the canonical
  home, don't clone it.

## Curation rule (in-lifecycle, not a side artifact)

A stale map that names a moved file is worse than no map. So curation is **part of the card
lifecycle**: a card that **establishes, moves, or removes** a concept updates the relevant
`concepts/*.md` file **in the same PR**. Entries point at stable module/file anchors, never line
numbers. The architect reconciles the map on merge.

## Concept file template

```md
# <Name>

**Importance:** high | medium · **Lives in:** `path/one.ts`, `path/two.ts`

<One sentence: what it is.>

## Domain model
<2–4 sentences: the shape + key invariants. High-level, not the implementation.>

## Reuse / do-not-duplicate
- Relates to [Other concept](other.md), [Another](another.md).
- **Do not duplicate:** <the specific near-duplicate trap to avoid.>
```

## Index

### Core

| Concept | What | Lives in |
| --- | --- | --- |
| [Workspace](workspace.md) | an indexed git repo Kanban has opened; top-level scope for board/runtime state | `src/server/workspace-registry.ts`, `src/state/workspace-state.ts` |
| [Task card](task-card.md) | a board item with prompt, base ref, agent + review settings | `src/core/api-contract.ts`, `src/core/task-board-mutations.ts` |
| [Card lifecycle / columns](card-lifecycle.md) | backlog→in_progress→review→done (+trash=archive) | `src/core/task-lifecycle.ts`, `src/core/api-contract.ts` |
| [Worktree](worktree.md) | per-card git worktree with a deterministic branch | `src/workspace/task-worktree.ts` |
| [Task session](task-session.md) | the live runtime on a card — PTY process or native Cline session | `src/terminal/session-manager.ts`, `src/cline-sdk/cline-task-session-service.ts` |
| [Runtime summary](runtime-summary.md) | small state object: idle/running/awaiting_review/failed/interrupted | `src/core/api-contract.ts`, `src/cline-sdk/cline-session-state.ts` |
| [tRPC contract & runtime-api](trpc-contract.md) | the typed spine + the coordinator that routes every request | `src/core/api-contract.ts`, `src/trpc/runtime-api.ts` |
| [Runtime state fanout](runtime-state-fanout.md) | the hub that streams board/session deltas to the browser | `src/server/runtime-state-hub.ts` |
| [Cline SDK boundary](cline-sdk-boundary.md) | maps task semantics onto the SDK; keeps SDK internals contained | `src/cline-sdk/` |
| [Agent catalog](agent-catalog.md) | registry of supported agents (Cline-native vs CLI/PTY) | `src/core/agent-catalog.ts`, `src/terminal/agent-session-adapters.ts` |

### Secondary

| Concept | What | Lives in |
| --- | --- | --- |
| [Home / architect agent session](home-agent-session.md) | synthetic project-scoped sidebar session; no card, no worktree | `src/core/home-agent-session.ts`, `src/server/architect-workspace.ts` |
| [Auto-review / PR mode](auto-review-pr-mode.md) | per-card mode: commit, open one idempotent PR, leave in Review | `src/prompts/pr-card-directive.ts`, `src/core/api-contract.ts` |
| [Skill injection & directives](skill-injection.md) | symlink `.agents/skills` into worktrees + one-line skill directives | `src/prompts/`, `src/workspace/task-worktree.ts` |
| [Persistence / CLINE_HOME](persistence-cline-home.md) | on-disk board/session JSON + worktrees, atomic + optimistic-concurrency | `src/state/workspace-state.ts`, `src/fs/locked-file-system.ts` |
| [External-issue correlation](external-issue.md) | optional link from a card to its Linear/GitHub source issue | `src/core/external-issue.ts`, `src/core/api-contract.ts` |
| [Dependency links](dependency-links.md) | directed prerequisite edges between cards | `src/core/api-contract.ts`, `src/core/task-board-mutations.ts` |
| [Runtime modes](runtime-modes.md) | native Cline chat vs CLI task terminal vs workspace shell | `src/terminal/`, `src/cline-sdk/` |
| [Architect workspace classification](architect-workspace.md) | which opened repo is the architect + its context preamble | `src/server/architect-workspace.ts`, `src/prompts/append-system-prompt.ts` |
