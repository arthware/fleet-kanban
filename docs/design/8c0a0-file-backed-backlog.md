# File-backed backlog (`.fleet/backlog/` → Backlog column)

**Card:** `8c0a0` · **Status:** design (plan card — no implementation) · **Base:** `production-line`

---

## 1. Problem & the workflow gap it closes

Since `bd16dfc` a card can be authored as a Markdown document with a YAML envelope
(`src/commands/task-card-frontmatter.ts`). But a card only reaches the board through
`kanban task create`, which inserts it **straight into the board store**
(`addTaskToColumn(state.board, "backlog", …)` in `src/commands/task.ts:645`, persisted to
`board.json` by `mutateWorkspaceState`). Authored `.md` files that aren't fed to `task create` live
in scratch dirs and never surface on the board.

In practice the operator authors a card and immediately starts it, so **there is no durable,
reviewable backlog you can see and curate before anything runs.** Author and start are effectively one
step.

We want to split them. A well-known directory — `.fleet/backlog/` — becomes the **default home** for
card files. **Any card-format `.md` dropped there shows up in the Backlog row**, parsed with the
existing envelope. Authoring (drop/commit a file) becomes separate from starting (an explicit,
per-card action). The folder *is* the backlog: reviewable in PRs, curatable by hand, and never
auto-started.

### Fixed requirements (decided — this doc designs *how*)

- `.fleet/backlog/` is the **default** home for card files; creation that doesn't start the card lands
  it here, visible in Backlog, not auto-started.
- **Anything in `.fleet/backlog/` in our card Markdown format appears as a Backlog card**, parsed by
  the existing `parseTaskCardDocument` — reused verbatim, never reimplemented.
- Ingested cards land in **Backlog only** — never auto-start.

---

## 2. Current behaviour, cited to code

How a card reaches the client today — the seam ingestion must plug into:

1. **Create** — `createTask` (`task.ts:614`) resolves the workspace, then
   `addTaskToColumn(board, "backlog", …, crypto.randomUUID)` (`task-board-mutations.ts:316`) mints a
   `RuntimeBoardCard` and prepends it to the backlog column, written to `board.json` under a directory
   lock with optimistic-revision concurrency (`mutateWorkspaceState`, `workspace-state.ts:714`).
2. **Snapshot** — the single seam through which the board reaches the client:
   `buildWorkspaceStateSnapshot` (`workspace-registry.ts:331`) → `loadWorkspaceState(workspacePath)`
   (`workspace-state.ts:653`) reads `board.json` + `sessions.json` + `meta.json`. Both the initial
   `snapshot` message and every `workspace_state_updated` broadcast run through this
   (`runtime-state-hub.ts:382` and `:493`).
3. **Re-broadcast** — a mutation calls `notifyStateUpdated` (`task.ts:336`), which the hub turns into
   `broadcastRuntimeWorkspaceStateUpdated` (`runtime-state-hub.ts:379`): rebuild the snapshot, push to
   every connected client.
4. **Metadata monitor** — `workspace-metadata-monitor.ts` polls **git** metadata per workspace every
   1 s (`WORKSPACE_METADATA_POLL_INTERVAL_MS`), **explicitly skipping backlog and trash cards**
   (`collectTrackedTasks`, `:106`). It never mutates `board.json`; it broadcasts a *separate*
   `workspace_metadata_updated`. It is the home of the **mtime-gated scan** pattern
   (`computeGitDirToken`, `git-dir-token.ts`) introduced in `453238d`, and of the
   previous→current column-diff pattern (`captureReviewDoneTransitions`, `:442`).

Two facts that shape the design:
- **`board.json` is the one source the snapshot reads.** For an ingested card to "appear the same way
  store-backed cards do," it must end up in `board.json` (or be merged into the object
  `loadWorkspaceState` returns). Anything else is a second render path.
- **There is no fs watcher anywhere in the tree.** The only change-detection primitive is the
  mtime-token (`453238d`), and snapshot assembly is deliberately kept off the blocking first-paint
  path (`a0bf83b`, `6c8d9be`).

---

## 3. Recommended model (the six hard questions)

### Q1 — Single source of truth → **Option A, materialized into the store**

