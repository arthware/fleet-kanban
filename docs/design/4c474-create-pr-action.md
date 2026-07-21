# Create PR action — kill auto-review injection, split into skill + deterministic runtime action

- **Card:** `4c474` (no external issue set → the card id is the filename ref)
- **Slug:** `create-pr-action` (formerly `auto-review-pr-reliability`; the `/fleet-*` skills
  reference this path)
- **Disposition:** split into build cards. This doc is the spec; the work is three reviewable
  slices (skill, remove-injection, runtime Create-PR action) sequenced below.
- **Status:** design — no product code changed by this card.

---

## 1. Problem

The board currently "ships" a card's work through a **prompt-injection** pipeline that has been a
recurring source of flakiness:

- `web-ui/src/hooks/use-review-auto-actions.ts` is a browser-side state machine that watches Review
  cards, *arms* on observed `changedFiles`, debounces (`AUTO_REVIEW_ACTION_DELAY_MS = 500`), guards
  against blocked/needs-input sessions, and then **types a commit/PR instruction into the live agent
  PTY** (or the Cline chat) via `runTaskGitAction` in `use-git-actions.ts:223-342`.
- The instruction text is a **prompt template** stored in runtime config
  (`commitPromptTemplate` / `openPrPromptTemplate`, `runtime-config.ts:70-111`) and interpolated by
  `build-task-git-action-prompt.ts`. The agent is then asked to do the git plumbing *itself*
  (cherry-pick onto the base worktree, resolve `.git/index.lock`, push, `gh pr create`, …).

Everything about this is fragile because it couples a **mechanical git operation** to:

1. a **live PTY / chat session** that must still be alive and unblocked (a card whose session ended,
   errored, or is waiting on a permission prompt silently never ships);
2. **browser-side arming state** (`awaitingCleanActionByTaskIdRef`, debounce timers, `no-retry`
   bookkeeping) that resets on reload and races with the metadata poll;
3. the **agent's own reliability** at executing a multi-step destructive git recipe (cherry-pick +
   stash + lock handling) that has nothing to do with the card's actual task.

The failure mode we keep paying for: work *is* done, but shipping it depends on a chain of
non-deterministic conditions, so cards sit in Review un-PR'd, or the agent gets re-prompted and
thrashes, or the auto-advance marches a card toward Done on stale signals.

We also now have a **shipped skill system** (`1b458d7`): each task worktree gets `.agents/skills/`
(symlinked to the canonical skills dir) and a card can pin a skill via `skill:` frontmatter, which
injects a one-line pointer while the agent loads the `SKILL.md` body natively. This gives us the
right home for *process guidance* and lets us stop injecting the recipe as config-templated PTY text.

---

## 2. Proposal (the decision, restated)

Kill auto-PR and the whole auto-review injection ceremony. Replace it with two clean halves:

### Part A — the commit/ship *process* is a skill, not board injection

Author a **`fleet-ship` skill** (`.agents/skills/fleet-ship/SKILL.md`) whose body is the
commit-cadence + create-PR recipe: *commit `save-work` regularly during the task; when done, if the
repo is PR-capable, run the **Create PR** action; on a local-only repo just leave the committed work
in place.* This is short process guidance, discovered natively and optionally pinned per card. It is
the **single source of the recipe** — it supersedes `commitPromptTemplate` / `openPrPromptTemplate`.

### Part B — shipping is a deterministic, capability-gated **Create PR** runtime action

The board and CLI expose one mechanical action — a button and `fleet task pr <id>` — that does the
git push + `gh pr create` **in the runtime**, not through the agent's PTY. It is shown **only when a
PR workflow is actually possible** (origin remote + authenticated `gh` + resolvable base ref). No
prompt injection, no debounce, no `changedFiles` arming, no live-PTY dependency, no auto-anything.

So: a card reaches Review already carrying committed work (the agent committed as it went, guided by
the skill); shipping a PR is an explicit human-click or CLI-triggered runtime action.

