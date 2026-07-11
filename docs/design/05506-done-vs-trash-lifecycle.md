# The done ≠ trash lifecycle split

**Status:** design (plan card — no code)
**Author:** design pass, 2026-07-12
**Prior art:** `99a5458` — *feat(kanban): declutter board card review status* (last touch of the
review→"done" card action and the `isTrashCard` styling this doc reshapes)
**Builds on:** `fleet/docs/kanban-ui-epic.md` §4.4 (PR-aware card lifecycle) and §4.5 (dependency
chains) — this doc is the concrete, code-grounded split those sections assume.

---

## 1. Problem & symptom

**Completing a card trashes it.** There is no real "done" state on the board — only a `trash` column
wearing a "Done" label.

Grounded in code:

- The column enum has four ids and no `done`:
  ```ts
  // src/core/api-contract.ts:77
  const runtimeBoardColumnIdEnum = z.enum(["backlog", "in_progress", "review", "trash"]);
  export const runtimeBoardColumnIdSchema = z.preprocess(
      (val) => (val === "done" ? "trash" : val),   // :78-80 — "done" is coerced to "trash"
      runtimeBoardColumnIdEnum,
  );
  ```
- The CLI `task done` is literally an alias of `task trash`:
  ```ts
  // src/commands/task.ts:1364
  task.command("trash").alias("done")
      .description("Move a task or an entire column to done and clean up task workspaces.")
  ```
  and `parseListColumn` maps the word `"done" → "trash"` (`task.ts:63-74`).
- The durability comment states the conflation outright: the assessment "gates a card **becoming
  Done and its worktree being removed**" (`api-contract.ts:588-590`).
- Completing a card therefore **removes its worktree** — `trashTaskById` → `deleteTaskWorkspace`
  (`task.ts:962`) — and gives it **trash styling**: struck-through title, muted chips, a
  non-interactive card, and a "restore in a new worktree" affordance:
  ```ts
  // web-ui/src/components/board-card.tsx:321-322
  const isTrashCard = columnId === "trash";
  const isCardInteractive = !isTrashCard;
  ```
  `isTrashCard` drives the line-through title (`:683`, `:713`), the muted description (`:793`), the
  muted agent/model chip (`:851-853`), the muted session dot (`:884`, `:892`), the struck-through
  worktree path (`:912-923`), and the restore button (`:746-777`).
- The default board even titles the `trash` column **"Done"**:
  ```ts
  // src/state/workspace-state.ts:33-38
  const BOARD_COLUMNS = [
      { id: "backlog", title: "Backlog" },
      { id: "in_progress", title: "In Progress" },
      { id: "review", title: "Review" },
      { id: "trash", title: "Done" },   // id says trash, label says Done
  ];
  ```
  (the web-ui mirrors this in `web-ui/src/data/board-data.ts:3-8`.)

**Desired outcome:** *Done* is a proud terminal state — the card stays intact, styled complete, its
worktree preserved. *Trash* is a separate, explicit cleanup **action** that removes the worktree and
archives the card out of the way. Finishing work and throwing it away must stop being the same event.

---

## 2. Root cause (in code)

The board is a **column state machine**, and "trash" is doing two unrelated jobs at once:

1. **Terminal success** — where a reviewed card lands when its work is accepted (labelled "Done").
2. **Cleanup/discard** — where a card goes to have its worktree deleted.

Because both jobs share one column id, every consumer that keys on that id conflates them. The id is
hardcoded in eight places, all of which currently treat "trash == done":