**Decision:** the **file is authoritative** for a backlog card's *content and existence while it is in
Backlog*. Ingestion **materializes a mirror card into `board.json`** (backlog column) keyed by a stable
id, so the snapshot, `start`, links, and every existing mutation treat it exactly like a store-native
card. The file remains the authoring source; the store is its runtime projection. A reconcile loop
keeps them consistent (file→board on drop/edit/delete; board→file on column change).

Cards carry a marker (`source: "file"`, plus `backlogFilePath`) so reconcile only ever manages
file-backed cards and never touches UI-created backlog cards.

| Option | Mental model | Cost |
|---|---|---|
| **A-strict — pure read-time overlay** (files merged into the snapshot, never persisted; start promotes file→store) | "folder *is* backlog", no in-backlog drift (file is the only copy) | **Two render paths**: `loadWorkspaceState` must merge files, *and* every backlog mutation (`task update`, the inline model edit from `5fb1b41`, links, reorder) writes `board.json` and would silently not persist for overlay-only cards. Large blast radius, fights the store. |
| **A-materialized (recommended)** — file authoritative, mirrored into `board.json`, kept synced | "folder *is* backlog" preserved; **every existing runtime path works unchanged** | Needs the round-trip reconcile (§Q3) and a "file wins on content" rule (§Risks). |
| **B — one-way import inbox** (drop file → create card once → consume/archive the file) | inbox, not a backlog | Loses the round-trip: a consumed file no longer reflects its card; **deleting a file doesn't remove the card**; editing a file does nothing. Contradicts "the folder is my backlog." |

A-materialized is B's machinery run **continuously and bidirectionally** instead of once — it keeps
the "folder is the backlog" mental model the operator asked for while reusing the entire existing
board runtime.

### Q2 — Identity / dedup → **stable `id:` stamped into frontmatter on first ingest**

A file maps to exactly one card by an `id` stored in its own frontmatter. On first sight of a file with
no `id`, ingest mints one (`crypto.randomUUID()`, same id space as `addTaskToColumn`) and **writes it
back** into the file (`matter.stringify`). Thereafter the file↔card mapping is by that id, held in an
in-memory `id → { path, contentHash, mtimeMs }` index.

| Scheme | Rename | Edit | Verdict |
|---|---|---|---|
| filename-as-id | **breaks** (rename = new card, links lost) | ok | ✗ |
| content/path hash | breaks (path) / new-card-per-edit (content) | **breaks** | ✗ |
| **stamped `id:` (recommended)** | same card (path re-indexed) | same card (content re-synced) | ✓ |

- **Rename** (file already has `id`): same card; update the tracked path only. Operator reorganizing
  `.fleet/backlog/` into subfolders never reshuffles identity, and links/deps survive.
- **Edit** (same `id`): re-sync the card's content (mtime-gated, §Q4).
- **Duplicate `id`** (copy-paste): second file detected on scan → skipped with a logged warning and
  surfaced as an ingest error (§Q5).
- **No `id`**: mint + write back — the *only* write ingest makes into the operator's file. It is
  idempotent (write only when `id` absent), atomic (temp-write + rename via the existing locked-fs
  helpers), and never runs on a file it didn't just readdir.

*Rejected alternative — path-derived deterministic id (no write-back):* avoids mutating the file, but a
rename becomes remove-old-card + add-new-card, discarding board position and links. For a curated
backlog that identity loss is the wrong default. The write-back cost (one tracked line in a committed
file) is worth stable identity. `task create` (§Q3) stamps the `id` up front so hand-dropped files are
the only ones that ever get written back.

### Q3 — Lifecycle round-trip → **top-level = live Backlog; `started/` + `trash/` = archive**

```
.fleet/backlog/
  <slug>.md            # authored, still in Backlog — THIS is the scanned set
  started/<slug>.md    # card left Backlog (in_progress / review / done live in the store)
  trash/<slug>.md      # card trashed
```

The file's only job is the **Backlog stage**. Once a card starts it gains a worktree and a session and
its lifecycle is owned by the store; the file steps aside. Relocation (not a `status:` stamp) is the
signal, because the active scan is then just "top-level `*.md`" — trivially bounded, and a large
`started/` history costs zero scan time. (A `status:` stamp would force re-parsing every file each tick
to know which are still Backlog, defeating the mtime gate.)

**State machine — the reconcile is declarative and idempotent** (diff *desired* = files vs *actual* =
store, each tick), so no need to hook every transition call-site:

