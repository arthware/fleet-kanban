# Create a named branch at worktree creation (drop detached HEAD)

**Card:** 36ab1 · **Status:** design for review · **Scope:** small, upstreamable (fork of `cline/kanban`)

## Problem

When Kanban starts a task it creates a per-task git worktree checked out on a **detached HEAD**:

```
src/workspace/task-worktree.ts:662
git worktree add --detach <worktreePath> <baseCommit>
```

A branch is only minted *later*, at commit/PR time, by the prompt templates the agent runs:

- `DEFAULT_COMMIT_PROMPT_TEMPLATE` opens with *"You are in a worktree on a detached HEAD"* and
  cherry-picks the task commit onto `{{base_ref}}` (`src/config/runtime-config.ts:70-93`).
- `DEFAULT_OPEN_PR_PROMPT_TEMPLATE` step 2 is literally *"If currently on detached HEAD, create a
  branch at the current commit in this worktree"* before it can push and open a PR
  (`src/config/runtime-config.ts:94-111`).

So every landing pays a **"detached HEAD → invent a branch name → commit → push → PR"** dance, and
the branch name is improvised by the agent at the end instead of being a stable, predictable label
tied to the card. The card you are reading this from is itself on a detached HEAD (`fleet task cat
36ab1` shows `branch: 9593b32`), which is exactly the friction.

**Goal:** a newly-created worktree gets a **named branch immediately at creation**, named
`<issueRef-or-cardId>-<title-slug>` — the same `<ref>` the `docs/design/<ref>-<slug>.md` convention
already uses. The commit/PR flow then pushes/PRs the branch that already exists instead of minting a
second one.

## Why is it detached today? (upstream rationale)

This is a fork of `cline/kanban`; the detached-HEAD choice is upstream's and is deliberate. The
defensible reasons:

1. **Branch-namespace cleanliness.** A board can churn through hundreds of ephemeral task worktrees.
   Detaching means git's `refs/heads/*` namespace is never polluted with a branch per task — `git
   branch` in the base repo stays readable, and there is nothing to garbage-collect when a worktree
   is removed (removing a worktree does *not* delete a branch, so a branch-per-task model
   accumulates dead refs).
2. **Name-the-work-when-you-know-it.** At creation time the "work" is just the prompt; the natural,
   descriptive branch name is only knowable once the change exists. Deferring naming to commit/PR
   time lets the name reflect what was actually done.
3. **Collision avoidance.** No branch means no "a branch named X already exists" / "X is already
   checked out in another worktree" failure on the hot task-start path. Two worktrees can safely
   sit on the same base commit.
4. **The worktree is the unit, not the branch.** Kanban already treats the worktree as authoritative
   (`ensureTaskWorktreeIfDoesntExist` never recreates an existing worktree —
   `src/workspace/task-worktree.ts:591-604`), and durable work is captured as a **patch**
   (`captureTaskPatch`) on delete, not as a branch. The branch was simply not load-bearing.

Our context differs from generic upstream usage: **we name cards after issues/refs and land through
PRs on every card**, so a stable, predictable, card-derived branch name is worth more to us than
namespace minimalism. The change below keeps upstream's guarantees (worktree stays authoritative,
patch capture unchanged, creation still anchored at the base commit) and only swaps `--detach` for a
deterministically-named branch — small and clearly separable, so it stays upstreamable (and could
even be offered upstream behind the same naming helper).

## Investigation — where the pieces live

| Concern | Location |
| --- | --- |
| Worktree creation (the `--detach`) | `src/workspace/task-worktree.ts:662` (and the storedPatch fallback add at `:677`) |
| Genuine-creation gate (idempotency) | `ensureTaskWorktreeIfDoesntExist` short-circuits on existing worktree HEAD — `src/workspace/task-worktree.ts:595-616`; creation only inside the setup lock |
| Per-creation setup | `prepareNewTaskWorktree` — `src/workspace/task-worktree.ts:505-551` (runs once, on genuine creation) |
| Trashed → restored patch path | `findTaskPatch` / `applyTaskPatch`, `baseCommit = storedPatch.commit` — `src/workspace/task-worktree.ts:648-697` |
| Commit/PR prompt templates (late branch creation) | `src/config/runtime-config.ts:70-111` |
| Template interpolation (`{{base_ref}}`) | `web-ui/src/git-actions/build-task-git-action-prompt.ts:53-67` |
| Card fields available | `runtimeBoardCardSchema` — `title`, `externalIssue.key`, `baseRef` — `src/core/api-contract.ts:192-227`; issue shape `:178-184` |
| Card lookup at the ensure boundary | `findBoardCard` — `src/trpc/workspace-api.ts:62-79`; ensure handler `:360-368` |
| Ref/slug selection (already implemented for docs) | `sanitizeDesignDocRef` + `resolveDesignDocRefCandidates` — `src/workspace/design-doc.ts:11-26` |
| Title resolution | `resolveTaskTitle` — `src/core/task-title.ts:44-54` |
| Worktree branch/detached reporting | `getTaskWorkspaceInfo` → `readGitHeadInfo` (`branch`, `isDetached`) — `src/workspace/task-worktree.ts:877-905`, `src/workspace/git-utils.ts:108-117` |

Key structural fact: **creation is already a single, locked, once-only path.** Everything after the
`git worktree add` line is skipped for an existing worktree. So branch-at-creation is a one-line
change *at the point of creation* plus a name computed from the card — idempotency falls out for
free.

## Proposed change

### 1. A shared branch/ref name derived from the card

The `<ref>` half already has a canonical implementation used by the design-doc convention. **Extract
it into one shared module** (e.g. `src/core/task-ref.ts`) so the branch ref and the
`docs/design/<ref>-<slug>.md` ref are computed by the *same* code and can never drift:

- `sanitizeDesignDocRef` and the `externalIssue.key ?? taskId` selection move there;
  `design-doc.ts` imports from it (no behavior change for docs).
- Add `deriveTaskBranchName({ taskId, externalIssueKey, title, prompt })`.

`deriveTaskBranchName` composition:

1. **ref** = `sanitizeDesignDocRef(externalIssueKey)` when an issue key is set, else
   `sanitizeDesignDocRef(taskId)`. This mirrors `resolveDesignDocRefCandidates` exactly (issue ref
   wins; card id is the fallback), so `36ab1-…` when no issue, `ENG-142-…` when the card carries
   `ENG-142`.
2. **slug** = slugify(`resolveTaskTitle(title, prompt)`): lowercase, collapse any run of
   non-`[a-z0-9]` to a single `-`, trim leading/trailing `-`. `resolveTaskTitle` already falls back
   to a prompt-derived title, so an untitled card still yields a meaningful slug.
3. **join + cap**: `` `${ref}-${slug}` ``, then cap the whole name (recommend **≤ 60 chars**,
   trimmed on a `-` boundary, trailing `-` stripped). If the slug ends up empty, use the bare `ref`.
4. **git-ref validity**: the slugify above already restricts to `[a-z0-9-]`, which satisfies
   `git check-ref-format`'s hard rules (no space/`~^:?*[\`, no `..`, no `@{`, no leading/trailing
   `/`/`.`, no `.lock`). As a belt-and-braces guard, run the composed name through a small
   `assertValidBranchName` (or `git check-ref-format --branch`) and fall back to the bare `ref` if it
   somehow fails.

Example: card `36ab1`, no issue, title *"Design: create a named branch at worktree creation"* →
`36ab1-design-create-a-named-branch-at-worktree-creation` (capped).

**Flat name, no `kanban/` namespace prefix.** The requirement is to match the `docs/design` ref
convention, which is flat; a flat name is also the head branch a human sees on the PR. (A
`task/`-style namespace is a viable alternative if branch-list noise becomes a problem later — noted
under Alternatives, not adopted.)

### 2. Create the branch at the `git worktree add`

Replace `--detach` with a branch, still anchored at the same `baseCommit` (patch commit or resolved
base — unchanged). Because creation is already once-only and locked, this is where all the branch
logic lives; nothing downstream re-runs it.

Handle the "branch already exists" cases explicitly (a re-created worktree for the same card, or a
restore, can find a same-named leftover — removing a worktree never deletes its branch):

```
name = deriveTaskBranchName(card)
branchExists = git rev-parse --verify --quiet refs/heads/<name>

if not branchExists:
    git worktree add -b <name> <path> <baseCommit>     # normal fresh creation
else if storedPatch present (baseCommit == storedPatch.commit):
    # stale leftover; the PATCH is the source of truth in this path
    git worktree add -B <name> <path> <baseCommit>     # reset the label to the patch base, then apply patch
else:
    # genuine leftover branch that may hold pushed/landed history — preserve it
    git worktree add <path> <name>                     # check it out as-is (baseCommit ignored)
```

Rationale for the split: in the **patch-restore** path the branch is just a label and the durable
work is the patch we apply afterward, so resetting it (`-B`) to the patch's base is correct. In the
**no-patch leftover** path the branch itself may be the durable artifact (e.g. it was pushed / has a
PR), so we re-attach to it rather than clobber it — same "worktree is authoritative, don't destroy
work" principle the existing code already follows.

**Collision with a branch checked out elsewhere** (`git worktree add` refuses a branch already
checked out in another worktree — realistically only if two *different* cards resolve to the same
name, e.g. two cards on the same `externalIssue.key` with the same title): detect the failure and
retry with a disambiguating suffix (`-<shortCardId>`, which is globally unique). Keep v1 simple: the
deterministic name first, suffix only on actual collision, and `log`/warn when we do.

**storedPatch fallback add** (`:677`, when the first add fails and we retry at the base commit) gets
the same branch treatment.

### 3. Thread the card-derived name into the creation path

`ensureTaskWorktreeIfDoesntExist` currently takes `{ cwd, taskId, workspaceId?, baseRef }` and has no
board access. Add an **optional** `branchName?: string` (pre-computed by the caller, which *does*
have the card). Mirror the pattern `deleteWorktree` already uses — it looks the card up via
`findBoardCard` and passes derived fields down (`src/trpc/workspace-api.ts:369-379`):

- **Primary creation path** — the `ensureWorktree` tRPC handler (`src/trpc/workspace-api.ts:360-368`)
  already has `taskId`; add a `findBoardCard` lookup, compute `deriveTaskBranchName(card)`, pass it.
- **Secondary path** — `resolveTaskCwd({ ensure: true })` (shell-session start,
  `src/trpc/runtime-api.ts:788`). In practice the agent session creates the worktree first, so this
  call finds it existing and short-circuits before creation. It may omit `branchName`.
- **Fallback:** when `branchName` is absent (or derivation fails), keep `--detach`. This preserves
  current behavior for any caller without card context and keeps the diff strictly additive — the
  core reason it stays small and upstreamable.

### 4. Reconcile the commit/PR templates (no double branch creation)

Once the worktree is already on a named branch, the templates must **use** it, not create a second
one:

- Add a `{{branch}}` template variable alongside `{{base_ref}}` in
  `build-task-git-action-prompt.ts`, sourced from `workspaceInfo.branch` (already reported by
  `getTaskWorkspaceInfo`). When `branch` is null (legacy detached worktree), interpolate a neutral
  fallback so old worktrees still work.
- `DEFAULT_OPEN_PR_PROMPT_TEMPLATE`: drop *"If currently on detached HEAD, create a branch…"* (step
  2). Replace the opener with *"You are on branch `{{branch}}` in a task worktree… push `{{branch}}`
  and open a PR against `{{base_ref}}`."* No branch invention; just push + PR the existing branch.
- `DEFAULT_COMMIT_PROMPT_TEMPLATE`: soften the *"detached HEAD"* opener (now inaccurate); the
  cherry-pick-onto-`{{base_ref}}` steps are unchanged.

**Migration is automatic for users on defaults.** `writeRuntimeGlobalConfigFile` only persists a
template when it differs from the default (`src/config/runtime-config.ts` → the
`hasOwnKey(...) || x !== DEFAULT_…` guards, `runtime-config.ts:436-441`), so bumping the default
strings silently upgrades everyone who never customized them. A user who *did* customize keeps their
template; if it still says "create a branch on detached HEAD", the agent simply finds it is already
on a branch — harmless. No forced config rewrite.

## Decisions (resolved)

- **Name format:** `<ref>-<title-slug>`, flat (no namespace), lowercase `[a-z0-9-]`, capped ~60
  chars on a `-` boundary. Bare `<ref>` if the slug is empty.
- **issueRef vs cardId:** `externalIssue.key` when set, else card id — computed by the **same shared
  helper** as `docs/design/<ref>-<slug>.md`, so branch ref and doc ref are guaranteed identical.
- **Base-ref anchoring:** unchanged — the branch is created *at* the resolved `baseCommit` (patch
  commit or `requestedBaseCommit`); only `--detach` → `-b <name>` changes.
- **Idempotency:** branch creation lives only inside the once-only, lock-guarded genuine-creation
  block; existing worktrees short-circuit and are never re-branched. Re-sync is untouched.
- **Existing-branch / restore collisions:** `-b` when absent; `-B` (reset) in the patch-restore path;
  plain checkout to preserve a genuine leftover branch; `-<shortCardId>` suffix only on an
  actual "checked out elsewhere" collision.
- **Template reconciliation:** commit/PR flow pushes/PRs the pre-created branch via a new
  `{{branch}}` variable; the "create a branch" step is removed. Defaults auto-migrate.
- **Upstreamability:** additive, feature-flagged by presence of `branchName`; detached remains the
  fallback. The naming helper is self-contained and shareable upstream.

## Implementation outline

1. **`src/core/task-ref.ts`** (new): move `sanitizeDesignDocRef` + the ref-selection out of
   `design-doc.ts`; add `deriveTaskBranchName(...)` and `slugifyTaskTitle(...)` + a validity guard.
   Re-point `design-doc.ts` imports (pure refactor, covered by existing design-doc tests).
2. **`src/workspace/task-worktree.ts`**: add optional `branchName` to
   `ensureTaskWorktreeIfDoesntExist`; replace both `worktree add --detach` calls (`:662`, `:677`)
   with the branch-aware add (create / reset / reuse / suffix-on-collision); fall back to `--detach`
   when `branchName` is absent. Add a small `branchExists`/`assertValidBranchName` helper via
   `runGit`.
3. **`src/trpc/workspace-api.ts`**: in `ensureWorktree`, `findBoardCard` → `deriveTaskBranchName` →
   pass `branchName`.
4. **`web-ui/src/git-actions/build-task-git-action-prompt.ts`**: add `{{branch}}` variable from
   `workspaceInfo.branch` (+ null fallback).
5. **`src/config/runtime-config.ts`**: update the two default templates to use `{{branch}}` and drop
   the detached-HEAD branch-creation step.

## Test strategy

- **`task-ref` unit tests:** ref selection (issue key vs card id), slugify (spaces, punctuation,
  emoji, casing), length cap on `-` boundary, empty-title → bare ref, git-ref validity guard. Assert
  the branch ref equals the `docs/design` ref for the same card (the anti-drift invariant).
- **`task-worktree` tests** (real git temp repo, matching existing worktree tests): fresh creation
  lands on the expected branch (`readGitHeadInfo().branch` set, `isDetached` false); re-`ensure`
  short-circuits and does **not** re-branch; patch-restore resets the leftover branch and re-applies
  the patch; genuine leftover branch is re-attached (tip preserved); same-name collision gets the
  suffix; missing `branchName` still produces a detached worktree.
- **`build-task-git-action-prompt` tests:** `{{branch}}` interpolation, null-branch fallback,
  unchanged `{{base_ref}}` behavior.
- **Gate (per repo testing rules):** `npm run typecheck` + `npm run test:fast` + the touched files;
  `npm --prefix web-ui run typecheck` + the web test file. Not the full `build`.

## Risks & edge cases

- **Pushed branch + reset:** the patch-restore `-B` reset only touches the *local* branch; a branch
  already pushed with a PR keeps its remote history. We deliberately reset only in the patch path
  (where the patch is the truth) and *preserve* the branch in the no-patch path (where a PR may
  exist) to avoid force-push confusion.
- **Two cards, one issue key + same title:** resolves to the same name → handled by the
  suffix-on-collision retry; logged so it's visible.
- **Very long titles / non-Latin titles:** slugify strips to `[a-z0-9-]` and caps length; a title
  that slugifies to empty falls back to the bare ref (still valid, still unique via card id).
- **Legacy detached worktrees in flight:** unaffected — `getTaskWorkspaceInfo` reports `branch:
  null`, the template `{{branch}}` fallback covers them, and the commit/PR flow still works.

## Alternatives considered (not adopted)

- **Namespace prefix (`task/<ref>-<slug>` or `kanban/…`):** keeps `git branch` tidy but diverges from
  the flat `docs/design` ref and makes a noisier PR head name. Revisit only if branch-list clutter
  becomes a real problem.
- **Compute the branch name inside `ensureTaskWorktreeIfDoesntExist` via a board lookup:** would put
  board/tRPC concerns into the workspace layer. Passing a pre-computed `branchName` from the boundary
  (as `deleteWorktree` already does with card fields) keeps layering clean.
- **Keep detached; only make the PR template's branch name deterministic:** leaves the "invent a
  branch at the end" dance in place and the worktree unnamed the whole time — doesn't solve the
  stated friction.
