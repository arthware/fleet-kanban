# Review-comment feedback loop — design & verdict

**Card:** 47b23 · **Type:** design / validation (not a build card) · **Author agent:** Opus
**Base branch:** `production-line`

> **TL;DR — Verdict (a): don't build it.** The thing this card contemplates already exists in the
> fork *twice over*, and GitHub gives us the one piece it doesn't. The full inline-diff-comment UI
> ships today (inherited from upstream `cline/kanban`); the agent-emittable steering path ships today
> (`fleet task say`); and line-anchored **tracking** — the only capability neither of those has — is
> already free via GitHub PR review threads, which the fixing agent can read *and* resolve. Building a
> board-native tracked-comment store would be a parallel channel that duplicates all three. The
> recommended action is a **convention + one doc paragraph**, plus an *optional* read-only card chip
> that surfaces the PR's unresolved-thread count. No new `api-contract` objects, no new store, no new
> UI on the critical path.

---

## 0. What I found before designing anything (this changes the question)

The card frames this as "competitors let you drop inline comments on diff lines; should we build the
same?" That framing is stale for our codebase. Three facts on the ground:

### Fact 1 — the inline-diff-comment UI already ships in this fork

It came in from upstream `cline/kanban` and is wired live. The pieces:

- **Data shape** — `web-ui/src/components/detail-panels/diff-viewer-panel.tsx:39`:
  ```ts
  export interface DiffLineComment {
    filePath: string;
    lineNumber: number;
    lineText: string;
    variant: "added" | "removed" | "context";
    comment: string;
  }
  ```
- **UI** — `InlineComment` (a per-line textarea, `diff-viewer-panel.tsx:90`) rendered inside the
  unified/split diff; comments held in a `Map<string, DiffLineComment>` keyed `file:variant:line`
  (`card-detail-view.tsx:463`).
- **Delivery** — `formatCommentsForTerminal()` (`diff-viewer-panel.tsx:54`) turns the map into
  `file:line | <line text>` blocks with `> comment` bodies, then hands them to
  `handleAddDiffComments` / `handleSendDiffComments` (`card-detail-view.tsx:644,656`). Those route to
  either the Cline chat composer (`appendToDraft` / `sendText`) or, for PTY agents (Codex/Claude), to
  `onAddReviewComments` / `onSendReviewComments` → `handleAddReviewComments` /
  `handleSendReviewComments` (`use-board-interactions.ts:226,241`) → `sendTaskSessionInput` (paste,
  then Enter).

So **verdict (c) — "build the full inline-diff-comment UI" — is already done for the human.** We would
be re-implementing shipped code.

### Fact 2 — it is one-shot and untracked, *by design*, and so is the competitor's

Comments are cleared whenever the selected card changes (`setDiffComments(new Map())`,
`card-detail-view.tsx:633`). There is no `resolved` flag, no persistence, no per-comment lifecycle.
They are assembled into one message and consumed.

This is **exactly** what vibe-kanban does — their own docs say so:

> "Comments are not sent individually. They are collected and submitted together when you send a
> message in the chat." … "Comments are consumed when you send a message. They become part of the
> chat history. Add new comments for the next review round."
> — `.research/vibe-kanban/docs/reviewing-code.mdx`

The competitor's inline comments are **prompt-assembly UI**, not a tracked checklist. The only place
vibe-kanban shows *tracked* review state is its **GitHub integration** — it renders submitted PR
review comments inline and reads their resolution from GitHub
(`.research/vibe-kanban/docs/workspaces/changes.mdx` §"GitHub Integration"). It did not build its own
comment store either; for tracking it leans on GitHub. That is the tell.

### Fact 3 — the agent-emittable steering path already exists

`fleet task say <id> "…"` is not hypothetical. It flows through the same runtime procedure the inline
UI uses — `runtime.sendTaskSessionInput` — and the schema documents it:

```ts
// src/core/api-contract.ts:1180
export const runtimeTaskSessionInputRequestSchema = z.object({
  taskId: z.string(),
  text: z.string(),
  appendNewline: z.boolean().optional(),
  // Steering (`fleet task say`): wrap the payload in bracketed-paste markers so a
  // mid-generation PTY agent buffers it as one paste instead of interleaving it… 
  bracketedPaste: z.boolean().optional(),
  submit: z.boolean().optional(),
});
```