| Trigger | Direction | Action |
|---|---|---|
| new top-level `*.md` | file→board | parse; mint+stamp `id` if absent; **upsert** Backlog card (`source:"file"`) |
| top-level file edited | file→board | re-sync card content from file (file wins) |
| top-level file deleted, card still in Backlog | file→board | remove the Backlog card |
| file-backed card leaves Backlog (started/moved) | board→file | relocate file → `started/` |
| file-backed card trashed | board→file | relocate file → `trash/` |
| file moved back from `started/` → top-level | file→board | re-appears as Backlog (same `id` re-syncs, or recreates) — a legit "re-queue" |

`done` / `in_progress` / `review` need **no** subdir: once relocated to `started/` the file is out of
the active scan and the store owns the rest. The board→file half is a diff of the file-backed cards'
current column (from `board.json`) against their file location — the same previous→current pattern as
`captureReviewDoneTransitions`.

**`task create` (no `--start`) becomes "author into `.fleet/backlog/` then reconcile."** It writes
`.fleet/backlog/<slug>.md` with a stamped `id`, then runs the same ingest reconcile **inline** so the
card exists and the id is returned synchronously — `--quiet`/`--id-only` and every script keep working.
Dropping a file by hand is the identical path minus the CLI. (`fleet task create --start` continues to
resolve start at the fleet wrapper; kanban's `task create` staying "always Backlog" is unchanged — it
just also writes the file.) Filename slug = kebab(title); collisions get a `-<shortid>` suffix. The
`id` frontmatter — not the filename — is identity.

### Q4 — Discovery → **fold into the periodic monitor tick, mtime-gated (no watcher)**

Reuse the incumbent `453238d` pattern, not `fs.watch`/chokidar.

- **No new dependency**; consistent with the existing 1 s monitor cadence.
- A human-curated backlog tolerates ≤ a couple seconds of latency (drop a file, it shows next tick).
- `fs.watch` is unreliable across platforms and network filesystems and adds teardown complexity;
  chokidar is a dependency for a latency win we don't need.

**Bound it** with a `computeBacklogDirToken` analogous to `computeGitDirToken` (`git-dir-token.ts`):
the token = dir mtime + child count + max child mtime (a handful of `stat`s, no subprocess). Token
unchanged → skip the `readdir`+parse entirely. Additionally cap per-file work: a size ceiling
(skip+warn oversized files), and a parse cache keyed by file mtime so an unchanged file is never
re-parsed. Cap the number of files turned into cards per tick and `log()` the overflow (no silent
truncation).

**Placement (honoring `a0bf83b` / `6c8d9be`):** reconcile is invoked from the monitor's background
`refreshWorkspace` path (which already runs each tick per connected workspace and is off the
first-paint path), via a new injected dep `onBacklogChanged(workspaceId, workspacePath)` that the hub
wires to `broadcastRuntimeWorkspaceStateUpdated`. It is **not** run synchronously inside
`buildWorkspaceStateSnapshot` — the backlog fills in one tick after first paint, exactly like git
metadata streams in today. Reconcile itself is wrapped best-effort (never throws out; a wedged/huge
dir degrades to "no change this tick," never wedges the snapshot).

### Q5 — Malformed files → **non-startable placeholder card, not a silent skip**

A `.md` that fails `parseTaskCardDocument` becomes a **placeholder Backlog card** (title = filename,
prompt = the parse error, additive flag `ingestError: string`), and `start` refuses a card with
`ingestError` set. The whole feature is about the operator *seeing and curating* their backlog; a
silent skip is the "I dropped a card and it never showed and I don't know why" failure that defeats the
point. The placeholder makes the failure visible and self-explanatory without ever being runnable.
(Fallback if we want zero schema change: skip + `log()` + include the failures in the ingest result so
the UI can show an "N backlog files failed to parse" affordance. Recommended path is the placeholder —
the tiny additive field is worth the visibility.)

### Q6 — Config & git → **path configurable (default `.fleet/backlog/`); backlog committed**

- **Path:** default `.fleet/backlog/`, overridable via the repo's `.cline/kanban/config.json` (which
  already carries per-repo executable config like `worktree.postCreateCommand`, `c8a59`) under a
  `backlog.dir` key. Cheap, and different repos organize differently.