```
BEFORE                                              AFTER
────────────────────────────────────────────       ─────────────────────────────────────────────
agent works ──▶ browser arms on changedFiles        agent works, commits as it goes (fleet-ship
           ──▶ debounce 500ms                        skill guidance) ──▶ card lands in Review with
           ──▶ types template into live PTY           commits already durable
           ──▶ agent runs cherry-pick/stash/push
           ──▶ agent runs gh pr create               human clicks "Create PR" (or `fleet task pr`)
           ──▶ auto-advance to Done                   ──▶ runtime: push origin + gh pr create
                                                       ──▶ persist prUrl/prState/prNumber; card
   (any broken link ⇒ card never ships)                   stays in Review; human merges
```

---

## 3. Part A — the `fleet-ship` skill

### 3.1 Shape — single `fleet-ship` (recommended) vs split

**Recommendation: a single `fleet-ship` skill.** The commit cadence and the "now create the PR"
step are one continuous narrative for the agent ("save often; when done, ship if you can"). Splitting
into `fleet-commit` + `fleet-pr` doubles the frontmatter and the pin bookkeeping for no clarity gain —
the PR half is two sentences. Keep it one file; revisit only if a card ever needs commit-cadence
guidance *without* the ship step (none foreseen).

### 3.2 Content (canonical skills dir, mirroring `fleet-smoke`)

`.agents/skills/fleet-ship/SKILL.md`:

```markdown
---
name: fleet-ship
description: use while working any build/impl card — commit your work as you go, then create a PR if the repo supports one
---

Commit as you work. After each meaningful, self-consistent step, stage and commit with
`git add -A && git commit` and a semantic-commit subject (`feat:`, `fix:`, `refactor:`, …). Do not
wait until the end to save — a card should reach Review with its work already committed on the
worktree branch, so nothing is lost if the session ends.

Do not run destructive git commands (`git reset --hard`, `git clean -fdx`, `git worktree remove`,
`rm`/`mv` on repo paths). Do not touch the base worktree.

When the task is done and your work is committed, ship it:
- **If the repo is PR-capable** (an `origin` remote exists and `gh` is authenticated), create the
  pull request with the **Create PR** action — click **Create PR** on the card in Review, or run
  `fleet task pr <card-id>`. This runs the push + `gh pr create` deterministically in the runtime;
  you do not run those commands yourself.
- **If the repo is local-only** (no origin / no `gh`), just leave the committed work on the branch
  and say so. There is nothing to push.

Leave the card in Review. A human reviews and merges the PR.
```

Notes:
- It names the **runtime action** (button / `fleet task pr`) rather than telling the agent to run
  `git push` + `gh pr create` — the whole point is that the mechanical step is deterministic and
  agent-independent. If an agent *does* run the commands directly it's harmless (the action is
  idempotent — it returns the existing PR), but the skill steers toward the deterministic path.
- No cherry-pick-onto-base recipe. That was an artifact of the detached-HEAD commit template; the
  Create PR action owns branch/push mechanics now (§5).

### 3.3 How `/fleet-plan` and `/fleet-implement` reference it

- `.agents/skills/fleet-plan/SKILL.md` currently ends with a hand-rolled `gh pr create --base
  production-line`. Replace that final step with: *"commit the design doc, then create the PR with the
  Create PR action (`fleet task pr <card-id>` or the board button); it no-ops gracefully on a
  local-only repo."* This routes plan cards through the same deterministic primitive.
- The `/fleet-implement` skill's final step likewise calls the Create PR action instead of describing
  git/gh by hand. Whether it **embeds** the two-line ship instruction or **references `fleet-ship`
  by name** is a wording choice; **recommendation: reference `fleet-ship` by name** from both
  `fleet-plan`/`fleet-implement` so the recipe lives in exactly one file. (Native cross-skill
  discovery is not guaranteed for every agent harness, so an explicit by-name reference in the
  loaded skill is the reliable path — not relying on the agent to auto-scan `.agents/skills/`.)

### 3.4 Pinning vs native discovery

**Recommendation: do not auto-pin `fleet-ship` on every card.** Cards that already run under
`/fleet-implement` or `/fleet-plan` get the ship step through those skills (§3.3). The `skill:`
frontmatter pin (`runtime-api.ts:210-213`, one-line pointer injection) stays available for bespoke
cards that want to force it. This keeps the default launch prompt clean and avoids a second pointer
line on every card.

