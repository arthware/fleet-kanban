# Re-model card types as `plan` + `build` (retire the confusing `feature`)

**Status:** design — buildable spec + build plan. Does **not** implement. · **Epic branch:**
`epic/card-types` · **Supersedes the type/activation half of**
[`card-types-skill-pipeline.md`](./card-types-skill-pipeline.md) (that doc's D1–D5, the `feature`
manifest, and its §6 injection wiring are what this evolves; its §7 seams are kept intact).

**Ref / slug:** no external issue ref; deliverable path fixed by the card to
`docs/design/plan-build-card-types.md`.

This doc turns the "plan/build card types" decision into a file-by-file spec. The direction
(`plan` + `build` replace `feature`; native plan-mode is removed; the activation defect is fixed at
the root) is **decided — do not re-litigate it**; the work here is to resolve the mechanics that were
left open: the activation-defect fix, the plan→implement disposition fork, surfacing the phase on the
board card, and an end-to-end lane-injection verification.

---

## 1. Root cause — why `feature` is the wrong model (read this first)

The shipped model has one built-in type, **`feature`**, in which "plan" is not a first-class intent
but an implicit **`--plan` sugar flag** that activates a `design` phase **bound to the `backlog`
lane** (`fleet/card-types/feature.md:5-9`, `src/core/card-type.ts:48-49`). Empirically that produced
two coupled defects and one naming defect.

### 1.1 Defect A — plan activation rides a transient lane snapshot (the latent time-bomb)

`startTaskSession` composes a card's directive by reading the card's **current lane** off the
on-disk board and gating each phase on `phase.lane === lane`:

```ts
// src/trpc/runtime-api.ts:476-482
const lane = getTaskColumnId(board as any, body.taskId) || "in_progress";
const { skills: orderedSkills, planMode } = resolveActiveSkillsForLane(manifest, {
  startInPlanMode: body.startInPlanMode,
  autoReviewEnabled: body.autoReviewEnabled,
  autoReviewMode: body.autoReviewMode,
  lane,
});
```

The CLI `startTask` reads/moves the lane in a specific order — it starts the session **before** it
moves the card to `in_progress`:

```ts
// src/commands/task.ts
942:  const started = await runtimeClient.runtime.startTaskSession.mutate({ … });   // reads lane here
959:  const movement = moveTaskToColumn(latestState.board, taskId, "in_progress");  // moves lane here
```

So the `design` phase — bound to `backlog` — only injects `fleet-plan` when the board read at
`runtime-api.ts:476` happens to observe `"backlog"`. Two things make that dishonest and fragile:

1. **The design phase is pinned to the wrong lane.** Planning does not *run* in `backlog`; the agent
   session runs in `in_progress` like every other session. `backlog` is merely the lane the card
   sits in for the millisecond between `mutate` returning and the move landing. The phase is bound to
   a **transient position**, not to where its work happens.
2. **The `|| "in_progress"` fallback hides the fragility for build and weaponizes it for plan.** If
   `getTaskColumnId` returns `null` (the card isn't found in the freshly-loaded board, or a refactor
   moves the lane read after the column move), the lane silently defaults to `in_progress`. For a
   **build** card that is *harmless* — `build` is bound to `in_progress`, so it still activates. For
   a **plan** card it is *silent data loss* — `design` (bound to `backlog`) drops, the composed
   directive is empty, and the card starts with **no plan directive and no error**. Reorder the two
   lines above in any "harmless" refactor and every plan card quietly stops planning.

This is precisely the `AGENTS.md` / Constitution Article 2 signal — *"a recurring bug means the model
is wrong."* The bug is latent, not yet fired, but the model that makes it possible is already broken:
**a workflow's identity must not depend on a race between a lane read and a lane move.**

### 1.2 Defect B — no home for the plan→implement disposition fork

After a plan exists, a human must choose one of two exits: **fan out** dedicated build cards, or
**implement here** in the same session/worktree. `feature` — a single bundle-with-flags — has nowhere
to host that decision, and no verb expresses it. The disposition is currently tribal knowledge, not a
modeled transition.

### 1.3 Defect C — `feature` names a bundle, not an intent

