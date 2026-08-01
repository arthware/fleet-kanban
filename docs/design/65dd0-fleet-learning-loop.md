# The architect learns its fleet — closing the discard between review and delegation

**Card:** `65dd0` · **Type:** plan · **Author agent:** claude / `claude-opus-5` · **Base branch:** `production-line`

**Ref / slug decision.** The card carries no `externalIssue`, so `<ref>` falls back to the card id
`65dd0` and the doc lands at `docs/design/65dd0-fleet-learning-loop.md` — the path the card names.

> **TL;DR.** The judgment is not missing; the *write* is missing. `SessionLedgerManifest.outcome`
> already exists as a typed field and is `"unknown"` in **206 of 206** real manifests on this board.
> The `fleet-implement` directive already *requires* every build agent to end with a `## Retro`
> naming what the card should have given it — and that text goes into a PR body and is never read
> again. So the design is not a new ledger: it is **two additive fields on a ledger that already
> exists**, a **5-observation rolling Markdown record** per `(agent, model)`, and **one caution block
> composed into the card directive** through the seam that already composes directives. No registry,
> no dashboard, no new store. Three ordered build cards; card 1 is independently useful.

---

## Problem statement

### Symptom

The architect delegates on intuition. Which agent gets which card is a judgment formed inside one
context window and lost at the next compaction. Every session re-derives the same fleet knowledge
from scratch, and none of it compounds. The operator's own working conclusion — *"gemini is quite
fast, but often overlooks stuff"* — is correct, was independently re-derived by three separate
reviews on this board today, and exists nowhere a future session can read it.

### Expected behavior

What a department manager has: a working knowledge of each team member's strengths and weaknesses,
built from observed outcomes, and **applied when handing out the next piece of work** — without
having to remember to look it up.

### Root cause

**Every review produces a judgment, and the judgment has no seat to sit in — so it is discarded at
three separate points.** This is not one discard; it is three, and naming them separately is what
makes the fix small:

| # | Artifact produced today | Where it goes | Recoverable later? |
|---|---|---|---|
| 1 | `SessionLedgerManifest.outcome` — a **typed field that already exists** (`"completed" \| "failed" \| "interrupted" \| "unknown"`) | written `"unknown"` at open and at harvest, **never updated** | n/a — the slot is simply empty |
| 2 | The architect's review verdict | prose typed into a steer message → PTY write | **No.** Nothing persists steers (`grep steerCount src` → no matches) |
| 3 | The agent's `## Retro` — *already mandatory* per the `fleet-implement` directive: "what fought back, what the card should have given you" | the PR body | Partially — via `gh pr view <n>`, only for auto-review-pr cards |

Measured on this board: **206 session manifests, 206 with `outcome: "unknown"`.** The discard is not
a metaphor; it is a field that is always the same value.

The fix is therefore *not* "build a ledger" (Article 1 — a ledger exists) and *not* "bolt on a
scoring dashboard" (which the card explicitly rejects). It is: **close the write, key it honestly,
and read it back at the one moment that matters.**

---

## What exists in the codebase

### Prior art read (`git show <sha>`)

| SHA | What it established that this design reuses |
|---|---|
| `f281a67` | `transitions` (`{column, at}`, append-only) + `src/core/task-lifecycle.ts`. **Also** `backfillCardTransitions` — the reason historical transitions are worthless (see Validation). |
| `9dde1c7` | The driver port: one harness = one driver, capability-shaped. The resolved model is known at launch inside the driver, not on the card. |
| `b936b37` | The pattern this design copies wholesale: a fact becomes a **driver/core capability**, with the CLI and UI as thin consumers — plus `budget --banner` folded into `fleet task ls` (`fleet-cli/fleet.py:1376`), and the `unknown-not-zero` selfcheck invariant. |
| `add89f7` | `fleet` CLI is the architect's real console; board operations belong there as first-class subcommands. |

### The concepts and their canonical homes