| # | Site | What keys on the column |
|---|------|--------------------------|
| 1 | `src/core/api-contract.ts:77` (+ `:78-80` preprocess, `:347` `runtimeProjectTaskCountsSchema`) | the enum itself, the `done→trash` coercion, per-column counts |
| 2 | `src/state/workspace-state.ts:33-38` | default columns + human titles |
| 3 | `src/commands/task.ts:31` `LIST_TASK_COLUMNS`, `:63` `parseListColumn`, `:1364` alias | CLI verbs |
| 4 | `web-ui/src/data/board-data.ts:3-8` + `web-ui/src/components/kanban-board.tsx:23` `BOARD_COLUMN_ORDER` + `web-ui/src/types/board.ts:9` `BoardColumnId` | visible order, labels, drag-step math |
| 5 | `web-ui/src/state/drag-rules.ts:25-98` | allowed cross-column moves + drop-disable |
| 6 | `web-ui/src/components/board-column.tsx:80-82,129-140` | `canClearTrash` + the red "Clear done" button |
| 7 | `web-ui/src/components/board-card.tsx:321` `isTrashCard` | all completion/trash styling + actions |
| 8 | `web-ui/src/data/column-colors.ts` + `web-ui/src/components/ui/column-indicator.tsx` | column color + indicator glyph |

Two more behaviours are entangled at the mutation layer:

- **The dependency auto-start trigger** fires on a card leaving `review` toward the trash/"done"
  column (`src/core/task-board-mutations.ts:210-229`, `:420-432`). It must follow *completion*, not
  *discard*.
- **The durability gate** — the single choke point that refuses to delete a worktree whose work
  isn't durably saved — is invoked on the trash transition (`deleteTaskWorktree`,
  `src/workspace/task-worktree.ts:619-641`; classifier in `src/workspace/durable-save.ts:64-111`).
  Its own header records the incident that motivated it: a card stalled at a `git commit` prompt was
  advanced to "Done" and its worktree deleted, discarding real work (`durable-save.ts:3-16`).

---

## 3. Principles

- **Done is proud and terminal.** Entering Done never destroys anything: the card stays intact,
  looks complete (no strike-through, no restore affordance), and its worktree is preserved.
- **Removal is always an explicit, gated action.** A worktree is removed only by an explicit *Trash*
  action, and only through the existing durability gate. No lifecycle transition auto-deletes.
- **Discard is an action + a hidden view, not a prime board lane.** The board's scarcest resource is
  horizontal space (epic §4.1 already worries there are too few visible columns). Trash is where dead
  cards go — the one place you rarely look — so it does not earn a permanent column.
- **Migrate, don't version.** `board.json` has no version field; backward compatibility is achieved
  entirely through the zod schema (optional/default/transform). The split follows that convention.
- **Small and upstreamable.** We rebase on `cline/kanban`. Prefer additive, column-native changes
  over a new orthogonal state axis that every consumer must learn.

---

## 4. Target model

**Data model — five states.** The enum gains `done`:
`backlog · in_progress · review · done · trash`. `trash` remains a real column id (reusing all the
existing column machinery), but it is **hidden from the default board**.

**Default board — four visible lanes** + an on-demand archived view:

```
[ Backlog ] [ In Progress ] [ Review ] [ Done ]        ⌄ Archived (N)
```

Per-state behaviour:

| State | Visible? | Worktree | Session | Card styling | Reached by |
|-------|----------|----------|---------|--------------|-----------|
| `backlog` | yes | none yet | none | normal | create |
| `in_progress` | yes | live | live | normal + activity | start |
| `review` | yes | live | live/stopped | normal | agent done |
| **`done`** | **yes** | **kept** (durability gate still applies to any later removal) | stopped | **proud/complete — no strike-through, interactive, no restore** | review → Done (manual/CLI); auto-start fires |
| `trash` (Archived) | **hidden**, behind "Archived (N)" | **removed** (durability-gated) | stopped | muted/struck (unchanged) + restore | explicit *Trash* action |

- **`done`** = terminal + positive. Card intact, worktree preserved, dependency auto-start fires.
- **`trash`** (surfaced as "Archived") = the explicit *Trash* action removes the worktree
  (durability-gated) and moves the card into the hidden bucket. Cold-recoverable via the existing
  "restore in a new worktree" path, which returns the card to `review` (unchanged from today).