`feature` reads as "the everything type," toggled by two orthogonal booleans (`startInPlanMode`,
`autoReviewEnabled`+`mode`). A card author cannot tell from the type name whether a card plans or
builds — the intent lives in flags, not in the type. Every new behavior has meant *another flag*
stacked on the same bundle. The type should **name the intent**; a card is either a plan card or a
build card.

---

## 2. Locked decisions (spec these; do not re-litigate)

| # | Decision | Resolution |
|---|----------|------------|
| **P1** | Two intent-first built-in types | Replace `feature` with **`build`** and **`plan`**. A card *is* one or the other. No third "everything" type. |
| **P2** | Default type | `--type` unset ⇒ **`build`**. A bare card implements — byte-identical to today's default build directive. |
| **P3** | Retire `feature` cleanly | `feature` is **not in production**; delete `feature.md` with **no alias, no migration table**. (Migration reality checked in §4.5 — the default is *derived at runtime*, never persisted, so there is nothing on disk to migrate.) |
| **P4** | Native plan-mode is **removed**, not preserved as sugar | The `plan` **type** fully replaces plan mode. Delete the `startInPlanMode` card field, the `--plan` / `--start-in-plan-mode` flags, the `plan-flag` activation value, the manifest `planMode?` field, and the native plan-mode launch flag. You plan by creating a `--type plan` card. No silent muscle-memory alias (see §4.6 for the loud-guidance replacement). |
| **P5** | Plan's design phase activates by `default` | Because the *type is the intent*, `plan`'s `design` phase is `activation: default` (always active for a plan card) — not gated on a `plan-flag`. Its lane is **`in_progress`** (where the work actually runs), not `backlog`. |
| **P6** | Activation is decoupled from the lane snapshot at start | Session-start composition is driven by **`(cardType, activation flags)`** only — **never** by `phase.lane === currentLane`. Remove the `getTaskColumnId` read from the start path. Lane-driven injection survives as a *separate*, event-driven **lane-entry** seam (§6.2). This makes Defect A **impossible**, not documented-around. |
| **P7** | `--auto-review pr` stays a flag — **for now** | It continues to activate `build`'s `ship` phase via `auto-review-pr`. Folding it into a type is a **separate follow-up cleanup**, explicitly *not* in this card (§9). |
| **P8** | No new board lane | Lanes stay the four columns. A "plan" column would duplicate state the type + phase already encode. |

**Out of scope to build (keep clean seams, do not regress):** enter-Review auto-start of a review
session; autonomous scheduler / DAG orchestration; a future dedicated PR-review lane. Attach points
named in §8.

---

## 3. The honest injection model (the core re-model)

The fix separates **two triggers that `feature` conflated into one racy read**:

1. **Session-start injection** — what `fleet task start` does. Compose the directive from the card
   **type manifest's start-active phases**: the phases whose `activation` is satisfied by the card's
   flags **and** is not `dormant`, in declaration order. **Lane is not an input.** Deterministic,
   race-free.

2. **Lane-entry injection (the seam, additive, future)** — when a card *transitions into* a lane that
   has a bound phase (e.g. a future `pr-review` lane → `fleet-review`), inject that lane's skill **on
   the entry event**. This is driven by a real board transition, not by a snapshot read at an
   unrelated moment. Today the only lane-bound-but-not-start phase is the `dormant` `verify` phase,
   which injects **nothing** — so removing lane from the start path is behavior-preserving.

The `lane` field on a phase does not disappear — it stops being a *start-time gate* and becomes
honest metadata: **where the phase runs** (drives the phase-in-UI badge, §7) and **which lane-entry
event will fire it** (the future seam). That is the whole re-model: identity comes from the **type**,
position is just position.

---

## 4. Data model

### 4.1 The card's persisted state shrinks

The only card-level type state is the existing optional field:

- **`cardType?: string`** — defaults to **`build`** when unset (was `feature`). Still the only new
  persisted card state (Article 7: additive/optional at the wire boundary).

**Removed** card state (P4): **`startInPlanMode`**. It was a boolean standing in for "this is a plan
card"; the `plan` *type* now carries that meaning. Its removal at the wire boundary is the one place
this design touches persistence — handled additively per §4.5.

`autoReviewEnabled` / `autoReviewMode` stay unchanged (P7).

### 4.2 The manifest schema (simplified)

