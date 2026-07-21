# Auto-archive stale cards (age + PR-state aware)

**Card:** `a9f26` · **Status:** plan (design only) · **Date:** 2026-07-21

## Problem & symptom

Cards that never land pile up on the board forever. A review card whose PR was closed without
merging, or a card abandoned days ago, just sits in its lane — the operator has to hand-trash each
one, and the board fills with noise that makes the live lanes hard to read. There is no automatic
housekeeping.

The bug this closes: **stale/resolved cards never settle on their own.** We want the board to settle
them *correctly* — work that landed → **Done**, work that was abandoned → **Trash** — and **never the
reverse** (Done is durably-landed-only; see `5f85928`).

## What already exists (don't rebuild it)

Half of this is already shipped. The workspace metadata monitor
(`src/server/workspace-metadata-monitor.ts`) polls each connected workspace, resolves each review
card's PR via `gh` (throttled), and persists `prUrl`/`prState`/`prNumber` onto the card. When it
persists a **terminal** PR state, `applyPersistedCardPrToBoard`
(`src/server/runtime-state-hub.ts:106`) already moves the card:

```ts
// runtime-state-hub.ts:116-126 (existing)
if (pr.state !== "merged" && pr.state !== "closed") return result;
if (previousColumnId !== "in_progress" && previousColumnId !== "review") return result;
const targetColumnId = pr.state === "merged" ? "done" : "trash";
const moved = moveTaskToColumn(result.board, taskId, targetColumnId);
```

So **PR mode is done**: merged→Done, closed-without-merge→Trash, driven by real PR state off the
existing cached/throttled path (`63c62a0`), with no new `gh` traffic. This design must **reuse** that,
not duplicate it.

**The remaining gaps this card closes:**

1. **Commit-mode (no PR) stale review cards never settle.** A card completed with `autoReviewMode:
   "commit"` (default — `task-board-mutations.ts:50`) has no PR to check, so `applyPersistedCardPrToBoard`
   never fires. It sits in review indefinitely. This is the net-new behavior.
2. **No configurable knob** to enable/disable/tune the housekeeping.
3. (Decision, below) Whether an **open PR past N days** ever forces a resolution — argued as *no*.

## Investigation — the mechanism, cited to code

- **Where cards live and move.** `RuntimeBoardData` → columns `backlog | in_progress | review | done
  | trash` (`api-contract.ts`). `moveTaskToColumn` (`task-board-mutations.ts:534`) is the single move
  primitive; it stamps `updatedAt = now` and appends a `{column, at}` transition
  (`:598-606`). `now` is injectable → testable.
- **The age clock is already on the card.** Every card carries `createdAt`, `updatedAt`, and
  `transitions: [{column, at}]` (`api-contract.ts:220-227`). `getTaskStartedAt`/`getTaskCompletedAt`
  read transitions (`task-lifecycle.ts:22-40`). We can read *"entered review at"* for free — no git,
  no subprocess.
- **PR state is already on the card.** `card.prState` ∈ `open | merged | closed`, `card.prUrl`
  (`api-contract.ts:216-218`), refreshed by the monitor with `PR_STATE_REFRESH_MIN_MS = 60_000` for
  stored-open PRs and `PR_RESOLVE_RETRY_INTERVAL_MS = 30_000` for review-cards-without-a-PR-yet
  (`workspace-metadata-monitor.ts:16-20`). The archival decision reads these **already-persisted
  fields** — it must never shell to `gh` itself.
- **Live-session state lives in the hub.** `RuntimeTaskSessionState = idle | running | awaiting_review
  | failed | interrupted` and `pid: number | null` (`api-contract.ts:346`). The hub already holds the
  latest summary per task (`clinePreviousSummaryByWorkspaceId`, `trackTerminalManager`/
  `trackClineTaskSessionService` — `runtime-state-hub.ts:133,579-624`). A card is **live** when its
  summary `state === "running"` (or PTY `pid != null`).
- **Trash is reversible; the worktree survives.** Moving to trash is a pure board move — no worktree
  deletion (`trashTaskAndGetReadyLinkedTaskIds`, `task-board-mutations.ts:474`). The worktree is only
  removed by the **explicit, dialog-gated** "clear trash" (`use-board-interactions.ts` →
  `cleanupTaskWorkspace`). Restore re-ensures the worktree and resumes (`resumeFromTrash: true`,
  `:606-616`). So an auto-trash is exactly as recoverable as a manual one — same guarantee
  `applyPersistedCardPrToBoard`'s closed-PR→trash already relies on.
