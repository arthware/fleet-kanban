# Worktree mirroring is decided by structure, not by artifact name (#171)

**Status:** implemented · **Supersedes the blacklist-only model from** [#160](160-worktree-module-resolution-boundary.md)

## The problem, twice

`syncIgnoredPathsIntoWorktree` mirrors a repo's git-ignored paths into every task worktree as
absolute symlinks, so a fresh worktree inherits `node_modules`, `.env`, and local caches for free.

#160 found that some of those symlinks break tooling and added `worktree.unsharedPaths` — a
**blacklist of basenames** (`node_modules`, `dist`, `.next`, …) that are never mirrored.

#171 is the same failure through a gap in that blacklist: generated artifacts nested inside a
**tracked source tree**.

```
Symlink packages/skill-runner/src/generated/runner-assets.json is invalid,
it points out of the filesystem root
```

Real cases in a ~77-project pnpm monorepo (Next 16 / Turbopack): `packages/skill-runner/src/generated/`,
`packages/viewer/src/tailwind.build.css`. Their generators are existence-guarded, so the escaping
symlink looks like a present artifact and the worktree's own `pnpm install` never replaces it. The app
cannot boot.

Adding `generated` and `*.build.css` to the defaults would be the third patch on one surface. No
upstream list can enumerate every repo's `__generated__/`, `*.gen.ts`, `schema.graphql`.

## The invariant

> An escaping symlink is safe only while nothing walks it as an in-root module.

A bundler or `tsc` walks the repo's **checked-out source trees**. So the question is structural — *where
does this path sit?* — not lexical — *what is it called?*

## The rule

A git-ignored path is mirrored into a worktree when it sits **at the repo root**, or inside a subtree
**git tracks nothing in**. Anything under a directory that contains tracked files stays local to the
source repo.

The repo root is deliberately not a "source tree": it is the container for workspace-level local state
(`.env`, `.env.local`, tool config), which build tools read by explicit path rather than discover by
walking. That exclusion is what keeps root-level env mirroring — the behaviour #167 restored — intact.

Implementation (`src/workspace/task-worktree-unshared-paths.ts`):

- `collectTrackedDirectories(trackedFilePaths)` — every directory below the repo root that git tracks
  something inside, built from **one** `git ls-files` pass (a per-path `git ls-files <dir>` would be
  O(ignored paths) git invocations on a large monorepo).
- `isPathInsideTrackedSourceTree(path, trackedDirectories)` — true when any ancestor of the path is
  such a directory. Checking every ancestor, not just the immediate parent, makes the verdict identical
  whether git hands us an ignored directory or a file inside it.
- `shouldMirrorIgnoredPathIntoWorktree(path, rules)` — the single decision point, composing the
  explicit `sharedPaths` opt-in, the name rule, and the structural rule.

The name-based list is **kept, not extended**: it still covers root-level dependency and cache
directories (`node_modules`, `.turbo`, `.next`) that the structural rule mirrors happily because they
sit at the root. No filename was added to make the reported cases pass.

## What this changes for existing repos

| Config | Before | After |
| --- | --- | --- |
| none | defaults apply | defaults apply, plus the structural rule |
| `worktree.unsharedPaths: [...]` | replaces the defaults | **unchanged** — still replaces the defaults |

Existing configs keep their exact meaning; this repo's own config, which omits `node_modules` on
purpose so worktrees inherit it, is unaffected. Two keys are new:

- **`worktree.additionalUnsharedPaths`** closes the foot-gun that made #160 re-openable: a repo that
  wanted one extra artifact name unshared had to write `unsharedPaths`, which silently discarded the
  `node_modules` / `dist` / `.turbo` defaults. Additions now extend whichever list is in effect.
- **`worktree.sharedPaths`** force-mirrors specific repo-relative paths. The structural rule
  necessarily stops mirroring ignored files nested inside tracked packages, including a per-app
  `apps/web/.env.local`. Generated artifacts are recreated by the repo's `postCreateCommand` exactly as
  `node_modules` already is, but secrets cannot be regenerated — `sharedPaths` is their opt-in.

## Verification

- `test/runtime/task-worktree-unshared-paths.test.ts` — the predicate, including the root-vs-nested
  boundary and the `sharedPaths` override.
- `test/integration/worktree-shapes.integration.test.ts` — a fixture carrying both a
  `packages/<pkg>/src/generated/` artifact and a root `.env`, asserted across all three worktree shapes
  plus a re-entry pass. The two halves of the rule pin each other: the generated artifact must be
  absent while `.env` must still be a symlink.