`src/core/card-type.ts` today (`card-type.ts:3-23`) carries a `plan-flag` activation and a per-phase
`planMode` field. Both are deleted (P4):

```ts
// src/core/card-type.ts — after
export const cardTypePhaseActivationSchema = z.enum(["default", "auto-review-pr", "dormant"]);
//                                                    ^ "plan-flag" removed

export const cardTypePhaseSchema = z.object({
  name: z.string(),
  lane: cardTypePhaseLaneSchema,          // documentation + phase-in-UI + future lane-entry seam
  skills: z.array(z.string()),
  activation: cardTypePhaseActivationSchema,
  // planMode: removed
});
```

And the resolver loses its `lane` parameter (P6):

```ts
// src/core/card-type.ts — replaces resolveActiveSkillsForLane
export function resolveStartActiveSkills(
  manifest: CardTypeManifest,
  flags: { autoReviewEnabled?: boolean; autoReviewMode?: string | null },
): string[] {
  return manifest.phases
    .filter((phase) => {
      switch (phase.activation) {
        case "default":         return true;
        case "auto-review-pr":  return flags.autoReviewEnabled === true && flags.autoReviewMode === "pr";
        case "dormant":         return false;    // never at start; future lane-entry seam only
      }
    })
    .flatMap((phase) => phase.skills);   // declaration order preserved
}
```

The `{ planMode }` return is gone (no more native plan mode). A separate, additive function serves the
future lane-entry seam without touching the start path:

```ts
// src/core/card-type.ts — the seam (returns [] today for every real lane)
export function resolveLaneEntrySkills(manifest: CardTypeManifest, lane: string): string[] {
  return manifest.phases
    .filter((p) => p.lane === lane && p.activation === "dormant")   // only dormant phases fire on entry
    .flatMap((p) => p.skills);
}
```

### 4.3 Built-in `build.md` (the default)

Path `fleet/card-types/build.md`. Reproduces today's default build → ship workflow:

```markdown
---
name: build
description: The default card workflow — implement, then ship a PR when auto-review is on.
phases:
  - name: build
    lane: in_progress
    skills: [fleet-implement]
    activation: default
  - name: ship
    lane: in_progress
    skills: [fleet-pr]
    activation: auto-review-pr
  - name: verify
    lane: review
    skills: [fleet-review]
    activation: dormant
---

# build

The default workflow every card runs unless it names another type. `build` always runs; `ship` is
activated by `--auto-review pr` and composes the PR directive **after** build in the same
(`in_progress`) lane — reproducing today's implement→pr stacking. `verify` is declared so
`fleet-review` has a home the moment the autonomous loop or a dedicated PR-review lane wants it, but it
is dormant in v1 (no start-time injection; the future lane-entry seam fires it — §6.2).
```

### 4.4 Built-in `plan.md` (plan only, no build/ship)

Path `fleet/card-types/plan.md`:

```markdown
---
name: plan
description: Plan only — investigate and produce a design doc; land in review for disposition.
phases:
  - name: design
    lane: in_progress
    skills: [fleet-plan]
    activation: default
  - name: verify
    lane: review
    skills: [fleet-review]
    activation: dormant
---

# plan

A plan card produces the design doc and stops. `design` **always** runs (the type is the intent — no
`--plan` flag) and injects `fleet-plan`; the card lands in `review` for the disposition fork (§5):
fan out dedicated `build` cards, or promote the same worktree to a `build` card in-session. There is
**no** build or ship phase — a plan card never implements.
```

Note `design.lane` is **`in_progress`**, not `backlog`. That is the honest lane (the plan session runs
in `in_progress`) and, because lane is no longer a start-time gate (P6), it carries **zero** start-path
risk — it only informs the phase-in-UI badge (§7).

### 4.5 Migration — there is nothing to migrate

- **Default type is derived, never persisted.** The `"feature"` literal lives at exactly one place —
  the runtime fallback `body.cardType?.trim() || boardCardType?.trim() || "feature"`
  (`runtime-api.ts:469`). Bare cards carry **no** `cardType` field on disk; they resolve their type at
  start. Flip the fallback to `"build"` and every existing bare card becomes a `build` card with no
  board rewrite.
