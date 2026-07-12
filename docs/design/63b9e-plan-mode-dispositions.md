# Plan-mode dispositions, completion policy & card badges

**Status:** design (plan card — no code)
**Author:** design pass, 2026-07-12
**Card:** `63b9e`
**Builds on:** `docs/design/05506-done-vs-trash-lifecycle.md` (the done/trash/archived lifecycle
this must stay consistent with) and `fleet/docs/kanban-ui-epic.md` §4.4 (PR-aware card lifecycle).

**Prior art (read with `git show <sha>` before starting the badge chunks):**
- `44f4b86` — *feat(web-ui): always show the agent and model on board cards* — the badge-row region
  (`board-card.tsx:879-913`) every new badge extends; establishes the muted bordered-chip styling.
- `edf021d` — *feat(web-ui): show per-card token-usage chip on board cards* — the
  render-nothing-when-N/A chip pattern the badges copy.
- `6e7d010` — *feat(kanban): show the PR a card led to on review and done cards* — the PR link
  (`board-card.tsx:480-495`), already in the badge region.
- `1450207` — *feat(kanban): resolve the GitHub PR a card's branch led to* — `resolveCardPrUrl`
  (`src/workspace/card-pr-url.ts`), the source of `prState`.

---

## 1. Problem & symptom

A card's whole "what kind of work is this, and what happens when it's done" story is fixed **at
creation, before the work exists**, and is scattered across two unrelated knobs:

- **`startInPlanMode: boolean`** — set by the "Start in plan mode" checkbox in the create dialog
  (`task-create-dialog.tsx:526-537`), persisted on the card (`api-contract.ts:139`,
  `board.ts:45`). It is a *launch* flag: each agent adapter turns it into a different native
  plan-mode incantation at spawn time (§4).
- **`autoReviewEnabled` + `autoReviewMode` (`"commit" | "pr"`)** — the "Automatically [Make
  commit | Make PR]" control, also creation-time (`task-create-dialog.tsx:552-581`), persisted at
  `api-contract.ts:140-141`. This is the self-landing knob: on review the board injects a
  commit/PR prompt into the session, then auto-moves the card to done (§4).

Three gaps fall out of this:

1. **No first-class "Plan card vs Build card."** The board has no notion that a card's *product*
   is a design doc rather than a code change. `startInPlanMode` is the closest proxy, but it is a
   launch detail, not a card type — and per `AGENTS.md`, design cards now materialize their plan to
   `docs/design/<card-id>-<slug>.md` *by convention* rather than relying on native plan mode at all.
2. **No review-time choice of what to do with a finished plan.** The right next step for a plan —
   implement it in the same session, hand it to one fresh build card, or hand it back to the
   architect to fan out N cards — is only knowable *after you read the plan*. Today there is no slot
   for that decision; a plan card just sits in review like any other.
3. **The card doesn't tell you what will happen.** Before completion you cannot see, at a glance,
   whether a card self-lands (auto-commit / auto-PR) or that it is a plan rather than a build. The
   agent·model chip (`44f4b86`) and PR link (`6e7d010`) already live in a badge row; the
   self-landing and plan signals are simply missing from it.

**Desired outcome.** One coherent model: a card has a **kind** (Plan / Build), and a single
**completion policy** — "what happens when this card's work is approved" — chosen *at review*, whose
vocabulary depends on the kind. Every card wears a consistent badge row that surfaces kind,
agent·model, self-landing policy, and PR link, each badge appearing only when it applies.

---

## 2. How plan mode actually works today (grounded)

`startInPlanMode` is threaded card → start-request → adapter: persisted at `api-contract.ts:139`,
set on the request at `runtime-api.ts:273` (Cline SDK) and `:331` (PTY), forwarded by
`session-manager.ts:401`, then consumed per-agent in `agent-session-adapters.ts`. **What each
adapter does is not uniform:**