| Concept | Home | Relevance |
|---|---|---|
| Session ledger | `src/core/session-ledger.ts` · `concepts/session-ledger.md` | **The durable per-card record.** `openSession` (`:69`) / `harvestSessions` (`:322`) write `manifest.json` per `(taskId, generation)` under `$CLINE_HOME/kanban/workspaces/<ws>/sessions/<taskId>/<gen>/`. Carries `agentId`, `agentSessionId`, `openedAt`/`closedAt`, `usage` (incl. `costUsd`), `source`, and **`outcome`** (`:21`). |
| Card lifecycle | `src/core/task-lifecycle.ts` · `concepts/card-lifecycle.md` | `transitions` — the append-only column history. Written by `moveTaskToColumn` (`src/core/task-board-mutations.ts:595`). |
| Task card | `src/core/api-contract.ts:170` · `concepts/task-card.md` | `agentId`, `agentModel`, `cardType`, `skill`, `prUrl`/`prNumber`, `transitions`. |
| Agent catalog + pricing | `src/core/agent-catalog.ts` · `concepts/agent-catalog.md` | Post-`8344cdb`: `modelPrices` and `estimateAgentCostUsd` live on the catalog entry. `supportsAgentModelOverride` is **true for claude and codex, absent for gemini**. |
| Card type / skill pipeline | `src/core/card-type.ts`, `src/prompts/compose-card-directive.ts` · `concepts/card-types.md` | Phases map `lane → skills`; directives are single-sourced from each skill's `directive:` frontmatter and **concatenated centrally** at session start. |
| Doctrine injection | `src/prompts/doctrine.ts` | `prependConstitution` — the existing "inject architect-owned knowledge into every session" seam. |
| Observation | `src/agents/driver.ts:104` (`ObservationPort.richUsage`) · `concepts/transcript-source.md` | Token usage is a driver capability. All transcript reads belong here. |

### The sibling design — the change-index

`docs/design/architect-console.md` §6 specifies a **change-index**: institutional memory about *what
landed in the code*, written at completion, read at kickoff to prime a card. It is **not
implemented** (`docs/change-index.jsonl` does not exist; only §6.5's manual `## Prior art`
convention shipped).

This design is its **sibling, not a duplicate**: same write-at-completion / read-at-kickoff shape,
different subject. The change-index remembers *the codebase*; the fleet record remembers *the fleet*.
They should stay separate files — one is per-repo and grows forever, the other is per-`(agent,
model)` and is deliberately capped at 5.

### What the card listed as available that is **not**

- **Steer count is not persisted.** `driver.control.steer` (`src/trpc/runtime-api.ts:216`) writes to
  a PTY. There is no `steerCount`/`steerHistory` anywhere in `src/`. The recorded proxy is the
  `review → in_progress` transition.
- **`agentModel` is mostly absent.** See below — this is the finding that most shapes the design.

---

## Validation against real board data

Every number below was computed from `~/code/repos/tools/.fleet/cline/` — the live dogfood board —
not from fixtures. Corpus: `board.json` (12 live cards), `archived-cards.json` (182 trashed),
`board.json.bak` (90, older snapshot), and `sessions/` (**206 manifests**, one generation each).

### 1. Does the design reproduce the operator's conclusion? — Yes, with numbers

| Card | Agent / model | First delivery | Deliveries | Bounces | Output tokens | Cost |
|---|---|---|---|---|---|---|
| `2a1b8` | gemini / *default* | **7.9 min** | 4 | 3 | 0 | — |
| `6c563` | gemini / *default* | **9.5 min** | 2 | 1 | 0 | — |
| `95958` | gemini / *default* | **12.0 min** | 4 | 3 | 0 | — |
| `2e39f` | claude / `claude-opus-5` | (landed direct) | 1 | **0** | 103,976 | **$16.33** |

*Fast* is objective and already recorded: gemini reaches first delivery in 8–12 minutes. *Overlooks
stuff* is objective too — 1–3 bounces per card — but the **word "overlooks" only exists once a cause
is attached**, which is exactly the half that is discarded today. With causes attached (below), the
record reads: gemini, 3 of 5 recent observations → `omitted-required-verification` ×2,
`fabricated-fact` ×1. That is the operator's conclusion, derived, and it is *more* actionable than
the prose version.

Critically it does **not** collapse to "gemini bad": `6c563` also earns `reused-existing-module` (a
genuine strength — it found and consolidated the existing pricing module rather than duplicating
it), and `95958`'s second-round duplication is attributed to the **card**, not the agent.