- **Verification step for the build card:** grep the live/dogfood `board.json` (and any fixture
  boards) for `cardType": "feature"` before deleting `feature.md`. Expected result: **none** (a card
  only persists `cardType` when created with an explicit `--type`, and `feature` was never the
  explicit value — it was the implicit default). If any are found, they are dev artifacts — recreate
  them rather than shipping alias glue.
- **Belt-and-suspenders resolver default.** Spec `loadCardTypeManifest` (or its caller) to fall back
  to the **`build`** manifest when a named type's manifest is missing, so a stray `cardType:
  "feature"` (or any typo) degrades to the default build workflow — an empty directive — **never** to
  a silent no-op. This replaces the current "manifest missing ⇒ inject nothing" branch
  (`runtime-api.ts:475`).
- **`startInPlanMode` at the wire boundary (Article 7).** Removing the field from
  `runtimeTaskSessionStartRequestSchema` / `runtimeBoardCardSchema`
  (`api-contract.ts:203,218,1221,1238`) must stay **additive/tolerant**: keep the field *parseable but
  ignored* for one release (schema `z.boolean().optional()`, dropped from all consumers) so an
  in-flight board written by the old build does not fail validation. No consumer reads it after this
  card. (This is the only compatibility concession; everything else is clean replacement per Article
  7.)

### 4.6 `--plan` becomes a loud guidance error, not a silent alias

P4 removes `--plan`. A silent `--plan → --type plan` alias would **re-introduce the exact confusion
this card removes** (behavior hiding in a flag instead of naming the type), so it does **not** earn its
keep. Instead, `fleet task create --plan` (and `--start-in-plan-mode`) should **fail fast with
guidance**:

```
error: --plan was removed. Plan is now a card type: `fleet task create --type plan …`.
```

Loud and self-correcting for muscle memory, with none of the alias's hidden-behavior debt.

---

## 5. The disposition fork at `review`

A `plan` card lands in `review`. It exits two ways.

### 5.1 Fan out — reuse the existing linking machinery (no new code)

The architect creates linked `build` cards in `backlog` with a dependency edge
`{ fromTaskId: buildCard, toTaskId: planCard }`. When the plan card moves **`review` → `done`**, the
existing auto-start path fires:

```ts
// src/core/task-board-mutations.ts:258-277 — gate requires fromColumnId === "review"
function getLinkedBacklogTaskIdsReadyAfterTaskCompleted(board, taskId, fromColumnId) {
  if (!taskId || board.dependencies.length === 0 || fromColumnId !== "review") return [];
  …returns backlog cards whose toTaskId === taskId…
}
// src/commands/task.ts:1214-1222 — completeTask auto-starts each ready card
for (const readyTaskId of mutation.value.readyTaskIds) {
  const started = await startTask({ cwd, taskId: readyTaskId, projectPath });
  autoStartedTasks.push(started);
}
```

**This works unchanged with the new types** — the machinery is keyed on lane transitions and
dependency edges, not on `cardType`. The build card only needs to **confirm** it (a Given/When/Then
test: plan card `review→done` with a linked backlog `build` card ⇒ the build card auto-starts and its
composed directive is `fleet-implement`).

**One caveat to document (memory: [[land-does-not-autostart-linked-cards]]):** this auto-start fires on
the **board move to done**, *not* on `fleet xtools land`, which clears dependency edges by hand and
does **not** run this path. Fan-out via land still requires a manual `fleet task start` of the
dependents. The build card should not "fix" that here — it is out of scope; just don't let a
verification assume land auto-starts.

### 5.2 Promote in-session — the one genuinely new mechanic (design precisely)

**Intent:** re-run the *same worktree/branch* as a build, without creating a new card. The plan doc is
already committed on the branch, so the build agent reads it directly.

**Trigger:** a new first-class CLI verb **`fleet task promote <id>`** (bash `fleet_task` arm in
`fleet-cli/fleet`, dispatching to a Kanban `task promote` command), and a **"Promote to build" board
action** on plan cards sitting in `review` (web-ui). Modeled on the existing first-class subcommand
pattern (prior art: `2361fa6` promoting `land` to a `fleet task` subcommand).

**Exact behavior (three attach points):**

1. **Flip the type** `plan → build`. `updateTask` (`src/commands/task.ts:719-808`,
   `updateTask(...)` mutation in `task-board-mutations.ts`) has **no `cardType` field today** — add one.
   The existing `updateTask` guard rejects most edits outside `backlog` (`task.ts:782-795`); `promote`
   is a **distinct verb** that intentionally permits the type flip in `review`, so it does not relax
   that guard for the general `update` path.
2. **Move `review → in_progress`.** `moveTaskToColumn(board, taskId, "in_progress")`
   (`task-board-mutations.ts`) — build runs in `in_progress`. This is the lane where the `build` phase
   is honest.
3. **Re-enter the session in the same worktree.** Call `startTaskSession`
   (`runtime-api.ts:startTaskSession`) with the card now typed `build`. Worktree/branch reuse is
   already handled — `resolveExistingTaskCwdOrEnsure` (`runtime-api.ts:428`) returns the **existing**
   task cwd (branch is deterministic per card), so no new worktree is created. Because `cardType` is
   now `build`, `resolveStartActiveSkills` returns `[fleet-implement]` and the build directive injects
   over the same branch that holds the committed plan doc.

**Sequencing:** `promote` = `setCardType(build)` → `moveTaskToColumn(in_progress)` → session start.
Steps 2–3 are exactly what `startTask` already does from `in_progress` (`task.ts:909-956`); `promote`
adds step 1 in front and the `review→in_progress` move. Prefer composing `promote` from the existing
`startTask` internals over duplicating the start flow (Article 8 — no parallel start path).

**Visible result:** the board badge flips `plan → build` (§7 phase-in-UI flips `design → build`), and
the same branch continues under a build agent.

---

## 6. Injection wiring (rework `startTaskSession`)

### 6.1 One central composition, lane-free at start

Rework `runtime-api.ts:449-488` so the non-home, non-explicit-skill branch composes purely from
type + flags:

```ts
// src/trpc/runtime-api.ts — after
const cardType = body.cardType?.trim() || boardCardType?.trim() || "build";           // P2
const manifest =
  (await loadCardTypeManifest(cardType, { workspacePath: workspaceScope.workspacePath }))
  ?? (await loadCardTypeManifest("build", { workspacePath: workspaceScope.workspacePath }));  // §4.5 fallback