| Agent | Plan-mode mechanism | Citation |
|---|---|---|
| **Claude** (PTY) | CLI flag `--permission-mode plan` (strips `--dangerously-skip-permissions` first) | `agent-session-adapters.ts:687-692` |
| **Codex** (PTY) | Injects a `/plan <prompt>` slash command as deferred startup input (bracketed paste) | `agent-session-adapters.ts:886-888` |
| **Gemini** (PTY) | CLI flag `--approval-mode=plan` | `agent-session-adapters.ts:928-930` |
| **OpenCode / Kiro** (PTY) | `--agent plan` (+ env / prompt prefix) | `agent-session-adapters.ts:1229-1233` |
| **Droid** (PTY) | Settings `autonomyMode: "spec"` | `agent-session-adapters.ts:1301` |
| **Cline** (SDK) | **Prompt injection only** — mode forced to `"act"` | `cline-task-session-service.ts:336` |

Two facts drive the whole design:

- **Native plan mode is heterogeneous and, for the SDK path, not even a real mode.** Cline resolves
  `startInPlanMode ? "act" : …` (`cline-task-session-service.ts:336`) and achieves "planning" by
  wrapping the prompt ("produce a plan only… ask for approval before making changes",
  `buildClineStartPrompt` `:152-163`). So "plan mode" already means *"a prompt convention that stops
  before editing,"* which is exactly what materialize-to-a-file formalizes.
- **Only the Cline SDK path can flip plan → act mid-session.** `sendTaskSessionInput(taskId, text,
  mode?)` carries a per-message mode (`cline-task-session-service.ts:544-565`,
  `updateActiveSessionMode` at `cline-session-runtime.ts:530-542`), surfaced as the composer's
  plan/act toggle (`cline-agent-chat-panel.tsx:272-278`). **PTY agents cannot** — plan mode is fixed
  by launch flags, there is no re-launch/mode-rewrite path, and **there is no `ExitPlanMode`
  handling anywhere in the repo**. On PTY the only "approve" lever is injecting text/keystrokes into
  the live agent (§4).

---

## 3. Principles

- **Plans materialize to a file; that is what makes a design card safe — not native plan mode.**
  Because a plan card writes `docs/design/<card-id>-<slug>.md` and commits it (`AGENTS.md`), the
  durable artifact exists whether or not the agent ran read-only. Native plan mode's job (don't
  touch files until approved) is redundant with the convention.
- **Disposition is chosen at review, not creation.** You cannot know whether a plan should be
  implemented here, handed off, or decomposed until you have read it. The decision belongs next to
  the finished work, in the same slot where a build card chooses how it lands.
- **One "on approval" concept across card types.** manual / auto-commit / auto-PR (build) and
  implement-here / hand-off / hand-back (plan) are the *same slot*: "what happens when this card's
  work is approved." Spec and render them as one model discriminated by kind, not two features.
- **Badges read data the card already stores, and render nothing when N/A.** Follow the token-chip
  precedent (`edf021d`): a badge that doesn't apply occupies no space.
- **Additive, upstreamable, reuse existing plumbing.** The approval/self-landing actions all reduce
  to *inject a prompt into the live session* — the mechanism auto-review and `fleet task say`
  already share (§4). No new execution engine.

---

## 4. The execution substrate we build on (grounded)

Every "on approval" action in this design is **agent-driven prompt injection**, not runtime git
work. This already exists for auto-review and is the single substrate we extend:

- **Auto-review is agent-driven.** `use-review-auto-actions.ts` watches review cards; when
  `autoReviewEnabled` and `changedFiles > 0` it calls `runAutoReviewGitAction(taskId, mode)`
  (`:237-255`). `use-git-actions.ts:277-315` builds a templated prompt
  (`buildTaskGitActionPrompt`, default templates in `runtime-config.ts:60-99` — literal "stage and
  commit…" / "push the branch… create a pull request… use gh CLI") and **injects it into the
  session**: Cline via `sendTaskChatMessage(taskId, prompt, {mode:"act"})` (`:290`), PTY via
  `sendTaskSessionInput(taskId, prompt, {mode:"paste"})` then a separate `"\r"` submit
  (`:302-315`). The *agent* runs git/gh; the runtime only supplies the prompt and detects the
  result (`changedFiles → 0` ⇒ auto-move to done, `use-review-auto-actions.ts:196-225`).
- **`fleet task say` is the same injection primitive.** `runtime-api.ts:393-435`
  `sendTaskSessionInput`: Cline gets the text as a discrete message (`:399-406`); PTY gets a
  bracketed paste (`toBracketedPasteSubmission`, `agent-session-adapters.ts:634-636`) then a
  separate `"\r"` (`:430-434`). `fleet task say` calls exactly this with `bracketedPaste:true,
  submit:true` (`task.ts:790-796`).

**Consequence for "implement here":** a plan-approval board action is a *cousin of `fleet task
say`* — inject "The plan in `docs/design/<card-id>-<slug>.md` is approved; implement it now" into
the live session. Because the plan is already a committed file, the agent re-reads its own doc and
builds. This needs **no** native plan-mode approve→build, **no** `ExitPlanMode` plumbing, and works
uniformly across PTY and SDK agents. (For Cline it can additionally set `mode:"act"`, matching
auto-review at `use-git-actions.ts:290`.)

- **PR state (`prState`) reconciliation gotcha.** `workspace-metadata-monitor.ts:316-361` captures a
  card's PR **only while it is in `review`**, via `resolveCardPrUrl` → `gh pr list --head <branch>
  --state all` (`card-pr-url.ts:105-117`), preferring newest **open** then newest **merged**
  (`:80-81`). Cards in done/trash are **not re-polled** (`:90-95`). So an auto-PR card is captured
  with `prState:"open"` and, after it moves to done, **does not flip to `"merged"`** on its own. This
  is the crux of the done=durable tension in §6/Q4.

---

## 5. Target model

### 5.1 Card **kind**: Plan vs Build

Introduce the idea of a card *kind*. A **Plan** card's product is a design doc at
`docs/design/<card-id>-<slug>.md`; a **Build** card's product is a code change that lands via
commit/PR. Kind drives (a) the Plan badge and (b) the completion-policy vocabulary.

- **Phase 1 (cheap):** derive kind from existing data — `startInPlanMode === true` ⇒ Plan. This is
  the trivial badge win (no schema change, reads a field the card already stores).
- **Later:** promote to an explicit persisted `kind: "plan" | "build"` (default `"build"`, set by
  the `--plan` create flag), *decoupling plan-ness from `startInPlanMode`*. See §6/Q1 for why the
  two must separate.

### 5.2 Completion policy — one slot, kind-dependent vocabulary

**Completion policy = "what happens when this card's work is approved,"** a single review-row slot on
every card. Its options depend on kind:

| Kind | Policy options | What each means |
|---|---|---|
| **Build** | `manual` · `auto-commit` · `auto-PR` | Today's `autoReviewEnabled`+`autoReviewMode`. `manual` = human clicks Commit/Open PR (`board-card.tsx:993-1024`); `auto-commit`/`auto-PR` = the agent-driven self-land of §4. |
| **Plan** | `hand-off` (default) · `implement-here` · `hand-back` | What to do with the finished, committed plan (below). |

**Plan dispositions:**

- **Hand-off (default).** The plan seeds **exactly one** fresh Build card (may switch agent/model,
  e.g. Opus→Codex), prefilled with the plan path and prompt. The plan card itself completes (its doc
  commits / opens a PR like any Build card). This is a pure board mutation — create-one-linked-card
  — needing no live-session interaction. It is the safe default because it works for every agent and
  never depends on a still-running session.
- **Implement-here.** The *same* session flips plan→build: inject "plan approved, implement it now"
  via the §4 substrate (cousin of `fleet task say`; Cline additionally `mode:"act"`). Same agent,
  full primed context, no re-read cost. Requires the live session to still be attached.
- **Hand-back to architect.** The plan returns to the architect agent, which fans out N ordered
  Build cards. For large/decomposable work. Reuses the architect's existing task-creation surface
  (the architect is itself a board-managing agent, `append-system-prompt.ts`); the board action is
  "send the plan to the architect session as a decomposition request."

### 5.3 Badge row

Extend the existing badge region (`board-card.tsx:879-913`), matching its muted, bordered-chip /
`font-mono` styling. Each badge is **render-nothing-when-N/A** (token-chip precedent):

| Badge | Shows when | Reads | Style |
|---|---|---|---|
| **Plan** | kind is Plan (Phase 1: `startInPlanMode`) | `startInPlanMode` → later `kind` | distinct color — `status-purple` (reserved, unused by other chips) |
| **agent · model** | already shipped | `agentId` / `agentModel` / `clineSettings` | `status-blue` chip (`board-card.tsx:881-902`) |
| **completion policy** | `autoReviewEnabled` (build) / non-default plan disposition | `autoReviewEnabled` + `autoReviewMode` → "Auto-commit" / "Auto-PR"; plan disposition label | muted chip; distinct from the review-only "Cancel Auto-X" *button* (`board-card.tsx:1025-1038`) |
| **PR link** | `prUrl` present | `prUrl` / `prNumber` | already shipped (`board-card.tsx:480-495`) |

The completion-policy badge is **informational and always-on** (any column), so you see *before*
completion whether a card self-lands — unlike the existing cancel button, which only appears in
review. `getTaskAutoReviewActionLabel` (`board.ts:25-31`) already yields "commit"/"PR"; a sibling
`getTaskCompletionPolicyBadgeLabel` returns "Auto-commit"/"Auto-PR"/null.

---

## 6. Decisions (open questions, resolved)

### Q1 — Retire, repurpose, or keep `startInPlanMode`? → **Repurpose (decouple), don't delete.**

`startInPlanMode` conflates two things: "this is a plan card" (a *kind*) and "launch the agent in
its native read-only sandbox" (a *launch flag*). The materialize-to-a-file convention makes the
launch flag **unnecessary for design cards** — they write the doc in normal act mode and commit it.

- **Retire it as the design-card mechanism.** Design cards created via `--plan` should set the
  card's *kind*, not `startInPlanMode`. The plan card writes the doc; native read-only mode is not
  required for safety.
- **Keep it as a narrow, optional launch flag.** Some operators still want an agent's genuine
  read-only plan sandbox (e.g. an exploratory Claude `--permission-mode plan` run). Leave the field
  and the checkbox, but relabel/reposition it as "launch read-only (native plan mode)", independent
  of kind/disposition.
- **Phase 1 pragmatism:** until the explicit `kind` field lands, the Plan badge reads
  `startInPlanMode` as the proxy. That is why Chunk 1 is trivial and Chunk 3 does the decoupling.

### Q2 — Is "implement-here" worth the plan-approval board action **now**? → **Phased: no, ship hand-off first.**

Implement-here reuses the §4 injection substrate, so it is *cheap to execute* — but it carries UX
and reliability nuance that hand-off does not: it depends on the live session still being attached,
and the "approve" affordance must read sensibly next to Cline's own plan/act toggle. Hand-off and
hand-back are pure board mutations (create-one-card / send-to-architect) with no live-session
coupling, so they are both simpler and the higher-frequency need (Opus plans, Codex builds).

**Recommended order:** badges (Phase 1) → unify completion-policy model + **hand-off** (default) →
**implement-here** (the live-session approval action) → **hand-back** (architect fan-out). Ship the
value that reads existing data first; add the live-session capability once the model exists.

### Q3 — Who chooses the disposition, and how is it surfaced? → **Human on the board (primary); architect via CLI (secondary); one field either writes.**

The disposition is a per-card completion-policy value, so it is set the same way the auto-review knob
is today — except **relocated to the review column**, next to the finished work, instead of the
create dialog. Surface it as a small select/segmented control in the plan card's review actions
(mirroring `showReviewGitActions`, `board-card.tsx:993-1024`): *Hand off · Implement here · Hand
back*. The **architect agent** can set the same field from the CLI (`fleet task` — it already
creates/links cards), so an autonomous pipeline can pick a disposition without a human. Both paths
write one field; the board is the source of truth.

### Q4 — How does completion policy reconcile with done = durable? → **Policy names the self-landing action; the done transition and durability stay 05506's.**

`05506` establishes: entering `done` **never** destroys a worktree, removal is an explicit gated
*Trash* action, and *done = durable* ultimately means **merged** — with the git/PR-derived reconcile
that makes done truly durable explicitly **out of scope there** (its §8), a later layer.

This design must not contradict that:

- **Completion policy decides *what self-landing action runs*, not *what durable means*.** `auto-PR`
  means "the agent opens a PR, then the card moves to done" — which, per §4, captures `prState:
  "open"`, i.e. **unlanded** (commits pushed + PR exists, recoverable) rather than merged.
- **The card moving to done on PR *open* is intentional and consistent with 05506:** done is a proud
  terminal column write; the durability gate still governs any later worktree removal
  (`05506` §4/§5, Q1). The **completion-policy badge (Auto-PR)** is precisely the signal that this
  card self-landed to an *open* PR, so a reviewer knows it is done-but-not-yet-merged.
- **The `prState "open" → "merged"` flip is 05506's future reconcile layer, not this card.** Because
  the monitor stops polling once a card leaves `review` (§4 gotcha), making done reflect *merged*
  requires the git/PR-derived reconcile 05506 defers. This design **flags the dependency** and does
  not attempt it: our badge honestly shows the last-captured state.

---

## 7. Implementation decomposition (the deliverable)

Five ordered Codex cards. Cheapest, highest-value slices first; each leaves the board working.

### Chunk 1 — Plan & completion-policy badges (reads existing data, no schema change)
- **Scope:** Add a **Plan** badge (shows when `startInPlanMode`, `status-purple`, distinct from the
  `status-blue` agent chip) and a **completion-policy** badge ("Auto-commit"/"Auto-PR" when
  `autoReviewEnabled`, else nothing) to the existing badge row. Add a
  `getTaskCompletionPolicyBadgeLabel` helper beside `getTaskAutoReviewActionLabel`. Render nothing
  when N/A.
- **Files:** `web-ui/src/components/board-card.tsx` (badge row `879-913`),
  `web-ui/src/types/board.ts` (label helper).
- **Tests:** `board-card.test.tsx` — Plan badge renders iff `startInPlanMode`; completion-policy
  badge renders iff `autoReviewEnabled` with the right label; both absent on a plain card (no extra
  DOM). Helper unit test for the label mapping.
- **Depends on:** nothing. Pure additive read.

### Chunk 2 — Unify the completion-policy model (one concept, discriminated by kind)
- **Scope:** Introduce a derived TS concept `CardCompletionPolicy` computed from existing fields
  (build: `autoReviewEnabled`+`autoReviewMode`; plan: disposition — placeholder until Chunk 3) plus
  a `cardKind(card)` helper (Phase-1 derivation from `startInPlanMode`). No persisted schema change;
  this is the seam the UI and later chunks read through, so completion policy is *one* model, not
  two. Route the Chunk 1 badge through it.
- **Files:** `web-ui/src/types/board.ts` (new `card-completion-policy.ts` util + `cardKind`),
  `web-ui/src/components/board-card.tsx` (consume the seam).
- **Tests:** util unit tests — build cards map to manual/auto-commit/auto-PR; plan cards map to the
  disposition vocabulary; kind derivation.
- **Depends on:** Chunk 1.

### Chunk 3 — Explicit card `kind` + decouple `startInPlanMode` (Q1)
- **Scope:** Add persisted `kind: "plan" | "build"` (`z.enum(...).default("build")`, additive zod
  per `api-contract.ts` idiom) set by the `--plan` create flag; point `cardKind`/Plan badge at it.
  Relabel the "Start in plan mode" checkbox as an independent "launch read-only (native plan mode)"
  option that no longer implies plan-ness.
- **Files:** `src/core/api-contract.ts` (card schema + create request), `src/core/
  task-board-mutations.ts` (persist kind), `src/commands/task.ts` (`--plan` sets kind),
  `web-ui/src/types/board.ts`, `web-ui/src/components/task-create-dialog.tsx` (relabel/reposition).
- **Tests:** old `board.json` without `kind` parses as `build`; `--plan` create yields `kind:"plan"`;
  a card with `kind:"plan"` and `startInPlanMode:false` still shows the Plan badge.
- **Depends on:** Chunk 2.

### Chunk 4 — Review-time disposition slot: **hand-off** (default) + hand-back (Q2/Q3)
- **Scope:** Persist a plan card's disposition (extend completion policy). In the review column,
  render a disposition control on plan cards (*Hand off · Implement here · Hand back*), mirroring
  `showReviewGitActions`. Wire **hand-off** (create one linked Build card prefilled with the plan
  path/prompt; complete the plan card) and **hand-back** (send the plan to the architect session as
  a decomposition request). Expose the same field to the architect via `fleet task`.
- **Files:** `src/core/api-contract.ts` (disposition field), `src/core/task-board-mutations.ts`
  (hand-off create-linked mutation), `web-ui/src/components/board-card.tsx` (review control),
  `web-ui/src/hooks/use-board-interactions.ts` (actions), `src/commands/task.ts` (CLI setter).
- **Tests:** hand-off creates exactly one linked Build card with the plan path and completes the
  plan card; hand-back routes to the architect; default is hand-off; disposition round-trips through
  `board.json` and CLI.
- **Depends on:** Chunk 3.

### Chunk 5 — **Implement-here**: plan-approval board action (the live-session capability, Q2)
- **Scope:** A board action that injects "plan in `docs/design/<card-id>-<slug>.md` approved —
  implement it now" into the live session via the §4 substrate (`sendTaskSessionInput`
  bracketed-paste+submit; Cline additionally `mode:"act"`, matching `use-git-actions.ts:290`). Guard
  on session attached; fall back to hand-off with a toast when the session is gone. Flip the card's
  kind/policy to a building state so the badge updates.
- **Files:** `web-ui/src/hooks/use-git-actions.ts` (new `runPlanApprovalAction`, reuse
  `sendTaskSessionInput`/`sendTaskChatMessage`), `web-ui/src/components/board-card.tsx` (the
  "Implement here" action), optionally `src/commands/task.ts` (`fleet task approve-plan` cousin of
  `task say`).
- **Tests:** action injects the templated approval and submits; Cline path sets `mode:"act"`; a
  gone session declines and suggests hand-off; no injection when the disposition isn't implement-here.
- **Depends on:** Chunk 4. Reuses existing injection plumbing (no new executor).

---

## 8. Out of scope / dependencies

- **PR merge-state reconcile** (`prState "open" → "merged"` after a card leaves review) is
  `05506` §8's git/PR-derived layer, not this card (§6/Q4). Our badges honestly show last-captured
  state.
- **Native `ExitPlanMode` / mid-session plan→act on PTY agents.** Not built and not needed —
  implement-here uses prompt injection, which is agent-uniform (§4). If a future card wants true
  PTY plan-mode approval it is a separate change.
- **Multi-card fan-out UX for hand-back** beyond "send to architect" (e.g. previewing the N cards
  before they land) — Chunk 4 wires the hand-off to the architect; richer fan-out review is a
  follow-on.
