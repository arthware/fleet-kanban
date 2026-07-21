# Attention surface + review-gate judge

**Status:** design (plan card — no code) · **Card:** `9daf8` · **Author:** design pass, 2026-07-21
**Base branch for the PR:** `production-line`
**Builds on / composes with:**
- `docs/design/per-card-token-usage.md` — the derive-on-read usage path (shipped: `agent-usage-reader.ts`, `runtime.getTaskTokenUsage`, the board chip).
- `docs/design/architect-console.md` — §3 Observe ("watch it burn"), §10 cost levers; the architect's operating loop this card serves.
- `docs/design/architect-steering.md` — the CLI-tools steering route the judge's "recommend" output rides on.
- Existing code: `web-ui/src/hooks/use-review-auto-actions.ts` (the current, blunt auto-review executor), `src/trpc/hooks-api.ts` (the `to_review` server seam), `src/core/task-board-mutations.ts` (dependencies + linked auto-start).

> Two connected gaps, one card. **Part A** gives the architect a single "what needs me now" surface with an *honest* per-card runway number. **Part B** puts a reasoning agent at the review gate that judges the next step in the context of the whole board. They share one substrate — the session summaries and board state the UI already consumes — and split cleanly into separate build cards.

---

## 1. Problem & symptom

The architect steers N cards but can only look at one at a time. Two gaps:

1. **Attention / runway.** There is no grouped "these need me" view. The board shows every card equally; nothing says *this one is blocked on a question*, *this one is 85% through its context window and about to compact*, *you haven't looked at this since it produced new output*. The operator scans columns by hand and misses the card that stalled 20 minutes ago on a permission prompt.

2. **Review-gate judgement.** When a card lands in `review`, *something* must decide: land it, steer it back with changes, spawn/unblock a follow-on build card, or escalate. Today that decision is either **fully manual** or a **blunt client-side automaton** (`use-review-auto-actions.ts`) that commits/PRs and marches the card to Done with **zero awareness of the rest of the board** — it doesn't know the card it's about to land unblocks three backlog cards, or that a sibling card already shipped the same change, or that the diff is a dead end that should be steered back. It also only runs *while a browser tab is open* (see §5.1).

---

## 2. Current state, grounded in code

### 2.1 What already exists for Part A

- **Per-card usage is already derived on read.** `src/terminal/agent-usage-reader.ts` → `deriveClaudeUsage` / `deriveCodexUsage` parse the agent's own transcript and return a **cumulative** `RuntimeTaskTokenUsage` (`{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd }`, `src/core/api-contract.ts:1261`). Served by the batched `runtime.getTaskTokenUsage` endpoint and consumed by `web-ui/src/hooks/use-task-token-usage.ts` + the board-card chip. Cost is priced per-lane by `src/core/claude-model-pricing.ts`.
- **Per-card session state already streams.** `runtimeTaskSessionSummarySchema` (`src/core/api-contract.ts:379`) carries, per card:
  - `state`: `"idle" | "running" | "awaiting_review" | "failed" | "interrupted"`,
  - `reviewReason`: `"attention" | "hook" | "error" | "needs_input" | …`,
  - `latestHookActivity` (with `notificationType` — e.g. a permission prompt = "blocked, answer me"),
  - `lastHookAt`, `lastOutputAt`, `updatedAt`, `pid`, `startedAt`, `agentSessionLifecycle` (`"attached" | "resumable" | "gone"`), `warningMessage`.
  These arrive in `RuntimeWorkspaceStateResponse.sessions` (`toWorkspaceStateResponse`, `src/state/workspace-state.ts:525`) and land in the UI via `web-ui/src/hooks/use-workspace-sync.ts` → `App.tsx` → board components.

**Consequence: most attention signals are already on the wire.** Awaiting-input vs running vs ended is `state` + `reviewReason` + `latestHookActivity.notificationType`. What is *missing* is (a) an honest **context-window/runway** number, and (b) **unread-since-last-viewed** (a client-only concept), and (c) a **view** that groups by "needs me now."