- **The freeze failure mode.** `cf853c0` froze the runtime by fanning **unbounded** cleanup work per
  card; `453238d` established the mtime-gated idle-vs-active scan and the 5 s subprocess bound
  (`GH_COMMAND_TIMEOUT_MS = 5_000`, `card-pr-url.ts:9`). Our sweep must stay inside those rails.

## Proposal

Add an **age-based archival pass** to the existing monitor tick — **not a new scheduler, not a new
subprocess.** The pass is pure in-memory (reads `card.transitions` + `card.prState` already loaded),
throttled to a slow cadence, gated by config and live-session state, and it archives through the
**existing** mutation path.

### Where it lives

Extend `workspace-metadata-monitor.ts`. It already: iterates tracked tasks per workspace, runs on an
unref'd 1 s timer **only while a client is subscribed**, bounds its subprocesses, and owns the
injectable `persistCardPr`/`resolveCardPr` deps wired from the hub. Adding a sibling
`archiveStaleCards(entry)` step to `refreshWorkspace` (after the PR capture, `:498`) reuses all of that.

Two new injected deps (same pattern as `resolveCardPr`/`persistCardPr`), wired from the hub which owns
config + liveness:

```ts
interface CreateWorkspaceMetadataMonitorDependencies {
  // ...existing...
  isTaskSessionLive?: (workspaceId: string, taskId: string) => boolean;   // hub reads its summaries
  archiveStaleCard?: (capture: { workspaceId; workspacePath; taskId }) => Promise<void>; // → trash
  loadAutoArchiveConfig?: (workspacePath: string) => Promise<AutoArchiveConfig>;  // per-repo config
}
```

`archiveStaleCard` in the hub mirrors `persistCardPr` exactly:

```ts
archiveStaleCard: async ({ workspaceId, workspacePath, taskId }) => {
  const mutation = await mutateWorkspaceState(workspacePath, (state) => {
    const result = trashTaskAndGetReadyLinkedTaskIds(state.board, taskId);   // existing helper
    return { board: result.board, value: result.moved, save: result.moved };
  });
  if (mutation.value) await broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
},
```

### Eligibility filter (a card is archivable when ALL hold)

1. Config `autoArchive.enabled === true` for this workspace.
2. Column is **`review`**. (Not `in_progress`; not `backlog` — argued below. `done`/`trash` are terminal.)
3. **No open PR gating it:** `card.prState` is undefined or not `"open"`. (Open PRs are handled by
   PR-mode / left alone — see decision. Merged/closed are already moved by
   `applyPersistedCardPrToBoard` before this pass would see them.)
4. **No live session:** `isTaskSessionLive(workspaceId, card.id) === false`. This is the cardinal-sin
   guard — belt *and* braces with rule 2.
5. **Stale:** `now - enteredReviewAt >= staleReviewDays` (age clock below).

Result: **move to Trash.** Never Done — a commit-mode card has no PR proving its work landed durably,
so the safe assumption for an untouched-for-N-days review card is *abandoned*. Trash is reversible; if
the operator disagrees they restore it. (This is the same asymmetry `applyPersistedCardPrToBoard`
encodes: only a *merged PR* earns Done.)

### The age clock

`enteredReviewAt` = timestamp of the **last transition into `review`**:

```ts
function getEnteredColumnAt(card, columnId) {
  const t = card.transitions;
  for (let i = (t?.length ?? 0) - 1; i >= 0; i--) if (t[i].column === columnId) return t[i].at;
  return card.updatedAt;   // fallback for pre-transitions cards
}
```

Measures **unresolved time sitting in review** — precisely the staleness the problem describes ("a
review card ... just sits there"). Re-touching the card (agent pushes a fix, operator moves it out and
back) appends a new `review` transition and **resets the clock** — activity correctly defers
archival. Free to compute (already on the card); no git call, so it can't reintroduce the `gh`/git
storm the constraints forbid.

### Bounding

- **Zero new subprocesses.** The decision reads `card.transitions` + `card.prState` in memory. The
  only cost is one locked-file board write per *actually-archived* card, through the same
  `mutateWorkspaceState` path `persistCardPr` already uses.
- **Cadence throttle.** Gate the whole pass per-workspace behind `ARCHIVE_SWEEP_INTERVAL_MS`
  (default 5 min) using a `lastArchiveSweepAt` timestamp on the entry — same shape as
  `PR_STATE_REFRESH_MIN_MS`. It rides the 1 s tick but only *acts* every 5 min.
- **Per-tick cap.** Archive at most `ARCHIVE_MAX_PER_SWEEP` (e.g. 10) cards per sweep; the rest settle
  next sweep. Directly mirrors `cf853c0`'s "bound the fan-out" fix, so a board where 100 cards go
  stale at once can't stampede the write path.