---

## 4. Part B — what to remove (kill the injection)

All of the following is dead once the Create PR action (§5) lands. Recommended fate is **delete +
tolerate legacy data**, not "keep inert" — the injection substrate is exactly the flaky surface we're
retiring, and leaving it inert invites re-wiring. `zod` object schemas strip unknown keys by default,
so deleting fields keeps old `board.json` / `config.json` loading without a migration script.

### 4.1 Browser auto-review engine — delete

- **Delete `web-ui/src/hooks/use-review-auto-actions.ts`** entirely (the debounce/arming/no-retry
  state machine).
- Remove its call site and the `runAutoReviewGitAction` wiring: `use-git-actions.ts:582-587`
  (`runAutoReviewGitAction`), the `taskGitActionLoadingByTaskId` "auto"/"agent" source plumbing that
  only auto-review used, and the `use-board-interactions` hookup that feeds it
  `sessionsByTaskId` / `requestMoveTaskToTrash`.
- The **agent-source** commit/PR injection (`handleAgentCommitTask` / `handleAgentOpenPrTask`,
  `use-git-actions.ts:437-449`, and `TaskGitActionSource = "card" | "agent"`) goes with it — those
  exist only to type templates into the session.

### 4.2 The template-injection path in `use-git-actions.ts` — delete

- Delete `runTaskGitAction`'s prompt-injection body (`:279-327`): `buildTaskGitActionPrompt`, the
  `sendTaskChatMessage` / `sendTaskSessionInput` typing, the 200 ms paste-then-`\r` dance.
- Delete `build-task-git-action-prompt.ts` and its tests.
- `handleCommitTask` / `handleOpenPrTask` (`:344-356`) are repurposed: **Open PR** becomes the
  Create PR action calling the new runtime mutation (§5). A standalone **Commit** button is no longer
  needed on Review cards (the agent commits via the skill); remove it. (`runImplementHereAction`,
  `:364-435`, is unrelated and stays.)

### 4.3 Runtime-config prompt templates — delete + migrate

Retire the recipe source in `runtime-config.ts`:
- Remove `commitPromptTemplate` / `openPrPromptTemplate` (+ `…Default`) from
  `RuntimeConfigState`, `RuntimeConfigUpdateInput`, `RuntimeGlobalConfigFileShape`, the
  `DEFAULT_*_TEMPLATE` constants (`:70-111`), and every read/write/normalize/equality path
  (`toRuntimeConfigState`, `writeRuntimeGlobalConfigFile`, `updateRuntimeConfig`,
  `updateGlobalRuntimeConfig`, `createRuntimeConfigStateFromValues`).
- Remove the corresponding contract fields and the **settings UI** that edits them (the
  commit/PR template editors in the settings dialog — grep `commitPromptTemplate` in `web-ui`).
- Migration: old `config.json` files may carry the two keys; they're simply ignored on read
  (unknown-key stripping). No rewrite needed.

### 4.4 Auto-review settings + CLI flags + frontmatter key — remove outright

- Contract: remove `autoReviewEnabled` / `autoReviewMode` (`api-contract.ts:198-199`), the
  `runtimeTaskAutoReviewModeSchema` if now unused, and the mutation plumbing
  (`task-board-mutations.ts:24-25,39-40,342-343,683-684`).
- CLI: remove `--auto-review-enabled` / `--auto-review-mode` from `task create` and `task update`
  (`task.ts:1599-1600,1658,1702-1703,1756`) and the `parseAutoReviewMode` helper.
- Markdown card: remove the `auto-review` frontmatter key
  (`task-card-frontmatter.ts` `KNOWN_FRONTMATTER_KEYS`, the `ParsedTaskCard.autoReviewMode/Enabled`
  fields) and the **`### auto-review defaults to pr`** section in `docs/card-authoring.md:85-90` and
  the flags table row (`:73`).
- Board card UI: remove `cancelAutomaticActionLabel` / `onCancelAutomaticAction`
  (`board-card.tsx:489-490,1049-1062`) and `getTaskAutoReviewCancelButtonLabel`,
  `resolveTaskAutoReviewMode`, `TaskAutoReviewMode` from `web-ui/src/types` once unreferenced.
