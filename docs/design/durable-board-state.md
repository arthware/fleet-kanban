# Durable board state (and durable agent sessions)

**Status:** design · **Epic:** `fleet/docs/kanban-ui-epic.md` §4.6 · **Scope:** fleet-kanban (fork) ·
**Supersedes/extends:** `docs/design/durable-agent-sessions.md` (that doc is now §7 of this one)

> Deliverable of `/fleet-plan`. No implementation code here. Hand this to `/fleet-implement`.

---

## 0. TL;DR

The board is **not** un-persisted. `board.json` / `sessions.json` / `meta.json` / `index.json` are
written **atomically** under `CLINE_HOME` (`workspace-state.ts:674-682`, `saveWorkspaceState`). The
incident where "Commit wiped the whole project + all cards" was **not** a crash losing in-memory
state — it was an **eager destructive auto-prune**: on every websocket (re)connect,
`resolveWorkspaceForStream` probes each project with `git rev-parse --is-inside-work-tree`, and on a
single *false/transient* result it **permanently `rm`s** the project's index entry and all state
files (`workspace-registry.ts:366-380`). The Commit flow runs git operations (checkout / stash /
cherry-pick / `index.lock` removal) against the base repo, which is exactly when that probe can
transiently fail.

So there are two distinct durability defects, and this design covers both under one principle:

> **`board = f(git worktrees/branches, agent session files, a minimal persisted manifest)`**, and
> **reconciliation may never destroy durable state on a transient or single-signal cue** — it
> repairs, soft-deletes, and is reconstructable after a crash.

Defect A (**state wipe**, the incident) — fixed by removing the destructive prune and replacing it
with derive-safe reconciliation.
Defect B (**session loss**, "No conversation found to continue") — fixed by persisting the CLI
session id and resuming by id (the original `durable-agent-sessions.md` plan, folded in as §7).

---

## 1. Ground-truth inventory — what persists vs what is memory-only (cited)

### 1.1 Durable today (survives process death)

| Datum | Where | Cite |
|---|---|---|
| Project registry (workspaceId ↔ repoPath) | `<CLINE_HOME>/kanban/index.json` | `workspace-state.ts:23,26,173-176` |
| Board (columns, cards: title/prompt/baseRef/agentId/plan-mode/links) | `<CLINE_HOME>/kanban/workspaces/<id>/board.json` | `workspace-state.ts:27,181-185`, schema `api-contract.ts:132-191` |
| Session **summaries** (state, agentId kind, pid, timestamps, checkpoints) | `.../<id>/sessions.json` | `workspace-state.ts:28,185`, schema `api-contract.ts:282-300` |
| Optimistic-concurrency revision | `.../<id>/meta.json` | `workspace-state.ts:29,312-319` |
| Task worktree + branch (the actual work) | `<CLINE_HOME>/worktrees/<taskId>/<label>` | `task-worktree-path.ts:5,33-40`; path derived purely from `taskId` |
| CLI transcript bodies | `~/.claude/projects/<slug>/<id>.jsonl`, `~/.codex/sessions/.../rollout-*-<id>.jsonl` | (host `$HOME`, outside CLINE_HOME) |

Writes are **atomic and crash-safe** already: `lockedFileSystem.writeJsonFileAtomic` for board /
sessions / meta (`workspace-state.ts:674-682`), guarded by a per-workspace directory lock and a
monotonic `revision` for conflict detection (`saveWorkspaceState`, `mutateWorkspaceState`
`:648-745`). **This part is good and must be preserved.**