- **`task delete`** stays the permanent record removal (`deleteTasksFromBoard`,
  `task-board-mutations.ts:434`) — distinct from Trash.

This keeps the diff additive and column-native: core/CLI/migration are as in §9; the only UI shift is
"render `trash` as a lane" → "hide it behind an Archived toggle" while `done` becomes the visible
proud terminal lane.

---

## 5. Decisions (the four questions, resolved)

### Q1 — Worktree lifecycle per state

**Recommendation:** entering `done` **never** auto-cleans the worktree. Explicit *Trash* is the
*only* action that removes one, and it still passes the durability gate
(`deleteTaskWorktree`, `task-worktree.ts:619-641`) unless the caller explicitly Discards.

**Justification:** the gate's header comment (`durable-save.ts:3-16`) records exactly the failure of
auto-deleting on "Done." Decoupling makes `done` safe by construction and every removal an explicit,
gated act. A welcome side effect: the shutdown path that force-moves cards to Done and deletes their
worktrees (mitigated today by `--skip-shutdown-cleanup`, epic §4.4) becomes a non-issue once `done`
no longer deletes — see Chunk 5.

### Q2 — Does Trash archive or hard-delete?

**Recommendation:** *Trash* **archives** — the card stays on the board in the (now hidden) `trash`
column, its worktree gone, recoverable via the existing "restore in a new worktree" affordance
(restore → `review`). `task delete` remains the permanent hard-delete. This preserves today's
two-tier model (trash = a move + worktree removal; delete = record removal); only the *completion*
path stops routing through trash.

### Q2b — Represent the hidden bucket as a column, not a boolean flag

**Recommendation:** keep `trash` a **column** the UI hides, rather than an orthogonal
`archived: boolean`.

An `archived` flag is the textbook model *only if* archive must be orthogonal to phase — archive from
any column and remember the original phase on restore. This product's archive is not orthogonal: it
is the terminal bucket past Done, and restore already drops cards back to `review`, not their origin
(`use-board-interactions.ts:779-803`). Meanwhile the codebase is thoroughly column-keyed — the
auto-start trigger (`fromColumnId === "review"`), per-column counts, the durability transition,
drag-rules, and `isTrashCard` all switch on the column id. A flag would force `&& !archived` into
every one of those, add a second parallel state axis, and diverge harder from upstream. Keeping
`trash` a hidden column is additive, reuses all existing machinery, and rebases cleanly. See §10 for
when to revisit.

### Q3 — Linking / auto-start dependency re-point (critical)

Today, "when a review card moves to Done, linked backlog cards auto-start." The trigger is:

```ts
// src/core/task-board-mutations.ts:210-229
function getLinkedBacklogTaskIdsReadyAfterTaskTrashed(board, taskId, fromColumnId): string[] {
    if (!taskId || board.dependencies.length === 0 || fromColumnId !== "review") return [];
    // …collect every dependency whose toTaskId === taskId and whose fromTaskId is still in backlog…
}
```

It keys on the **source** column being `review` (never the target), and is invoked only via
`trashTaskAndGetReadyLinkedTaskIds` (`:420-432`) → `moveTaskToColumn(..., "trash")`; the CLI then
starts the ready backlog cards (`task.ts:952-960`). Because "done" *is* the trash column today, the
trigger fires by accident of that aliasing.

**After the split, the trigger must fire on entering `done`, not `trash`.** Concretely:

- Add `completeTaskAndGetReadyLinkedTaskIds(board, taskId)` that computes the ready-linked set (reuse
  `getLinkedBacklogTaskIdsReadyAfterTaskTrashed` — the `=== "review"` source check stays correct,
  since review → Done *is* the completion path) and moves the card to `done` via
  `moveTaskToColumn(..., "done")`.