So the orchestrating agent (often *me*) already has a first-class, structured way to steer a card
from the CLI. What it emits is **prose**, not line anchors — that's the only gap on the agent side,
and §Q4 shows GitHub already fills it.

**Net:** the interesting question is no longer "should we build inline comments." It's the narrower
"is a **board-native, tracked, agent-emittable** comment object worth building, given that the human
UI, the agent steering verb, and GitHub's tracked threads all already exist?" The gate below answers
that honestly.

---

## 1. Decision gate

### Q1 — Is line-anchored feedback meaningfully better than a plain steering prompt?

**Marginally, and only for disambiguation — and we already have the anchor UI when we want it.**

Where prose *does* cost a round-trip: when the same token or call recurs several times in one hunk and
a prose comment can't say which. Concrete example from a real recent diff, `9593b32`
(`fleet service restart`), which added three `launchctl` calls to one function:

```
+  launchctl bootout   "gui/$(id -u)/$label"  2>/dev/null || true
+  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || { dim "launchctl bootstrap failed"; return 1; }
   launchctl kickstart -k "gui/$(id -u)/$label"
```

- **Prose steering:** *"the launchctl call should check its exit code"* → ambiguous across three
  calls; the fixing agent has to guess or ask → possible extra round-trip.
- **Line anchor:** `fleet/fleet:… | launchctl bootstrap … > check exit code here` → unambiguous.

But two things blunt this into a small win:

1. **Prose can disambiguate cheaply too** — *"the `bootstrap` call, not `bootout`"* is one clause and
   costs nothing. Round-trips come from *vague* feedback ("this is wrong"), not from *unanchored*
   feedback. An anchor doesn't make a lazy comment specific; a specific comment rarely needs an
   anchor.
2. **The fixing agent re-reads the file anyway.** It greps/opens the target before editing, so a
   named symbol resolves the location as well as a line number does. Anchors help humans more than
   agents.

And crucially: **when the human does want the anchor, the inline UI already produces it** (Fact 1).
There is nothing to build to get this win.

**Answer:** real but small; already available; not a reason to build anything new.

### Q2 — Is the win "anchoring" or "tracking"?

**Tracking is the only genuinely-absent capability — and it still doesn't clear the bar.**

A `say` prompt genuinely cannot turn "5 comments" into "5 items the fixing agent ticks off, so the
architect sees *3 of 5 addressed*." That checklist/round-trip-accounting is the one thing prose lacks.
So if anything justifies machinery, it's tracking, not anchoring.

But it fails the cost/benefit three ways:

1. **Neither the fork nor the competitor actually built it.** Both fold comments into one message
   (Fact 2). If line-item resolution were the high-value primitive, the incumbents would have it. Its
   absence everywhere is evidence the demand is weak.
2. **GitHub already provides it** (Q3) — resolvable review threads with counts, for free, in the PR
   mode we already default to.
3. **A board-native version is real machinery for an unmeasured need.** It means: first-class comment
   objects persisted through `api-contract.ts`, a resolution-state store synced across board reloads,
   and an agent write-back protocol so the fixing agent can mark items resolved. We have **no logged
   instance** of a review round-trip that a checklist would have saved. Building a durable store
   against a hypothetical is exactly the cost spiral `AGENTS.md` warns against.

**Answer:** the win is tracking, not anchoring — and tracking is already covered by GitHub, so it does
not justify a new store.

### Q3 — Does GitHub already give us this for free?

**Yes — ~90%.** PR review comments are line-anchored, tracked (resolvable threads with counts), and
fully accessible to an agent on both sides:

- **Emit (human):** the PR "Files changed" UI, or `gh pr review --comment`.
- **Emit (agent):** `gh api repos/:o/:r/pulls/:n/comments -f path=… -F line=… -f body=…`, or the
  GraphQL `addPullRequestReviewThread`.
- **Read (fixing agent):** `gh pr view <n> --comments`, `gh api repos/:o/:r/pulls/:n/comments`.
- **Resolve (fixing agent):** GraphQL `resolveReviewThread` — this is the tick-the-box the board
  can't do natively.