- **Isolation.** Wrap each card's evaluation + archive in try/catch; a failed read/move logs and
  skips that card — never throws out of the tick (matches `captureTrackedCardPrs`' "never throws"
  contract, `:418-420`).

## Config

Per-repo `.cline/kanban/config.json`, a new `autoArchive` block — the exact analog of `worktree`
(`RuntimeProjectConfigFileShape`, `runtime-config.ts:28-31`), loaded the same way and exposed to the
hub/monitor per workspace.

```jsonc
// <repo>/.cline/kanban/config.json
{
  "autoArchive": {
    "enabled": false,      // opt-in (default off)
    "staleReviewDays": 7   // N (default 7)
  }
}
```

- **Schema:** add `runtimeAutoArchiveConfigSchema = z.object({ enabled: z.boolean().optional(),
  staleReviewDays: z.number().int().positive().optional() })` to `api-contract.ts` (additive/optional
  — wire + on-disk compatible), add `autoArchive?` to `RuntimeProjectConfigFileShape` and to
  `RuntimeConfigState`, with `normalizeAutoArchiveConfig` + defaults in `runtime-config.ts`
  (`DEFAULT_STALE_REVIEW_DAYS = 7`, `DEFAULT_AUTO_ARCHIVE_ENABLED = false`).
- **Opt-in, default OFF.** Auto-*moving* cards on a heuristic timer is surprising; ship it opt-in so a
  repo turns it on deliberately. Flipping to opt-out later is a one-line default change once trusted.
  (Note: the *existing* deterministic PR-state settling in `applyPersistedCardPrToBoard` stays
  **always-on** — this config gates only the **new age-based commit-mode** pass. Do not regress the
  shipped PR-mode behavior behind a flag.)
- **Per-repo, not global,** matching `worktree.postCreateCommand` — different repos want different
  staleness tolerances, and the sweep is already per-workspace.

## Key decisions & tradeoffs

| Decision | Choice | Why / tradeoff |
|---|---|---|
| Age clock | `now − enteredReviewAt` (last `review` transition) | On-card, free, resets on re-activity. Alternative "last git commit mtime" is a truer last-work signal but needs a per-card git call — violates the no-storm constraint. `createdAt` ignores time-in-review; `updatedAt` is bumped by any move, muddier. |
| Open PR past N | **Never auto-archive** | An open PR is live, human-reviewable work; trashing it on a timer destroys in-flight work and races review. It settles the moment the PR goes merged/closed via the existing path. A "stale >N" *visual nudge* is possible but out of scope for v1. |
| Backlog eligibility | **No** (review only) | Backlog is an intentional queue of not-yet-started work; auto-trashing queued ideas erases intent and surprises. Also, the monitor deliberately doesn't track backlog (`collectTrackedTasks`, `:106`) — including it would mean polling more cards. Config could extend later. |
| in_progress eligibility | **No** (excluded, live or not) | The cardinal sin. Even an orphaned in_progress card (dead session) is left for the operator; auto-trashing "supposed-to-be-running" work is too risky for v1. |
| Reuse cached PR state vs fresh fetch | **Reuse** `card.prState` | The monitor already refreshes it (throttled). Fetching again per sweep is the `gh` storm the constraints forbid. |
| Monitor tick vs separate timer | **Extend monitor tick** | Reuses iteration, subprocess bounds, injectable deps, mtime gating. A separate scheduler duplicates all of it. |
| Target column for age-archival | **Trash** (never Done) | No PR ⇒ no proof of durable landing (`5f85928`). Trash is reversible; the code, if it landed, is already on base — trashing the card loses nothing. |

## Risks

- **False-positive archival (card mid-work, stale PR ref).** Mitigated by rules 3–4: an `open` PR or a
  `running` session both veto archival; and the clock resets on any re-entry to review.
- **Subscriber-gated sweep.** The monitor timer runs only while a client is subscribed
  (`ensureWorkspaceTimer`/`disconnectWorkspace`). On a board nobody's watching, nothing settles until
  someone opens it — acceptable (the dogfood board is effectively always open). Documented tradeoff; a
  future headless variant could lift the timer to run whenever the workspace is tracked.
- **Clock skew / `Date.now()`** — all timestamps are the server's own `Date.now()`; no cross-host
  comparison, so skew is a non-issue. Keep `now` injectable for tests.