### 2. "Entered review" over-counts — and the correct derivation is one clause longer

`projectSessionSummaryColumn` (`src/server/runtime-state-hub.ts:51`) moves a card to `review`
whenever the session state projects there — **including after the architect has already moved it to
`done`**, because the session record still says awaiting-review. Real evidence, same-second pairs:

```
2a1b8  … in_progress review in_progress review done review done      naive=5  correct=4
6c563  … in_progress review done review done                          naive=3  correct=2
95958  … in_progress review in_progress review                        naive=4  correct=4
```

**Definition (validated):** a **delivery** is a transition into the review lane *immediately preceded
by* an `in_progress` transition. **Bounces = deliveries − 1.** This strips the spurious re-projection
exactly, on real data, with no special-casing of timestamps.

### 3. Historical transitions are backfilled and must not be counted

`backfillCardTransitions` (`src/core/task-lifecycle.ts`) synthesises `[backlog, currentColumn]` for
any card written before `f281a67`. Consequence, measured on `board.json.bak`: **73 of 90 cards show
0 review entries** — not because they landed clean, but because their history is fabricated at parse
time. Naively counting the archive would produce a completely fictitious quality signal.

**Rule:** an observation is only admissible if the card's transitions contain **≥3 entries or any
`in_progress` entry with `at > createdAt`** — i.e. real recorded movement. Everything older is
ignored, not zero-scored. This is the "unknown, not zero" invariant applied to history.

### 4. The `(agent × model)` key has a real hole — key on it anyway, honestly

Across the 160 cards that have both a card record and a ledger entry:

| `(agentId, agentModel)` | count |
|---|---|
| `(codex, null)` | 61 |
| `(gemini, null)` | 28 |
| `(null, null)` | 23 |
| `(claude, claude-opus-4-8)` | 20 |
| `(claude, claude-sonnet-5)` | 16 |
| `(claude, claude-opus-5)` | 6 |
| `(null, claude-opus-4-8)` | 4 |
| `(claude, null)` | 2 |

**A model is recorded for 26% of cards.** Worse, the archive contains `(gemini, claude-sonnet-5)` ×4
— an incoherent pair, because `agentModel` persists on the card when the agent is switched. And
`gemini` has no `supportsAgentModelOverride` in the catalog at all, so the Gemini CLI is launched
with **no `--model` flag**: its model is whatever the CLI defaults to that week.

This is precisely the hazard the card names — a record keyed on the agent alone carries a dead
model's reputation forward — and it is *already live in the data*. The design's answer:

- Key on the **resolved model at launch**, captured by the driver, **not** on the card's optional
  `agentModel` override. Where the harness exposes none, the value is the literal `default`, never
  omitted and never guessed.
- The 5-observation window is what makes `default` survivable: a silent Gemini model swap washes out
  of the live record within five cards.

### 5. Cross-agent cost/token comparison is invalid today — the record must refuse to rank on it

Of 206 manifests: **197 carry token usage, but only 76 carry `costUsd`.** And the token numbers are
not comparable across harnesses — real output-token counts:

```
claude 2e39f : 103,976 output   ($16.33)
gemini f3ad5 :     657 output   (null)
gemini 44fd0 :     520 output   (null)
gemini df1ac :     573 output   (null)
gemini 4c643 :     308 output   (null)
gemini 95958 :       0 output   (null)
```

Gemini is not 200× more frugal than Claude; the usage reader does not parse its transcripts
comparably. And after `8344cdb`, Codex and Gemini rates are **deliberately omitted** from
`modelPrices` so unknown cost returns `null` rather than a fabricated figure.

**Constraint on the design:** the fleet record may show cost *within* an agent over time; it must
**never** rank agents against each other on cost or tokens. This is the same class of error as the
130× token chip — a confidently wrong number behind a green suite.

### 6. The durable corpus is the ledger, not the board

`sessions.json` holds only *live* sessions (1 card + home agents today; the `.bak` was 426 KB).
`archived-cards.json` is **trash-only** (182 cards, all in the `trash` column). Done cards live in
`board.json` and are pruned. The only thing that survives is `sessions/<taskId>/` — 206 entries,
197 with usage.