Our house default is already **PR mode** (a card lands as a PR → review → merge; see the team's
"use PR mode not local commit" convention), so the review surface *is* a PR for most cards. The
architect leaves review comments on the PR; the fixing agent reads unresolved threads, addresses each,
and resolves them; the architect sees "2 unresolved" on GitHub. **Zero new board UI.**

What a board-native version would add over GitHub:

- **(a) Works before a PR exists** — during the local/steering phase there's no PR to comment on. But
  that phase is already covered by the shipped inline-diff UI + `fleet task say` (Facts 1 & 3). So
  this isn't a gap, it's a different tool for a different phase.
- **(b) Counts on the card face** without opening GitHub — a minor glance-ability QoL. This is the
  *only* sliver worth considering, and it can be a **read-only projection of GitHub's own counts**,
  not a store (see §Optional).

**Answer:** GitHub covers the tracked-feedback loop end-to-end for the PR phase, which is our default
phase. The pre-PR phase is covered by shipped tooling. There's no 10% gap that needs a store.

### Q4 — Agent-architect ergonomics (the crux)

The architect here is frequently an agent, not a human clicking a diff. For an agent, a "comment" is a
better contract than a prompt **only if it's emittable as structured data** and **trackable**.
Inventory of what the agent architect can emit *today*:

| Surface | Line-anchored | Tracked (resolve) | Agent-emittable | Phase |
|---|---|---|---|---|
| `fleet task say` (prose steer) | ✗ | ✗ | ✓ (CLI) | pre-PR & PR |
| Board inline-diff comments | ✓ | ✗ | **✗ (human-only UI)** | pre-PR |
| **GitHub PR review threads** | ✓ | ✓ | ✓ (`gh api`/GraphQL) | PR |

The board's inline-comment UI is **human-only** — it's hover-a-line-and-type; there is no verb an
orchestrating agent can call to emit a `DiffLineComment`. So a board-native comment object would only
differentiate *if we also built the agent-emit verb*. But the row that already has **all three
checkmarks is GitHub**. For the agent path, a parallel board-native object is strictly redundant with
GitHub PR threads, which the agent can already emit, read, and resolve.

The card's own test applies: *"if the feature isn't agent-emittable, it's a human-only QoL feature —
say so plainly."* The board inline UI is precisely that human-only QoL feature — and it already exists.
There's nothing to add for the human. For the agent, GitHub is the answer.

**Answer:** for an agent architect, GitHub PR review threads are the better contract than any
board-native comment we could build, because they're already structured, emittable, *and* resolvable.

---

## 2. Verdict — (a) Don't build it

Building either a board-native tracked-comment store **(b)** or a new inline-diff UI **(c)** would
duplicate capabilities that already exist across three surfaces (shipped inline UI, `fleet task say`,
GitHub PR threads) to close a round-trip cost we have never actually measured. That is the wrong
trade for a fork we keep small and upstreamable.

Instead, adopt a **convention** (docs, not code) and — *only if the architect asks for glance-ability*
— one small read-only projection.

### 2.1 The convention (ship this — it's a doc change, ~0 risk)

Route review feedback by phase, using what already exists:

- **Pre-PR / local steering phase** — use the shipped **inline-diff comment UI** (human) or
  **`fleet task say`** (agent) to hand the fixing agent a batch of feedback. This is the fast,
  low-ceremony loop; it's fine that it's untracked because the batch is small and immediate.
- **PR phase (default)** — leave feedback as **GitHub PR review comments**; the fixing agent reads
  unresolved threads (`gh pr view --comments`), addresses each, and **resolves** them (GraphQL
  `resolveReviewThread`). This is the tracked loop. Because our cards default to PR mode, this is the
  common path and it already gives the architect the "3 of 5 addressed" view — on GitHub.

Document this in `AGENTS.md` / `fleet-kanban/AGENTS.md` (one short "Review feedback" subsection) and,
for the fixing-agent contract, add a line to the impl-card template: *"If the card is in PR review,
read `gh pr view <n> --comments` for unresolved review threads before re-running; address each and
resolve its thread."*

### 2.2 Explicitly NOT doing