- Make `trashTaskAndGetReadyLinkedTaskIds` **pure cleanup**: move to `trash`, **no** auto-start
  (discarding a card is not completing it).
- Keep `resolveDependencyEndpoints` rejecting `trash` endpoints (`:191-193`) and add `done` to that
  rejection — you cannot create a new dependency on a finished or discarded card.
- The CLI `task done` handler auto-starts linked cards and keeps the worktree; the CLI `task trash`
  handler removes the worktree and does not auto-start.

**Failure mode if missed:** wire completion to `trash` instead of `done` and the auto-chains keep
working by accident; wire the auto-start to fire on *any* → `trash` and discarding a card silently
launches its dependents. The re-point above avoids both.

### Q4 — board.json migration

There is **no** board.json version field and **no** migration function; backward compatibility is
pure zod (`parsePersistedStateFile` validates old data straight against `runtimeBoardDataSchema`,
`workspace-state.ts:255-273`). The established idioms:

- new optional field: `z.string().optional()` — e.g. `agentModel` with the inline comment "*so a
  board.json written before this field existed still parses*" (`api-contract.ts:146`);
- new non-optional field: `.default(...)` — e.g. `dependencies: z.array(...).default([])` (`:194`);
- reshape/rename: a `.transform` that folds legacy scalars (`:155-174`).

**Recommendation:** follow the transform idiom.

1. Add `"done"` to `runtimeBoardColumnIdEnum` and add a `done` key to
   `runtimeProjectTaskCountsSchema` (`:347-353`).
2. **Remove** the `"done" → "trash"` input preprocess (`:78-80`) — `done` is now a real value.
3. Add a load-time `.transform` on `runtimeBoardDataSchema` that, when a board has a `{ id: "trash" }`
   column and no `{ id: "done" }` column, **renames that column's id to `done`** (its cards all
   arrived via the "Done"-labelled completion path) and appends a fresh empty `trash` column.

No version bump; old boards still parse. This is safe because (a) the column was already *labelled*
"Done", so its cards are completions, and (b) the live board currently holds **0** cards in that
column, so blast radius is effectively nil. It would be the first board.json transform of its kind —
model it on the existing card-level legacy transform.

---

## 6. Auto-start re-point — summary

