---
name: feature
description: The default card workflow — design → build → ship, with a dormant verify lane.
phases:
  - name: design
    lane: backlog
    skills: [fleet-plan]
    activation: plan-flag
    planMode: true
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

# feature

The default workflow every card runs unless it names another type. `design` is activated by
`--plan` and runs the card in real plan mode; `build` always runs; `ship` is activated by
`--auto-review pr` and composes the PR directive **after** build in the same (`in_progress`) lane —
reproducing today's stacking. `verify` is declared so fleet-review has a home the moment the
autonomous loop wants it, but it is dormant in v1 (no auto-start on entering Review).