**Therefore the record is keyed off the session ledger, and reads the board for context — not the
other way round.**

---

## Proposed solution

Three parts, strictly ordered. Part A is independently valuable; each later part is a pure consumer
of the one before.

### Part A — the verdict gets a seat (the only new persisted state)

Extend `SessionLedgerManifest` (`src/core/session-ledger.ts:12`) **additively** — permitted at the
persistence boundary by Article 7, and justified because the two facts are provably
underivable (§Root cause: the steer prose is gone, the Retro is off-board).

```ts
export interface SessionLedgerManifest {
  // … existing fields unchanged …

  /** The model the driver actually launched with, or null when the harness exposes none. */
  readonly agentModel: string | null;

  /**
   * The architect's review judgments — one per review cycle, append-only.
   * A card that bounced three times carries four verdicts, and each one is a
   * separate observation in the record. Empty until the first is recorded.
   */
  readonly verdicts: readonly SessionVerdict[];
}

export interface SessionVerdict {
  readonly at: number;
  /** Which delivery this judges — 1-based, matching the derived delivery count. */
  readonly delivery: number;
  readonly disposition: "landed" | "bounced";
  /** Who this round-trip is charged to. */
  readonly attribution: "agent" | "card" | "environment";
  /**
   * Closed vocabulary — free prose cannot be counted. One review may name more
   * than one, including a strength beside a defect (`6c563` did exactly that).
   */
  readonly causes: readonly VerdictCause[];
  /** One line of prose. Human context, never parsed. */
  readonly note: string;
}
```

**The observation unit is one verdict, not one card.** This falls out of the data: `2a1b8` was
reviewed four times and the four reviews found different things — a missed constraint, then an
unlabelled editorial choice, then a true-but-misleading green report. Collapsing those into one
per-card verdict would throw away three-quarters of the judgment, which is the discard this design
exists to close.

**`agentModel` is captured at launch, from the driver** — `src/terminal/agent-session-adapters.ts`
already resolves it (`:163`, `agentModel: input.agentModel ?? null`) and the driver knows what it
passed. It is *not* read back off the card, whose value is stale 74% of the time and sometimes
incoherent (§4).

**The cause vocabulary is derived from the six real observations the card supplies**, not invented.
It deliberately records strengths as well as defects — a record that can only accuse is a rap sheet,
and a rap sheet is what makes a self-fulfilling prophecy:

| Cause | Attribution | Real instance |
|---|---|---|
| `omitted-required-verification` | agent | `95958` d1 — zero tests on a card naming cost assertions as the deliverable |
| `fabricated-fact` | agent | `6c563` — invented rates for two providers with fake source attributions |
| `missed-stated-constraint` | agent | `2a1b8` d1 — missed an explicit "must not block" |
| `unlabelled-editorial-choice` | agent | `2a1b8` d1 — chose which token lanes to count, unlabelled |
| `true-but-misleading-report` | agent | `2a1b8` d2 — "all checks green" off `verify:precommit` while full `verify` was red |
| `reused-existing-module` | agent *(strength)* | `6c563` — found and consolidated the existing pricing module |
| `landed-clean` | agent *(strength)* | `2e39f` — the O(1) liveness fix, a hard root-cause card |
| `card-referenced-unreachable-target` | **card** | `95958` d2 — told to extend a tool living outside its worktree; it duplicated 444 lines |
| `card-underspecified` | **card** | the general case |
| `harness-or-environment-failure` | environment | crashed board, killed session, missing dep |

`true-but-misleading-report` is a distinct entry precisely because the card demands it: a correct
statement supporting a false conclusion is not the same failure as writing bad code, and a ledger
that cannot tell them apart teaches the wrong lesson.

**How a verdict is recorded.** One new first-class CLI subcommand (per the fleet-CLI boundary
established in `add89f7`), invoked by the architect at the moment it already forms the judgment —
i.e. inside the `fleet-review` skill, whose body today is one sentence:

```
fleet task verdict 95958 --bounced --blame agent \
  --cause omitted-required-verification \
  --note "shipped zero tests on a card that named cost assertions as the deliverable"

# --cause is repeatable; a strength beside a defect is one verdict, not two:
fleet task verdict 6c563 --bounced --blame agent \
  --cause fabricated-fact --cause reused-existing-module \
  --note "consolidated the existing pricing module, then invented rates for two providers"
```

