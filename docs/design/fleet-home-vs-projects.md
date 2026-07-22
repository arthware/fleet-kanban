# Fleet home vs. projects — decouple the board's root from the code it runs

**Status:** proposed · **Author:** architect (ad-hoc, no card ref yet) · **Date:** 2026-07-22

## Summary

The dogfood board (`com.fleet.kanban.tools`, port 3500) roots its process at
`kanban_source` — the fleet-kanban **code checkout**, which is *also* the git host for
~37 card worktrees. When that checkout's `.git` got corrupted (`core.bare = true`,
written during a live `--build`; see the restart-safety fix on this branch), the board could no longer detect
its own work tree and the **entire board went down** (`No git repository detected` →
"Disconnected" spinner loop).

This is a modelling bug: **"where the board roots" and "which code the board runs" are two
different things that we've collapsed into one path (`kanban_source`).** This doc proposes
separating them: the board roots at the **fleet home** (a stable repo that hosts no
worktrees and is never rebuilt), and the fleet-kanban checkout becomes just another
**project** whose corruption degrades *that one project*, not the whole board.

The `fleet service restart --build` safety fix (stop→build→start, on this branch) removes
the *cause* of the corruption. This change removes the
*blast radius*: even a genuinely broken child checkout can no longer take the board down.

## Intended model (operator's mental model)

```
<fleet home>/            ← git repo `fleet init` creates; the Kanban agent + all
                            instance config (.fleet/) live here. The board's cwd.
<fleet home>/repo1/      ← child project managed by the board
<fleet home>/repo2/
```

For the dogfood instance: **fleet home = `/Users/arthur/code/repos/tools`** (owns `.fleet/`,
is a valid git work tree), and `fleet-kanban` is a child repo under it. One requirement from
the operator: **support multiple instances in different directories and ports.**

## What already exists (don't rebuild it)

- **`fleet init` already makes the home a thin git repo** so the board registers it as the
  *architect workspace* — "a workspace whose path contains the others" (`_init_root_repo` in
  `fleet-cli/fleet`). `.fleet/` and nested work repos are gitignored at the home.
- **Consumers already root correctly.** A consumer board sets no `kanban_source`, so the
  daemon's `dir="${KANBAN_SOURCE:-$PWD}"` (`fleet-cli/fleet`) resolves to the consumer's
  init'd home — a stable repo, never rebuilt. Consumers get the resilience for free.
- **Workspace IDs are persisted, not derived.** `.fleet/cline/kanban/workspaces/index.json`
  holds `entries` + `repoPathToId` (`src/state/workspace-state.ts`). A repo path always maps
  to the same workspace ID across restarts — this is the key to a zero-orphan migration.
- **Per-project probing + graceful degradation already exist.** The registry probes each
  project's `repoPath` (`src/server/workspace-registry.ts:411-412`) and keeps a set of
  `unavailableWorkspaceIds` (line 221) — a project whose probe misses is greyed/hidden but its
  state is retained and it reappears when the probe passes. The board *can* already survive a
  bad project; it just can't survive a bad **cwd**.

## Root cause of the fragility

Two independent couplings both point at the same fragile directory:

1. **Process root.** `src/cli.ts:280` does `hasGitRepository(process.cwd())` and
   `loadWorkspaceContext(process.cwd())`; `src/cli.ts:405` builds the whole registry from
   `createWorkspaceRegistry({ cwd: process.cwd() })`. At
   `src/server/workspace-registry.ts:196-197`, `probeGitRepository(cwd)` decides boot. cwd =
   `kanban_source` = the fleet-kanban checkout → its `.git` corruption failed boot.
2. **Project repoPath.** The `fleet-kanban` project's `repoPath` is that same checkout, so its
   per-project probe also fails.

Because dogfood collapses cwd **and** its only project **and** the worktree host into one
directory, that directory's corruption is a total outage instead of one greyed-out project.

There's a second, related defect: **when cwd auto-adoption sees a git repo it makes it a
project.** That's how the daemon, when `KANBAN_SOURCE` was empty and it fell back to `$PWD`,
spawned a spurious `tools`/`repo` project. cwd-is-a-repo should not, by itself, mint a card
project.

## Proposed design

**Separate three concepts that are currently one `kanban_source`:**

| Concept | Today | Proposed |
| --- | --- | --- |
| **Board home** (process cwd / `WorkingDirectory`) | `kanban_source` | the **fleet home** (dir that owns `.fleet/`) |
| **Binary to run** (`kanban_bin`) | `kanban_source/dist/cli.js` | unchanged — still `kanban_source` for dogfood |
| **Projects** (card workspaces) | cwd auto-adopted + index | explicit child repos (config `repos`) + persisted index |

