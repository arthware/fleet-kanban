---
description: Analyse one problem and produce a design doc — investigate, weigh options, recommend an approach with an implementation outline and test strategy. Stops at a committed design doc in review; no implementation code.
argument-hint: "[issue or card id] [problem statement / scope]"
---

# /plan — analyse a problem, produce a design doc

Take one problem from question to a committed **design doc**: intake → investigate → design →
write the doc → stop. This is the **plan half** that precedes `/implement`. It produces a decision
and an actionable outline; it deliberately does **not** write implementation code, so plan and
build never overlap.

**Project profile.** This skill is generic. For the concrete details of the repo you're working in
— stack, house style, and where design docs live — read its **implement profile**:
`.claude/implement-profile.md` if present, otherwise its `AGENTS.md`.

## Arguments

`$ARGUMENTS` — the work-item id (an issue id, or a board card id), optionally followed by the
problem statement / scope. If no id is given, treat `$ARGUMENTS` as the problem to analyse.

## Gate (not fully autonomous)

- **Clarify gate** — after reading the item, if the problem or the desired outcome is ambiguous,
  ask via `AskUserQuestion` and wait before investigating.
- **Commit gate** — in supervised mode (default), show the design doc and confirm before
  committing. If `CLAUDE_MODE=semi_autonomous` or `autonomous`, commit and document instead of
  asking.

## Steps

### 1. Intake

- Read the issue / board card and the problem statement. Establish the branch: use the current
  worktree/branch if you're in one, otherwise create `<id>-design` off the latest `main`.

### 2. Clarify GATE

Restate the problem and what a good outcome looks like in 2–4 lines. If scope, symptom, or desired
behaviour is ambiguous, use `AskUserQuestion` now. If it's clear, say so and proceed.

### 3. Investigate

Read the relevant subsystems and reproduce your understanding of the **current behaviour and the
root cause** — cite `file:line`. Rule candidate causes in or out with evidence. **Do not fix
anything or write implementation code.**

### 4. Design — write the doc

Write a design doc at `docs/design/<slug>.md` covering:

- **Problem & symptom** — what the user sees.
- **Root cause** — the mechanism, cited to code.
- **Options considered** — 2–3, each with tradeoffs (complexity, risk, blast radius, reversibility).
- **Recommended approach** — and why it wins.
- **Implementation outline** — the concrete changes (files / functions / data), phased if needed.
- **Test strategy** — the tests `/implement` should write RED-first: the BDD user-facing surface
  tests (if any) and the internal unit tests, named for intent.
- **Risks, open questions, and out-of-scope.**

Keep it tight and decision-oriented — a reader should be able to hand it straight to `/implement`.

### 5. Verify

The doc is a coherent, actionable plan grounded in real code (line references check out). No code
changes; don't run the app.

### 6. Commit (stop here)

- Commit the design doc on the branch, referencing the id. Follow the repo's commit convention
  (its `AGENTS.md`). Honor the Commit gate.
- **Do not implement** — the build phase (`/implement`) owns that. Leave the card in review.

## Terminal condition

Print:

> ✅ `<id>` designed — `docs/design/<slug>.md` committed on `<branch>`, ready for review → `/implement`.

Then stop. Stop only at the Clarify and Commit gates; elsewhere, decide and document.