- Legacy cards with `autoReviewEnabled` in `board.json` load fine (fields stripped). They get the
  Create PR button from the new column/capability gate, so no behavior is lost (§5.7 backfill).

---

## 5. The Create PR action (runtime-side, deterministic)

One primitive, shared by the board button and `fleet task pr <id>`. It lives in the **runtime**, so
it does not depend on a live session.

### 5.1 Where it lives

- **New runtime module** `src/workspace/create-task-pr.ts` — the git/`gh` mechanics, pure and
  unit-testable with an injectable runner (mirror `card-pr-url.ts`'s `GhRunner`/`execFile` shape).
- **New tRPC mutation** `workspace.createTaskPr` in `workspace-api.ts` (next to `runGitSyncAction`,
  `discardGitChanges`), resolving the worktree via `resolveTaskCwd` and persisting the result via the
  same `persistCardPr` path the metadata monitor uses (`runtime-state-hub.ts:159` → `setCardPrUrl`).
- **CLI** `task pr <id>` in `src/commands/task.ts`, surfaced through the dispatcher as
  `fleet task pr <id>` (the dispatcher already forwards `fleet task …` → `kanban task …`; no new
  dispatcher case). *(Naming: the card called this `fleet create pr`; `fleet task pr <id>` fits the
  existing `fleet task <verb>` surface and the kanban `task` command family — **recommended**. If we
  prefer the literal `fleet create pr`, that needs a new top-level dispatcher case; not worth it.)*

### 5.2 Capability probe — the "PR workflow is possible" gate

A cheap probe decides whether the offer appears at all:

1. `origin` remote exists — `git -C <worktree> remote get-url origin`.
2. `gh` present and authenticated — `gh auth status` (bounded timeout, like `card-pr-url.ts`'s
   5 s cap).
3. base ref resolvable — `card.baseRef` resolves (`git rev-parse --verify`).

If any fail → **no offer** on the button, and the CLI/mutation returns a clear *"PR not available
here"* with the specific reason.

**Where the gate is evaluated (recommendation):** surface a **workspace-scoped** `prWorkflowCapable`
boolean (origin + `gh auth`) computed once per workspace with a short TTL cache, exposed on the data
the board already fetches (runtime config / workspace info) so the button can gate without a
per-card `gh` call on every render/poll. Base-ref resolvability is per-card but cheap and local. The
**click-time** action re-runs the full probe and surfaces precise errors — the flag is only for
showing/hiding the button, the action is the source of truth. This avoids re-introducing a per-card
`gh` fan-out (the very cost `card-pr-url.ts` already guards against).

### 5.3 PR target (base) branch — default to what the worktree was cut from

The PR **targets `card.baseRef` by default** — the branch the worktree was created off. `baseRef` is
already the per-card record of exactly that: `docs/card-authoring.md` defines `base-ref` as optional,
**defaulting to the current branch at card-creation time**, and it is what `resolveTaskCwd` and the
worktree-creation path use. So the default target needs **no new state** — the action passes
`card.baseRef` straight to `gh pr create --base <baseRef>`.

Rules:
- **`baseRef` must resolve to a branch name, not a detached SHA.** `gh pr create --base` only accepts
  a branch. In normal cards `baseRef` *is* a branch ("the current branch" at creation), but the
  capability probe (§5.2) and the action validate it (`git rev-parse --verify --abbrev-ref`) and fail
  with a clear message if a card was created off a raw commit — rather than pushing a PR at the wrong
  target.
- **`baseRef` must exist on `origin`.** Within the fork, `origin` is `arthware/fleet-kanban` and the
  PR is head=`<branch>` → base=`baseRef`, both on origin; for a consumer repo (e.g. leapter) origin
  is that repo. The probe treats a base ref that is missing on origin as *not PR-capable* with a
  precise reason.
- **Optional override.** `fleet task pr <id> --base <branch>` (and a corresponding mutation arg) lets
  a caller retarget when needed; **default is always `card.baseRef`** — no override required for the
  common case. This is also how `fleet-plan` should stop hardcoding `production-line`: it just runs
  the Create PR action and inherits the card's `baseRef`.

### 5.4 Algorithm (button and CLI share it)

1. **Probe** capability (§5.2); bail with a clear message if not capable.
2. **Resolve** worktree (`resolveTaskCwd`), base ref (`card.baseRef`, §5.3), and branch name
   `<issueRef-or-cardId>-<slug>` (aligns with the branch convention from card `36ab1`; **reuse** the
   branch if it already exists). If HEAD is detached, create/checkout that branch at HEAD.
3. **Assume the agent already committed** (per `fleet-ship`). If uncommitted changes remain, commit
   them with a fallback message derived from the card title (`chore: <title>` style) so nothing is
   dropped — but this is the exception, not the path.
4. `git push -u origin <branch>` — **origin only** (the fork; never `upstream`). Then
   `gh pr create --base <baseRef> --head <branch>`. **Idempotent:** if a PR already exists for that
   head/base, return/update it instead of erroring (reuse `resolveCardPrUrl` / `gh pr list --head`
   from `card-pr-url.ts` to detect-then-return).
5. **Persist** `prUrl` / `prState` / `prNumber` on the card via the existing
   `persistCardPr` → `setCardPrUrl` path, and broadcast the board update. The card renders the
   existing `PrBadge` / "Show PR" link (`pr-badge.tsx` — already built). **Card stays in Review**; a
   human merges.
6. **Errors surface, never swallowed** — push rejected, `gh` not authed, base gone → returned to the
   button (toast) and the CLI (non-zero exit + message).

### 5.5 Button — repurpose, don't add

- `board-card.tsx:1033-1046` "Open PR" becomes **Create PR**, calling the new runtime mutation via
  `handleOpenPrTask` (rewired to `workspace.createTaskPr`), not the injection path.
- **Gate change (important):** today `showReviewGitActions = columnId === "review" && changedFiles >
  0` (`board-card.tsx:481`). Under the new model the agent has *already committed*, so a shippable
  card typically has **`changedFiles === 0`** (clean worktree, commits ahead of base). The button
  must therefore show on **`columnId === "review" && prWorkflowCapable`** — not gated on
  uncommitted `changedFiles`. The action itself handles "nothing to ship" gracefully (idempotent /
  clear message), so we don't need an "ahead of base" count to decide visibility; keep it simple.
  Remove the standalone **Commit** button (§4.2).
- If a PR already exists on the card (`prUrl` set), the badge shows and the button reads **Show PR**
  / re-runs idempotently.

### 5.6 CLI `fleet task pr <id>`

- Resolves the card by id in the current project, runs the same runtime action, prints the PR URL on
  success or the capability/plumbing error on failure (non-zero exit). No-ops with a clear message on
  a local-only repo — so a `/fleet-implement` card's final `fleet task pr` step is safe everywhere.

### 5.7 Backfill

Cards **already in Review with committed work** get the Create PR button **immediately** — the gate
is `review + prWorkflowCapable`, independent of any per-card auto-review arming state (which is being
deleted). No migration; the button simply appears for them on next render.

---

## 6. Key decisions (resolved)

| Question | Decision | Why |
|---|---|---|
| Skill shape | **Single `fleet-ship`** | Commit + ship is one narrative; splitting doubles bookkeeping for a two-sentence PR half. |
| Cards pin the skill? | **No auto-pin**; `fleet-plan`/`fleet-implement` reference it by name; `skill:` pin stays available | Keeps default prompt clean; explicit by-name reference is the reliable path (no reliance on auto-scan). |
| Fate of `commit`/`openPr` templates | **Delete + tolerate legacy keys** | Skill owns the recipe; unknown config keys are stripped on read — no migration. |
| Capability probe location | **Workspace-scoped `prWorkflowCapable` flag (cached) gates the button; click-time action re-probes and owns errors** | Avoids per-card `gh` fan-out; action stays the source of truth. |
| Fate of `autoReviewEnabled`/`autoReviewMode` + CLI flags + `auto-review` frontmatter | **Remove outright**; legacy `board.json` fields stripped on load | Injection substrate is the flaky surface we're retiring; zod stripping makes removal safe. |
| CLI name | **`fleet task pr <id>`** (not top-level `fleet create pr`) | Fits `fleet task <verb>` + kanban `task` family; no new dispatcher case. |
| PR target (base) branch | **Default to `card.baseRef`** — the branch the worktree was cut from; validate it is a branch (not a SHA) and exists on origin; `--base` override available | Matches operator preference; `baseRef` already records the creation branch, so zero new state. |
| Button gate | **`review && prWorkflowCapable`**, not `changedFiles > 0` | Agent already committed → clean worktree; gating on uncommitted changes would hide the button on exactly the cards that should ship. |

---

## 7. Risks

- **Detecting "shippable"** without an ahead-of-base count: we deliberately show the button on any
  capable Review card and let the idempotent action report "nothing to push." Risk: a Review card
  with genuinely zero commits shows a button that no-ops. Acceptable — clearer than hiding it and
  cheaper than an extra per-card `git rev-list` on every poll. Revisit if noise appears.
- **`gh auth` latency** on the capability probe: bound it (5 s, as `card-pr-url.ts` does) and cache
  the workspace flag; never run it inline on a render path.
- **Removing the settings-UI template editors** touches a settings surface some users may have
  customized. Mitigated: the config keys are ignored, not errored; the UI just no longer exposes
  them. Call it out in the PR description.
- **`fleet-plan` base ref** is hardcoded to `production-line` in the current skill, while kanban's
  own base is `main`. The Create PR action uses **`card.baseRef`** (§5.3), so the target is data, not
  a hardcode — the skill should drop the literal `--base production-line` and inherit the card's
  `baseRef`. Verify plan cards carry the intended `baseRef` so the PR targets the right branch, and
  that `baseRef` is a branch name (a card created off a detached SHA is rejected by the probe, §5.3).
- **Upstreamability:** deleting `autoReview*` from the contract is a fork-visible change. Keep the
  removal mechanical and well-described so a rebase on `upstream` is clean; the skill files are
  fork-local additions (`.agents/skills/`) and don't conflict.

---

## 8. Test strategy

- **`create-task-pr.ts` unit tests** (base config, injectable `gh`/`git` runner like
  `card-pr-url.test`): capability probe pass/fail per condition; detached-HEAD → branch creation;
  branch reuse; idempotent existing-PR return; origin-only push (never `upstream`); error surfacing.
- **`workspace.createTaskPr` tRPC test**: resolves worktree, persists `prUrl/prState/prNumber` via
  `setCardPrUrl`, broadcasts; not-capable returns a clean error.
- **CLI `task pr` test**: success prints URL; local-only no-ops with message + right exit code.
- **Removal regressions**: `task create`/`update` reject the removed `--auto-review-*` flags;
  markdown card rejects the `auto-review` key; legacy `board.json`/`config.json` with the old fields
  still load (fields stripped).
- **web-ui**: `board-card` shows **Create PR** on `review && prWorkflowCapable` (incl. `changedFiles
  === 0`); hidden when not capable; renders `PrBadge` when `prUrl` set. Delete
  `use-review-auto-actions` and `build-task-git-action-prompt` tests with their modules.
- Scope the gate to the change surface per repo testing rules: CLI/runtime slices →
  `npm run typecheck` + `npm run test:fast` + touched files; web-ui slice → `web-ui` typecheck +
  targeted `web:test`. No full `npm run build` on the inner loop; no root `vitest`.

---

## 9. Build slices (suggested cards)

1. **`fleet-ship` skill + rewire `fleet-plan`/`fleet-implement`** (docs/skill only; no product code).
   Small, independent, immediately useful.
2. **Create PR runtime action** — `create-task-pr.ts` + `workspace.createTaskPr` + `task pr` CLI +
   `prWorkflowCapable` flag. The deterministic primitive; lands before the deletion so nothing is
   ever without a ship path.
3. **Remove the injection** — delete `use-review-auto-actions`, the template path, runtime-config
   templates, `autoReview*` contract/CLI/frontmatter, and repurpose the button gate. Depends on #2.

## Prior art (read with `git show <sha>` before starting)
- `1b458d7` — skill delivery: `.agents/skills/` per worktree + `skill:` frontmatter + one-line
  pointer (the mechanism Part A rides on; `fleet-smoke` is the example to mirror for `fleet-ship`).
