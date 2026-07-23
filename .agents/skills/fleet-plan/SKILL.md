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

Write the design doc as an RFC: real markdown `##` section headers, in this order, each present even
if short. Write for a human reviewer — clean markdown with short paragraphs, bulleted lists, and small
tables where they help; avoid a single wall of text; keep each section focused. A one-paragraph
section is fine when the problem doesn't warrant more — the headers are required, the length isn't.

- `## Problem statement` — what's broken or needed and why it matters: the observed symptom, the
  expected behavior, and the root cause (not just the surface symptom).
- `## What exists in the codebase` — the current design in this area: the relevant concepts and their
  canonical homes, with concrete code pointers (`path:line`, function/type names) and the Prior-art
  SHAs read. Ground the proposal in what's really there.
- `## Proposed solution` — how the design solves the problem statement, step by step, referencing the
  specific files/functions it changes.
- `## Technical rationale` — why this design over the alternatives: key decisions and tradeoffs,
  options considered and rejected, and risks.
- `## Open questions`
- `## Disposition` — one of implement-here, split into build cards, or hand back to the architect to
  fan out

Commit the design doc, push the branch, and open a PR against `production-line` with
`gh pr create --base production-line`. Leave the card in review. The plan is the deliverable: durable,
reviewable, and traceable to its issue or card.
