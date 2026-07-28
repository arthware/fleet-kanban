# A task worktree resolves its own modules

**Ref:** `160` — GitHub issue [arthware/fleet-kanban#160](https://github.com/arthware/fleet-kanban/issues/160).
**Slug:** `worktree-module-resolution-boundary`.
**File:** `docs/design/160-worktree-module-resolution-boundary.md`.

> Ref/slug decision: the card carries an external issue ref (`arthware/fleet-kanban#160`), so the doc is
> named after the issue rather than the card id, per `AGENTS.md` → "Plans always materialize to a file".

**Status:** proposal. **Disposition:** split into build cards (see the last section).

---

## Problem statement

### Symptom

A fleet task worktree is not a usable checkout of the repo. In a pnpm monorepo (#160: ~77 workspace
projects, pnpm 10, turbo 2.9, Next 16 / Turbopack) it fails three separate ways:

| Command | Failure |
| --- | --- |
| `next dev --turbopack` | `Module not found: Can't resolve 'zod'` + `Symlink [project]/packages/core-model/node_modules is invalid, it points out of the filesystem root` |
| `pnpm install` (after the main checkout's dirs are wiped) | `ENOENT: no such file or directory, mkdir .../apps/e2e/node_modules` |
| `turbo run` (same state) | the contradictory pair `error creating log file directory: AlreadyExists` **and** `Failed to replay logs: failed to create directory .../.turbo` |

The contradictory pair is diagnostic: `mkdir` sees the symlink (`EEXIST`) while writes through it fail
(`ENOENT`). Both errors are one dangling link seen from two syscalls.

### Expected

The worktree behaves like an ordinary checkout. `pnpm install`, `turbo run` and `next dev` work in it
without anyone knowing fleet created the directory.

### Root cause

`syncIgnoredPathsIntoWorktree()` mirrors gitignored paths into the worktree as absolute symlinks back
to the main checkout. That single policy is doing two different jobs:

- **(a) Sharing genuinely shareable state** — `.env*`, credentials, `.claude`, `.husky`. Small, stable,
  and **nothing resolves *through* it**. This job works.
- **(b) Pre-emptively sharing dependencies and build caches** — `node_modules`, `.turbo`, `.next`,
  `dist`, `*.tsbuildinfo`, generated sources. This is an *optimization* — avoid a per-worktree install —
  bought by placing bundler-visible paths outside the worktree root.

Job (b) is the entire #160 failure class, and it is broken three ways at once, only one of which is
about Turbopack:

1. **Resolution leaves the root.** Every module path resolves through an absolute link into another
   directory tree. Turbopack rejects this by design; other tools tolerate it by accident.
2. **Two checkouts share one output directory.** Card A's `npm run build` overwrites the main
   checkout's `dist` and every other card's. `.turbo`'s per-run log directories collide — that is the
   `AlreadyExists` half of the pair. We have been shipping a concurrent-build corruption bug and only
   noticed the Turbopack half.
3. **The link outlives its target.** Wipe `node_modules` in the main checkout and every worktree holds
   a dangling link. Re-sync cannot repair it: `mirrorIgnoredPath()` calls `symlink()`, which throws
   `EEXIST` on the dangling link, and the error is swallowed by the `catch` (`task-worktree.ts:76-83`).
   The worktree stays broken forever.

The fix history is the tell. `ff9f929` copied `node_modules` in the background, `e25c09f` reverted it,
`1a708a2` re-landed a skip-list, `019bab5` widened the detection heuristic — four changes on one
surface, and #160 still reproduces on paths the heuristic was never about. Per Constitution Article 2,
that is a stop sign.

**The missing invariant:** *nothing a package manager or bundler resolves through, or writes to, may
live outside the worktree root.* Job (b) violates it by construction; job (a) never touches it.

---

## What exists in the codebase

### The mirror

`src/workspace/task-worktree.ts` — the canonical home of the worktree concept
(`docs/architecture/concepts/worktree.md`; `component-overview.md:143`).

| Location | What it does |
| --- | --- |
| `listIgnoredPaths()` — `:380-389` | `git ls-files --others --ignored --exclude-per-directory=.gitignore --directory`. Everything it returns is a mirror candidate. |
| `syncIgnoredPathsIntoWorktree()` — `:464-500` | The mirroring loop. Subtracts `shouldSkipSymlink()` (junk files only: `.git`, `.DS_Store`, …, `:45-53`) and `turbopackNodeModulesSkipPaths` (`:472-473`). |
| `mirrorIgnoredPath()` — `:70-83` | `symlink(absoluteSourcePath, targetPath)`, errors swallowed. Best-effort since `5dac7f9` (Windows lacks unprivileged symlinks). |
| `syncManagedIgnoredPathExcludes()` — `:435-462` | Writes the mirrored paths into the repo's `.git/info/exclude` between managed markers, so a *symlink* named `dist` stays ignored. |
| `prepareNewTaskWorktree()` — `:594-644` | Creation path: submodules → sync → skills → post-create hook. |
| `ensureTaskWorktreeIfDoesntExist()` — `:674-722` | Runs `syncIgnoredPathsIntoWorktree()` **on every task start**, not only creation (`:703`, `:715`). This is the repair seam. |

Empirically, in this repo's main checkout, `git ls-files --others --ignored --directory` returns
`node_modules/`, `web-ui/node_modules/`, `packages/desktop/node_modules/`, `dist/`, `web-ui/dist/`,
`fleet-cli/__pycache__/`, `.husky/_/`, `.DS_Store`. Six of eight are class (b). The worktree this doc
was written in has all of them as absolute symlinks into `/Users/arthur/code/repos/tools/fleet-kanban`.

### The current exception

`src/workspace/task-worktree-turbopack.ts` (167 lines) —
`listTurbopackNodeModulesSymlinkSkipPaths()` scans up to `TURBOPACK_SCAN_MAX_DIRECTORY_DEPTH = 3`
directories deep, reads each `package.json`, and drops `node_modules` from the mirror set for packages
that depend on `next` / run a `--turbo` script / mention turbopack in a `next.config.*`.

It cannot fix #160 in principle: Turbopack resolves *into* workspace packages, so
`packages/core-model/node_modules` must also be in-root — but `core-model` is a plain library, matches
no Next heuristic, and stays symlinked. Deeper nesting than 3, and every non-`node_modules` artifact,
are likewise uncovered.

### The dependency seam that already exists

`src/workspace/worktree-post-create-hook.ts` + `.cline/kanban/config.json` → `worktree`
(`runtimeWorktreeConfigSchema`, `api-contract.ts:1192-1197`): `postCreateCommand`,
`postCreateTimeoutMs` (default 300 s), `postCreateFailureMode` (`warn` | `block`).

### Prior art read

| SHA | What it teaches |
| --- | --- |
| `ff9f929` | Background-copied `node_modules` and atomically swapped the symlink. Its own header comment records the constraints: *"we keep ignored paths symlinked by default because creating full copies can make task startup slow"*, *"full copies are too expensive for large dependency trees"*, *"reflinks are not consistently available across filesystems and platforms"*, and the design was explicitly *"optimistic eventual consistency, not a hard readiness guarantee"* with an accepted race against first launch. |
| `e25c09f` | Reverted `ff9f929` wholesale hours later (240 src + 194 test lines), no stated reason. Read with the comment above: the copy is slow, the reflink unportable, the async swap racy. **Any proposal that copies or asynchronously mutates `node_modules` is re-treading this.** |
| `1a708a2` | Replaced the copy with the skip-list. Notably: skipping means the worktree simply *has no* `node_modules` there — "worktree without mirrored deps" is already a shipped state. |
| `019bab5` | Widened Next detection to `next` in dependencies. The last widening; still insufficient. |
| `316ec71` | How a path is carved out today — `.claude/skills` is excluded from the mirror and placed by skill injection, which runs *after* sync. |
| `5f85928` | A worktree lives until its PR merges. Bounds the cost argument: any per-worktree install is paid **once per card**, not per session. |

### Constraint check: is Turbopack's rejection fixable upstream?

No, and it is deliberate. `turbopack.root` exists precisely so that "files are not resolved outside of
the project root … to improve cache validation, reduce filesystem watching overhead, and reduce the
number of resolving steps" ([Next.js docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack)).
The rejection is a design property of the virtual FS, and Turbopack is the default bundler in Next 16.
Open reports confirm no fix is coming and the escape hatch is unreliable:
[#88335](https://github.com/vercel/next.js/issues/88335) (symlinked `node_modules`),
[#91896](https://github.com/vercel/next.js/issues/91896) (symlinked `package.json`),
[#92540](https://github.com/vercel/next.js/issues/92540) (`turbopack.root` ignored in pnpm monorepos).

`turbopack.root` is also not ours to set: it lives in the *user's* `next.config.js`, would have to name
a directory containing both the worktree and the main checkout, and disables the caching it exists for.
Rejected.

---

## Proposed solution

**Keep the mirror machinery. Delete only the class-(b) links.** The gitignore-driven loop, the
`info/exclude` management and the best-effort symlink helper all stay; the change is a single
classification applied inside `syncIgnoredPathsIntoWorktree()`.

### 1. The boundary rule

> **Rule R.** A task worktree never contains a symlink to a path outside its own root for anything a
> package manager or bundler **resolves through or writes to**. Dependency trees and build artifacts
> are **worktree-owned**; they are reproduced by the repo's own tooling, not shared.

Rule R is applied by **path-name class** — a property of the path itself, not an inference about the
toolchain that produced it:

| Class | Matched as |
| --- | --- |
| Dependency trees | a path segment named `node_modules` (any depth) |
| Build/bundler caches & output | a path segment named `.turbo`, `.next`, `dist`, `build`, `out`, `.cache`, `.vite`, `.parcel-cache`, `.svelte-kit`, `.nuxt`, `.output`, `.angular`, `target` |
| Incremental-build state | a basename matching `*.tsbuildinfo` |
| Generated sources | a path segment named `generated` or `__generated__` |

Matched paths are dropped from the mirror set; everything else is symlinked exactly as today.

This is both **simpler and more stable** than the rule it replaces. Today's question is *"is this
package a Next app, within 3 directories, judging by its `package.json`?"* — a question about a
toolchain, answered by scanning and pattern-matching 167 lines' worth of signals, and wrong for
`packages/core-model`. The new question is *"is this path named `node_modules`?"* — a property of the
string, correct at any depth, in any framework, for any package manager, and it covers `.turbo`,
`.next`, `dist` and `*.tsbuildinfo`, which the heuristic never addressed.

**`src/workspace/task-worktree-turbopack.ts` is deleted**, with
`test/runtime/task-worktree-turbopack.test.ts` and its integration cases. The class rule strictly
subsumes it: every `node_modules` it would have skipped is a `node_modules`, and the rule additionally
covers the ones it missed. Net change surface: ≈ −170 src lines, −110 test lines, one import and one
filter replaced by a predicate.

**Local extension.** One new optional field on the existing `runtimeWorktreeConfigSchema`:
`worktree.unsharedPaths: string[]` — repo-declared additional path classes to keep out of the mirror.
A repo whose exotic tool writes `.mytool-cache/` adds one config line instead of waiting for a fleet
release. (Discussed further under "fails open", below.)

### 2. Dependencies: fleet adds no install machinery

Fleet does not detect package managers and does not run installs. A repo that needs dependencies
materialized declares it once, in the seam that already exists:

```jsonc
// .cline/kanban/config.json
{
  "worktree": {
    "postCreateCommand": "pnpm install --frozen-lockfile",
    "postCreateTimeoutMs": 900000
  }
}
```

**The seam was checked against the requirement and it holds:**

| Requirement | Finding |
| --- | --- |
| Fires after the worktree exists and is synced | ✅ `prepareNewTaskWorktree()` `:602-620` runs submodules → `syncIgnoredPathsIntoWorktree` → skills → hook. `node_modules` is absent at hook time, which is exactly what an install wants. |
| Runs in the worktree | ✅ `spawn(..., { cwd: ctx.worktreePath })` (`worktree-post-create-hook.ts:123-129`). |
| Blocks the card until it finishes | ✅ awaited inside `prepareNewTaskWorktree`, which `ensureTaskWorktreeIfDoesntExist` awaits before the session starts. No race of the kind `e25c09f` reverted. |
| Long enough for a cold install | ⚠️ default 300 s; a cold `npm ci` on a large monorepo can exceed it. `postCreateTimeoutMs` covers it, but the default deserves a docs note. |
| Reports failure | ✅ output tail logged, `warning` on the ensure response, `postCreateFailureMode: "block"` fails creation. |
| Finds `pnpm`/`npm` on `PATH` | ⚠️ **gap.** The hook inherits the kanban server's `process.env` (`buildWorktreeHookEnv`). `AGENTS.md` records that kanban inherits the launching shell — but a launchd-daemon board has a minimal `PATH`, so `pnpm: command not found` is plausible. It surfaces as a hook failure with the message in the tail, which is acceptable, but the docs must say "use an absolute path or a wrapper if your board runs under launchd". |
| Re-runs for an existing worktree | ❌ **gap.** The hook fires only from `prepareNewTaskWorktree()`, never from the existing-worktree path at `:703`/`:715`. This matters only for migration — see §3. |

### 3. Existing worktrees

Live worktrees already hold class-(b) links. Repair belongs on the path that already runs on every task
start (`:703`, `:715`), as one idempotent step inside the sync:

1. Walk the worktree for **symlinks** whose target resolves outside the worktree root and whose path
   matches a class-(b) name. Remove them. Never touch real files or directories — an already-localized
   worktree, or content an agent produced, is left alone. This also clears dangling links, which the
   current code can never repair.
2. If anything was removed, run the repo's **already-configured** `postCreateCommand` once, stamped in
   the worktree's git dir so it never repeats.

Step 2 is the one place this design touches the operator's "no install machinery" line, so it is stated
plainly: **fleet still runs only the command the repo declared** — same function, same config, no
detection, no default. It exists because step 1 removes a live worktree's `node_modules` and leaving a
running card with nothing is a worse outcome than reusing the repo's own declared command. If review
prefers the stricter reading, the alternative is step 1 plus a warning on the card telling the operator
to run their install; the cost is a manual step per existing worktree.

Recommended over an explicit `localize` command (one seam, no operator knowledge required) and over
documented manual steps (they do not scale past the operator who read the doc). The escape hatch is
unchanged: delete the worktree and let it be recreated.

### 4. The managed `info/exclude` block — checked, and it shrinks

Dropping class (b) from the mirror also drops it from `syncManagedIgnoredPathExcludes()`. **This is
correct and makes worktrees less dirty, not more.** Verified empirically in a scratch repo:

```
.gitignore:  dist/   node_modules/          # trailing-slash patterns
dist -> /elsewhere  (symlink)   node_modules/  (real dir)

$ git status --porcelain
?? dist                                     # symlink NOT ignored
$ git check-ignore -v node_modules
.gitignore:2:node_modules/	node_modules      # real dir IS ignored
```

That is precisely why the managed block exists (`4636cf3`): a `dist/` pattern does not match a *symlink*
named `dist`, so kanban had to add `/dist` to `info/exclude` to stop its own mirror from dirtying every
worktree. Once the link is gone, the path is either absent (nothing to ignore) or a **real directory**
created by the toolchain, which the repo's own `.gitignore` matches. The workaround is no longer needed
for those paths.

Two supporting facts:

- Every mirrored path is ignored by a **tracked** `.gitignore` by construction: `listIgnoredPaths()`
  passes only `--exclude-per-directory=.gitignore`, not `--exclude-standard`, so `info/exclude` and the
  global excludes are not even consulted. The same `.gitignore` files are present in the worktree.
- The managed block is written to the shared `.git/info/exclude` (`rev-parse --git-path`), which the
  main checkout also reads. Removing anchored entries like `/dist` changes nothing there — the main
  checkout's `.gitignore` already covers them.

No card starts producing dirty worktrees. The block keeps only the class-(a) entries it is actually
needed for.

### 5. Failure behavior

| Situation | What the operator sees |
| --- | --- |
| Repo declares no `postCreateCommand` | The worktree has no dependencies. The first command fails with the ordinary `Cannot find module 'next'` / `command not found` — a normal, googleable error, not an out-of-root symlink internal error. |
| Install command fails or times out | Existing hook path: output tail logged, `warning` on the ensure response; `postCreateFailureMode: "block"` fails worktree creation outright. |
| Package manager not on the board's `PATH` | Hook failure with the shell's own message in the tail (see the `PATH` gap in §2). |
| A repo needs a class-(b)-named path shared anyway | Not supported by design; the escape hatch is the repo's own `postCreateCommand` reproducing it. |

Worth adding while the file is open: log which paths were dropped by class at sync time. One line makes
"my worktree has no `node_modules`" self-explaining instead of a mystery.

### 6. Verification

The gate is a **property test over a fixture tree**, not a Next boot. Given a temp git repo whose
`.gitignore` covers `node_modules/`, `dist/`, `.turbo/`, `.next/`, `*.tsbuildinfo`, `.env`, plus nested
`packages/core-model/node_modules` and `apps/web/.next`, when a worktree is created, then:

> **Invariant assertion:** walk every entry in the worktree; for each symlink, resolve it; assert that
> no class-(b) path is a symlink, and that no symlink target of a class-(b) path escapes the worktree
> root.

`packages/core-model/node_modules` is the case that reproduces #160 and that today's heuristic passes
over. Supporting cases: `.env` and `.claude/skills` are still linked (class (a) unchanged); the managed
`info/exclude` block no longer lists class-(b) paths and `git status` in the worktree is clean; the
repair path removes a pre-planted out-of-root `node_modules` symlink and leaves a real directory alone;
the class predicate is a pure function tested directly against a table of paths.

Placement: extend `test/integration/task-worktree.integration.test.ts` (already builds real temp git
repos via `createTempDir` + `createGitTestEnv` and boots no server) plus a fast unit file for the
predicate. Note `expectMirroredPathBehavior()` in that file asserts the *old* behavior for class-(b)
paths and must be updated.

---

## Technical rationale

### Why the name class beats the toolchain heuristic

The four prior patches all asked a question about *tooling* ("is this a Next app?") and answered it by
inference. Inference is where the bug lives: it was wrong for a plain library package, wrong below 3
directories, and structurally silent about `.turbo`, `.next`, `dist` and `*.tsbuildinfo`. A name class
is a property of the path, so it is right at any depth, for any framework, under any package manager —
and it is checkable in one predicate instead of a module. It removes code and special cases rather than
adding a branch (Article 2).

### This design fails open — stated, not discovered later

A name-class denylist **fails open**: a future build tool whose artifact directory is not on the list
gets symlinked out of root and breaks exactly as #160 does. An allowlist (share only a small enumerated
set; worktree owns everything else) would **fail closed** — an unrecognized new artifact directory is
simply not shared, and the bug class cannot recur.

The design picks fail-open deliberately:

- It is the **smallest change that removes the cause we have**. The four prior patches failed by being
  narrow *within* the wrong question; this one answers the right question and covers every artifact
  class in evidence today.
- Fail-closed has its own failure direction, and it is not obviously cheaper. An allowlist stops sharing
  paths that are neither derived nor obviously secret — large ignored fixture/dataset directories,
  vendored caches, a repo's local tool state — and each one becomes a card that breaks for a reason the
  operator has to discover. Fail-open's failure mode is a known-shape error we have already learned to
  read; fail-closed's is a novel one per repo.
- The gap is closed **locally rather than centrally** by `worktree.unsharedPaths`: a repo hitting an
  unrecognized artifact directory adds one line to `.cline/kanban/config.json` and is unblocked
  immediately, instead of waiting on a fleet release. That is what makes fail-open acceptable here —
  the recovery path does not route through us.
- The property test in §6 encodes the invariant rather than the list, so when a new class does appear,
  the fix is one entry plus one fixture line — not a fifth module.

**The honest residue:** if a new bundler ships a new cache directory name, #160 recurs for that repo
until the list or its config grows. Review should overrule this in favor of an allowlist if that
recurrence is judged worse than the unshared-path breakage an allowlist causes.

### Why regenerate rather than copy

`ff9f929`'s own header comment is the strongest evidence available: full copies "noticeably hurt task
startup", reflinks are "not consistently available across filesystems and platforms", and the
background-swap variant was explicit "optimistic eventual consistency" with an accepted race — then
reverted within hours (`e25c09f`). A package manager reproducing `node_modules` from its own store is
faster than our copy, correct by construction, and free of the drift a snapshot has.

### What the mirror was actually for, and who now pays

The card asks whether the symlinks are load-bearing. `git log` plus `ff9f929`'s comment answer it: the
mirror is opt-out **for startup cost** — *"we keep ignored paths symlinked by default because creating
full copies can make task startup slow."* It was never a correctness requirement. Class (b) is an
optimization, and this design removes it.

**That optimization was real for someone.** Who pays, concretely:

| Package manager | Mechanism | Cost of a per-worktree install |
| --- | --- | --- |
| pnpm | global content-addressable store, hardlinks | seconds; ≈ 0 extra disk (the #160 reporter measured exactly this) |
| bun | global cache, hardlinks | seconds; ≈ 0 extra disk |
| yarn Berry (PnP) | `.pnp.cjs` + zip cache | seconds; small |
| **npm / yarn classic** | **per-project copy out of the local cache** | **tens of seconds to minutes; a full `node_modules` of disk, per card** |

Three things bound it: the install is network-free from a warm cache, it is paid **once per card**
because worktrees live until the PR merges (`5f85928`), and — because fleet adds no install machinery —
**the cost is opt-in**. A repo that never sets `postCreateCommand` pays nothing and gets a worktree
with no dependencies, failing at the first command with an ordinary error instead of silently
resolving through another checkout. The trade is *opt-in cost over silent breakage*.

**This repo is one of the payers.** `fleet-kanban`'s own `.cline/kanban/config.json` sets only
`shortcuts`; our cards get `node_modules`, `dist` and `web-ui/node_modules` free from the mirror today.
After this change every fleet-kanban card runs its own `npm ci`. Adding that `postCreateCommand` to
this repo's config is part of the work, not a follow-up — otherwise we ship a regression to our own
board on the same commit.

### Two corroborating observations

- **Windows worktrees already live under Rule R.** Since `5dac7f9`, symlink creation is best-effort and
  routinely fails without developer mode, so Windows worktrees already have no mirrored `node_modules` —
  silently dependency-less today. This design makes that state explicit and gives it a declared fix.
- **`.husky/_` is class (b) by name?** No — and that is a useful boundary case. It is derived (husky
  regenerates it from `prepare`), but nothing resolves *through* it and it is not on the class list, so
  it stays shared. Rule R is about resolution and writes, not about derivability in the abstract; the
  class list is deliberately narrower than "everything reproducible".

### Alternatives considered and rejected

| Alternative | Why not |
| --- | --- |
| Widen the Turbopack heuristic again (5th patch) | The stop sign. Cannot cover `packages/*/node_modules` of non-Next packages, deeper nesting, or non-`node_modules` artifacts. |
| Invert to an allowlist (worktree owns everything not explicitly shared) | Fails closed, which is safer for the #160 class — but breaks unknown-but-legitimately-shared ignored paths with no signal, and is a much larger change to a mechanism that works for class (a). Directed against; recorded above with its tradeoff so review can overrule. |
| Fleet detects the package manager and installs by default | New machinery in fleet for something the repo knows better; forces the npm/yarn cost on every repo rather than making it opt-in. |
| Copy `node_modules` (sync or reflink) | Already tried and reverted (`ff9f929`/`e25c09f`); slow, unportable, produces a drifting snapshot. |
| Background copy + atomic swap | Same commit pair; the race window is real and invisible to the operator. |
| Relative in-root symlinks | The target genuinely is outside the worktree; no relative path fixes that. |
| Set `turbopack.root` | Not our file to edit, defeats the caching it exists for, reported broken in pnpm monorepos ([#92540](https://github.com/vercel/next.js/issues/92540)). |
| Bind mounts / firmlinks | Platform-specific, privileged, out of proportion. |
| Move worktrees inside the repo | Turbopack's root is the *project* (the worktree); pointing up and out still leaves it. Out of scope per the card. |

### Risks

1. **Fails open** (above) — a new artifact directory name reintroduces #160 for that repo until the list
   or `unsharedPaths` grows.
2. **Cold install for npm / yarn-classic repos that opt in** — real time and disk, once per card.
3. **Repos that opt out get dependency-less worktrees.** Intended, and it fails loudly, but it is a
   behavior change for every repo relying on the mirror today — including this one.
4. **`build`, `out` and `target` are common source-directory names.** They are on the class list because
   they are common *artifact* names, but a repo with a tracked `build/` directory is unaffected (only
   *ignored* paths are ever mirrored). Still the entries most worth a second look in review.
5. **Board `PATH` under launchd** may not contain `pnpm`/`npm` for the hook (§2). Fails loudly; needs a
   docs line.
6. **Migration removes links a card is mid-build on.** Mitigated by removing links only and re-running
   the declared install in the same step; the narrow window deserves a sanity check during
   implementation.

---

## Open questions

1. **Does the ensure-response `warning` actually surface on the card?** It is set at
   `task-worktree.ts:810-828` and returned through `src/trpc/workspace-api.ts:376`; the consumer path
   was not traced end-to-end. If it dead-ends, §5 needs a small UI addition scoped into the build card.
2. **Should step 2 of §3 exist** (re-run the declared install after a repair), or should migration stop
   at removing links plus a warning? Recommended as written; flagged because it is the one place this
   design touches the "no install machinery" constraint.
3. **Exact class list membership** — particularly `build`, `out`, `target`, and whether `coverage`,
   `.venv`, `__pycache__` and `.gradle` belong. Adding them is consistent with Rule R (`.venv` in
   particular is *actively wrong* to share: it embeds the outer checkout's absolute paths and editable
   installs point at the outer sources), but each addition is a repo that stops getting something free.
4. **`worktree.unsharedPaths` matching semantics** — path-segment names, globs, or both. Segment names
   are the smaller surface and match how the built-in list works; globs are more expressive.
5. **`normalizeWorktreeConfig()`** (`src/config/runtime-config.ts:157-181`) early-returns `{}` when
   `postCreateCommand` is unset and will silently drop `unsharedPaths`. It needs restructuring — cheap,
   but easy to miss.

---

## Disposition

**Split into build cards** — one substantive card plus a small follow-up. The rule and its repair path
are one behavior change and should land together; docs and this repo's own config are separable.

**Card 1 — worktree-owned dependencies and build artifacts** (`--agent-id codex`)
- Add the class predicate and apply it in `syncIgnoredPathsIntoWorktree()`; add `worktree.unsharedPaths`
  to `runtimeWorktreeConfigSchema` and fix `normalizeWorktreeConfig()`'s early return.
- **Delete** `src/workspace/task-worktree-turbopack.ts` and `test/runtime/task-worktree-turbopack.test.ts`.
- Repair sweep on the existing-worktree ensure path, stamped, re-running the declared hook once.
- Add `worktree.postCreateCommand` to this repo's own `.cline/kanban/config.json` in the same change.
- Tests: the containment property test (including `packages/core-model/node_modules`), the predicate
  table, clean `git status` in the worktree, the repair case; update `expectMirroredPathBehavior()`.

**Card 2 — document the seam** (`--agent-id codex`, depends on Card 1)
- Rule R in `docs/architecture/concepts/worktree.md` (extend the existing concept — no new concept
  file), the `component-overview.md` change-index entry, and `worktree.postCreateCommand` docs covering
  the per-package-manager cost, the `postCreateTimeoutMs` default, and the launchd `PATH` caveat.