- **Git:** **commit the backlog** — a durable, reviewable, PR-curated team backlog is the whole point.
  Caveat: `.fleet/.gitignore` today is a single `*`, and **git will not descend into an ignored
  directory**, so a nested `.fleet/backlog/.gitignore` is never consulted. Tracking it requires
  re-including from the ancestor:
  ```gitignore
  # .fleet/.gitignore
  *
  !backlog/
  !backlog/**
  ```
  `.fleet/.gitignore` is authored by the **fleet CLI** (parent repo, out of this fork's scope), so the
  upstreamable split is: kanban **detects and warns** when the configured backlog dir is git-ignored
  (a "your shared backlog isn't actually tracked" guard), and the fleet side ships the re-include.
  Kanban does **not** silently auto-edit `.fleet/.gitignore`. This closes the "gitignored-vs-committed
  surprise" risk without magic.

---

## 4. Implementation outline (files / functions)

Phased; each phase is independently testable.

**Phase 1 — envelope: identity.** `src/commands/task-card-frontmatter.ts`
- Add `id` to `KNOWN_FRONTMATTER_KEYS`; parse it onto `ParsedTaskCard.id` (additive, back-compatible).
- Add `stampCardId(source, id): string` (idempotent write-back via `matter.stringify`; no-op if `id`
  already present).

**Phase 2 — dir primitives.** New `src/workspace/backlog-paths.ts` (resolve `<repo>/.fleet/backlog`,
`started/`, `trash/`; read `backlog.dir` from `.cline/kanban/config.json`; `isBacklogDirGitIgnored`
check) and new `src/workspace/backlog-dir-token.ts` (`computeBacklogDirToken`, mtime+count token,
best-effort, never throws — mirror `git-dir-token.ts`).

**Phase 3 — reconcile core (pure, injected fs).** New `src/server/backlog-ingest.ts`:
`reconcileBacklog({ workspacePath, board, previousIndex })` →
`{ nextBoard, nextIndex, changed, ingestErrors }`.
- Scan top-level `*.md` (token-gated, parse-cached, size/count-capped).
- Upsert file-backed cards (by `id`) into the backlog column via the existing
  `task-board-mutations` helpers — **upsert, not blind `addTaskToColumn`** (it throws on dup id):
  exists → update content; else add with `source:"file"` + `backlogFilePath`.
- Remove file-backed Backlog cards whose top-level file vanished.
- Relocate files whose file-backed card left Backlog (diff column vs file location) → `started/`/`trash/`.
- Malformed → placeholder card with `ingestError`.
- All board writes go through `mutateWorkspaceState` (locked + revision) so concurrent CLI/tick
  reconciles can't double-insert.

**Phase 4 — wire discovery.** `src/server/workspace-metadata-monitor.ts` (or a sibling driven by the
same timer): call `reconcileBacklog` in the background `refreshWorkspace` path; on `changed`, invoke a
new dep `onBacklogChanged`. `src/server/runtime-state-hub.ts` + `runtime-server.ts`: wire
`onBacklogChanged → broadcastRuntimeWorkspaceStateUpdated`.

**Phase 5 — create writes the file.** `src/commands/task.ts` `createTask`: write
`.fleet/backlog/<slug>.md` (stamped `id`) then run the reconcile inline before returning; unchanged
return shape/id.

**Phase 6 — contract + guards.** `src/core/api-contract.ts` `runtimeBoardCardSchema`: additive optional
`source: z.enum(["file"]).optional()`, `backlogFilePath: z.string().optional()`,
`ingestError: z.string().optional()` (additive/optional — wire + on-disk compat). `startTask` guard:
refuse a card with `ingestError`.

**Phase 7 — docs.** Update `docs/card-authoring.md` (the `.fleet/backlog/` default + `id`) and add a
"To change X, edit Y" row to `docs/architecture/component-overview.md`.

---

## 5. Test strategy (RED-first)

**Unit — envelope** (`task-card-frontmatter.test.ts`): `id` parsed; `stampCardId` writes idempotently
and leaves an existing `id` untouched; unknown-key error still fires.

**Unit — dir token**: unchanged dir → identical token; add/edit/delete a child → token changes; missing
dir → `null` (caller falls back), never throws.

**Unit — reconcile** (injected fs, `backlog-ingest.test.ts`):
- drop file (no `id`) → mints+stamps `id`, produces a Backlog card (`source:"file"`).
- re-tick, token unchanged → **no `readdir`/parse, no new card** (dedup + bound).
- edit body → card prompt updates (file wins).
- rename file (same `id`) → same card, path re-indexed, **no duplicate**.
- delete top-level file, card still Backlog → card removed.
- file-backed card set to non-Backlog in the store → file relocated to `started/`; next scans ignore it.
- trashed → file → `trash/`.
- malformed file → placeholder card with `ingestError`; **`start` refuses it**.
- two files, same `id` → second skipped + warning + ingest error.
- oversized / over-count → skipped + `log()`, others still ingested.

**Integration / BDD** (isolated instance, `startIsolatedKanbanInstance` + `inject("kanbanBaseUrl")`):
- drop a valid `.md` into `.fleet/backlog/` → within a tick it appears in the Backlog column of the
  snapshot/stream.
- `task create --file …` (no start) → file exists in `.fleet/backlog/`, card in Backlog, id returned.
- start a file-backed Backlog card → moves to `in_progress`, file relocated to `started/`, **not**
  re-ingested as a new Backlog card next tick.
- **never auto-starts** — a dropped card stays in Backlog until an explicit `start`.
- git-ignored backlog dir → ingest still works locally **and** emits the "not tracked" warning.

---

## 6. Risks, open questions, out-of-scope

**Risks**
- **File-edit vs UI-edit of the same card** (last-writer): rule is **file wins on content** — on the
  next tick the file re-syncs the card. Document that UI content edits to a file-backed backlog card
  are transient; consider annotating/locking those fields in the UI (follow-up, not blocking).
- **Dedup races across ticks / CLI + tick concurrency**: mitigated by the mtime-gate + `id` keying +
  upsert (never blind-add) + all writes through the locked, revisioned `mutateWorkspaceState`.
- **Huge / broken dir wedging the snapshot** (`a0bf83b`): token-gate + size/count caps + parse cache +
  best-effort try/catch + background (not first-paint) placement; overflow is `log()`ged, never silent.
- **Rename / re-queue**: handled by stamped `id`; moving a file out of `started/` re-queues it.
- **Gitignored-vs-committed surprise**: kanban warns when the dir is ignored; the fleet CLI ships the
  `.fleet/.gitignore` re-include.
- **Write-back dirties a committed file**: bounded to files lacking an `id`, idempotent, atomic;
  `task create` pre-stamps so only hand-dropped files ever trigger it.

**Open questions**
1. Placeholder card vs skip+log for malformed files — recommended placeholder; confirm the small
   additive `ingestError` field is acceptable on the spine.
2. Should `fleet`/kanban own the `.fleet/.gitignore` re-include, or leave it to operator setup + warn?
   (Recommended: fleet owns it; kanban warns.)
3. UI treatment of file-backed cards (badge? lock content edit?) — deferred to a follow-up.

**Out of scope**: fs.watch/chokidar; a UI editor for backlog files; syncing non-Backlog columns to
files (started/done/review stay store-owned); the fleet-side `.fleet/.gitignore` change itself.

---

## 7. Disposition

**One build card (Codex), phased internally as §4.** The pieces (envelope `id`, dir primitives,
reconcile, wiring, create-writes-file, contract) are tightly coupled around one reconcile core and
share tests; splitting would thrash the shared `backlog-ingest` module across cards. Ship Phases 1–7 as
one PR against `production-line`.

**Concrete Codex scope:** implement `stampCardId` + `id` parsing; `backlog-paths.ts` +
`backlog-dir-token.ts`; `backlog-ingest.ts` `reconcileBacklog` (pure, injected fs, upsert/remove/
relocate/malformed); wire it into the monitor tick + `onBacklogChanged → broadcast`; make `task create`
write the file + inline-reconcile; additive card fields + `start` guard; update
`docs/card-authoring.md` + the component-overview index. Deliver the full RED-first test set in §5.
**Prior art to read first:** `bd16dfc` (envelope), `453238d` (mtime-gated scan + dir token),
`a0bf83b`/`6c8d9be` (bounded, non-blocking snapshot), `5fb1b41` (backlog-card mutation path).

*Optional follow-up card:* UI badge/lock for file-backed cards and the fleet-side `.fleet/.gitignore`
re-include.