if (manifest) {
  const orderedSkills = resolveStartActiveSkills(manifest, {              // NO lane param (P6)
    autoReviewEnabled: body.autoReviewEnabled,
    autoReviewMode: body.autoReviewMode,
  });
  const directive = composeCardDirective(orderedSkills, { baseRef: body.baseRef });
  withDirectives = directive ? `${directive}${body.prompt}` : body.prompt;
}
```

**What is removed:** the `getTaskColumnId(board as any, body.taskId)` read (`runtime-api.ts:476`), the
`lane` argument, `computedPlanMode`, and the `startInPlanMode` threading into `startTaskSession`
(`runtime-api.ts:439,484,570,628`). The board is no longer read to *place* the directive — only (still)
to resolve `boardCardType` when `body.cardType` is absent. This is the deeper fix that *removes* code
(Article 2).

### 6.2 The lane-entry seam stays wired but dormant

`resolveLaneEntrySkills` (§4.2) exists and is unit-tested, but **no caller fires it in v1** — the only
dormant phase is `verify` on `review`, and entering `review` still injects nothing / auto-starts
nothing (unchanged behavior). The seam's attach point is named in §8 so a future PR-review lane wires a
board-transition handler to it without re-touching the start path.

### 6.3 Explicit `skill:` override — preserved

The explicit-`body.skill` short-circuit (`runtime-api.ts:445-448`) is unchanged: an explicit skill
still composes just that one skill's directive, bypassing type composition. (Seam: a purpose-built type
eventually supersedes ad-hoc skill overrides — not this card.)

### 6.4 Retire the per-adapter plan-mode launch path

With native plan mode gone (P4), delete the plan-mode launch plumbing the adapters carry
(`startInPlanMode` → `--start-in-plan-mode` for the agent CLIs, and the Cline
`startInPlanMode` argument). These are the call sites the prior doc flagged
(`agent-session-adapters.ts` ~961/1047/1702, `cline-task-session-service.ts:155`). No plan directive
double-injects because there is no plan directive *and* no plan-mode flag anymore — the `plan` **type**
is the only mechanism.

---

## 7. Surface the active *phase* on the board card

The operator sees **lane** (column) and **type** (badge, `board-card.tsx:909`) but not **phase**.
Add a small **phase chip** next to the type badge in the chip row (`board-card.tsx:900-910`) so all
three concepts are legible.

**Derivation (pure, client-side, from `(type, lane, flags)`):** add a `resolvePhaseLabelForLane` helper
(new `web-ui/src/utils/card-phase.ts`) mirroring the server's manifest phases. For the built-ins:

| Type | Lane | Phase chip |
|---|---|---|
| `build` | `in_progress` | `build` — and `build+ship` when `autoReviewEnabled && mode==="pr"` (both active in the same lane) |
| `build` | `review` / `done` | `verify` (dormant) |
| `plan` | `in_progress` | `design` |
| `plan` | `review` / `done` | `verify` (dormant) |
| any | `backlog` | *(no chip — not yet started)* |

**Many-active-phases case:** when two phases are active in one lane (`build+ship` in `in_progress`),
render them joined (`build·ship` or two small chips) in declaration order — the same order they compose
into the directive. Style with the existing chip pattern (`border-status-*/30 bg-status-*/10`), a
distinct status color from the type badge, so type and phase are visually separable.

**Data plumbing:** `normalizeCard` (`board-state.ts:169-234`) already carries `cardType`,
`autoReviewEnabled`, `autoReviewMode`; no new server field is needed — the phase is *derived*, matching
the server's own "no persisted active-phase state" principle (§4.1). The web-ui must **not** hardcode a
second copy of the manifests beyond this small display map; if drift risk is a concern, expose the
built-in manifests' `(lane → phase names)` via the existing runtime state rather than duplicating the
activation logic. (Recommended: derive in the client for v1 — the built-in map is tiny and stable — and
note the "single source" seam if custom types ever need their phase shown.)

---

## 8. Clean seams (out of scope to build, in scope to not regress)

| Seam | Attach point | Status in v1 |
|---|---|---|
| Enter-Review auto-start of a review session | `verify` phase (`dormant`) + a `review`-entry handler calling `resolveLaneEntrySkills` | Declared, not fired |
| Future dedicated **PR-review lane** injecting `fleet-review` on entry | `resolveLaneEntrySkills(manifest, "<pr-review-lane>")` + board-transition handler (§6.2) | Seam only — no new lane built |
| Scheduler / DAG orchestration | a new `activation: orchestrated` enum value + external phase driver | Not added; enum stays closed at `default | auto-review-pr | dormant` |
| `--auto-review pr` → its own type | P7 follow-up | Stays a flag |
| `fleet-smoke` | orphan skill, no type binds it | Untouched |
| Fan-out via `fleet xtools land` | land clears edges manually, bypassing the move-to-done auto-start (§5.1) | Unchanged; documented caveat |

---

## 9. Resolution walk-through (proves start-time composition is lane-free and correct)

Composition now depends only on `(cardType, flags)` — the "Lane at start" column is shown to prove it
is **not consulted**:

| Card | `cardType` | flags | Lane at start (irrelevant) | Start-active phases (declaration order) | Composed skills → directive |
|---|---|---|---|---|---|
| bare card | `build` (default) | — | any | `[build]` | `[fleet-implement]` → today's implement directive, verbatim |
| `--auto-review pr` card | `build` | `autoReview=pr` | any | `[build, ship]` | `[fleet-implement, fleet-pr]` → implement **then** pr, verbatim |
| `--type plan` card | `plan` | — | any | `[design]` | `[fleet-plan]` → plan directive (no plan-mode flag) |
| promoted plan card (§5.2) | `build` (flipped) | — | `in_progress` (moved) | `[build]` | `[fleet-implement]` over the same worktree/branch |
| any card in review | either | — | `review` | `[]` (`verify` dormant) | no directive, no auto-start |

Contrast with today's table (`card-types-skill-pipeline.md:202-208`), whose correctness **depended** on
the lane column reading exactly `backlog`/`in_progress` at the right instant. That dependency is gone.

---

## 10. Verification plan (closes the empirical gap)

The empirical scratch-board check is what exposed Defect A; the build card must ship a verification that
would have caught it.

### 10.1 Module tests (golden-string, extend Card B's suite)

- `resolveStartActiveSkills(buildManifest, {})` === `["fleet-implement"]`
- `resolveStartActiveSkills(buildManifest, { autoReviewEnabled: true, autoReviewMode: "pr" })` ===
  `["fleet-implement", "fleet-pr"]`
- `resolveStartActiveSkills(planManifest, {})` === `["fleet-plan"]`
- `composeCardDirective(...)` of each === the byte-identical current literals (implement / implement+pr /
  plan) — the migration guarantee.
- `resolveLaneEntrySkills(buildManifest, "review")` === `[]` and `resolveLaneEntrySkills(planManifest,
  "review")` === `[]` (dormant fires nothing in v1); a fixture manifest with a non-dormant `review`
  phase returns its skill — pins the future seam without wiring it.
- **Regression guard for Defect A:** a test asserting `resolveStartActiveSkills` **takes no lane
  argument** (type-level) — i.e. start composition cannot be made lane-dependent again.

### 10.2 Behavior test (Given/When/Then, through the runtime surface)

- *Given* a `plan` card, *when* `startTaskSession` composes, *then* the prompt contains the `fleet-plan`
  directive — **regardless of the card's lane** (parametrize the test over `backlog` / `in_progress` to
  prove lane-independence; the old code would fail the `in_progress` case).
- *Given* a bare `build` card and an `--auto-review pr` build card, *then* the prompt contains
  `fleet-implement` (and `+fleet-pr` respectively).
- *Given* a plan card in `review` linked to a backlog `build` card, *when* it moves to `done`, *then*
  the build card auto-starts (§5.1) with a `fleet-implement` directive.
- *Given* a plan card in `review`, *when* `fleet task promote` runs, *then* `cardType` is `build`, the
  card is in `in_progress`, the worktree/branch is reused (no new worktree), and the session prompt
  carries `fleet-implement`.

### 10.3 Manual smoke (throwaway isolated instance — never 3500/3200)

`cd fleet-kanban && npm run kanban:scratch` (boots a throwaway board on a random port under a temp
`CLINE_HOME`). Create one bare card and one `--type plan` card; `fleet task start` each; capture the
composed session prompt (session transcript / a targeted debug log of `finalPrompt`) and confirm the
plan card carries the `fleet-plan` directive and the build card carries `fleet-implement`. Then
Ctrl-C. This is the check the shipped model lacked.

---

## 11. Build plan (§ decomposition into implementation cards)

**Impl agent: Codex** (fast, reliable on well-scoped builds — per AGENTS.md). Each card is primed with
exact files + prior-art SHAs; **no codebase-discovery sub-agents**. Every card writes **module tests
through the public surface first** (Article 4) and commits at coherent boundaries (Article 9). Cards
**PB1 → PB2** are sequenced (PB2 rewrites the injection PB1's schema feeds); **PB3** (CLI/promote) and
**PB4** (web-ui) run in parallel after PB1.

```
PB1 (data model: manifests, schema, resolver) ─┬─▶ PB2 (injection rework in runtime-api + adapter cleanup)
                                                ├─▶ PB3 (CLI: default build, --plan error, `fleet task promote`)
                                                └─▶ PB4 (web-ui: phase chip + default `build`)