### 1. First-class "fleet home", never auto-adopted as a project

The board roots its process at the fleet home for git-independence and path resolution, but
the home is **never** turned into a card workspace even though it's a git repo. Detect the
home by the presence of `.fleet/` at (or above) cwd; when cwd is the home, **skip the
cwd-auto-adoption** at `workspace-registry.ts:196-197` and load projects from config + index
instead. This also fixes the spurious-project bug.

The home *may* still be surfaced as the read-only **architect workspace** (the existing
"contains the others" behaviour) — it just isn't a normal card project and its git health
governs only the architect surface, not the board.

### 2. Projects sourced explicitly

Register projects from `.fleet/config.json` `repos`, resolved relative to the fleet home
(`<home>/<repo>` → repoPath), unioned with the persisted index. IDs come from the persisted
`repoPathToId`, so existing workspaces keep their identity. This is also exactly what makes
the operator's `repo1, repo2` multi-project model real.

### 3. CLI: `WorkingDirectory` = fleet home, deterministically

Change the daemon-install `dir` resolution (`fleet-cli/fleet`, currently
`dir="${KANBAN_SOURCE:-$PWD}"`) to the resolved fleet home (walk up from the invocation dir to
the nearest `.fleet/`, or a recorded value). `kanban_source` shrinks to *one* job — locating
the binary via `kanban_bin` — decoupled from where the board roots. Record the home
explicitly in config so there is no `$PWD` guessing (this subsumes the earlier "env-path pin"
idea).

### 4. Boot validation + graceful per-project degradation

- The board boots iff the **fleet home** is a valid work tree (stable; not a worktree host;
  not rebuilt). Validate at the CLI boundary before (re)installing the daemon and fail loud
  with a precise message rather than installing a daemon that spins.
- A corrupted **child** repo now hits the existing `unavailableWorkspaceIds` path: that one
  project greys out with a reason; the board and other projects stay up. The server should
  render the reason instead of the generic "Disconnected" retry loop.

## Migration & compatibility

**Zero-orphan, low risk.** Existing dogfood cards live under workspace `fleet-kanban`
(repoPath `…/tools/fleet-kanban`). Because projects are keyed by the persisted
`repoPathToId`, keeping that project's repoPath unchanged preserves its ID and every card.
The reroot only changes the board's **cwd**, not any project's repoPath.

- Existing spurious `tools` index entry: harmless (it's the architect/home path); the
  home-detection change stops it from being presented as a card project.
- Consumers: **no change** — they already root at their init'd home. This purely aligns
  dogfood with how consumers already behave.

## Risks / open questions

1. **Home detection.** Walk-up-to-`.fleet/` vs. an explicit recorded `home` in config. Prefer
   recording it (deterministic; supports a home that isn't an ancestor of cwd) with walk-up as
   a fallback. Decide before implementing.
2. **Architect workspace semantics.** Confirm the home-as-architect-workspace surface still
   works when the home is no longer the auto-adopted "initial" workspace. May need to seed the
   architect workspace explicitly rather than via cwd adoption.
3. **`loadWorkspaceContext` on the home.** Ensure skipping cwd-adoption doesn't break code that
   assumes an `activeWorkspace` on boot (`workspace-registry.ts:204-209`). Fallback to
   `listWorkspaceIndexEntries()[0]` already exists; verify it selects a sensible default.

## Rollout / suggested card split

1. **Design → this doc** (done).
2. **CLI card (Codex):** `fleet-cli/fleet` — resolve/record the fleet home, set daemon
   `WorkingDirectory` to it, add boundary validation (refuse to install a daemon whose home
   isn't a valid work tree; clear error). No server changes; verify with an isolated scratch
   board.
3. **Server card (Codex):** home-vs-project separation in `workspace-registry.ts` /
   `cli.ts` — skip cwd auto-adoption when cwd is the fleet home; source projects from config
   `repos` + index; render an unavailable-project reason instead of a disconnect loop.
4. **Verify:** with the dogfood board rooted at `tools`, deliberately corrupt a child checkout
   (`git config core.bare true`) and confirm only that project greys out while the board and
   other projects stay live.

## Out of scope

- The corruption *cause* (fixed on this branch: stop→build→start, `install:all` off the hot
  path, `dist` stash) and the consumer `fleet update` stash — already shipped.
- A staging-dir build that closes the consumer `fleet update` wipe→rebuild window (separate
  follow-up noted in `fleet_update`).
