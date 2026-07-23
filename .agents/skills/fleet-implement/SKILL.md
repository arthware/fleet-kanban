---
name: fleet-implement
description: use when working a build/implementation card — tests first (BDD surface, then RED units), then implement and verify; commit on the branch (the land/fleet-pr phase owns any PR)
---

You are working a build card: take it from pickup to a verified, committed build — intake →
tests-first → implement → verify → commit. This is the build half; it ends at a
committed branch and doesn't itself run a review pass — the fleet-pr / land phase owns the PR and
review, so build and review never overlap. If a fleet-pr / auto-PR flow is also active, defer PR
creation to it rather than block it (see Commit).

Read the repo's implement profile for the concrete details — how to run tests, build, and lint; the
house style; and how to spin up a throwaway instance to verify a UI: `.claude/implement-profile.md`
if present, otherwise its `AGENTS.md`. Don't hard-code stack, path, or tooling here.

## Intake

Read the card (description, acceptance, comments) and any design doc a prior plan phase produced. If
the card has a `## Prior art` section listing SHAs of similar past work, read every one with
`git show <sha>` (and `git log -p -1 <sha>` for the fuller diff) BEFORE exploring, and match the
pattern it established — this primes context from git history instead of re-deriving the tree, so
don't spawn broad codebase-discovery sub-agents. Use your current worktree/branch if you're on one.

If the intended surface or acceptance is ambiguous, ask (`AskUserQuestion`) before writing code.

## Tests first — BDD surface, then RED units, THEN implement

Write both test layers before any implementation, in this order:

1. **Behavior tests (only if there's a user-facing surface** — a component/hook, an API/procedure, a
   CLI command**).** One per behavior, structured **Given / When / Then** and named as the spec
   sentence `given <context>, when <trigger>, then <outcome>`. Make the three phases visible in the
   body (arrange / one act / assert). One When and one Then per test; exercise the real interface, not
   an outer black box.
2. **Unit tests — RED.** Pin the intended branches, edge cases, invariants, and error paths of the
   implementation's own units. Watch them fail before writing any code.

Then implement the minimal code to green, and refactor with every layer green. Test code is
production code: name the behavior (not the mechanics), one behavior per test, group `describe` blocks
by capability. The suite is the living spec a future agent reads to tell an intended change from a
regression — and a failing name should point at exactly one cause.

## Verify

Run the project's build and the affected tests to green (exact commands in the implement profile). For
behavior/UI changes, verify on a **throwaway, ISOLATED** instance — never a shared or production board:
exercise the real flow, check the console/logs for errors, capture evidence, then tear it down. If
verification fails, fix the root cause and re-verify before continuing.

## Commit

Commit **as you go, not once at the end.** After each meaningful, self-consistent step — the tests,
then the implementation that greens them, then a refactor — stage and commit with a semantic-commit
subject (`feat:`, `fix:`, `refactor:`, …) following the repo's convention. Commit at **coherent
boundaries** where the tree is self-consistent: not per line, not one giant commit — the history
should read as the steps you took, and each diff shows its own how. The build phase ends at a
**verified, committed branch**, and you don't run a review pass yourself.

Opening the PR is the land phase's job, not part of the build — but don't treat "no PR" as absolute.
If this card also runs in **auto-PR mode** (the **fleet-pr** skill is active alongside this one), the
two compose: build with the tests-first discipline here, and follow **fleet-pr** for its
commit-as-you-go cadence and for opening the single idempotent PR. **Defer** PR creation to fleet-pr
rather than contradict it. If no PR/land phase applies, stop once the branch is committed and
verified — that alone is done; the card advances on its own, so don't run a card-move command.