- No new `DiffLineComment`-as-persisted-object in `core/api-contract.ts`.
- No board-side comment/resolution store, no sync path, no new tRPC procedure.
- No change to how cards land (backlog → in_progress → review → PR → merge). This design stays **off
  the critical path** entirely.
- No new agent-emit verb for board comments (GitHub's `gh api` already is that verb).

### 2.3 Optional, speculative, off critical path — a read-only PR-thread count chip

The single sliver of value that GitHub doesn't put *on the board* is glance-ability: seeing
"2 unresolved review threads" on the card without opening the PR. **If — and only if — the architect
asks for that**, implement it as a **read-only projection**, never a store:

- On a card linked to a PR (we already track the external issue/PR ref), fetch the PR's
  review-thread resolution counts from GitHub (`gh api` / GraphQL `reviewThreads { isResolved }`).
- Surface `unresolved / total` as a small chip on the card, mirroring the existing external-issue
  chip pattern (which is already conditional and link-aware — see the tribal-knowledge note on
  `--external-issue`).
- **No writes, no local state.** GitHub remains the source of truth; the chip is a cache-with-TTL
  read, the same shape as the budget cache `fleet task ls` already uses.

This is the *only* board-native piece that could earn its place, and it's a display projection, not
the feature the card asked about. Ship it lazily, on request.

---

## 3. If we're ever forced to build (b) anyway — the minimal shape

Recorded for completeness so a future card doesn't re-derive it. **Not recommended.** If a
board-native tracked comment ever became necessary (e.g. we drop PR mode as the default, removing the
GitHub surface), the smallest correct design is:

- **Data:** extend `core/api-contract.ts` with a `reviewComment` object reusing the existing
  `DiffLineComment` fields (`filePath`, `lineNumber`, `lineText`, `variant`, `comment`) plus
  `{ id, resolved: boolean, author: "human" | "agent" }`. Store them **on the card**, not on the PR,
  since the pre-PR phase is the only justification for a board-native version.
- **Delivery to the fixing agent:** *reuse the existing seam* — assemble unresolved comments into one
  batch via the same `formatCommentsForTerminal()` path and deliver through `sendTaskSessionInput` /
  the resume path in `terminal/session-manager.ts`. Do **not** invent a parallel channel.
- **Agent-emit verb:** a `fleet task review comment --file X --line N "…"` + `fleet task review send`
  pair that writes the objects and then triggers the same batch delivery. This is the differentiator
  vs. a human-only feature — without it, don't bother, because the human already has the inline UI.
- **Resolution write-back:** the fixing agent marks items resolved via a `fleet task review resolve
  <commentId>` verb; the card face shows `unresolved / total`.

Even in that world, note that this is a strict re-implementation of GitHub PR review threads scoped to
the pre-PR phase — which is why the recommendation is to keep defaulting to PR mode and never build it.

---

## 4. Where I looked (read directly, no sub-agents)

- `web-ui/src/components/card-detail-view.tsx` — `diffComments` state, `handleAddDiffComments` /
  `handleSendDiffComments`, wiring to `DiffViewerPanel`.
- `web-ui/src/components/detail-panels/diff-viewer-panel.tsx` — `DiffLineComment`, `InlineComment`,
  `formatCommentsForTerminal`.
- `web-ui/src/hooks/use-board-interactions.ts` — `handleAddReviewComments` /
  `handleSendReviewComments` → `sendTaskSessionInput`.
- `web-ui/src/hooks/use-task-sessions.ts` — `sendTaskSessionInput` → `runtime.sendTaskSessionInput`.
- `src/core/api-contract.ts` — `runtimeTaskSessionInputRequestSchema` (the `fleet task say` /
  bracketed-paste seam) and session summary schemas.
- `src/terminal/session-manager.ts` — the resume/steer path a batched follow-up would reuse.
- `fleet-cli/` — confirmed `fleet task say` / `sendTaskSessionInput` is the agent steering surface.
- `.research/vibe-kanban/docs/reviewing-code.mdx`, `.research/vibe-kanban/docs/workspaces/changes.mdx`
  — competitor's inline-comment loop is prompt-assembly + GitHub for tracking, not a native store.
