# Configurable columns and transitions, and QA as the first configured column

**Ref / slug decision.** The card carries no external issue ref, so the doc is named after the card
id: `caeff` + slug `configurable-columns` → `docs/design/caeff-configurable-columns.md` (the path the
card specified). Sanitized: both parts are already lowercase alphanumeric/hyphen.

**Destination.** This plan is written for an epic integration branch. §8 decomposes it into build
cards with dependency order; §9 states the merge-down gate; §10 lists what cannot be validated
headlessly.

---

## Problem statement

**Symptom.** The board's column set is fixed at five ids — `backlog`, `in_progress`, `review`,
`done`, `trash` — and every lifecycle behaviour is written against those literals. We want to add a
**QA** column (a card whose PR is open parks there while code review and quality gates run, instead of
being indistinguishable from a card waiting on a human) and, later, an **ingest/design** column (a card
is primed against the repo's own concept map and change index before implementation starts). Neither is
currently a configuration change; both are a rewrite across the runtime, the CLI, the web-ui, and the
card-type manifests.

**Expected.** A board instance declares its columns and the transitions between them as data. Adding
QA is an edit to one config object. Adding the column after QA is free.

**Root cause.** It is *not* "the column enum is hardcoded". Widening
`runtimeBoardColumnIdSchema` (`src/core/api-contract.ts:114`) to a string would compile and change
nothing, because the column id is not the problem — **the lifecycle rules are the problem, and they are
written as comparisons against column ids scattered across three layers**:

- **Which automatic move happens** lives in two functions in the state hub
  (`getTargetColumnForSession`, `applyPersistedCardPrToBoard`).
- **What a column implies about a card** (does it have a worktree? can a session be live? can a
  dependency link attach? is it terminal?) is re-derived by ad-hoc id comparison in at least eight
  places — the CLI, the shutdown coordinator, the metadata monitor, the dependency resolver, the
  archive reader.
- **What entering a column does** (tear down the worktree, release linked backlog cards) is inlined in
  the CLI command bodies, keyed on the literal target column.
- **Which manual moves are legal** is a third, independent encoding in
  `web-ui/src/state/drag-rules.ts`.

There is no single place that answers "what does this column mean". Four layers each answer it
separately, so a new column has to be taught to all four. That is the cause to remove.

**The honest scope check.** QA on its own does not justify this work. Everything that *drives* QA
already exists as card state (`prState`, `prGateStatus`, and a deterministic branch that makes PR
detection reliable) — a board could render "PR open · gate pending" as a badge or a filter on the
review column today, with no lifecycle change at all. What a *column* buys over a field is exactly the
three things this design makes configurable: a distinct parking place that an ended session does not
yank the card out of, a distinct set of legal manual moves, and a distinct skill/phase binding. If
Half 1 is not built, **QA should be a field and a UI filter, not a column** — say so at review rather
than shipping a sixth hardcoded id. The deliverable that matters here is Half 1.

---

## What exists in the codebase

### Concepts touched (canonical homes)

| Concept | Home | What this design does to it |
| --- | --- | --- |
| [Card lifecycle / columns](../architecture/concepts/card-lifecycle.md) | `src/core/task-lifecycle.ts`, `src/core/api-contract.ts` | **Extends** — the column set becomes data; the concept file's "fixed column set" sentence is rewritten |
| [Card type / skill pipeline](../architecture/concepts/card-types.md) | `src/core/card-type.ts`, `fleet/card-types/` | **Extends** — the phase `lane` stops being an enum of the five ids and becomes a reference into the configured set |
| [Task card](../architecture/concepts/task-card.md) | `src/core/api-contract.ts` | Column id widens; `transitions` unchanged in shape |
| [Dependency links](../architecture/concepts/dependency-links.md) | `src/core/task-board-mutations.ts` | The "backlog endpoint / terminal endpoint" rules become stage-derived |
| [Persistence / CLINE_HOME](../architecture/concepts/persistence-cline-home.md) | `src/state/workspace-state.ts` | `archived-cards.json` stops hardcoding `trash` |
| [Runtime state fanout](../architecture/concepts/runtime-state-fanout.md) | `src/server/runtime-state-hub.ts` | The two projection functions collapse into one table-driven resolver |
| **Board lifecycle configuration** | *new* — `src/core/board-lifecycle.ts` | Genuinely new concept; gets its own `concepts/board-lifecycle.md` in the same change (Article 1 step 4) |

No new *near-duplicate* is introduced: there is no existing "workflow config" concept to extend, and
the card-type manifest is deliberately **not** stretched to cover it (§4).

### Prior art read

| SHA | What it established that this design reuses |
| --- | --- |
| `9dde1c7` | The epic shape: a capability **port** per harness plus a **TCK** that asserts the contract, replacing N inline branches. This design applies the same move to columns — one lifecycle value object plus scenario coverage, replacing N id comparisons. |
| `53e0e3d` | The file-backed backlog plan: source-of-truth resolution, a file↔board state machine, and explicit malformed-input handling. The config-vs-board reconciliation rules in §6 follow its shape. |
| `dd725f8` | Deleting a legacy path rather than gating it — the "Implement here" removal shows the expected posture toward `resolveLaneEntrySkills` and the dead `verify` phase (§4). |
| `4783b95` | Column-specific card actions in `board-card.tsx` are behaviour, and they must say what they do. Under a configurable set these actions cannot key off ids. |
| `3359d75` | A card reaches Review automatically once the session ends — no agent action. This is the invariant QA must not break. |

### The bindings, precisely

`in_progress` appears 251 times, but the great majority are tests, docs strings, and hook *event*
names (`to_in_progress`, which is a session-state signal, not a column — see below). The **behavioural**
bindings are these, and they are the actual work:

**Automatic moves (server) — 2 functions.**
- `src/server/runtime-state-hub.ts:28` `getTargetColumnForSession` — `running → in_progress`,
  `awaiting_review → review`, everything else `null`. Called from the summary-emit path
  (`runtime-state-hub.ts:648`) on every session summary, so it is a *reconciling* rule, not an edge:
  it moves the card whenever current ≠ target.
- `src/server/runtime-state-hub.ts:207` `applyPersistedCardPrToBoard` — `merged → done`,
  `closed → trash`, guarded to `from in_progress|review`. Called from the metadata monitor's
  `persistCardPr`, i.e. on the poll path.

**What a column implies — 8 ad-hoc predicates.**
- `src/commands/task.ts:1233` `columnCanHaveLiveTaskSession` = `in_progress|review`.
- `src/server/shutdown-coordinator.ts:162` `collectWorkColumnTaskIds` = `in_progress|review`.
- `src/server/workspace-metadata-monitor.ts:128` skip `backlog|trash` from git/PR polling;
  `:313` `isActive = columnId === "in_progress"` gates the mtime short-circuit.
- `src/core/task-board-mutations.ts` `resolveDependencyEndpoints` — `done|trash` are "terminal", one
  endpoint must be `backlog`.
- `src/core/task-board-mutations.ts` `getLinkedBacklogTaskIdsReadyAfterTaskCompleted` — releases links
  only when `fromColumnId === "review"`.
- `src/core/task-lifecycle.ts` `getTaskStartedAt` (`in_progress`), `getTaskCompletedAt` (`done`),
  `sortCardsForColumn` (`done`), plus `moveTaskToColumn`'s `done|trash → prepend` insert rule.
- `src/state/workspace-state.ts:394` the archive file schema is `z.literal("trash")`;
  `:1174` restore refuses `trash` and defaults to `review`.
- `src/server/workspace-registry.ts:103–136` project task counts are a **fixed five-key object**
  (`api-contract.ts:434`), and `getActiveTaskCount` reads `.in_progress`.

**Entry effects — inlined in command bodies.**
- `src/commands/task.ts:1324` `trashTaskById` → stop session, then `deleteTaskWorkspace` (worktree torn
  down). `completeTaskById:1237` → stop session, keep worktree, then start each ready linked card.
- `src/commands/task.ts:982,1046` `startTask` moves to `in_progress` explicitly before launching.

**Legal manual moves — a third encoding.**
- `web-ui/src/state/drag-rules.ts` `isAllowedCrossColumnCardMove` + `isCardDropDisabled` — a hand-written
  adjacency list, duplicated as a per-column drop-target switch.
- `web-ui/src/components/board-card.tsx:366,522,531,547,717,729,1036` — per-column actions and badges.
- `web-ui/src/utils/card-phase.ts` — maps `(cardType, lane) → phase label` with a nested if-chain that
  re-implements what the card-type manifest already declares.

**Public contract.**
- `src/commands/task.ts:49` `LIST_TASK_COLUMNS` and `:95` `parseListColumn` — the `--column` values.
- `src/prompts/append-system-prompt.ts:137–299` — the architect's CLI reference enumerates the five ids
  in prose across a dozen lines, and states the linking rule ("a task in the review column moved to
  done starts linked backlog tasks") as fixed text.
- `fleet-cli/fleet.py:1219,1258` reads `taskCounts` by key and computes `live_tasks = backlog +
  in_progress + review`.

**What is *not* a column binding, despite the grep.** `to_in_progress` / `to_review` in
`src/commands/hooks.ts`, `src/agents/*/driver.ts`, `src/agents/claude/hook-settings.ts` and
`src/terminal/codex-hook-config.ts` are **session** signals. `src/terminal/session-state-machine.ts`
is already completely column-free — it reduces over `running` / `awaiting_review` / `interrupted` only.
This is load-bearing good news: **the session state machine needs no change**, and the entire
session→column coupling is the one 20-line function `getTargetColumnForSession`.

### The card-type pipeline, as it actually runs

`src/core/card-type.ts` declares phases as `{ name, lane, skills, activation }` where
`cardTypePhaseLaneSchema = z.enum(["backlog","in_progress","review","done"])` — **a phase already
points at a column.** Two resolvers exist:

- `resolveStartActiveSkills(manifest, flags)` — used in production
  (`src/trpc/runtime-api.ts:514`), filters by `activation` (`default` | `auto-review-pr` | `dormant`)
  and **ignores the lane entirely**.
- `resolveLaneEntrySkills(manifest, lane)` — returns the `dormant` phases bound to a lane. It is
  **tested (`test/runtime/core/card-type.test.ts:124`) but never called from `src/`.** It is a declared
  seam that nothing fires.

Consequence: `build.md`'s `verify` phase (`lane: review`, `activation: dormant`, `skills:
[fleet-review]`) **never runs**, and `plan.md`'s does not either. That dead seam is the hinge of §4.

---

## Proposed solution

### The model in one paragraph

A **column** keeps its identity (id + title + order) and gains a small, fixed vocabulary of *meaning*:
one exclusive **stage**, an optional terminal **outcome**, and a list of **entry effects**. A separate,
ordered **auto-transition table** says which automatic moves happen and from where, and a **manual-move
matrix** says which drags a human may perform. Together those three things are the `BoardLifecycle`
value object — resolved once per workspace, threaded as a parameter into the pure mutation helpers, and
published on the state wire so the web-ui reads the same rules the server enforces. No behaviour asks
"is this column `in_progress`" ever again; it asks "is this column's stage `active`".

The card's sketch — "a user-defined column bound to a fixed set of lifecycle roles" — is right in
shape, with **one correction: the roles are not a single exclusive enum.** A single role cannot express
QA, which is simultaneously *not terminal*, *a place a session may be dead*, *not the human decision
point*, and *not where a halted session lands*. Forcing one enum would make QA a sixth role and we
would be back to hardcoding. So: **one exclusive facet (`stage`, three values) plus independent,
declared effects and transitions.** That is the smallest vocabulary that expresses today's five
columns *and* QA *and* ingest without a new keyword for each.

### The `BoardLifecycle` shape

New file `src/core/board-lifecycle.ts` — the canonical home, with a Zod schema, the built-in default,
and pure resolver functions.

```jsonc
{
  "columns": [
    { "id": "backlog",     "title": "Backlog",     "stage": "intake" },
    { "id": "in_progress", "title": "In Progress", "stage": "active" },
    { "id": "review",      "title": "Review",      "stage": "active" },
    { "id": "done",        "title": "Done",        "stage": "terminal",
      "outcome": "completed", "onEnter": ["release_linked_cards"],
      "insert": "top", "sort": "completed-desc" },
    { "id": "trash",       "title": "Trash",       "stage": "terminal",
      "outcome": "abandoned", "onEnter": ["teardown_worktree"],
      "archive": true, "insert": "top" }
  ],
  "auto": [
    { "when": "session.running", "from": ["backlog", "review"],     "to": "in_progress" },
    { "when": "session.halted",  "from": ["backlog", "in_progress"], "to": "review" },
    { "when": "pr.merged",       "from": ["in_progress", "review"],  "to": "done" },
    { "when": "pr.closed",       "from": ["in_progress", "review"],  "to": "trash" }
  ],
  "manual": [
    { "from": ["backlog"], "to": ["in_progress"] },
    { "from": ["review"],  "to": ["done"] },
    { "from": "*",         "to": ["trash"] },
    { "from": ["trash"],   "to": ["review"] }
  ]
}
```

**That object is exactly today's board.** It is the built-in default, and a board with no configuration
resolves to it byte-for-byte. Nothing in `board.json` changes.

#### `stage` — the one exclusive facet (3 values)

| stage | Means | Replaces |
| --- | --- | --- |
| `intake` | Card exists, no worktree, no session, not git-polled. Dependency links attach here. | `columnId === "backlog"` (×4) |
| `active` | Worktree exists; a session may be live; git + PR polling on; shutdown stops sessions here. | `in_progress \|\| review` (×3), the metadata-monitor skip list |
| `terminal` | Card is closed. Links cannot attach or be created. | `done \|\| trash` (×2) |

Exactly one column must be `stage: intake`; at least one must be `active`; at least one `terminal`.
Validation enforces this (§6).

#### `outcome` — terminal columns only

`"completed"` or `"abandoned"`. `getTaskCompletedAt` looks for the last transition into any
`outcome: "completed"` column; `getTaskStartedAt` looks for the first transition into any `active`
column. Dependency release (below) fires only into `completed`.

#### `onEnter` — the entry-effect vocabulary (4 values)

| effect | Does | Replaces |
| --- | --- | --- |
| `release_linked_cards` | Start every backlog card linked to this one | the inline loop in `completeTaskById` + the `fromColumnId === "review"` guard |
| `teardown_worktree` | `deleteTaskWorkspace` after stopping the session | the inline call in `trashTaskById` |
| `stop_session` | Stop a live session on entry | the `columnCanHaveLiveTaskSession` guard in both commands |
| `start_session` | Launch the card's agent on entry | *new* — this is what makes the ingest column possible |

`release_linked_cards`'s old `from review` guard generalizes to **"entered from an `active` column"**,
which is what makes inserting QA correct without touching the rule. This is the single clearest test
that the abstraction is the right one.

#### `auto` — the transition table

Each rule is `{ when, from, to }`. Rules are evaluated **in declaration order, first match wins**, so
ordering is the operator's tool for precedence. Triggers, matching the two signals the runtime actually
has:

| `when` | Fired by | Today's equivalent |
| --- | --- | --- |
| `session.running` | summary emit, `state === "running"` | `getTargetColumnForSession` |
| `session.halted` | summary emit, `state === "awaiting_review"` | `getTargetColumnForSession` |
| `pr.open` / `pr.merged` / `pr.closed` | metadata-monitor PR refresh | `applyPersistedCardPrToBoard` |
| `pr.gate.passing` / `pr.gate.failing` | metadata-monitor gate refresh | *new* — `prGateStatus` exists but drives nothing |

Both sources are **reconciling, not edge-triggered** — they re-evaluate on every emit/poll and move only
when current ≠ target. That is already how both functions behave today, so this is a restatement, not a
new execution model. The two collapse into one
`resolveAutoTransition(lifecycle, currentColumnId, signal): columnId | null`.

#### `manual` — the legal-drag matrix

`web-ui/src/state/drag-rules.ts` becomes a lookup over this list instead of a hand-written adjacency
chain, and `isCardDropDisabled` derives from the same list rather than a parallel per-column switch.
The `programmaticCardMoveInFlight` escape hatch for `in_progress ↔ review` stays as-is: it is not a
policy about columns, it is an optimistic-UI mechanism for a move the *server* initiated.

### QA, concretely

Adding QA to a board is this diff to the object above, and nothing else:

```diff
   { "id": "in_progress", "title": "In Progress", "stage": "active" },
+  { "id": "qa",          "title": "QA",          "stage": "active" },
   { "id": "review",      "title": "Review",      "stage": "active" },
...
-  { "when": "session.running", "from": ["backlog", "review"],      "to": "in_progress" },
-  { "when": "session.halted",  "from": ["backlog", "in_progress"], "to": "review" },
-  { "when": "pr.merged",       "from": ["in_progress", "review"],  "to": "done" },
-  { "when": "pr.closed",       "from": ["in_progress", "review"],  "to": "trash" }
+  { "when": "session.running", "from": ["backlog", "qa", "review"], "to": "in_progress" },
+  { "when": "pr.open",         "from": ["in_progress"],             "to": "qa" },
+  { "when": "session.halted",  "from": ["backlog", "in_progress"],  "to": "review" },
+  { "when": "pr.merged",       "from": ["in_progress","qa","review"], "to": "done" },
+  { "when": "pr.closed",       "from": ["in_progress","qa","review"], "to": "trash" }
...
-  { "from": ["review"], "to": ["done"] },
+  { "from": ["qa", "review"], "to": ["done", "in_progress"] },
```

Answering the card's specific questions:

- **In:** automatic, on `pr.open` from `in_progress`. Because `pr.open` is declared *before*
  `session.halted`, a PR-mode card that opens its PR and exits lands in QA; a card with no PR still
  lands in Review. The split is data, not a branch.
- **Out:** `pr.merged → done` and `pr.closed → trash` already exist and are **reused unchanged**,
  with `qa` added to their `from` lists. No duplicate merge/close handling is introduced. A
  closed-without-merge PR still goes to trash so abandoned work does not auto-start linked cards —
  that decision is preserved verbatim.
- **Is the session alive in QA?** Usually not, and that is correct. A PR-mode agent opens the PR and
  finishes; the session halts moments later. QA is `stage: active` (the worktree survives, git and PR
  polling continue) but is deliberately **absent from `session.halted`'s `from` list**, so the ended
  session does not yank the card to Review. This is the one behaviour a QA *field* could not give us,
  and it is exactly the invariant `3359d75` established for Review — now expressed as data instead of
  as an implicit consequence of "there is only one halt target".
- **Steer or restart?** Steer. `fleet task say` on a card with a dead agent already relaunches it
  (`givenCardWithGoneAgentWhenStartedThenNewAgentRuns`). Steering fires `session.running`, whose `from`
  list includes `qa`, so the card returns to `in_progress` — visibly back in the work zone. When the
  agent pushes and exits, the PR is still open, so the reconciling `pr.open` rule returns it to QA. No
  new mechanism; the loop closes because the rules reconcile rather than fire once.
- **Gate status:** `prGateStatus` is captured today and rendered (`fleet task cat`,
  `web-ui/src/components/pr-badge.tsx`), but drives no *lifecycle* behaviour — no transition consults
  it. The `pr.gate.*` triggers make it optional policy — e.g. a board could add
  `{ "when": "pr.gate.failing", "from": ["qa"], "to": "in_progress" }`. **Not enabled in the default or
  epic config**; declared so QA's rendering and its routing come from one source. Flagged in §7.

### The ingest/design column, concretely

```jsonc
{ "id": "ingest", "title": "Ingest", "stage": "active", "onEnter": ["start_session"] }
// auto: { "when": "session.halted", "from": ["ingest"], "to": "in_progress" }
// manual: { "from": ["backlog"], "to": ["ingest"] }
```

plus one phase in the card type: `{ name: prime, lane: ingest, skills: [fleet-prime] }`, plus the
`fleet-prime` skill itself (which reads `docs/architecture/concepts/` and the `to change X, edit Y`
index and writes the primed context into the card's worktree). **No runtime code.** That is the
success condition Half 1 must meet, and it is why `start_session` earns its place in the effect
vocabulary — it is the one effect that a column genuinely needs and no existing code path provides.

---

## Technical rationale

### 1. Columns and card-type phases: they stay separate, and the unification *removes* code

This is the question the card said to resolve first. The answer:

**They do not merge into one registry, and merging them would be wrong.** A column is a property of the
*board* — one set, shared by every card on it. A phase is a property of a *card type* — and different
card types deliberately bind different skills to the *same* column (`plan`'s `in_progress` phase is
`design`/`fleet-plan`; `build`'s is `build`/`fleet-implement`). The relation is many-to-many: N card
types × M columns. Collapsing it either forces every card type to define the whole column set (a board
holding one plan card and one build card would need two column sets — incoherent) or forces every
column to fix one skill list (which deletes card types outright). Neither is a simplification.

**They are already two halves of one edge, and the design makes that explicit.** A phase's `lane` is
*already* a column id. The correct model is: **the column set is the axis; the card type binds skills to
points on that axis.** That is not two pipelines — it is one pipeline with a per-card-type binding, and
it is what the code half-implements today.

The unification that actually **removes machinery**:

1. `cardTypePhaseLaneSchema` stops being `z.enum([...5 ids])` and becomes a slug validated against the
   board's configured columns. **One enum deleted**, and `fleet card-type validate` gains a real check
   (today it cannot catch a lane typo beyond the five).
2. `resolveStartActiveSkills` (flag-driven, lane-ignoring) and `resolveLaneEntrySkills` (lane-driven,
   never called) **collapse into one lane-driven resolver.** `activation` loses `default` and `dormant`
   — a phase is active when the card is in its lane — and keeps only the optional
   `when: auto-review-pr` condition. **Two resolvers become one; a three-value enum becomes an optional
   one-value flag.**
3. `web-ui/src/utils/card-phase.ts`'s hardcoded `(cardType, lane) → label` if-chain is deleted; the
   label is the phase's `name` from the manifest, which is where it was always declared.

The rule that falls out, and which should be stated in `concepts/card-types.md`: **a lane gets a phase
iff a session runs in that lane.** Composition happens at session start, against the column the card
occupies once the start request's own move has been applied.

That rule has a consequence worth naming: `build.md`'s `verify` phase (`lane: review`,
`activation: dormant`) **never fires today and never will under this model**, because nothing starts a
session in `review`. It should be **deleted**, following `dd725f8`'s posture of removing a legacy path
rather than gating it. A board that wants an agent-driven review lane declares
`onEnter: ["start_session"]` on that column and a phase bound to it — which is precisely the ingest
mechanism, reused. `resolveLaneEntrySkills` is deleted with it.

**Net: this design removes one enum, one resolver, one dead phase, one dead exported function, and one
UI if-chain, and adds one config schema.** By the Article 1 test, that is the answer.

### 2. Why `stage` is three values and not more

Every id comparison in the codebase reduces to one of three questions: *does this card have a
worktree/session yet* (no → intake), *is it being worked* (yes → active), *is it closed* (yes →
terminal). Nothing asks a fourth. QA and ingest are both `active`; what distinguishes them from
`in_progress` is not a new stage but their absence from / presence in specific transition `from` lists.
Resisting a fourth stage is what keeps the vocabulary from growing one keyword per column.

### 3. Why explicit `from` lists rather than derived precedence

An earlier shape derived the halt target from stage ("halt moves to the last active column"). Rejected:
it is clever, it silently changes meaning when a column is inserted, and it cannot express "QA is active
but is not a halt target". Explicit `from` lists are more verbose and completely legible — a reader can
answer "where does a halted session put my card" by reading one line. Ordering-with-first-match-wins is
the only implicit rule, and it is the one that lets `pr.open` outrank `session.halted` without a
special case.

### 4. Threading, not a module global

`moveTaskToColumn`, `sortCardsForColumn`, `resolveDependencyEndpoints` and friends are pure. They gain a
leading `lifecycle: BoardLifecycle` parameter rather than reading a module-level singleton. This is a
wide but mechanical signature change (~15 call sites) and it preserves Article 3: the resolved lifecycle
has exactly one owner (`loadWorkspaceContext`, alongside `repoPath`/`revision`/`epic`), and no layer
re-derives it. The web-ui receives it as one new field on `RuntimeWorkspaceStateResponse` — additive,
and it means the drag rules the browser enforces are literally the rules the server enforces, killing
the third encoding.

### 5. Configuration scope: per workspace, with the instance supplying the default

`src/config/runtime-config.ts` already resolves a **global** config
(`$CLINE_HOME/kanban/config.json`) layered with a **project** config
(`<repo>/.cline/kanban/config.json`). Reuse it exactly; invent nothing.

- **Instance default** ← the global file. Because 3500 and 3200 have distinct `CLINE_HOME`s, per-instance
  defaults come free with no new concept.
- **Per workspace** ← the repo file, and **it wins wholesale**. A repo that declares `lifecycle` replaces
  the instance's object entirely; it is not deep-merged.

**Why whole-object override and not merge:** merging an ordered column list with a transition table that
references it produces incoherent intermediate states — a rule pointing at a column the override
removed, an ambiguous ordering, a `manual` entry whose `from` no longer exists. The object is only
meaningful validated as a unit, so the unit is the thing that overrides. This directly answers "what
happens when a workspace's config disagrees with the instance's": **the workspace wins, entirely, and
the instance's object is not consulted at all.**

The board renders one project at a time, so per-workspace column sets are already coherent in the UI.
The one thing that is not is `runtimeProjectTaskCounts` (a fixed five-key object used for the
cross-project sidebar), which becomes `z.record(z.string(), z.number())` — see §7.

### 6. Migration: no data migration

**Nothing in `board.json` changes.** The steps:

- `runtimeBoardColumnIdSchema` widens from `z.enum([...])` to a slug string
  (`/^[a-z][a-z0-9_-]{0,31}$/`). Widening a persisted enum is safe in the additive/optional sense
  Article 7 carves out — every existing file parses.
- The existing legacy transform in `runtimeBoardDataSchema` (trash-but-no-done → done + fresh trash)
  **stays** untouched.
- A board with no `lifecycle` config resolves to the built-in default, which is today's five columns.
  Existing boards are bit-identical before and after.

**Reconciliation when config changes under a live board.** On workspace load, the persisted board's
columns are reconciled against the configured set:

1. Columns in config but not on the board are created empty, in config order.
2. Columns on the board but not in config are removed, and their cards **relocate**: walk backwards
   through the *persisted* column order to the nearest surviving column; if none, the `intake` column.
3. The relocation **appends** a `transitions` entry naming the new column.

**`transitions` is never rewritten.** Entries naming a column that no longer exists are kept verbatim —
which is why widening the id to a string is not merely convenient but *required* by the append-only
constraint. A card that passed through `qa` still reports `hasTaskEnteredColumn(card, "qa") === true`
after `qa` is removed from config, which is the truthful answer and is what the scenarios assert.

**Failure mode.** An invalid `lifecycle` object does **not** crash the board. It is logged and the
built-in default is used, following the precedent recorded in `workspace-state.ts:394` about
crash-looping the whole board on a bad persisted file being a live-migration landmine.

### 7. Contract surface: what stays stable, what breaks

| Surface | Verdict |
| --- | --- |
| `--column backlog\|in_progress\|review\|done\|trash` | **Stable on a default board.** `parseListColumn` validates against the board's configured set instead of a literal list; the five values remain valid unless the board is reconfigured. Against a reconfigured board an unknown value errors with the valid ids enumerated. |
| `board.json` / `archived-cards.json` | **Stable.** No migration; the archive schema's `z.literal("trash")` widens to "the configured archive column id", still accepting `"trash"` for existing files. |
| tRPC board payloads | **Stable in shape.** Column id type widens; `RuntimeWorkspaceStateResponse` gains an additive `lifecycle` field. |
| `runtimeProjectTaskCounts` | **Breaking shape change** — fixed five keys → `Record<string, number>`. Server and web-ui version together. `fleet-cli/fleet.py:1219` already reads it with `.get(key, 0)`, so it keeps working on a default board. |
| `fleet.py:1258` `live_tasks = backlog + in_progress + review` | **Must change** — it undercounts on any board with an extra active column. Becomes "sum of counts for non-terminal columns", which requires the counts payload to carry stage or the CLI to read `lifecycle`. Called out as its own build card (B8). |
| `fleet.py:675` `if agent: return "in_progress"` | **Unaffected** — that is fleet's own derived status string, not a board column. |
| `fleet/xtools/*` | Anything passing a literal `--column in_progress` keeps working on default boards. `card-watch` derives from git, not columns. **Audit is part of B8**, not an assumption. |
| `src/prompts/append-system-prompt.ts` | The prose enumerations and the linking-rule sentence are **generated** from the configured set, so the architect's own reference stays truthful on a reconfigured board. |

---

## Open questions

1. **Do `pr.gate.*` triggers ship in the epic, or only the schema?** The design declares them so QA's
   badge and its routing share a source, but enables neither in the default nor the epic config. If the
   operator wants "gate failing kicks the card back to `in_progress`", it is one rule — but it needs a
   debounce story against a flapping CI, which this doc does not design. **Recommendation:** ship the
   trigger, ship no rule using it.
2. **Should `stage` gate `--column` bulk operations?** `task done --column <id>` and `task trash
   --column <id>` accept any column today. With a QA column, `task done --column qa` bulk-completes
   gated work. Probably fine, possibly a footgun. Not designed here.
3. **Cross-project sidebar counts on heterogeneous boards.** If 3500 has QA and a sibling project does
   not, the sidebar shows a ragged set of count keys. §5 makes this representable; it does not design
   the rendering. Small UI decision, deferrable to B7.
4. **Does the ingest column need its own base-ref/worktree timing?** `onEnter: ["start_session"]` on a
   column a card enters from `backlog` implies worktree creation at that moment rather than at
   `card.start`. `ensureTaskWorktreeIfDoesntExist` is idempotent so this should just work, but it is
   the one place the ingest design touches worktree lifecycle and it is unverified. The QA half does not
   depend on it.
5. **Is `insert`/`sort` worth configuring at all,** or should terminal columns just always prepend and
   `outcome: completed` always sort by completion? Leaning yes-to-derive (fewer knobs), but it is a
   real reduction in the config surface and worth a reviewer's opinion.

---

## Disposition

**Split into build cards** — this becomes an epic. The two halves the card asked for are separable, and
the seam is clean: **Half 1 ships a `BoardLifecycle` that is always the built-in default; Half 2 makes
where the object comes from configurable.** Half 1 is the deliverable that matters; Half 2 is small once
Half 1 lands, because it is file reading and validation on top of an already-data-driven runtime.

### Half 1 — columns and transitions become data (built-in default only)

| Card | Scope | Depends on |
| --- | --- | --- |
| **B1** | `src/core/board-lifecycle.ts`: the Zod schema, the built-in default (today's five columns), and pure resolvers (`resolveAutoTransition`, `getColumnStage`, `getEntryEffects`, `isManualMoveAllowed`). Consumed by nothing yet. Module tests only. | — |
| **B2** | Widen `runtimeBoardColumnIdSchema` to a slug; widen `BoardColumnId`; remove column-id exhaustive switches; add board↔config reconciliation on load (§6) with `transitions` never rewritten. | B1 |
| **B3** | Collapse `getTargetColumnForSession` + `applyPersistedCardPrToBoard` into one table-driven `resolveAutoTransition` call site. The behavioural heart. | B1, B2 |
| **B4** | Replace the eight ad-hoc predicates with `stage`/`outcome` lookups: `columnCanHaveLiveTaskSession`, `collectWorkColumnTaskIds`, the metadata-monitor skip list + `isActive`, `resolveDependencyEndpoints`, `getTaskStartedAt`/`getTaskCompletedAt`, `sortCardsForColumn`, `moveTaskToColumn`'s insert rule. | B1, B2 |
| **B5** | Entry effects: one dispatcher for `release_linked_cards` / `teardown_worktree` / `stop_session` / `start_session`, replacing the inline bodies in `completeTaskById` / `trashTaskById`. Generalizes the release guard to "from an `active` column". | B3, B4 |
| **B6** | Archive stops being `trash` by name: `archived-cards.json` keys on the configured `archive: true` column, accepting the `"trash"` literal for existing files. | B2 |
| **B7** | web-ui reads `lifecycle` off the state wire: `drag-rules.ts` + `isCardDropDisabled` from the `manual` matrix; `board-card.tsx` actions keyed on stage/outcome; delete `card-phase.ts`'s if-chain in favour of the manifest phase name. | B1, B2 |
| **B8** | Contract surface: `parseListColumn` validates against the board's set; `runtimeProjectTaskCounts` → record; generate the `append-system-prompt.ts` enumerations; fix `fleet.py`'s `live_tasks`; audit `fleet/xtools/`. | B1, B2 |
| **B9** | Card types bind to configured lanes: lane enum → validated slug; collapse the two resolvers into one lane-driven resolver; drop `activation: default\|dormant`; delete `resolveLaneEntrySkills` and `build.md`'s dead `verify` phase; update `concepts/card-types.md`. | B1, B2 |

**Order and parallelism.** B1 alone first. Then B2. Then **B3, B4, B6, B7, B8, B9 can all run in
parallel** — they touch disjoint files once the value object and the widened id exist. B5 waits on B3+B4
because it moves logic those two cards are rewriting. B6 and B9 are the two most independent and are
good candidates for whoever is free first.

**Collision warning for dispatch:** B3, B4 and B5 all touch `src/core/task-board-mutations.ts` and
`src/server/runtime-state-hub.ts`. B3 and B4 are separable within those files (transition resolution vs.
predicate lookup) but should not be dispatched to two agents in the same round without re-reading each
other's diff. B7 and B8 are fully disjoint from all of them.

### Half 2 — each instance configures its own

| Card | Scope | Depends on |
| --- | --- | --- |
| **H2-1** | Read `lifecycle` from the existing two-layer config (`$CLINE_HOME/kanban/config.json` → `<repo>/.cline/kanban/config.json`), whole-object override, validation (exactly one `intake`, ≥1 `active`, ≥1 `terminal`, exactly one `archive`, every `from`/`to`/`lane` resolves), and fall-back-to-default-and-log on invalid input. | Half 1 complete |
| **H2-2** | Config-change reconciliation exercised for real: a board whose config gains and then loses a column; operator docs in `AGENT-OPS.md` and `docs/architecture.md`; `concepts/board-lifecycle.md`. | H2-1 |

### The QA card

| Card | Scope | Depends on |
| --- | --- | --- |
| **B10** | Add the QA column to the **epic's** board config (not the built-in default), plus the selfcheck scenarios below. | H2-1 |

QA ships as configuration on the epic board first, and the decision to make it a default for 3500 is an
operator call at merge-down, not a code change.

### What must be true before the epic branch merges down

`npm run verify` green, plus these **selfcheck scenarios**, whose specs are fixed here rather than left
to the implementing agent:

1. **`givenDefaultLifecycleWhenCardRunsThroughItThenColumnsBehaveAsBefore`** — the existing
   `givenLifecycleCardWhenCompletedThenLinkedCardStarts` passes **unmodified**. If it needs editing, the
   default is not byte-identical and the migration claim is false. This is the regression gate and it
   costs nothing.
2. **`givenQaConfiguredBoardWhenPrOpensThenCardParksInQaAndStaysThereWhenTheSessionEnds`** — boot an
   isolated instance whose repo config declares QA; drive a card to PR-open through the stubbed PR
   resolver; assert `hasTaskEnteredColumn(card, "qa")`; then let the stub agent exit and assert **the
   card's last transition is still `qa`, with no `review` entry after it**. This is the one behaviour
   that a QA field could not provide, so it is the scenario that justifies the column.
3. **`givenQaCardWhenPrMergesThenCardCompletesAndLinkedCardStarts`** — proves `release_linked_cards`
   fires on `qa → done`, i.e. that generalizing the old `from review` guard to "from an `active` column"
   is correct. This is the direct test of the abstraction.
4. **`givenConfiguredColumnRemovedWhenBoardLoadsThenCardsRelocateAndHistoryKeepsTheOldColumn`** — a card
   in `qa`, `qa` removed from config, board reloaded: the card relocates to `in_progress`, **and
   `hasTaskEnteredColumn(card, "qa")` is still true.** This is the append-only constraint, asserted
   directly.
5. **`givenIngestColumnWithStartSessionWhenCardEntersThenPrimeSkillRuns`** — configure an ingest column
   with `onEnter: ["start_session"]` and a card type with a phase bound to it; assert the stub agent's
   composed prompt carries that phase's directive. Proves entry effects and lane-driven skill
   composition together, and proves the ingest column is config-only.
6. **`givenCliColumnFlagWhenBoardHasConfiguredColumnsThenItAcceptsThemAndRejectsUnknown`** — `--column
   qa` succeeds, `--column nope` errors listing the valid ids. Guards the public CLI contract.

Assertions use `expectEnteredColumn` / `hasTaskEnteredColumn` on the append-only history, never
`expectColumn` on a column a running card only passes through — the projection race is exactly what this
design multiplies.

**Scenario-file contention:** scenarios are separate files under `test/selfcheck/scenarios/`, but each
registers one import + one call in `test/selfcheck/run-selfcheck.ts`. Six new scenarios means six edits
to that one file — sequence B10's scenario work, or land them as one card, rather than dispatching six
parallel agents at the same registry.

### What cannot be validated on an integration branch

- **Real PR state changes.** Selfcheck stubs the `gh` resolver, so `pr.open` / `pr.merged` /
  `pr.closed` are proven as *rules*, not as *detection*. The detection path is already proven by the
  deterministic-branch work and is not changed here — but the QA column's first real card is the first
  time a live PR drives a move to a configured column. Watch the first one on a live board.
- **Drag-and-drop on a six- or seven-column board.** Layout, horizontal overflow, and drop-target
  hit areas are not covered headlessly and are not worth a Playwright investment. Eyeball it on a
  scratch board (`npm run kanban:scratch`) before merge-down.
- **A config change under a live board with cards in flight.** Reconciliation is scenario-covered
  against a cold load; a running board with active sessions and open PTYs picking up a changed config is
  not. **Recommendation:** treat a `lifecycle` change as requiring a board restart, and say so in the
  H2-2 docs rather than designing hot-reload.
- **Two instances with genuinely different configs** (3500 with QA, 3200 without) is the whole point of
  Half 2 and is only observable on the live boards. It is also the lowest-risk item on this list —
  the configs are read from separate `CLINE_HOME`s and never interact.
