---
name: build
description: The default card workflow — implement, then ship a PR when auto-review is on.
phases:
  - name: build
    lane: in_progress
    skills: [fleet-implement]
    activation: default
  - name: ship
    lane: in_progress
    skills: [fleet-pr]
    activation: auto-review-pr
  - name: verify
    lane: review
    skills: [fleet-review]
    activation: dormant
---

# build

The default workflow every card runs unless it names another type. `build` always runs; `ship` is
activated by `--auto-review pr` and composes the PR directive **after** build in the same
(`in_progress`) lane — reproducing today's implement→pr stacking. `verify` is declared so
`fleet-review` has a home the moment the autonomous loop or a dedicated PR-review lane wants it, but it
is dormant in v1 (no start-time injection; the future lane-entry seam fires it — §6.2).