The dependency chain (epic §4.5: "B waits on A; when A moves to Done, the waiting backlog card
auto-starts") must key on **entering `done`**:

- Source-column check `=== "review"` — **unchanged** (review → Done is completion).
- Target — **`done`** instead of `trash`.
- `trash` — **no** auto-start.

Files: `src/core/task-board-mutations.ts` (`completeTaskAndGetReadyLinkedTaskIds`,
`getReadyLinkedTaskIdsForTaskInTrash` rename, `resolveDependencyEndpoints` reject `done`),
`src/commands/task.ts` (which handler starts linked cards). This is Chunk 2 + Chunk 3.

---

## 7. Migration — summary

- Enum gains `done`; the `done→trash` preprocess is dropped; a `.transform` on
  `runtimeBoardDataSchema` remaps a legacy `trash` column → `done` and adds a fresh `trash`.
- Old boards parse unchanged (missing `done` column ⇒ created by the transform; the four-column
  default in `workspace-state.ts` becomes a five-column default with `done` before `trash`).
- Correctness proof: legacy `trash` cards are completions (the label was "Done"); live blast radius
  is 0 cards. This is Chunk 1.

---

## 8. Alignment with `kanban-ui-epic.md` §4.4

§4.4 wants the column to *follow the branch/PR*: a card stays in Review while its PR is open and only
reaches **Done** on merge (branch merged into base or branch deleted); it also flags the interim
`--skip-shutdown-cleanup` fix that stops the shutdown path force-moving cards to Done and deleting
worktrees.

This doc is the **structural precondition** for §4.4, not a competitor:

- It creates a real, non-destructive `done` state to *be* the git-derived terminal, so §4.4's
  reconcile has an honest column to write (today it would have to write into the trash bin).
- Making `done` non-destructive (Q1) is what lets §4.4 retire `--skip-shutdown-cleanup`: once Done
  never deletes worktrees, the shutdown hazard is gone regardless of who sets the column.
- The git/PR-derived reconcile (`gh pr view` / merge-state) that *automatically* sets Review/Done is
  **out of scope here** — a later layer on top of the manual/CLI Done this doc defines.

---

## 9. Implementation decomposition (the deliverable)

Five ordered, independent Codex cards. The order keeps the board working at every step:
compatibility first, then CLI, then the visible lane, then the hidden Archived view.

### Chunk 1 — Core: `done` column + board.json migration (compatibility layer)
- **Scope:** add `done` to the enum + counts schema; drop the `done→trash` preprocess; add the
  load-time `.transform` remapping legacy `trash` → `done`; extend the default columns. No CLI/UI
  behaviour change yet.
- **Files:** `src/core/api-contract.ts` (enum, `runtimeProjectTaskCountsSchema`, board-data
  transform), `src/state/workspace-state.ts` (`BOARD_COLUMNS`).
- **Tests (RED-first):** an old four-column `board.json` parses with its `trash` cards remapped to
  `done` and a fresh empty `trash` appended; a new board has five columns in order; counts schema
  round-trips a `done` key.
- **Depends on:** nothing. Board still works (new `done` column is simply empty until later chunks
  route to it).

### Chunk 2 — Core mutations: split completion from trashing + re-point auto-start
- **Scope:** add `completeTaskAndGetReadyLinkedTaskIds` (review → `done`, computes ready-linked);
  make `trashTaskAndGetReadyLinkedTaskIds` pure cleanup (→ `trash`, no auto-start); handle `done`
  ordering in `moveTaskToColumn`; `resolveDependencyEndpoints` rejects `done` as a new-link endpoint.
- **Files:** `src/core/task-board-mutations.ts`.
- **Tests:** review → `done` returns the ready-linked backlog ids; review → `trash` returns none;
  linking to a `done` card is rejected; dependency pruning intact.
- **Depends on:** Chunk 1.

### Chunk 3 — CLI: disentangle `task done` / `task trash` / `task delete`
- **Scope:** `task done` → complete (move to `done`, **keep** the worktree per the durability gate,
  auto-start linked backlog cards); `task trash` → remove the worktree + archive (→ `trash`, no
  auto-start); `task delete` unchanged (permanent record removal); `parseListColumn` maps `done →
  done`.
- **Files:** `src/commands/task.ts` (command registration/alias, `parseListColumn`,
  `LIST_TASK_COLUMNS`, `trashTaskById`/new complete handler).
- **Tests:** `task done` leaves the worktree in place and the card in `done` and auto-starts a linked
  backlog card; `task trash` removes the worktree and archives; `task delete` removes the record.
- **Depends on:** Chunks 1–2.

### Chunk 4 — web-ui: visible `done` lane + proud completion styling
- **Scope:** visible lanes become Backlog · In Progress · Review · **Done**; drop `trash` from the
  *default* visible order (revealed in Chunk 5). Split `isTrashCard` into a proud `isDoneCard`
  (interactive, no strike-through, no restore) and the existing muted archived styling. The Review
  card action "Move to Done" targets `done`.
- **Files:** `web-ui/src/data/board-data.ts`, `web-ui/src/components/kanban-board.tsx`
  (`BOARD_COLUMN_ORDER`), `web-ui/src/types/board.ts` (`BoardColumnId` mirror),
  `web-ui/src/state/drag-rules.ts` (`review→done`, `done→trash`),
  `web-ui/src/components/board-card.tsx`, `web-ui/src/data/column-colors.ts`,
  `web-ui/src/components/ui/column-indicator.tsx` (done color + glyph).
- **Tests:** a `done` card renders proud (no strike-through) and is interactive; the Review action
  lands a card in `done`; drag rules permit `review→done` and `done→trash`. Manual: `npm run
  kanban:scratch`.
- **Depends on:** Chunks 1–3.

### Chunk 5 — Hidden Archived view + explicit Trash-from-done + shutdown alignment
- **Scope:** reveal the `trash` column via an **"Archived (N)"** toggle instead of a permanent lane;
  keep "Clear" scoped to that view; add an explicit *Trash* action on a `done` card (worktree
  removal, distinct from review→done); restore stays → `review`. Align shutdown so Done cards are
  never force-moved/deleted on shutdown — the positive version of `--skip-shutdown-cleanup`.
- **Files:** `web-ui/src/components/kanban-board.tsx` / `board-column.tsx` (Archived reveal, prop
  fan-out), `web-ui/src/hooks/use-board-interactions.ts` (trash-from-done handler),
  `web-ui/src/components/task-trash-warning-dialog.tsx` + `clear-trash-dialog.tsx` (copy),
  `src/server/shutdown-coordinator.ts` (no force-move-to-done / worktree deletion on shutdown).
- **Tests:** archived cards are hidden by default and revealed by the toggle; trash-from-done removes
  the worktree and archives; a shutdown leaves `done` worktrees intact.
- **Depends on:** Chunk 4.

---

## 10. Alternatives considered

**`archived: boolean` flag, orthogonal to column (no `trash` column).** The conceptually cleanest
model — mirrors Linear/GitHub — and the right choice *if* archive must be orthogonal to phase
(archive from any column, restore to the original phase). Rejected for now because (a) this product's
archive is the terminal bucket past Done, and restore already returns cards to `review`, so
orthogonality is unused; (b) the codebase is thoroughly column-keyed, so a flag adds a second state
axis every consumer must AND against; (c) it diverges harder from upstream, which we rebase on.
**Revisit if** a real need emerges to archive mid-pipeline cards while preserving their phase — at
which point `trash` can be promoted to a flag with the column split already in place.

**A fifth, always-visible `Trash` column.** The most literal reading of the task. Rejected: it spends
the board's scarcest axis (horizontal space) on cards you rarely look at, and two side-by-side
terminal lanes read as ambiguous. Epic §4.4's terminal model has no trash column at all.

---

## 11. Test strategy (for `/implement`, RED-first)

- **Core (Chunks 1–2):** pure-function unit tests on the schema (migration transform) and
  `task-board-mutations` (completion vs trash, auto-start set, dependency rejection). No I/O.
- **CLI (Chunk 3):** exercise `task done` / `task trash` / `task delete` against the isolated
  integration instance (`test/utilities/kanban-test-instance.ts` → `startIsolatedKanbanInstance`,
  `inject("kanbanBaseUrl")`); assert worktree presence/absence and card column.
- **web-ui (Chunks 4–5):** component/interaction tests for styling and the Archived reveal; manual
  smoke via `npm run kanban:scratch` (throwaway board + `CLINE_HOME` on a random port — never 3500/
  3484).
- **Guard:** scrub `KANBAN_RUNTIME_PORT` before running/committing (known in-session flake).

---

## 12. Risks & out of scope

- **Risk — a missed column-id site.** Eight hardcoded sites (§2) plus the two mutation behaviours;
  each chunk lists its files exhaustively to close this. `tsc` catches most (the `BoardColumnId`
  union widens), but the object-keyed `runtimeProjectTaskCountsSchema` and the string-literal drag
  rules will not error on their own — call them out in review.
- **Risk — restore semantics.** Restore stays → `review` (unchanged). If a future card wants "restore
  to Done," that is a separate change, not part of this split.
- **Out of scope:** the §4.4 git/PR-derived reconcile that *automatically* sets Review/Done from PR
  merge state; any `fleet` CLI surface changes; swimlanes/grouping (§4.2); resources tab (§4.3).
