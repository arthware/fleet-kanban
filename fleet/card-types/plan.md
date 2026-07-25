---
name: plan
description: Plan only — investigate and produce a design doc; land in review for disposition.
phases:
  - name: design
    lane: in_progress
    skills: [fleet-plan]
    activation: default
  - name: verify
    lane: review
    skills: [fleet-review]
    activation: dormant
---

# plan

A plan card produces the design doc and stops. `design` **always** runs (the type is the intent — no
`--plan` flag) and injects `fleet-plan`; the card lands in `review` for the disposition fork (§5):
fan out dedicated `build` cards, or promote the same worktree to a `build` card in-session. There is
**no** build or ship phase — a plan card never implements.