`--delivery` defaults to the delivery count derived from `transitions` at the moment of recording,
so the architect never types it; it is only there to correct a mis-filed verdict.

The command writes into the *existing* manifest for that card's current generation. It moves nothing
— read-only with respect to the board's lifecycle, per the card's constraint.

**`outcome` gets closed at the same time.** The field has been `"unknown"` 206/206 times because
nothing ever calls a `closeSession`. Setting it is a two-line fix on the same write path and removes
a standing lie from the data.

**Retro harvesting is derived, not stored.** The agent's `## Retro` already exists in PR bodies and
the card already persists `prNumber`. `fleet task verdict` may offer `--from-retro` to fetch it
(`gh pr view <n> --json body`) and pre-fill the `note`. This stays an *enrichment*: it is a network
call and only exists for auto-review-pr cards, so it never gates the verdict.

### Part B — the rolling record (plain Markdown, capped at 5)

One file per `(agentId, resolvedModel)`, at **`fleet/fleet-record/<agentId>/<model>.md`** — the same
project layer that already carries `fleet/card-types/*.md` (tracked, diffable, hand-editable) and
resolves the same way skills do. Gemini's file is `fleet/fleet-record/gemini/default.md`.

```markdown
---
agent: gemini
model: default            # harness exposes no --model; see §4
window: 5
observations: 5           # window is full
archived: 12
attribution:              # card-attributed observations never become agent cautions
  agent: 4
  card: 1
strengths:
  reused-existing-module: 1
causes:                   # agent-attributed only, most-recent first
  true-but-misleading-report: 1
  missed-stated-constraint: 1
  fabricated-fact: 1
  omitted-required-verification: 1
median_first_delivery_min: 9.5
cost: unavailable         # never a number for this agent — see §5
---

# gemini / default

## Recent observations (one per review — newest first, max 5, then archived)

- `2a1b8` d2 · bounced · agent · `true-but-misleading-report` —
  reported "all checks green" truthfully off `verify:precommit` while full `verify` was red.
- `95958` d2 · bounced · **card** · `card-referenced-unreachable-target` —
  told to extend a tool living outside its worktree; duplicated 444 lines. Not an agent defect.
- `2a1b8` d1 · bounced · agent · `missed-stated-constraint` —
  implemented the stated semantics correctly but missed an explicit "must not block".
- `6c563` d1 · bounced · agent · `fabricated-fact` — invented rates with fabricated source
  attributions, *and* `reused-existing-module` — consolidated the existing pricing module.
- `95958` d1 · bounced · agent · `omitted-required-verification` — zero tests on a card that
  named cost assertions as the deliverable.
```

A verdict may carry a strength alongside its cause (`6c563` d1 did both), so the record is never
purely a list of failures even for an agent that is bouncing.

Rules, each with a reason:

- **Window of 5, then archive** to `fleet/fleet-record/<agent>/archive/<model>.md`. Archived
  observations stay readable and **must not feed the live frontmatter**. This is the whole
  anti-self-fulfilling-prophecy mechanism: a belief has to be re-earned from recent evidence, and a
  model change washes out within five cards.
- **`observations < 3` → the record renders `not enough evidence`**, emits no caution, and shows no
  rate. **No rate is ever printed below n=5.** Counts (`1 of the last 5`) are always allowed;
  percentages never are. This reuses the invariant proven by
  `givenAgentBudgetWhenAProviderCannotBeReadThenTheReadoutSaysUnknownNotZero` (`b936b37`).
- **Cautions are the top 2 causes by most-recent occurrence — not by a count threshold.** The real
  gemini window above makes the reason concrete: its four agent-attributed causes each occur exactly
  once, so *any* frequency threshold would emit nothing at all while the operator can plainly see
  the pattern. Recency-ranked with the honest count stated inline (`1 of the last 5`) reports what
  is actually there. Fixing this by grouping causes into families was considered and rejected —
  it re-introduces the taxonomy this design deletes (see Rationale).
- **`cost: unavailable`** whenever the agent has no `modelPrices` entry. Never `0`, never a
  cross-agent comparison (§5).