### 2.2 What already exists for Part B

- **The `to_review` trigger seam.** The CLI hook fires `to_review` (`src/commands/hooks.ts` — `inferActivityText` handles `event === "to_review"` at :262; the event is emitted by the agent wrapper on end-of-turn). It is ingested server-side by `src/trpc/hooks-api.ts` → `ingest`: it transitions the card to `awaiting_review`, captures a turn checkpoint, and calls **`broadcastTaskReadyForReview(workspaceId, taskId)`** (`hooks-api.ts:127`). This WebSocket broadcast (`src/server/runtime-state-hub.ts:416`) is the robust, server-side "a card just entered review" edge — it fires regardless of whether a browser is open.
- **The existing auto-review executor is client-side.** `web-ui/src/hooks/use-review-auto-actions.ts` watches cards in the `review` column and, when `autoReviewEnabled`, schedules `runAutoReviewGitAction(taskId, "commit" | "pr")` then moves the card to Done once work is durably saved. **It runs only in the browser tab.** It already encodes the critical safety guard the judge must inherit: `isSessionBlockedForAutoReview` (`:20`) refuses to advance a card whose `reviewReason` is `needs_input`/`error` or whose `state` is `failed` — "work not durably saved, let a human intervene."
- **Linked auto-start on Done already exists.** `src/core/task-board-mutations.ts` models dependencies as `{ backlogTaskId, linkedTaskId }` pairs; `completeTaskAndGetReadyLinkedTaskIds` (`:460`) / `getReadyLinkedTaskIdsForCompletedTask` (`:452`) return the backlog cards that become ready when a card lands in Done. This is the "land → auto-start the next" primitive the judge composes with, **not** something it reimplements.
- **Durability is classified, not guessed.** `src/workspace/durable-save.ts` → `classifyTaskWorkDurability` decides whether a card's work is safely on the base branch (commit vs merged PR). The judge reuses this to know "is this landable."

**Consequence:** the judge is a *smarter brain above existing primitives*. It reads the same board/session state the UI reads, and it decides *whether* to invoke commit/pr/move-to-done/steer — it does not re-implement any of them.

---

## 3. Part A — the attention surface

### 3.1 The context/runway number — getting it right (validated against real transcripts)

This is the card's #1 key question and the one place the shipped instinct is a trap. **There are two different token numbers, and conflating them is exactly how the prior chip shipped ~130× wrong.**

**Number 1 — cumulative work (weight / cost).** Already shipped: `realWorkTokenCount = inputTokens + outputTokens`, cache-read **excluded** (`web-ui/src/utils/format-token-count.ts:22`). Correct, because summing `cache_read_input_tokens` across every turn double-counts the same context re-read every turn. Measured on a real 1,553-turn Opus transcript:

```
CUMULATIVE  input=312,554  output=2,194,767  cacheRead=319,866,574  cacheCreate=10,281,437
  realWork(in+out) = 2,507,321
  grandTotal(all4) = 332,655,332   →  132.7× inflation if you sum cache-read
```

**Number 2 — context-window fill (runway).** This is a **single-turn snapshot**, not a cumulative sum, and it is a *different quantity* from Number 1. For Claude Code, each request re-sends the whole conversation; the CLI caches the prefix, so a turn's total prompt size (what fills the window) is:

```
windowFill(turn) = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

Runway = `latestTurn.windowFill / model.contextWindow`. Measured tail of the same transcript:

```
LAST 6 TURNS (windowFill = in + cacheRead + cacheCreate):
  in=2  cr=154,986  cw=21     out=289   | 155,009
  ...
  in=2  cr=158,273  cw=215    out=104   | 158,490   ← last turn