```

### PB1 — Manifests, schema, and lane-free resolver

- **New** `fleet/card-types/build.md` (§4.3), `fleet/card-types/plan.md` (§4.4); **delete**
  `fleet/card-types/feature.md`.
- **Edit** `src/core/card-type.ts`: drop `plan-flag` from the activation enum, drop the `planMode`
  field, replace `resolveActiveSkillsForLane` with `resolveStartActiveSkills` (no lane param) and add
  `resolveLaneEntrySkills` (§4.2).
- **Edit** the resolver's caller default: manifest-missing ⇒ fall back to `build` (§4.5).
- **Tests:** the §10.1 module/golden-string suite (RED first). No behavior change consumed yet beyond
  the resolver contract.
- **Read first:** `src/core/card-type.ts`, `fleet/card-types/feature.md`. **Prior art:** `646b4ac`
  (data-model card), `6b3152b` (directive single-source — golden strings live here).

### PB2 — Central injection rework + retire plan-mode plumbing

- **Edit** `src/trpc/runtime-api.ts:449-488`: lane-free composition (§6.1), default `build`, resolver
  fallback; remove the `getTaskColumnId` start read, `computedPlanMode`, and `startInPlanMode`
  threading (`:439,484,570,628`).
- **Delete** the native plan-mode launch plumbing in `agent-session-adapters.ts` (~961/1047/1702) and
  `cline-task-session-service.ts:155` (§6.4).
- **Wire boundary (additive):** drop `startInPlanMode` from all consumers but keep it *parseable* for
  one release in `api-contract.ts:203,218,1221,1238` (§4.5).
- **Tests:** the §10.2 behavior tests (parametrized over lane to lock Defect A closed).
- **Read first:** `src/trpc/runtime-api.ts:420-505`, `src/core/api-contract.ts:198-260,1210-1245`.
  **Prior art:** `60071d9` (central injection — where the defect lives).

### PB3 — CLI: default `build`, `--plan` guidance error, `fleet task promote`

- **Edit** `fleet-cli/fleet`: remove `--plan`/`--start-in-plan-mode` mapping in `fleet_task` create
  (`fleet:982-984`) and update (`:1266-1267`), replacing with the loud guidance error (§4.6); update the
  `card_type_new` scaffold (`fleet:1746-1765`) to drop `plan-flag`/`planMode` and default to a `build`
  phase.
- **Add** the `fleet task promote <id>` arm (bash) + Kanban `task promote` command (`src/commands/task.ts`):
  `setCardType(build)` → `moveTaskToColumn(in_progress)` → reuse `startTask` internals (§5.2). Add a
  `cardType` field to `updateTask` / the `updateTask` mutation.
- **Edit** the Kanban CLI default type and remove the `startInPlanMode` create/update inputs
  (`task.ts:662,694,726,806`).
- **Tests:** `fleet-cli` test (create defaults to `build`; `--plan` errors; `promote` flips type + lane);
  Kanban `task promote` command test asserting worktree reuse + `cardType` flip.
- **Read first:** `fleet-cli/fleet:960-990,1260-1275,1737-1775`, `src/commands/task.ts:660-810,909-997`.
  **Prior art:** `c2d8aa3` (`fleet card-type` + `--type`), `2361fa6` (first-class `fleet task` subcommand).

### PB4 — web-ui: phase chip + default `build`

- **New** `web-ui/src/utils/card-phase.ts`: `resolvePhaseLabelForLane(card)` (§7 table).
- **Edit** `web-ui/src/components/board-card.tsx:900-910`: render the phase chip next to the type badge;
  change `card.cardType ?? "feature"` → `?? "build"`.
- **Edit** `web-ui/src/state/board-state.ts` only if a derived field is surfaced (default: derive in the
  component; no new normalized field).
- **Add** a "Promote to build" action on plan cards in `review` (calls the PB3 `task promote` path).
- **Tests:** `web:test` for `resolvePhaseLabelForLane` (each row of the §7 table, incl. `build+ship`);
  a board-card render test asserting the chip.
- **Read first:** `web-ui/src/components/board-card.tsx:895-937`, `web-ui/src/state/board-state.ts:169-234`.
  **Prior art:** `3d1a8ab` (the type badge).

---

## 12. How this satisfies the constitution

- **Article 2 (root cause):** the activation defect is *removed*, not instrumented — the lane read is
  deleted from the start path, so the race cannot recur. The fix *removes* code (`lane` param,
  `computedPlanMode`, plan-mode plumbing).
- **Article 1 (concepts first):** `plan`/`build` **extend** the existing card-type concept and manifest
  format rather than adding a parallel mechanism; the disposition fork reuses the **existing** linking
  machinery (§5.1). Only `fleet task promote` is genuinely new — recorded as a deliberate new verb.
- **Article 3 (one source of truth):** active phase stays **derived** from `(type, flags[, lane])`,
  never persisted; the directive stays single-sourced from `SKILL.md` frontmatter.
- **Article 7 (clean replacement):** `feature` is deleted outright (no alias/migration), with the single
  additive concession at the `startInPlanMode` wire boundary.