- **Card-attributed observations are counted separately and never become agent cautions.** They
  aggregate into a second, arguably more valuable file — `fleet/fleet-record/card-authoring.md` —
  which grades *the architect*. That is the half of the loop the architect actually controls.

### Part C — the self-heal: the correction is applied where directives are already composed

A record the architect must remember to read is still a human remembering to look. The loop closes
at **`src/prompts/compose-card-directive.ts`**, which already resolves an ordered skill list and
concatenates their `directive:` frontmatter at session start. Add **one more composed block**: the
live cautions for the card's resolved `(agent, model)`.

For a card routed to gemini today, with no architect memory involved:

```
Fleet record — the last 5 reviews of gemini on this board found:
- `true-but-misleading-report` (1 of the last 5): a green `verify:precommit` was reported as
  "all checks green" while the full `verify` tier was red. Report the tier you actually ran.
- `omitted-required-verification` (1 of the last 5): a card naming tests as its deliverable
  shipped none. Before reporting done, re-read what the card names as the deliverable.
```

Why this seam and not another:

- It is **the** existing central concatenation point (`concepts/card-types.md`: "directives are
  derived exclusively from skill frontmatter; do not define separate hardcoded prompt builders").
  The record becomes one more *source* of a directive, not a parallel prompt path.
- It is **per-session and ≤6 lines** — two causes, one line of evidence and one of instruction each.
  The token cost is bounded by construction, which the card requires as a hard constraint. The full
  record, the archive, and the timings are never injected.
- It is **automatically self-limiting.** A caution exists only while its cause is in the 5-window. If
  the correction works, the cause stops recurring, falls out of the window, and the caution
  disappears on its own. That is what stops the loop overcorrecting into noise — no decay constant to
  tune, no suppression list.

**And the card-authoring corrections apply to card *creation*, not the agent.** When
`card-referenced-unreachable-target` is live, `fleet task create` prints a one-line pre-flight to
the architect ("recent cards failed by naming a target outside the worktree — confirm every path in
this card is reachable from the card's repo"). Same mechanism, other side of the attribution split:
a card that failed because it was underspecified makes the *next* card of that shape better
specified.

**Automatic routing is explicitly out of scope.** The card's constraint is read-only with respect to
the board's lifecycle, and routing is the architect's judgment. Automatic *priming* changes what an
already-chosen agent is told; automatic *routing* would change who gets chosen, and would make the
window's anti-bias property moot — an agent that is never chosen can never re-earn its record. **This
remains a human decision.** So does landing, steering, and overriding any caution.

### Where it surfaces at the moment of delegation

Two consumers, both cheap, both following the `b936b37` banner precedent:

1. **`fleet task ls`** gains a ≤4-line fleet banner beside the existing budget banner (folded in at
   `fleet-cli/fleet.py:1376`). One line per agent that has ≥3 observations:
   ```
   fleet   (last 5 reviews per agent — counts, not rates)
     gemini/default   ~9.5m to first delivery · 4 of 5 charged to the agent
                      recent: true-but-misleading-report, missed-stated-constraint
     claude/opus-5    3 obs · 3 landed clean · $16.33 median      ← within-agent cost only
     codex/default    not enough evidence (1 obs)
   ```
2. **`fleet fleet-record [<agent>]`** prints the full file(s) on demand — the drill-down, off the hot
   path.

The banner is derived from frontmatter only (no manifest scan, no transcript read — `concepts/
transcript-source.md`), so it is a handful of small file reads and safe to leave always on.

### Surviving configurable columns (card `caeff`)

The delivery metric is defined against **the lane a card's type declares as its review phase**, not
the literal string `"review"`. `CardTypeManifest.phases` already carries `lane` per phase
(`src/core/card-type.ts`), and both shipped manifests declare `verify` at `lane: review`. If `caeff`
splits a QA column out of review, the manifest names the new lane and the derivation follows it with
no change here. Designed against today's columns, as instructed; not blocked on `caeff`.

---

## Technical rationale

### Why not the smallest thing — a derived report with no new storage?

This was the first design attempted, because the card rightly says a smaller design that removes
machinery beats a larger one that adds a registry. It fails on a specific, checkable point.

A pure derived report **can** produce: deliveries, bounces, first-delivery latency, tokens, cost
(claude only), `agentId`. It **cannot** produce **why** a card bounced or **whether the agent or the
card was at fault** — and those two facts are, verifiably, unrecoverable: the steer prose was never
written to disk, and `outcome` is `"unknown"` in all 206 manifests.

The result would be a report that says *"gemini: 3 bounces per card"* — which is exactly the
"gemini is weak" uselessness the card warns against, and is one bad inference away from being wrong
(the `95958` second round was the **card's** fault; a naive report blames the agent). So the
report-only design does not merely deliver less value — it delivers a **misleading** artifact.

New persisted state is therefore justified under the card's constraint. The amount is the argument:
**two additive fields on a manifest that already exists.** No new store, no new schema file, no
registry, no dashboard. The derived half stays derived — bounces, latency, tokens and cost are all
computed, never stored.

### Why the "kind of work" axis is *not* a third key dimension

The card leaves the third axis open and notes `--type` may be the wrong cut. **The proposal is to
not have one.** The `cause` vocabulary already carries the work-shape specificity that the axis was
meant to supply:

> "Gemini omits required verification on cards where tests are the deliverable"
> ≡ `cause: omitted-required-verification`, 2 of the last 5.

The caution that follows is useful on *every* gemini card, not only test-deliverable ones ("re-read
what the card names as its deliverable"), so conditioning it on a work-kind classifier buys nothing
and costs a taxonomy that would need defining, maintaining, and back-filling. **The key stays
`(agentId, resolvedModel)`** — two dimensions, both already present at launch, no classifier.

This is the change that *removes* machinery rather than adding a branch.

### Why Markdown files and not the ledger itself for the rolling record

The verdicts live in the ledger (one per card, forever, under `CLINE_HOME`). The **record** is the
5-observation rollup, and it lives in git as Markdown because the operator must be able to read,
diff, and *hand-edit* it — including deleting an observation they judge unfair, which is a real
requirement for a system that grades an agent. `fleet/card-types/*.md` is the established precedent
for exactly this shape of hand-editable data manifest in this repo.

The rollup is regenerated from the ledger, so a hand edit is a *deliberate override* that the next
regeneration would revert — which is why regeneration is an explicit `fleet fleet-record --rebuild`,
not an automatic background write.

### Risks

| Risk | Mitigation |
|---|---|
| **The architect self-serves its own grade.** The same agent authors the card, reviews it, and assigns attribution — it can quietly blame the agent for its own bad cards. | The agent's `## Retro` is an **independent** input on card quality, written before the verdict by a different party. Where a Retro says "the card should have given me X" and the verdict says `attribution: agent`, that disagreement is itself worth surfacing. |
| **`default` as a model value hides real model churn.** | Accepted and stated in the record. The 5-window bounds the damage to five cards. A future card can teach the gemini driver to report its resolved model. |
| **Verdict recording is a manual step that gets skipped.** | `outcome`/`verdict` absent renders as *no observation*, never as a clean pass. A card with no verdict simply does not enter the window. The record shrinks toward "not enough evidence" rather than toward a flattering lie. |
| **Cause vocabulary drifts or grows unbounded.** | It is a TypeScript union in `session-ledger.ts` — adding a cause is a typed, reviewed change, and the CLI rejects unknown values. |
| **Injected cautions bloat the prompt.** | Cautions are capped at the top 2 causes and ≤4 lines, composed only when `observations ≥ 3`. Bounded by construction. |
| **Bounces punish hard cards.** | `2e39f` is the counter-example already in the data: a hard root-cause card that landed clean. Bounces are only ever shown as counts with causes attached, never as a solo score. |

### Rejected alternatives

- **Score / rating per agent.** Rejected: a single number is the thing that can be confidently wrong,
  and it destroys the attribution split. Counts with causes, or nothing.
- **LLM judge over transcripts at review time.** Rejected: expensive on the architect's hot path,
  non-deterministic, and unnecessary — the architect *already forms* the judgment; it just has
  nowhere to put it.
- **A new `fleet-record.json` store.** Rejected under Article 1: `sessions/<taskId>/<gen>/manifest.json`
  is the canonical per-session record and already has the empty `outcome` slot.
- **Storing bounces/latency on the card.** Rejected under Article 3: they are derivable from
  `transitions`, whose owner is `task-lifecycle.ts`. Mirroring them would be a second source of truth.
- **Grouping causes into families** (e.g. a "reported done without meeting the bar" family covering
  `omitted-required-verification` + `true-but-misleading-report`, which would read 2 of 5 on today's
  real window). Rejected: it re-introduces exactly the taxonomy this design deletes, it needs
  maintaining as causes are added, and the specific cause is *more* actionable than the family — the
  instruction for "you reported the wrong tier" is not the instruction for "you shipped no tests".
  Recency ranking gets the same two causes onto the card without the taxonomy.

---

## Open questions

1. **Does `fleet task verdict` belong in the `fleet` CLI or in `kanban` (`src/commands/`)?**
   Recommendation: **`kanban` core + `fleet` wrapper**, mirroring `b936b37` exactly (`src/commands/budget.ts`
   is core; `fleet` shells out for the banner). The ledger write is core behavior, not architect sugar.
2. **Should the `verify` phase (currently `activation: dormant` in both card-type manifests) become
   active so `fleet-review` fires on lane entry and prompts for the verdict?** This is the difference
   between "the architect remembers to run `fleet task verdict`" and "the review lane asks for it".
   Recommendation: yes, but as a follow-up — it touches the lane-entry seam that `caeff` is also
   reshaping.
3. **Should the card-authoring record (`fleet/fleet-record/card-authoring.md`) be per-repo or fleet-wide?**
   The failure modes it records (unreachable targets, underspecification) look repo-independent.
   Leaning fleet-wide, at the architect workspace root.
4. **Is `fleet/` in the `tools` repo committed?** It is currently **untracked** (`?? fleet/`), unlike
   `fleet-kanban/fleet/` which is tracked. If the card-authoring record lives at the architect level
   it needs a tracked home; that is an operator decision, not a code one.
5. **Should a verdict be recordable per *generation* rather than per card?** All 206 ledger entries
   have exactly one generation today, so this is currently moot — but a restarted card would want
   one verdict per attempt. The schema already supports it (verdict is on the manifest, which is
   per-generation); only the CLI's default target needs deciding.

---

## Disposition

**Split into build cards — three, strictly ordered.** Card 1 is independently shippable and starts
the data accruing the day it lands; cards 2 and 3 are pure consumers with no new storage.

| # | Card | Agent | Deliverable | Why it stands alone |
|---|---|---|---|---|
| 1 | **The verdict gets a seat in the ledger** | gemini | `agentModel` + `verdict` on `SessionLedgerManifest` (additive), `outcome` actually closed, `fleet task verdict` recording it, `fleet-review` skill body updated to call it | The data starts accruing immediately. Nothing downstream can exist without it. |
| 2 | **The rolling record** | gemini | `fleet/fleet-record/<agent>/<model>.md` generation with the 5-window + archive, the n<3 / n<5 honesty rules, `fleet fleet-record`, and the `fleet task ls` banner | Pure read over card 1's data. Delivers the "what the architect sees at delegation" surface. |
| 3 | **The self-heal** | claude | Cautions composed into the card directive via `compose-card-directive.ts`; the card-authoring pre-flight on `fleet task create` | Touches the prompt-composition seam every card runs through — worth the more careful agent. |

**Card 1 must land first**, and the record is *empty* on day one — correctly. Sample-size honesty
means every agent reads `not enough evidence` until three verdicts exist. That is the design working,
not a gap: the alternative is back-filling the window from history that §3 proves is fabricated.

**Explicit selfcheck specs belong in each card** (the architect writes them, not the implementing
agent). The three that matter:

- *given a card with a recorded verdict, when the record is rebuilt, then the observation appears in
  the window and the sixth-oldest is in the archive* — proves the window and the archive.
- *given an agent with two observations, when the banner renders, then it says "not enough evidence"
  and prints no rate* — the unknown-not-zero invariant, transplanted.
- *given a card whose transitions contain a `done → review` re-projection, when deliveries are
  derived, then the spurious entry is not counted* — pins §2 against the real shape found in
  `2a1b8` and `6c563`.
