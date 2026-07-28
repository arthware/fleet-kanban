# Session kinds: overseer sessions are not cards

**Ref / slug:** This card set no external issue ref, so the doc is named after the card id per
`AGENTS.md`: ref `44010`, slug `session-kinds` → `docs/design/44010-session-kinds.md`.

**Card:** 44010 · **Status:** design (no implementation in this card) · **Base:** `production-line`

**Root cause in one sentence:** the runtime has two kinds of session but only one of them is
modelled — the other is a *string prefix* re-derived ad hoc at ~20 call sites — and on top of that
the single rule those sites keep getting wrong ("may this session return to running?") is itself
**implemented three times in three modules with three different answers**, so a change to one copy
silently breaks the sessions served by the others.

---

## Problem statement

### Observed symptom

`08e1f0d` ("fix: keep human-review cards dormant", #164) narrowed the set of review reasons a hook
may wake a session from, so a card parked at `awaiting_review` would stop being woken by its own
agent's automatic `to_in_progress` hook. Correct for cards. For the architect it meant that once its
turn ended it could never be resumed — it **froze for six hours**.

That was the third regression on this surface: `ea3ca19` (#130), `9ca30b7` (#143), `08e1f0d` (#164).
`158f9a3` (#172) is the fourth patch, landed hours ago on `production-line`, and it is a re-derivation
of the same question at the same site:

```ts
// src/trpc/hooks-api.ts:47-50 (as of #172)
return isHomeAgentSessionId(taskId)
   ? canWakeFromAnyReviewReason(summary.reviewReason)
   : summary.reviewReason === "needs_input";
```

### Expected behaviour

A card session and an overseer session are different kinds of thing, and the runtime should know it.
A policy authored for cards should not be *applicable* to an overseer without the author having
answered, at compile time, what the overseer does.

### Root cause — two layers

**Layer 1 — kind is a convention, not a type.** Overseer sessions exist only as the id shape
`__home_agent__:<workspaceId>` (`src/core/home-agent-session.ts:12`), tested by the boolean
`isHomeAgentSessionId()` (`:16`). Every behavioural difference is a hand-written `if` at the point of
use. The rule is therefore *"remember to ask, everywhere, forever."* `hooks-api.ts` didn't ask, and
nothing failed — the architect just quietly stopped existing.

**Layer 2 — the rule that keeps breaking has no owner.** This is the part the card's framing does not
yet name, and it is why patching kind-awareness alone would not close the class. "May this session
return to running?" exists **three times, with three different answers**:

| Owner | Answer | Serves |
|---|---|---|
| `session-state-machine.ts:47` `canReturnToRunning` | `needs_input` | terminal (PTY) sessions, all kinds |
| `cline-session-state.ts:172` `canReturnToRunning` | `attention \| needs_input` | Cline SDK sessions, all kinds |
| `session-state-machine.ts:51` `canWakeFromAnyReviewReason` | `attention \| hook \| error \| needs_input` | overseers via `hooks-api.ts`, and `human.input_submitted` for everyone |

Two of those are *the same exported name in two modules* and `08e1f0d` edited both in one commit, to
different values. A fourth caller (`hooks-api.ts`) then had to choose between them per session kind.

This is a Constitution Article 3 failure (one source of truth) sitting underneath an Article 1 failure
(the concept was never introduced). Fixing only the second leaves the first free to produce regression
number five — and note the latent one already loaded: **the Cline path has no kind-awareness at all**,
so an overseer running on the Cline agent instead of the claude CLI is governed by variant 2, which
neither #164's fix nor #172's patch touches.

---

## What exists in the codebase

### Prior art read

| SHA | What it establishes |
|---|---|
| `08e1f0d` | The regression. Card-correct narrowing of the wake set across `session-state-machine.ts`, `cline-session-state.ts`, `cline-event-adapter.ts`, `hooks-api.ts` — four files, no kind concept. |
| `158f9a3` (#172) | The quickfix, already on `production-line`. Threads `taskId` into `canTransitionTaskForHookEvent` and branches on `isHomeAgentSessionId`. Call site #20. |
| `045957b` (#121) | Epic owners: an epic workspace carries `ws.epic`, and `resolveHomeAgentContext` grants the Epic Owner preamble. The epic owner is a home-agent session in the epic workspace — the *same mechanism* as the architect. |
| `9e74b48` (#152) | Home-agent session lifecycle: `homeAgentSessionGeneration`, deterministic CLI session ids, "start fresh". |
| `ea3ca19` (#130) | First patch of the three: `resolveArchitectHomeAgentWorkspaceId` returns the epic workspace itself when the active workspace is an epic. |

### Concepts and their canonical homes

- **Home / architect agent session** — `docs/architecture/concepts/home-agent-session.md`, living in
  `src/core/home-agent-session.ts`. Owns the id *format*. Already states "the raw prefix must not be
  duplicated in app code (lint-enforced)" — enforced by `grit/no-home-agent-prefix-literal.grit`. Note
  what that rule does and does not do: it forces you through the helper, but it does not force you to
  *consult* it. There is no concept for **session kind**.
- **Task session** — `docs/architecture/concepts/task-session.md`. Two execution paths (PTY and Cline
  SDK) behind one runtime surface. This is precisely why the wake rule has two homes.
- **Architect workspace** — `src/server/architect-workspace.ts`. Owns *which workspace* is the
  architect and whether a workspace is an epic (`ws.epic`).

### Is "overseer" one category?

Yes, and the code already behaves as if it were:

- `createHomeAgentSessionId(workspaceId)` (`home-agent-session.ts:12`) is called with the epic
  workspace's id for an epic owner exactly as with the root workspace's id for the architect. The two
  ids are **shape-identical**: `__home_agent__:tools` vs `__home_agent__:epic-cool-feature`.
- `resolveRunningHomeAgentTaskId` (`review-notification.ts:32`) treats them uniformly.
- The only architect-vs-epic difference is the launch preamble, and it is already resolved *from the
  workspace*, not from the session id — `resolveHomeAgentContext` branches on
  `workspaces.find(...)?.epic` (`architect-workspace.ts:357`).

**Consequence for the model:** overseer *role* (architect vs epic owner) is **not derivable from the
session id** and must not be pushed into the id-derived classification. It stays where its data already
lives, in the workspace layer. Kind stays purely id-derivable — which is what makes the card's "no
persisted state needs migrating" assumption hold (verified below).

### Audit — every kind-dependent call site

Verdicts: **load-bearing** (correct and the behaviour depends on it), **incidental** (correct only by
accident of some other lookup), **structural** (correct today but is the bug pattern itself), **LIVE
BUG** (check is missing and behaviour is wrong today).

| # | Site | What it decides | Verdict |
|---|---|---|---|
| 1 | `trpc/hooks-api.ts:34-50` `canTransitionTaskForHookEvent` | may a hook wake this session | **structural** — the third patch on this surface; also 100% duplicated (see below) |
| 2 | `trpc/hooks-api.ts:115` `checkpointCapture` on `to_review` | `git add -A` worktree snapshot per turn | **LIVE BUG — missing check** |
| 3 | `trpc/hooks-api.ts:157` `broadcastTaskReadyForReview` | desktop "ready for review" notification | **LIVE BUG — missing check** |
| 4 | `trpc/hooks-api.ts:141` `ensureAutoReviewPrForTask` | push branch + open PR backstop | **incidental** — no-ops only because `findCard` misses |
| 5 | `trpc/runtime-api.ts:498` | cwd + architect/epic preamble vs worktree ensure | load-bearing |
| 6 | `trpc/runtime-api.ts:514` `shouldCaptureTurnCheckpoint` | checkpoint on start | load-bearing (the counterpart #2 lacks) |
| 7 | `trpc/runtime-api.ts:515,520` `isHome` | skip card-type directive composition | load-bearing |
| 8 | `trpc/runtime-api.ts:589` | skip constitution prepend (overseer gets it via preamble) | load-bearing |
| 9 | `trpc/runtime-api.ts:743` | persist summary (overseer has no card to persist it) | load-bearing |
| 10 | `trpc/runtime-api.ts:788` | reject `startFresh` for a non-overseer | load-bearing (validation) |
| 11 | `trpc/runtime-api.ts:910` | cold-start the overseer chat on reload | load-bearing |
| 12 | `trpc/runtime-api.ts:1108` | skip persisted-session rebind | load-bearing |
| 13 | `cline-sdk/cline-task-session-service.ts:261` | restart guard | load-bearing |
| 14 | `cline-sdk/cline-task-session-service.ts:556` | restart guard | load-bearing |
| 15 | `cline-sdk/cline-task-session-service.ts:667` | restart guard | load-bearing |
| 16 | `cline-sdk/cline-task-session-service.ts:823` `shouldCaptureReviewCheckpoint` | checkpoint on review | load-bearing (the counterpart #2 lacks) |
| 17 | `terminal/session-manager.ts:357` `isHomeAgentTask` | deterministic resumable CLI session id | load-bearing |
| 18 | `terminal/session-manager.ts:367` | skip the `gone`-lifecycle early return | load-bearing |
| 19 | `terminal/session-manager.ts:1166` | reject `startFresh` for a non-overseer | load-bearing (duplicate of #10) |
| 20 | `terminal/agent-session-adapters.ts:1734` | skip card `GH_REPO` env | load-bearing |
| 21 | `prompts/append-system-prompt.ts:49` `resolveHomeAgentId` | legacy `:agentId` suffix parse | load-bearing |
| 22 | `prompts/append-system-prompt.ts:339` | inject the overseer system prompt | load-bearing |
| 23 | `core/review-notification.ts:38` | suppress the self-ping | load-bearing |
| 24 | `state/workspace-state.ts:589,595` | scope + prune persisted overseer records | load-bearing |
| 25 | `server/workspace-registry.ts:387` | cold-load lifecycle re-derivation | load-bearing |

Plus one mint site in the client: `web-ui/src/hooks/use-home-agent-session.ts:105`.

**Exposure: 25 sites, not ~15.** Twenty are correct and load-bearing — which is the point: the
distinction is real and pervasive, it is simply not typed.

#### LIVE BUG #2 — overseer turns are being checkpointed, with evidence

`hooks-api.ts` fires `captureTaskTurnCheckpoint` on every `to_review`, for any session. Both other
checkpoint sites exclude overseers explicitly (#6, #16); this one never got the memo. Overseers *do*
receive `to_review` hooks — that is the whole mechanism that froze the architect in #164 — so the path
is live. Confirmed against the fleet root repo:

```
$ git -C /Users/arthur/code/repos/tools for-each-ref --format='%(refname)' refs/kanban | wc -l
       9
$ git -C .../tools log -1 --format='%H %ad %s' --date=iso <turn/28 ref>
7dcc680 2026-07-28 12:20:17 +0200 kanban checkpoint task:__home_agent__:tools turn:28
$ git -C .../tools ls-tree -r --name-only <turn/28 ref> | wc -l   # 18
$ git -C .../tools ls-tree -r --name-only HEAD | wc -l            # 8
```

Nine refs, all overseer ids, latest dated **today**. `captureTaskTurnCheckpoint`
(`workspace/turn-checkpoints.ts:55`) runs `git add -A -- .` at the repo root, so the tree captures 18
paths against 8 tracked at `HEAD` — it is snapshotting `.fleet/` and `.claude/`, i.e. the board's own
state directory, into a commit object on every architect turn. Wrong on the merits (an overseer has no
card to roll back) and wrong on cost. This survived #172 untouched: **the same file, the same missing
question, still open after the fourth patch.**

#### LIVE BUG #3 — the desktop notification names a synthetic id

`broadcastTaskReadyForReview` also fires for overseers. In the client,
`use-review-ready-notifications.ts:181` calls `findCardSelection(board, taskId)`, which misses for a
synthetic id, so the fallback title renders literally as **`Task __home_agent__:tools`**. Cosmetic,
but it is the same missing question and it is user-visible.

#### `canTransitionTaskForHookEvent` is 100% duplicated logic

Comparing it against `reduceSessionTransition` case by case:

| Event | `hooks-api` gate | `session-state-machine` gate | Verdict |
|---|---|---|---|
| `activity` | `false` | no such event | event mapping, not a gate |
| `to_review` | `state === "running"` | `hook.to_review` requires `state === "running"` | **identical** |
| `to_in_progress` | `awaiting_review` + reason set | `hook.to_in_progress` requires `awaiting_review` + `canReturnToRunning` | **identical** |

Every gate in `hooks-api` is already enforced downstream. It exists only because
`transitionToReview`/`transitionToRunning` (`session-manager.ts:1007,1091`) return
`cloneSummary(summary)` whether or not anything changed — so the caller cannot tell a no-op from a
transition and pre-checks instead. `applySessionEvent` (`:1211-1215`) *already computes* the
`changed` bit from `reduceSessionTransition` and then throws it away.

That discarded boolean is why the wake rule has a second owner, and why #164 and #172 both had to be
written twice.

---

## Proposed solution

Three parts. Part 1 is the model the card asks for; **part 2 is the root-cause fix and is the one that
makes #164's exact shape impossible**; part 3 is the structural backstop.

### Part 1 — `SessionKind` as a parsed, discriminated ref

New concept home `src/core/session-kind.ts`, extending (not cloning) the id-format ownership that stays
in `home-agent-session.ts`:

```ts
export type SessionKind = "card" | "overseer";

declare const cardIdBrand: unique symbol;
declare const overseerIdBrand: unique symbol;
export type CardSessionId = string & { readonly [cardIdBrand]: true };
export type OverseerSessionId = string & { readonly [overseerIdBrand]: true };

export type SessionRef =
   | { kind: "card"; taskId: CardSessionId }
   | { kind: "overseer"; taskId: OverseerSessionId; workspaceId: string };

/** The ONE place a session id is turned into a kind. Parse, don't validate. */
export function classifySessionRef(taskId: string): SessionRef;
```

Overseer **role** (architect vs epic owner) is deliberately absent: it is a workspace fact, not an id
fact, and `architect-workspace.ts` already owns it. Adding it here would clone that ownership.

### Part 2 — collapse the wake rule to one owner, and delete `canTransitionTaskForHookEvent`

Every behavioural difference between kinds is declared in **one exhaustive table**:

```ts
// src/core/session-policy.ts
export interface SessionPolicy {
   /** Review reasons a hook may wake this session from. */
   wakesFromReviewReason(reason: RuntimeTaskSessionReviewReason): boolean;
   /** Snapshot the worktree into a per-turn checkpoint ref on entering review. */
   capturesTurnCheckpoints: boolean;
   /** Back-stop push + PR when the session reaches review. */
   ensuresAutoReviewPr: boolean;
   /** Broadcast "ready for review" to the board and the desktop. */
   broadcastsReadyForReview: boolean;
   /** Ping the overseeing architect when this session reaches review. */
   notifiesOverseerOnReview: boolean;
   /** Prepend card-type directives + the constitution to the start prompt. */
   injectsCardDirective: boolean;
   /** Inject GH_REPO / GH_PROMPT_DISABLED for the card worktree's remote. */
   injectsCardGhEnv: boolean;
}

export const SESSION_POLICY: Record<SessionKind, SessionPolicy> = {
   card: {
      // A card at awaiting_review is waiting on a human; only its own permission
      // prompt resumes it. (#164)
      wakesFromReviewReason: (r) => r === "needs_input",
      capturesTurnCheckpoints: true,
      ensuresAutoReviewPr: true,
      broadcastsReadyForReview: true,
      notifiesOverseerOnReview: true,
      injectsCardDirective: true,
      injectsCardGhEnv: true,
   },
   overseer: {
      // An overseer rests at awaiting_review between turns; any hook resumes it. (#172)
      wakesFromReviewReason: canWakeFromAnyReviewReason,
      capturesTurnCheckpoints: false,
      ensuresAutoReviewPr: false,
      broadcastsReadyForReview: false,
      notifiesOverseerOnReview: false,
      injectsCardDirective: false,
      injectsCardGhEnv: false,
   },
};
```

The state machine becomes the single owner and reads the table:

```ts
// src/terminal/session-state-machine.ts — the ONLY owner of the wake rule
case "hook.to_in_progress":
case "agent.prompt-ready": {
   const policy = SESSION_POLICY[classifySessionRef(summary.taskId).kind];
   if (summary.state !== "awaiting_review" || !policy.wakesFromReviewReason(summary.reviewReason)) {
      return { changed: false, patch: {}, clearAttentionBuffer: false };
   }
   ...
}
```

`summary.taskId` is already on `RuntimeTaskSessionSummary` (`api-contract.ts:407`), so this needs no
new argument and no new field.

Then, in order:

1. `transitionToReview` / `transitionToRunning` (`session-manager.ts:1007,1091`) return `null` when
   `applySessionEvent` reports `changed: false` — surfacing the bit `:1213` already computes.
2. **`canTransitionTaskForHookEvent` is deleted.** `hooks-api.ts` maps `RuntimeHookEvent` →
   `SessionTransitionEvent`, calls the manager, and branches on whether a transition happened. There is
   no longer a second place where the wake rule can be written.
3. The three `hooks-api` side effects become policy reads, which closes LIVE BUGs #2 and #3:

```ts
const ref = classifySessionRef(taskId);
const policy = SESSION_POLICY[ref.kind];
if (event === "to_review") {
   if (policy.capturesTurnCheckpoints) { void checkpointCapture({ ... }); }
   if (policy.ensuresAutoReviewPr)     { void deps.ensureAutoReviewPrForTask?.({ ... }); }
   if (policy.broadcastsReadyForReview) {
      deps.broadcastTaskReadyForReview(workspaceId, taskId);
      if (policy.notifiesOverseerOnReview) { void deps.notifyTaskReadyForReview?.({ ... }); }
   }
}
```

4. The Cline path's divergent copy (`cline-session-state.ts:172`, five call sites in
   `cline-event-adapter.ts`) is folded into the same table, closing the latent regression where an
   overseer on the Cline agent obeys neither #164 nor #172.

### Part 3 — make card-only code structurally unable to receive an overseer

Functions whose whole contract is card-only take `CardSessionId`, obtainable only by narrowing a
`SessionRef`. Passing a raw or overseer id is a compile error, not a review catch:

```ts
export async function captureTaskTurnCheckpoint(input: {
   cwd: string; taskId: CardSessionId; turn: number;
}): Promise<RuntimeTaskTurnCheckpoint>;
```

Candidates: `captureTaskTurnCheckpoint`, `ensureAutoReviewPrForReview`, `deriveTaskBranchName`,
`resolveExistingTaskCwdOrEnsure`, `composeCardDirective` callers. Symmetrically,
`startFreshHomeAgentSession` takes `OverseerSessionId`, which collapses the duplicate guards at
sites #10 and #19 into one parse at the tRPC boundary.

Finally, extend the existing lint precedent: `grit/no-home-agent-predicate-outside-policy.grit` bans
`isHomeAgentSessionId` outside `src/core/session-*.ts`, so no site can re-derive kind ad hoc — the
question must be asked through the classification, where the table is.

### Does this actually make #164 impossible? — honest scorecard

| Failure mode | Prevented by | Impossible, or merely loud? |
|---|---|---|
| The wake rule narrowed in a second place | Part 2 (single owner; the second place is deleted) | **Impossible** — there is no second place to edit |
| A card-only side effect fired for an overseer (bugs #2, #3) | Part 3 (branded param types) | **Impossible** — compile error |
| A new cross-kind behaviour added to `SessionPolicy` without deciding overseer | Part 2 (`Record<SessionKind, SessionPolicy>`) | **Impossible** — the literal fails to compile until both kinds answer |
| Kind re-derived ad hoc at a new site | Part 3 (grit rule) | **Impossible** at lint time |
| A new kind-dependent rule written *inline*, never touching the table | — | **Loud, not impossible** |

Being explicit about the last row, per `AGENTS.md`: a determined author can still write
`if (summary.reviewReason === "hook") return;` inside some new function and bypass all of this. What
the design removes is the specific mechanism of #130/#143/#164/#172 — a *second copy* of an existing
rule, and *unguarded* card-only side effects. Replaying #164 under this design means editing
`card.wakesFromReviewReason`, which sits three lines above `overseer.wakesFromReviewReason` in the same
object literal. That is not "documented"; it is the only place the edit can be made, and the overseer's
answer is physically adjacent to it. Regressions of a genuinely *new* shape remain possible, and no
type system here will change that.

### Migration

Kind is derived from the id, which is already persisted, so **no persisted state changes and no
migration is required**. Verified: the assumption holds because (a) `sessionKind` is never stored —
`RuntimeTaskSessionSummary` (`api-contract.ts:406-433`) is untouched, and (b) every policy site already
has either the raw `taskId` or a summary carrying `summary.taskId`. Post-#172 there is **no site that
lacks the id** — `canTransitionTaskForHookEvent` was the only one, and it now receives it.

That last point reframes the work: *plumbing kind is not the hard part; every site can already reach
it.* The hard part is that nothing forces a site to consult it — which is why the plan's weight sits in
parts 2 and 3, not in carrying a field around.

Lands incrementally, in four cards, each independently shippable and green:

| Card | Scope | Risk |
|---|---|---|
| **A** | `session-kind.ts` + `session-policy.ts` + concept doc; migrate the 20 pure consult sites to `classifySessionRef`. **Zero behaviour change.** | Low — the existing suite staying green *is* the proof |
| **B** | Thread the policy into `reduceSessionTransition`; make the manager report `changed`; **delete `canTransitionTaskForHookEvent`**; fold in the Cline copy. | **Highest** — the load-bearing seam |
| **C** | Gate the three `hooks-api` side effects on policy. Fixes LIVE BUGs #2 and #3. | Low, high value |
| **D** | Branded ids on card-only entry points + the grit rule. Type-level only. | Low behaviour risk, high signature churn — last |

Order is forced: A before B and C (they consume the table); D last, once behaviour is already correct,
so signature churn never mixes with behaviour change.

**Risky seams, named:**

- `reduceSessionTransition` is pure and shared; `applySessionEvent` compares summaries by identity
  (`summary !== before`, `:1019`). Changing the return contract to `null`-on-no-op touches every caller
  of `transitionToReview`/`transitionToRunning` — including the tRPC steering paths that already treat
  `null` as "not found". Card B must distinguish *not found* from *no-op*.
- `cline-event-adapter.ts` patches `state`/`reviewReason` directly at five sites rather than going
  through the reducer. Folding it into the table is the largest single change in card B and the least
  covered by existing tests.
- `resumeFromHumanInput` (`session-manager.ts:1107`) deliberately wakes from *any* reason for *both*
  kinds — a human typing always wins. That must stay kind-independent; it is a `SessionPolicy`
  non-field, and card B should assert it.

**Verification, without booting a board** (per `AGENTS.md`, scope the gate to the surface):

- `npm run typecheck` + `npm run test:fast`.
- Module tests through the public API, RED first:
  - `hooksApi.ingest` with an overseer id at `awaiting_review`/`"hook"` → wakes; the same with a card
    id → stays dormant. This is #164 and #172 as one test, at the boundary, not at the predicate.
  - `hooksApi.ingest` `to_review` for an overseer id in a temp git repo → `git for-each-ref
    refs/kanban/checkpoints` is **empty**, and `broadcastTaskReadyForReview` is not called. That is
    LIVE BUG #2 pinned by observable git state rather than a spy.
  - A table test asserting every `SessionPolicy` field is decided for both kinds.
- Deleting `canTransitionTaskForHookEvent` deletes its unit tests; the replacements above are strictly
  higher-level, which is the intended trade.
- One operator action, not code: the 9 stray `refs/kanban/checkpoints/…__home_agent__…` refs in the
  fleet root can be deleted once card C lands.

---

## Technical rationale

**Why a policy table rather than a `sessionKind` field on the summary.** A field is mirrored state:
`taskId` already determines kind, so storing it invites drift (hand-built summaries in tests, zod
parses from disk that bypass the factories) and violates Article 3. More decisively, a field does not
help — it is still "remember to ask", just with a shorter question. The table is chosen because
`Record<SessionKind, SessionPolicy>` is *exhaustive by construction*: adding a field forces an answer
for every kind, which is exactly today's failure mode converted into a compile error.

**Why not a third kind for epic owners.** Nothing in the runtime distinguishes them at the session
layer — same id shape, same lifecycle, same `resolveRunningHomeAgentTaskId` treatment. The only
difference is the launch preamble, already resolved from `ws.epic` in `architect-workspace.ts:357`. A
third kind would clone that ownership (Article 1) and force every future `Record<SessionKind, …>` to
answer a question with no distinct answer. If a genuine session-layer divergence appears, the cheap
move is a `role` field inside the overseer variant of `SessionRef`, not a new kind.

**Why the branded ids are worth the churn.** They are the only mechanism here that converts a review
catch into a compile error, and bugs #2 and #4 are precisely the failure they prevent — #4
(`ensureAutoReviewPrForTask`) is correct *only* because an unrelated board lookup happens to miss. That
is a latent bug: any refactor that resolves the branch before the card lookup would push and open a PR
from the architect's own repo. Deferred to card D because the churn is wide and the behaviour fixes
should not wait on it.

**Rejected: keep patching per site.** The card's premise, and the evidence supports it — four patches,
one live bug still open in the same file after the fourth, and a fifth loaded in the Cline path.

**Rejected: a runtime assertion that logs when a card-only policy sees an overseer.** Making a broken
thing loud is diagnosis, not a fix (Article 2). It would have caught #164 after the six hours, not
instead of them.

**Rejected: lint alone.** The grit rule is real leverage and it is in the plan, but #164 never wrote
`isHomeAgentSessionId` — it narrowed a reason set. No lint on that predicate would have caught it. Only
collapsing the duplicate owner does.

**Risk accepted.** Card B is a real behaviour change on the load-bearing hook path, landing on top of a
quickfix that is hours old. The mitigation is that B's replacement tests assert the *union* of #164's
and #172's requirements at the ingest boundary, so both behaviours are pinned before the predicate is
removed.

---

## Open questions

1. **Does card C wait for D?** Bugs #2 and #3 are live today and card C fixes them with policy reads
   alone. Recommendation: ship C without waiting for the branded ids.
2. **How far does the Cline fold in card B go?** `cline-event-adapter.ts` patches state at five sites
   without the reducer. Unifying it fully may deserve its own card; the minimum for B is that its
   wake rule reads the shared table.
3. **Should `notifiesOverseerOnReview` stay a policy field or collapse into
   `resolveRunningHomeAgentTaskId`?** The latter already suppresses the self-ping correctly
   (`review-notification.ts:38`). Keeping both is arguably belt-and-braces duplication — the table
   entry is clearer, so the recommendation is to make the table authoritative and simplify site #23 to
   `kind === "overseer"`, dropping the workspace comparison.
4. **Ping delivery is out of scope but adjacent.** Site #23 only suppresses the self-ping; it does not
   answer what happens when no overseer session is attached. Noted, not designed here.

---

## Disposition

**Split into build cards** — four, in the stated order, all `--agent-id codex`:

- **A** — `session-kind.ts` + `session-policy.ts` + concept doc + migrate the 20 consult sites. No
  behaviour change.
- **B** — single owner for the wake rule; delete `canTransitionTaskForHookEvent`; fold in the Cline
  copy. Depends on A.
- **C** — gate the `hooks-api` side effects on policy; fixes LIVE BUGs #2 and #3. Depends on A.
- **D** — branded card/overseer ids + the grit rule. Depends on B and C.

B and C are independent of each other and can run in parallel once A lands.

**Carry into card C's prompt, as a bug that exists today independent of this design:** overseer turns
are writing `git add -A` checkpoint commits into the fleet root repo (9 refs, latest dated
2026-07-28) — the same missing question as #164, in the same file, still open after #172.