- **Race with a manual move.** `mutateWorkspaceState` is atomic + revision-checked
  (`WorkspaceStateConflictError`); `moveTaskToColumn` no-ops if the card already left review
  (`:559`). Worst case the sweep's write is rejected/no-ops and retries next sweep.
- **Runtime freeze (the `cf853c0` mode).** Guarded: no new subprocess, per-tick cap, per-card
  try/catch, slow cadence.
- **gh rate limits** — untouched: the sweep adds **zero** `gh` calls; PR state is read from the card.

## Implementation outline (single Codex build card)

Small, well-scoped, mostly in two files. RED-first.

1. **Config** — `api-contract.ts`: `runtimeAutoArchiveConfigSchema` (additive). `runtime-config.ts`:
   `autoArchive` on `RuntimeProjectConfigFileShape` + `RuntimeConfigState`, `normalizeAutoArchiveConfig`,
   defaults, load from project config. Expose via the same accessor the hub uses to reach `worktree`.
2. **Pure decision helper** — new `src/core/stale-card-archival.ts`:
   `getEnteredColumnAt(card, columnId)` and
   `isCardArchivable(card, columnId, { staleReviewDays, now, isLive })` → boolean. **Pure, no I/O** →
   trivially unit-testable. (Keep it out of the monitor so it's testable without booting the monitor.)
3. **Monitor** — `workspace-metadata-monitor.ts`: add `isTaskSessionLive`, `archiveStaleCard`,
   `loadAutoArchiveConfig` deps; add `lastArchiveSweepAt` + `ARCHIVE_SWEEP_INTERVAL_MS` +
   `ARCHIVE_MAX_PER_SWEEP`; add `archiveStaleCards(entry)` called from `refreshWorkspace` after PR
   capture; per-card try/catch.
4. **Hub wiring** — `runtime-state-hub.ts`: implement `archiveStaleCard` (mirror `persistCardPr` →
   `trashTaskAndGetReadyLinkedTaskIds` → `mutateWorkspaceState` → broadcast), `isTaskSessionLive`
   (read `clinePreviousSummaryByWorkspaceId` + terminal summaries: `state === "running"`), and
   `loadAutoArchiveConfig`.

No web-ui change required for v1 (the card just moves columns via the existing stream). A settings
toggle in `runtime-settings-dialog.tsx` is a nice follow-up but out of scope.

## Test strategy (RED-first)

**Pure unit — `test/runtime/core/stale-card-archival.test.ts`** (fast, no monitor):
- commit-mode review card, `enteredReviewAt` older than N days, no PR, not live → **archivable**.
- same card **younger** than N (boundary: exactly N vs N−1ms) → **not archivable**.
- review card with `prState: "open"` → **not archivable** (open PR veto).
- review card with a **live** session (`isLive: true`) → **not archivable**.
- card in `in_progress` / `backlog` / `done` → **not archivable** (column filter).
- card with no `transitions` → falls back to `updatedAt`.

**Monitor — extend `test/runtime/server/workspace-metadata-monitor.test.ts`**:
- injects fake `archiveStaleCard`/`isTaskSessionLive`/`loadAutoArchiveConfig`; asserts a stale
  commit-mode review card triggers exactly one `archiveStaleCard` call; a fresh one triggers none.
- `enabled: false` → never archives.
- `ARCHIVE_MAX_PER_SWEEP` cap: 15 stale cards, cap 10 → 10 this sweep, 5 next.
- `archiveStaleCard` rejecting for one card doesn't abort the others (isolation).
- no extra `gh` (`resolveCardPr`) calls attributable to the archival pass.

**Hub — extend `test/runtime/server/runtime-state-hub.test.ts`**:
- `archiveStaleCard` moves the card to trash in `board.json` and broadcasts a workspace-state update.
- `isTaskSessionLive` returns true for a `running` summary, false otherwise.
- (regression) `applyPersistedCardPrToBoard` merged→Done / closed→Trash still passes unchanged.

## Out of scope / open questions

- **Open-PR "stale" visual nudge** (chip past N days) — deferred.
- **Backlog / in_progress-orphan archival** — deferred; config could opt in later.
- **Headless (no-subscriber) sweeping** — deferred; relies on a client being connected for v1.
- **A global (vs per-repo) default** — start per-repo; revisit if repos want a board-wide default.

## Disposition

**Implement in a single Codex build card.** Scope is contained (2 core files touched + 1 new pure
helper + config plumbing), the PR-mode half already ships, and every new piece is unit-testable
RED-first. Hand this doc straight to `/fleet-implement` with `--agent-id codex`. Carry a `## Prior
art` section citing `63c62a0`, `cf853c0`, `453238d`, `d671167`, `5f85928`.