last-turn window fill: 158,490  →  79.2% of a 200K context window
```

> **⚠️ Correction to the card's phrasing — this is a root-cause note, flagged per AGENTS.md.** The card says the runway figure must *"exclude cache-read from the context consumed notion."* That is right for **Number 1** and **wrong for Number 2**. The 130× bug was caused by **summing cache-read across turns**, not by *reading* cache-read. For the window-fill snapshot, cache-read **IS the context** — it is the cached conversation prefix being re-sent this turn. Excluding it is catastrophic in the opposite direction:
>
> ```
> last turn usage: { input_tokens: 2, cache_creation: 215, cache_read: 158,273, output: 104 }
> EXCLUDING cache-read (in + cw):     217 tokens  =  0.11% of 200K   ← absurd, understates ~99.9%
> INCLUDING cache-read (in + cr + cw): 158,490    =  79.2%          ← the true fill
> ```
>
> **The honest rule:** *don't SUM cache-read cumulatively (Number 1); DO include it in the single-turn window-fill snapshot (Number 2).* Same guardrail — "cache-read is 0.1×-billed re-read, not fresh work" — expressed correctly for each number.

**Exactly which fields feed the runway number:**

| Field | Source | Role |
|---|---|---|
| `input_tokens` | last assistant `message.usage` | new uncached prompt tokens this turn (tiny — often single digits once caching warms) |
| `cache_read_input_tokens` | last assistant `message.usage` | the cached conversation prefix = the bulk of the window |
| `cache_creation_input_tokens` | last assistant `message.usage` | prefix newly written to cache this turn |
| `model` | last assistant `message.model` | keys the context-window size |
| **denominator** | model context-window catalog (new; sits beside `claude-model-pricing.ts`) | `claude-opus-4-8` → 200,000 (note the 1M-context beta caveat, §8) |

Derivation detail: the existing `deriveClaudeUsage` **sums** and therefore cannot yield this — it discards per-turn structure. The runway number needs the **last** usage-bearing assistant record's three input-side fields (the same dedup rule applies: last *counted* record by `message.id`+`requestId`). This is a **new, sibling derivation** (`deriveClaudeContextWindow`), not a change to the cumulative sum. Codex reports `total_token_usage` cumulatively (already the last-record shape) and its context window differs — Codex runway is a **follow-up**, Claude ships first (it's the default agent).

Pace/runway hint is derived from two window-fill snapshots over time (Δfill / Δt across the last few turns) → a coarse label only: `"~79% ctx"`, and if the slope is steep, `"burning fast"`. **No projection math on the card** — a three-bucket label (`ok` / `high` / `critical`, e.g. <60% / 60–85% / >85%) plus an optional "rising" arrow is all the glance needs. Precise burn-rate analytics are out of scope.

> **Caveat — compaction resets the window.** The same transcript peaked at 616K window-fill (308% of 200K) across the session because Claude Code auto-compacts and the window resets and regrows. So runway must use the **current (last-turn)** fill, never a session max, and the operator should read it as "runway until the *next* compaction," not "until a hard wall." Documented so nobody later 'fixes' it by taking a max.

### 3.2 Per-card signals to surface

All derive from data already on the wire (§2.1) except runway (§3.1) and unread:

| Signal | Derivation |
|---|---|
| **awaiting-input / blocked** | `reviewReason === "needs_input"`, or `latestHookActivity.notificationType` is a permission/approval prompt |
| **running** | `state === "running"` |
| **awaiting-review (done a turn)** | `state === "awaiting_review"` && `reviewReason` in `hook`/`attention` |
| **idle / ended** | `state === "idle"`, or `agentSessionLifecycle === "gone"`, or `pid === null` after end |
| **rate-limited / blocked (agent-side)** | `warningMessage` / a hook-activity signal indicating a rate-limit stall (surface `warningMessage` verbatim; a dedicated rate-limit hook is a later enrichment) |
| **runway** | §3.1 — new derivation |
| **unread-since-last-viewed** | client-only: compare `lastOutputAt` against a per-card `lastViewedAt` persisted in the browser (see §3.4) |

### 3.3 The view — decision: **a filter/lens over the existing board, not a new mode or a separate panel**

Three options weighed:

| Option | Pros | Cons |
|---|---|---|
| **A. Badge/count only** (a number on a toolbar button) | tiniest change | doesn't answer *which* cards or *why*; operator still hunts |
| **B. Filter/lens over the board** ✅ | reuses the board the operator already reads; cards keep their column context (you see the blocked card *is* in In-Progress); one toggle collapses the board to "needs me now," grouped awaiting-input → low-runway → unread; zero new surface to learn | needs a lightweight client-side grouping/sort layer |
| **C. Dedicated panel / new mode** | maximal focus | a whole second surface to build and keep in sync; duplicates card rendering; heavier than the problem warrants |

**Pick B.** It is the smallest thing that answers "what needs me now" at a glance while preserving the board's spatial context. Concretely: a **"Needs attention" toggle** in the board toolbar that (1) shows a **count badge** (so A is subsumed — the badge is the entry point) and (2) when engaged, filters/reorders visible cards into three ranked groups — **awaiting-input first, then low-runway, then unread** — computed entirely client-side from the session summaries + runway hook already in `App.tsx`. Each card keeps its existing card component (and its new runway chip), so there is nothing new to render. This also composes with Part B: a card carrying a judge recommendation (§4.4) surfaces in the same "needs me" list as an "awaiting your confirm" group.

### 3.4 The state → schema → UI seam

**Runway rides the existing usage endpoint, not workspace-state.** Per `per-card-token-usage.md` §6, transcript reads are deliberately kept *off* the cheap streamed summary. So:

- **Schema (`src/core/api-contract.ts`):** extend `runtimeTaskTokenUsageSchema` (or add a sibling in the same response) with an optional, additive block:
  ```ts
  contextWindow: z.object({
    fillTokens: z.number(),        // last-turn input + cache_read + cache_creation
    windowTokens: z.number(),      // model context-window size (denominator)
    model: z.string().nullable(),
  }).nullable().default(null),
  ```
  Additive + defaulted, so an old `sessions.json`/client still parses (same backward-compat discipline the usage card used).
- **Populated in:** the `runtime.getTaskTokenUsage` handler (already reads the transcript per card) — compute `deriveClaudeContextWindow` in the same pass as `deriveClaudeUsage`, no extra file read.
- **Consumed in:** `web-ui/src/hooks/use-task-token-usage.ts` (already batches + polls the visible cards) → a small `deriveRunwayLabel` util → the board-card runway chip + the "Needs attention" grouping in `App.tsx`.
- **Attention grouping + unread** stay **client-side** in `App.tsx`/a `use-attention-groups` hook, reading the already-synced `sessions` map + the usage/runway hook. `lastViewedAt` per card persists via `localStorage` (a `react-use` `useLocalStorage`), compared to `lastOutputAt`. **No new server field for unread** — it is inherently per-viewer.

---

## 4. Part B — the review-gate judge

### 4.1 Where the judge runs — decision: **opt-in, server-side, at the `broadcastTaskReadyForReview` seam**

The card names `to_review` (`hooks.ts:262`) as the trigger. That event is ingested server-side in `hooks-api.ts`, which already emits `broadcastTaskReadyForReview` after transitioning the card. **That is the judge's activation edge**, for three reasons:

1. **It is robust to the UI.** The existing auto-review runs only in a browser tab (§2.2). A board-reasoning judge that can *land work* must not depend on someone having the page open. Server-side activation fires on every `to_review` regardless.
2. **It is the natural read point for whole-board context** — the server already holds the workspace state and terminal manager.
3. **It is opt-in by construction** — activation is gated on a per-card/per-board flag (§4.5), so existing cards are untouched.

The judge is **not** baked into `use-review-auto-actions.ts`. That hook stays as the *executor primitive* (commit/pr/move-to-done) the judge can invoke. (Whether the invocation is via a server-issued board mutation or by handing the client hook a decision is an implementation choice for the build card; the *decision* is server-side either way.)

### 4.2 What the judge is given (read-only board context)

The judge is an **LLM invocation** (a scoped agent turn — reuse the CLI-agent launch path already used for cards; model choice per §4.6) whose prompt is assembled read-only from state the runtime already has:

- **The card's result:** its diff / PR / design-doc path, and durability (`classifyTaskWorkDurability`), plus the last turn's `finalMessage` from `latestHookActivity`.
- **The whole task list, read-only:** all columns + cards + dependency links, obtained from the **same** `loadWorkspaceState` the UI consumes (`src/state/workspace-state.ts` → board + sessions). The judge reads this snapshot; it **must not** call any `task-board-mutations` write as a side effect of reading. Reuse `getReadyLinkedTaskIdsForCompletedTask` to know what landing this card would unblock.
- **Overall context:** the card's initiative/project (from card frontmatter / external-issue ref), what's already in flight (sessions in `running`), and remaining budget signal (the aggregate token/cost the usage readers already produce — a coarse "how much has this initiative burned" number, not a hard meter).

**Read-only contract:** the judge receives an immutable board snapshot object; the only writes it can cause are the explicitly allow-listed actions in §4.4, and only when autonomy is enabled. This is stated as an invariant in the build card so no reviewer has to infer it.

### 4.3 Recommend vs act — decision: **default is RECOMMEND (don't act)**

This is the card's #3 key question. **Default = recommend.** The judge posts a next-step recommendation on the card for the architect to confirm. Rationale: it respects the project's hard rule — *never stop/trash/restart/land an unfinished card without approval* — and the existing auto-review already covers the narrow "this card opted into commit/pr auto-land" case. The judge's value is *judgement*, and judgement the operator can veto is strictly safer than judgement that already happened.

Recommendation vocabulary (one primary + rationale + evidence):
- **`land`** — merge/commit → Done (and note which backlog cards auto-start).
- **`request_changes`** — steer back with **specific** asks (the judge must produce the concrete change list, not "looks off").
- **`spawn_follow_on` / `unblock`** — link or start a follow-on build card (proposed prompt included).
- **`escalate`** — hand to the architect with the reason it couldn't decide.

### 4.4 Act autonomously — only when explicitly enabled, with a hard allow-list

When (and only when) a card/board opts into autonomy (§4.5), the judge may **execute** a bounded set:

| Action | Allowed autonomously? | Notes |
|---|---|---|
| **Land finished work** (invoke commit/pr → move to Done) | ✅ | Only when `classifyTaskWorkDurability` says landable **and** the card is not blocked (`isSessionBlockedForAutoReview` guard, inherited verbatim from `use-review-auto-actions.ts:20`). Auto-starts linked backlog via the existing primitive. |
| **Steer a card back** (post changes + resume the session) | ✅ | Reuses the steering route (`architect-steering.md`). |
| **Spawn / unblock a follow-on build card** | ✅ but **staggered** | Must go through the normal create/start path; see §4.7 (never concurrent-burst). |
| **Stop / trash / delete a card** | ❌ **never** without human approval | Hard rule. The judge may only *recommend* `escalate` here. |

Autonomy is **opt-in and applies to NEW cards only** — never retroactively toggled onto in-flight cards. Even autonomous, every action is logged to the card timeline so the architect can audit "why did it land this."

### 4.5 The opt-in flag

Layer on the existing `autoReviewEnabled` / `autoReviewMode` card settings rather than inventing a parallel system. Add a third tier:

- today: `autoReviewEnabled=false` (manual) | `autoReviewMode="commit"|"pr"` (blunt auto-land).
- new: a **`reviewJudge`** mode — `"off"` (default; nothing changes) | `"recommend"` (judge posts a recommendation) | `"autonomous"` (judge may execute the §4.4 allow-list). Stored on the card (frontmatter → `task-card-frontmatter.ts`), settable at create time, board-level default configurable. `"autonomous"` implies the durability/blocked guards above.

### 4.6 How the recommendation is presented on the card

The recommendation is a structured note attached to the card and surfaced two ways:
- **On the board:** the card joins the Part A "Needs attention" list in an **"awaiting your confirm"** group, with a one-line verdict chip (`▸ land` / `▸ changes` / `▸ escalate`) and a click-through to the full rationale.
- **In the card detail:** the full recommendation (verdict, rationale, evidence, and — for `request_changes`/`spawn_follow_on` — the concrete proposed text) with **one-tap confirm/dismiss** buttons that invoke the same executor primitives. This is the human-in-the-loop step that `"recommend"` mode requires.

The two parts reinforce each other: Part A is *how the recommendation reaches the operator's eye*; Part B is *what fills that slot*.

### 4.7 Don't destabilize the live board

- **Never target the board it runs on / concurrent-start guard.** Concurrent card starts can wedge the UI (known lesson). If the judge spawns follow-on work, it must **stagger** starts (a small serialized queue with a delay, mirroring `AUTO_REVIEW_ACTION_DELAY_MS`) and **never** start a card on the live board it is reasoning about as a reflex. Spawns go to backlog "ready" and start through the normal throttled path, not a burst.
- **The judge is itself a card/agent** and must obey the same "don't stop/restart the live board" rules — it operates via the CLI/board API, not by poking the daemon.
- **Best-effort, never blocking.** Judge failure (LLM error, timeout) must degrade to "no recommendation → manual review," exactly as the hook ingest is best-effort today. A dead judge never wedges the review gate.

---

## 5. Options considered (cross-cutting)

### 5.1 Judge placement: client hook vs server seam
- **Extend `use-review-auto-actions.ts` (client).** Cheapest to wire — the hook already loops over review cards. **Rejected as the home for the decision:** it only runs with a tab open, so autonomous landing would silently stop when nobody's watching; and whole-board LLM reasoning doesn't belong in a render hook. It **stays** as the executor the server-side decision drives.
- **Server seam at `broadcastTaskReadyForReview` (chosen).** Robust, opt-in, natural board-read point. Slightly more plumbing (a judge runner + a way to post recommendations), but it's the only placement consistent with "can land work unattended" + "reasons about the whole board."

### 5.2 Attention data: new server fields vs derive client-side
- **Push new attention fields through workspace-state.** Rejected for the grouping/unread logic — it's per-viewer and cheap to compute client-side from data already synced; adding server fields for it violates "derive, don't re-persist." **Only** the runway number needs a server contribution, and it rides the existing usage endpoint (transcript read), not the cheap summary.

### 5.3 Runway number: last-turn snapshot vs cumulative
- Covered in §3.1 — cumulative (excl. cache-read) is the wrong quantity for runway; last-turn window-fill (incl. cache-read) is right. Validated on two real transcripts.

---

## 6. Build-card split (the card's #5 key question)

Sized to avoid a giant diff; each independently shippable. **Part A and Part B are independent** and can proceed in parallel.

**Part A — attention surface**
1. **`feat: derive per-card context-window fill (runway)`** — `deriveClaudeContextWindow` (last-turn `input + cache_read + cache_creation`, dedup by id+requestId) + a model context-window catalog beside `claude-model-pricing.ts`; extend `runtimeTaskTokenUsageSchema`/response additively; populate in the `getTaskTokenUsage` handler (same transcript pass). **Claude only.** Unit tests against a checked-in real-transcript fixture. No UI.
2. **`feat(web-ui): per-card runway chip`** — consume the new field in `use-task-token-usage.ts`; `deriveRunwayLabel` (three buckets + rising arrow); render the chip on the board card beside the token chip. Renders nothing when absent.
3. **`feat(web-ui): "Needs attention" board lens`** — the toolbar toggle + count badge; a `use-attention-groups` hook grouping the synced `sessions` + runway into awaiting-input → low-runway → unread; `lastViewedAt` via `localStorage`. Pure client.

**Part B — review-gate judge**
4. **`feat: review-judge opt-in flag + read-only board context assembler`** — the `reviewJudge` card setting (frontmatter + create flag + schema); a read-only `assembleJudgeContext(workspaceState, taskId)` that packages card result + whole board + dependencies + budget. No decision yet; unit-tested pure assembler.
5. **`feat: review-judge runner (recommend-only) at the to_review seam`** — activate on `broadcastTaskReadyForReview` when `reviewJudge !== "off"`; run the scoped judge turn; post a structured recommendation to the card; best-effort/non-blocking. Recommend mode only.
6. **`feat(web-ui): surface + confirm judge recommendations`** — the "awaiting your confirm" group + verdict chip + card-detail confirm/dismiss wired to the existing executor primitives.
7. **`feat: autonomous review-judge action allow-list`** — the `"autonomous"` tier; land/steer/spawn through existing primitives with the durability + blocked guards and the staggered-spawn queue; per-action audit log. **Ships last, behind the opt-in.**

> If review prefers a hard cut: **Part A (cards 1–3)** and **Part B (cards 4–7)** are separate PRs against `production-line`. Card 7 (autonomy) should not merge until 4–6 are proven in `recommend` mode on real cards.

---

## 7. Test strategy (for `/fleet-implement`, RED-first)

**Unit (the derive/decision cores — the real risk):**
- `deriveClaudeContextWindow`: last-turn window-fill = `in + cache_read + cache_creation`; **includes** cache-read; dedups; ignores sidechain/meta; empty transcript → absent. **Fixture assertion pinned to the measured values** (`158,490` for the captured tail) so the cache-read-inclusion rule can't silently regress to the 130× / 0.1× traps.
- `deriveRunwayLabel`: bucket thresholds; "rising" only when slope over the last N snapshots is positive; absent usage → no label.
- `assembleJudgeContext`: read-only (asserts no board mutation), includes dependencies + ready-linked ids + durability; a blocked card yields context flagged blocked.
- Judge decision mapping: given a landable+unblocked card → `land`; blocked/needs_input → never `land` (mirrors `isSessionBlockedForAutoReview`); stop/trash → never emitted autonomously.

**API/integration:**
- `getTaskTokenUsage` returns the new `contextWindow` block for a card with a resolvable Claude session; `null` for one without.
- The judge runner activates on `to_review` only when `reviewJudge !== "off"`; posts exactly one recommendation; a thrown judge degrades to no-recommendation (gate stays manual).

**BDD / surface:**
- Board renders the runway chip; the "Needs attention" toggle groups a blocked card above a low-runway card above an unread card.
- A card in `recommend` mode shows the verdict chip + confirm/dismiss; confirming `land` invokes the commit/pr primitive; a card in `off` mode shows nothing new.
- Autonomy: an autonomous card with landable work moves to Done and auto-starts its linked backlog card **staggered**; an autonomous **blocked** card does **not** advance.

---

## 8. Risks, open questions, out of scope

- **Context-window denominator drift / 1M beta.** `claude-opus-4-8` is 200K standard, but a 1M-context beta exists; a session on the beta would read as ~5× over-full against a 200K denominator. Mitigation: the catalog is one-file editable, and the runway label is a coarse bucket, not a promise. **Open question:** can we read the effective window from the transcript (some CLIs record it)? If not, the catalog default stands with the caveat surfaced in the tooltip.
- **Compaction resets** (§3.1) — runway is "until next compaction," documented so it's never 'fixed' to a session max.
- **Judge cost & latency.** Every `to_review` in a non-off card spends an LLM turn. Mitigation: recommend-mode is the default; the judge model can be cheaper than the card's own (Haiku/Codex-class for triage), decided in card 5; best-effort so it never blocks the gate.
- **Judge quality / trust.** A wrong `land` in autonomous mode lands wrong work. Mitigation: autonomy is opt-in, new-cards-only, never stops/trashes, obeys the durability + blocked guards, and audit-logs every action. Recommend-mode is the on-ramp; autonomy earns trust only after 4–6 prove out.
- **Codex/Cline runway.** Only Claude ships in card 1. Codex's `total_token_usage` gives a cumulative snapshot but a different window size; Cline reports via SDK. Follow-up, not this cut.
- **Out of scope:** precise burn-rate projection / ETA-to-limit analytics; a dedicated attention *panel/mode* (rejected, §3.3); rate-limit *detection* beyond surfacing `warningMessage` (a dedicated rate-limit hook is a later enrichment); cross-initiative budget metering as a hard cap; the judge stopping/trashing cards (never).
