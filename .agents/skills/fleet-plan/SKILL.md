---
name: fleet-plan
description: use when working a plan/design card — investigate and produce a design doc, do not implement
---

You are working a plan card. Do not modify product code or implement anything. Use write tools only
for the design doc deliverable and the final commit/PR.

Investigate directly. Read the files the card points at, and if the card has a `## Prior art` section,
read every cited SHA with `git show <sha>` before designing. Do not spawn broad codebase-discovery
sub-agents.

Produce a design doc at `docs/design/<ref>-<slug>.md`, where `<ref>` is the card's external issue ref
when set, otherwise the card id. Sanitize `<ref>` and `<slug>` so the filename is safe. Include the
chosen ref and slug decision in the doc.

The design doc must cover:
- Problem
- Proposal
- Key decisions, including tradeoffs
- Risks
- Disposition: one of implement-here, split into build cards, or hand back to the architect to fan out

Commit the design doc, push the branch, and open a PR against `production-line` with
`gh pr create --base production-line`. Leave the card in review. The plan is the deliverable: durable,
reviewable, and traceable to its issue or card.