Worktrees are already treated as authoritative — `ensureTaskWorktreeIfDoesntExist` only *creates
missing* worktrees and does not clobber existing ones (`task-worktree.ts:449` comment: "worktrees are
now treated as authoritative and only missing worktrees are created").

### 1.2 Memory-only (dies with the process)

| Datum | Where | Cite |
|---|---|---|
| Live PTY / child process handle | `ActiveProcessState.session` (`PtySession`) | `session-manager.ts:51-64`, `entries` Map `:206` |
| Terminal scrollback mirror | `TerminalStateMirror` (headless xterm) | `session-manager.ts:69,315` |
| The **CLI session id** needed for a deterministic resume | *nowhere* — never captured | schema has no field `api-contract.ts:282-299` |

On boot, only `sessions.json` is rehydrated, always with `active: null`
(`workspace-registry.ts:239-240` → `session-manager.ts:245-258`). There is **no** rebuild of the
board from worktrees, and **no** reconciliation between board/manifest/worktrees/sessions.

**Correction to the earlier hypothesis:** board/card state is *not* in-memory-only. The fragility is
(A) a destructive prune on a transient git probe and (B) no persisted session id. Both are fixed
below.

---

## 2. Confirmed root cause of the incident (state wipe)

### 2.1 The destructive path

`resolveWorkspaceForStream` runs on **every** runtime-state websocket connection
(`runtime-state-hub.ts:353` calls it in the `"connection"` handler; the browser reconnects often —
tab focus, network blips, HMR, navigation after an action). For each indexed project it does:

```
if (!(await deps.pathIsDirectory(project.repoPath)))       → mark "no longer exists on disk"
else if (!deps.hasGitRepository(project.repoPath))         → mark "not a git repository"
...
removedProjects.push(project)
await removeWorkspaceIndexEntry(project.workspaceId)        // deletes index entry
await removeWorkspaceStateFiles(project.workspaceId)        // rm -rf board.json/sessions.json/meta.json
disposeWorkspace(project.workspaceId)
```

`workspace-registry.ts:364-386`. `removeWorkspaceStateFiles` / `removeWorkspaceIndexEntry` are the
same functions the *explicit* "Remove project" button uses (`projects-api.ts:185-189`) — i.e. a
transient probe failure is treated identically to a deliberate user deletion. **No soft-delete, no
confirmation, no grace period, no second signal.**

### 2.2 Why the probe fails during "Commit"

`hasGitRepository` = `spawnSync("git", ["rev-parse","--is-inside-work-tree"])` and requires
`status === 0 && stdout.trim() === "true"` (`cli.ts:239-247`). It returns `false` on *any* non-zero
exit or non-`"true"` output — including transient conditions:

- The Commit action injects the **commit prompt template** into the task agent
  (`runtime-config.ts:60-83`, built by `build-task-git-action-prompt.ts`). That template tells the
  agent to operate on the **base repo**: "Find where `{{base_ref}}` is checked out… use that P",
  `git -C P stash push`, **cherry-pick into P**, and if `.git/index.lock` exists to "treat the lock
  as stale, remove it, and retry" (steps 2-8). During a checkout/cherry-pick/stash the base repo is
  momentarily inconsistent, and an `index.lock` present at probe time makes many git plumbing
  commands exit non-zero.
- Under load (several sessions starting at once) `spawnSync git` can be slow/fail — the repo's own
  `AGENTS.md` warns heavy shell init can freeze the runtime on hot paths.

A **single** such false reading on the **next reconnect** → permanent deletion of the project row and
all board/session files. The git **worktrees and branches survive** (they're never touched on this
path — `resolveWorkspaceForStream` deletes only index + state files, not worktrees), which is exactly
the observed symptom: "work still on disk, board empty."

**One sentence:** a transient `git rev-parse` failure during the Commit flow is misread as "project
deleted," and an eager reconnect-time prune hard-`rm`s durable board state that is otherwise
perfectly intact.

### 2.3 Why reopening also lost the session (Defect B, unchanged from prior doc)

The live handle is memory-only and no CLI session id is persisted, so resume falls back to each CLI's
recency/cwd heuristic (`claude --continue`, `codex resume --last`), which errors ("No conversation
found to continue") or grabs the wrong conversation. `recoverStaleSession` collapses *dead* to *idle*
and clears everything (`session-manager.ts:705-728`), leaving nothing to Resume against. Full
analysis: §7.

---

## 3. Design principle & target architecture

**`board = f(GIT, SESSIONS, MANIFEST)`** — every board fact is either derivable from durable ground
truth (git worktrees/branches/commits, CLI session files) or lives in a small persisted **manifest**;
nothing important is memory-only, and the board is **reconstructable at any time** by a reconciliation
pass. The persisted files we already have (`board.json` etc.) become a **cache/manifest** that
reconciliation can *repair from git*, never the single fragile source that a bad probe can destroy.

Three rules:

1. **Persist the irreducible minimum** (the manifest) — the user-authored and mapping data that git
   cannot know.
2. **Derive the rest** — column, worktree, branch, PR/merge status, session liveness — from git and
   session files at load/reconcile time.
3. **Reconcile, never destroy** — startup and reconnect run an idempotent reconciliation that repairs
   drift and *soft-deletes* only on durable, multi-signal evidence.

---

## 4. The minimal manifest — what is NOT derivable

Git knows about commits, branches, and worktrees, but nothing about *intent*. The manifest is the
authoritative store for the non-derivable facts. It stays essentially the **current `board.json` +
`index.json` + `sessions.json`**, hardened — we are not inventing a new store, we are (a) making it
un-destroyable and (b) adding two fields.

Per card (already in `board.json`, keep): `id`, `title`, `prompt`, `baseRef`, `startInPlanMode`,
`autoReviewEnabled/Mode`, `agentId` override, `clineSettings`, `createdAt/updatedAt`
(`api-contract.ts:132-149`); board-level `dependencies` (links) (`:179-191`).

**Add to the manifest (the only genuinely new persisted state):**

1. `card.column` **as an intent hint**, *not* an authority — the column the user last placed the card
   in. Reconciliation prefers derived-from-git column when git has a clear signal (merged → Done),
   else falls back to this hint. (Cards already live inside a column array; we keep that but treat it
   as overridable by git evidence — see §6.)
2. `session.agentSessionId: string | null` — the CLI session UUID, the one datum needed for a
   deterministic resume (§7). Add to `runtimeTaskSessionSummarySchema` (`api-contract.ts:282`),
   `default(null)` for back-compat.

The **task ↔ worktree ↔ branch** mapping needs **no new storage**: the worktree path is a pure
function of `taskId` (`getTaskWorktreePath` → `<CLINE_HOME>/worktrees/<taskId>/<label>`,
`task-worktree-path.ts:33-40`) and the branch is derivable from the worktree HEAD. The task ↔
session-id mapping is `sessions.json[taskId].agentSessionId`.

**Where it lives / crash-safety:** unchanged location under `CLINE_HOME`; unchanged atomic writer
(`writeJsonFileAtomic`, per-workspace lock, `revision` CAS — `workspace-state.ts:648-745`). We add
one guarantee: **manifest deletion is never triggered by a runtime probe** — only by an explicit
user action or a reconciliation that has confirmed durable absence (§6.3).

---

## 5. What IS derivable (and from where)

### 5.1 From git
- **Worktree existence** for a task → `pathExists(getTaskWorktreePath(repo, taskId))`
  (`task-worktree.ts:634-637`). A worktree ⇒ the card had work started.
- **Branch / HEAD / task commit** → `git -C <worktree> rev-parse HEAD`, `git worktree list
  --porcelain`, `for-each-ref` (already used: `workspace-state.ts:451`, `detectGitBranches`).
- **Merged / committed onto base** → `git branch --merged <baseRef>` / `git merge-base --is-ancestor`
  → a strong "this card is Done" signal.
- **PR state** (§4.4 epic, complementary) → `gh pr view` / branch pushed + PR open → "Review" vs
  "Done".

### 5.2 From session files
- **Conversation body** — never copied; lives in the CLI store.
- **Resumability** — does `~/.claude/projects/*/<agentSessionId>.jsonl` (or the codex rollout) exist?
  → `resumable` vs `gone` (§7).
- **Liveness** — a persisted `pid` that is no longer alive ⇒ dead session (needs reconcile), not a
  running one.

---

## 6. Reconciliation algorithm (startup / after crash / on reconnect)

A single idempotent function `reconcileWorkspace(workspaceId, repoPath)` that **only repairs**. It
replaces the destructive prune in `resolveWorkspaceForStream` and augments boot hydration.

### 6.1 Inputs
`manifest = board.json ∪ sessions.json`; `worktrees = scan <CLINE_HOME>/worktrees/*` filtered to this
repo; `git = branches/merge-status per worktree`; `transcripts = existence of agentSessionId files`.

### 6.2 Reconcile loop (per task)
For each card in the manifest and each worktree on disk, form the union of task ids, then classify:

| Manifest card? | Worktree on disk? | Action |
|---|---|---|
| yes | yes | **Healthy.** Recompute derived column from git (merged→Done candidate). Recompute session lifecycle (`attached`/`resumable`/`gone`, §7). Keep card. |
| yes | no | **Worktree missing.** Do **not** delete the card. If column ∈ {in_progress, review} and git shows no merge → mark card `needs_attention` (worktree vanished) and leave it; user can restart (recreates worktree). If merged/Done → column = Done. Never `rm` the card. |
| no | yes | **Orphan worktree.** A card row was lost (e.g. the incident) but work survives. **Re-adopt**: synthesize a recovered card (id = taskId, title/prompt = placeholder "Recovered task <id>", baseRef from worktree's fork point) placed in `in_progress`/`review` per git. Surface a "recovered" badge. This makes the incident *self-healing* on next boot. |
| no | no | Nothing to do. |

### 6.3 Deletion policy (the fix for the incident)
- **A failed `hasGitRepository` / `pathIsDirectory` probe NEVER deletes state.** It marks the project
  `unavailable` (transient) and *hides/greys* it in the UI, retaining all files.
- A project is only **hard-removed** when: (a) the user explicitly removes it
  (`projects-api.removeProject`), **or** (b) reconciliation confirms **durable** absence — the repo
  path is missing/non-git across **N consecutive checks over a grace window** (e.g. 3 checks / 30s),
  and even then it should **soft-delete** (move the workspace dir to `<CLINE_HOME>/kanban/.trash/`)
  rather than `rm`, so it is recoverable.
- Require a **positive** signal for "repo exists but not git," not merely a non-zero git exit: e.g.
  the directory exists AND contains no `.git` AND `git rev-parse` fails — distinguishing "genuinely
  not a repo" from "git command transiently failed." A `spawnSync` error (`error`/`signal`/timeout)
  is treated as *unknown → keep*, never *absent → delete*.

### 6.4 When it runs
- **Boot**, per workspace, before the first snapshot (extends `ensureTerminalManagerForWorkspace`
  hydration, `workspace-registry.ts:236-253`).
- **On reconnect** inside `resolveWorkspaceForStream` — but only the *non-destructive* repair +
  transient-unavailable marking.
- Cheap and debounced; results feed the existing `buildWorkspaceStateSnapshot`.

---

## 7. Durable agent sessions (folded in from the prior design)

This is the original `durable-agent-sessions.md`, unchanged in intent; summarized here so the two
efforts share one document.

**Cause:** live handle is memory-only (`session-manager.ts:51-64,206`); the CLI session id is never
captured/persisted (`api-contract.ts:282-299`); resume relies on each CLI's recency/cwd heuristic
(`agent-session-adapters.ts` claude `--continue`, codex `resume --last`), which fails or grabs the
wrong conversation; `recoverStaleSession` collapses dead→idle and clears everything
(`session-manager.ts:705-728`).

**Fix (Option A):**
1. **Spawn:** mint `sessionId = randomUUID()`; claude sets it via `--session-id <id>`; codex has it
   *discovered* post-spawn from the rollout file matched by cwd (reuse
   `findCodexRolloutFileForCwd`, `codex-hook-events.ts:322-351`). Persist to
   `summary.agentSessionId`.
2. **Resume:** on reopen of a non-active session with a stored id **and** transcript present, resume
   by explicit id (claude `--resume <id>`, codex `resume <id>`); else fall back to the current
   heuristic; else fresh.
3. **Lifecycle (derived, not stored):** `attached` (`active != null`) / `resumable`
   (`active == null` and transcript for id exists) / `gone` (no transcript). Replace the
   dead→idle collapse in `recoverStaleSession` with this; never clear `agentSessionId`.

**Transcript locator (new `agent-transcript-locator.ts`):** find claude by glob
`~/.claude/projects/*/<id>.jsonl` (UUID is globally unique — avoids the fragile cwd-slug rule);
codex via the rollout scan. Pure, temp-`HOME` unit-testable.

Full option analysis, per-adapter argv, and UI details: see the original doc body (§4-§6 there) —
they are unchanged and carried into the implementation cards below.

---

## 8. Making commit / move-to-done / cleanup derive-safe

The destructive operations must be **idempotent, reversible where possible, and never able to remove
still-needed state on a transient signal.**

1. **Reconnect prune → repair-only** (Defect A fix). `resolveWorkspaceForStream`
   (`workspace-registry.ts:354-435`) stops calling `removeWorkspaceIndexEntry` /
   `removeWorkspaceStateFiles`. Transiently-unavailable projects are *marked*, not deleted (§6.3).
2. **Commit action** stays a prompt to the agent, but the runtime must not interpret the base repo's
   momentary inconsistency as project loss (covered by 1 + §6.3's multi-signal, `spawnSync`-error =
   keep). Optionally serialize the reconnect reconcile against known in-flight git actions.
3. **Move-to-done / trash** (`task.ts:trashTaskById:784`, `shutdown-coordinator.moveTaskToTrash`):
   already moves the card to the Done column and best-effort deletes the worktree
   (`deleteTaskWorktree`) — keep, but (a) never delete the *card/manifest row* (Done is a column, not
   a deletion), and (b) make worktree deletion tolerant/idempotent (already `ok/removed`-shaped,
   `task-worktree.ts:565-607`). Deriving column from git means a card whose branch is merged shows in
   Done even if the move event was lost.
4. **Explicit project removal** (`projects-api.removeProject:158-235`) — keep as the *only* routine
   user-facing hard delete, but route it through **soft-delete** (`.trash/`) too, so an accidental
   click is recoverable.
5. **Shutdown cleanup** (`shutdown-coordinator.ts`) already persists interrupted sessions to disk
   before exit (`persistInterruptedSessions:56-94`) — good; ensure it also flushes
   `agentSessionId`. Honor `--skip-shutdown-cleanup` (test instances).

---

## 9. Migration / back-compat, risks, out-of-scope

**Migration / back-compat**
- `agentSessionId` and `column`-as-hint are additive with defaults → old `board.json` / `sessions.json`
  parse unchanged (`z...default(null)`).
- Reconciliation's **re-adoption** (§6.2 "no card / yes worktree") auto-recovers any project already
  half-wiped by the current bug on the next boot — a migration for existing victims, no manual step.
- Soft-delete `.trash/` is new; a tiny GC (age-out after N days) keeps it bounded.

**Risks / mitigations**
- *Reconcile misclassifies a real deletion as transient* → project lingers greyed-out; acceptable,
  and far better than data loss. GC + explicit remove handle true deletions.
- *Orphan re-adoption creates junk cards* if a user manually `rm`'d a card but left the worktree →
  bounded (only work-column worktrees), clearly badged "recovered," one-click dismiss (which then
  also removes the worktree).
- *Codex id discovery race / `--session-id` collision* → as in §7 (bounded poll; branch strictly
  fresh-vs-resume). 
- *Perf of per-reconnect git scans* → debounce, cache by mtime, cap concurrency (heed the
  shell-init/`spawnSync` freeze warning in `AGENTS.md`).

**Out of scope**
- Native Cline SDK agent durability (already persisted/rehydrated —
  `cline-message-repository.ts`, `runtime-api.ts:211-216`).
- Cross-machine / remote resume (transcripts are host-local).
- Full PR-aware column engine (§4.4 epic) — this design consumes its signal but doesn't build it.
- Copying/mirroring CLI transcripts into `CLINE_HOME` (rejected Option C).

---

## 10. Phased implementation breakdown (ordered, `/fleet-implement`-able cards)

Sequenced so **durability + non-destruction land first** (board robust ASAP), reconciliation next,
sessions last. Each card: scope · acceptance · RED-first tests.

### Phase 1 — Stop the bleeding (make state un-destroyable)

**Card 1.1 — Reconnect prune must never delete durable state.**
- *Scope:* In `resolveWorkspaceForStream` (`workspace-registry.ts:354-435`), remove the
  `removeWorkspaceIndexEntry` + `removeWorkspaceStateFiles` calls on a probe miss; replace with an
  in-memory `unavailable` marking that keeps files. Distinguish `spawnSync` error/timeout (→ keep as
  "unknown") from a positive "dir exists, no `.git`" result.
- *Accept:* A project whose `hasGitRepository` returns false on a connect is NOT removed from
  `index.json`; its `board.json`/`sessions.json` remain on disk; it reappears once the probe passes.
- *Tests (RED):*
  - **Unit** `workspace-registry.test`: `resolveWorkspaceForStream` with a stubbed
    `hasGitRepository → false` leaves `listWorkspaceIndexEntries()` and state files intact; with
    `pathIsDirectory → false` (transient) likewise. A `spawnSync`-throw path is classified keep.
  - **BDD/surface**: reconnect the runtime-state websocket while `hasGitRepository` is stubbed to
    flip false→true; assert the project is present in the post-connect snapshot and no
    `removeWorkspaceStateFiles` was called (spy).

**Card 1.2 — Harden `hasGitRepository` against transient failure.**
- *Scope:* `cli.ts:239-247` — treat non-zero exit vs spawn error/timeout differently; add a bounded
  retry; return a tri-state (`yes`/`no`/`unknown`) surfaced to the registry.
- *Accept:* A single transient git failure yields `unknown` (kept), only a stable non-repo yields
  `no`.
- *Tests (RED):* unit with a fake `spawnSync` returning status≠0 once then 0 → `yes`; ENOENT git →
  `unknown`; real non-git temp dir → `no`.

**Card 1.3 — Soft-delete instead of `rm` for explicit removal.**
- *Scope:* `removeWorkspaceStateFiles` (`workspace-state.ts:628`) moves the workspace dir to
  `<CLINE_HOME>/kanban/.trash/<id>-<ts>/` instead of unlinking; add `.trash` GC.
- *Accept:* `removeProject` leaves a recoverable copy; index entry gone but files retrievable.
- *Tests (RED):* unit — after `removeWorkspaceStateFiles`, the `.trash` copy exists and original path
  is gone; GC removes entries older than the threshold.

### Phase 2 — Reconciliation (self-healing board)

**Card 2.1 — Worktree/branch scanner + derive-column helper (pure).**
- *Scope:* New `workspace/board-reconcile.ts`: `scanTaskWorktrees(repoPath)`,
  `deriveColumnFromGit(taskId, baseRef)` (merged→Done, worktree-exists→in_progress/review, else
  backlog/hint).
- *Accept:* Given a temp git repo with a task worktree and a merged branch, returns the right derived
  column; missing worktree → hint fallback.
- *Tests (RED):* unit over a temp git repo (create worktree, merge branch, assert classification).

**Card 2.2 — `reconcileWorkspace` (repair-only) + boot wiring.**
- *Scope:* Implement the §6.2 classification (union of manifest cards + on-disk worktrees), producing
  a repaired board without ever dropping a card; re-adopt orphan worktrees as "recovered" cards. Call
  it in `ensureTerminalManagerForWorkspace` hydration and (repair-only) in `resolveWorkspaceForStream`.
- *Accept:* Manifest-with-no-worktree keeps the card (marked needs_attention if in a work column);
  worktree-with-no-card produces a recovered card; healthy pairs recompute column from git. Idempotent
  (second run = no change).
- *Tests (RED):*
  - **Unit**: four-quadrant table (§6.2) over temp repo + fake manifest.
  - **BDD/surface**: simulate the incident — delete the board card rows but leave worktrees; boot /
    connect; assert the snapshot shows recovered cards in the correct columns and files were rewritten,
    not deleted.

**Card 2.3 — Multi-signal durable-absence gate.**
- *Scope:* Only mark a project for (soft) removal after N consecutive `no` results over a grace
  window; `unknown`/transient resets the counter.
- *Accept:* One-off false never soft-deletes; a genuinely deleted repo soft-deletes after the window.
- *Tests (RED):* unit with a fake clock/probe sequence.

### Phase 3 — Durable sessions (resume by id)

**Card 3.1 — Persist `agentSessionId` on the summary schema.**
- *Scope:* `api-contract.ts:282` add `agentSessionId: z.string().nullable().default(null)`; ensure
  `hydrateFromRecord`/`updateSummary` round-trip it (`session-manager.ts`).
- *Accept:* `sessions.json` with and without the field both parse; value survives hydrate.
- *Tests (RED):* schema round-trip unit; `hydrateFromRecord` preserves id.

**Card 3.2 — Transcript locator util.**
- *Scope:* New `terminal/agent-transcript-locator.ts` (claude glob, codex rollout, dispatch).
- *Tests (RED):* temp-`HOME` unit for present/absent per agent kind.

**Card 3.3 — Adapters resume-by-id + claude `--session-id` at spawn.**
- *Scope:* `agent-session-adapters.ts` — claude fresh `--session-id <id>`, resume `--resume <id>`;
  codex resume `resume <id>`; strict fresh-vs-resume branching; others heuristic fallback.
- *Tests (RED):* argv assertions per agent for fresh/resume/no-id.

**Card 3.4 — Session manager: mint/capture id, lifecycle, no-clear on stale.**
- *Scope:* `startTaskSession` mints/reuses id and passes it; codex post-spawn capture via bounded poll;
  `recoverStaleSession` computes `attached`/`resumable`/`gone` and keeps `agentSessionId`
  (`session-manager.ts:295,705`).
- *Tests (RED):* id persisted on start; stale-recover keeps id and yields lifecycle; codex-capture
  timeout falls back.

**Card 3.5 — Resume routing + UI.**
- *Scope:* `runtime-api.startTaskSession` (`:168`) passes stored id + resume intent; UI offers Resume
  (`resumable`) / Start-fresh (`gone`) in `use-task-sessions` / `board-card`.
- *Tests (RED):* tRPC surface — second start for same taskId with `active` cleared resumes by id
  (argv spy), not fresh; hook test — resumable card issues resume mutation, gone card offers fresh.

### Phase ordering rationale
Phase 1 alone makes the board **safe to dogfood** (the incident cannot recur). Phase 2 makes it
**self-healing** (past victims recover, git drift repairs). Phase 3 restores **session continuity**.
Ship 1 → 2 → 3; each phase is independently valuable and independently testable.
