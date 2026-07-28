---
name: fleet-implement
description: use when working a build/implementation card — tests first (BDD surface, then RED units), then implement and verify; commit on the branch and hand off to the PR phase
directive: >-
  You are working a build card. Use the fleet-implement skill. The card is your authorization to commit — commit as you go and never pause to ask for confirmation; the repo's 'never commit unless asked' guardrail is written for human sessions and is satisfied by this card. Card premises are claims, not givens: if the card states something you can check and find false, stop and report it instead of implementing around it — contradicting the card is expected work.
---

You are working a build card: take it from pickup to a verified, committed build — intake →
tests-first → implement → verify → commit. This is the build half; it focuses on testing, implementing, and committing on the task branch. If a fleet-pr / auto-PR flow is also active, follow the **fleet-pr** skill's instructions on PR creation (see Commit).

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

**Card premises are claims, not givens.** A card's `## Confirmed` section is the operator's verified
facts and its `## Assumed` section is explicitly unverified — but either can be wrong, and so can a
card that separates neither. If a card states something you can check and find false — an API behaving
differently, a cited symbol that doesn't exist, a mechanism that cannot work as described — **stop and
report it instead of implementing around it.** Contradicting the card is expected work, not deviation.

This sits *beside* the ambiguity rule above, not inside it: that one fires when the card is unclear;
this one fires when the card is perfectly clear and simply wrong. Confident wrongness draws less
questioning than vagueness precisely because there is nothing to be confused about — which is why it
needs its own rule. "Don't re-investigate" in a card scopes to the **symptom** it already diagnosed; it
never licenses building a mechanism you can see won't work. See
[`docs/card-authoring.md`](../../../docs/card-authoring.md) for the body standard cards are written to.

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

**The card is your authorization to commit — never pause to ask the operator whether to commit.**
The repo's "never commit unless user asks" guardrail is written for human dev sessions; a card
satisfies it. (This is separate from the Intake allowance to ask when the surface or acceptance
itself is ambiguous — that pause is fine; pausing to ask permission to commit is not.)

Commit **as you go, not once at the end.** After each meaningful, self-consistent step — the tests,
then the implementation that greens them, then a refactor — stage and commit with a semantic-commit
subject (`feat:`, `fix:`, `refactor:`, …) following the repo's convention. Commit at **coherent
boundaries** where the tree is self-consistent: not per line, not one giant commit — the history
should read as the steps you took, and each diff shows its own how.

Committing is continuous (as you go, at coherent boundaries). When the build is verified and committed, the **fleet-pr** skill governs what 'done' means and opens the PR — follow it; do not declare the card done here. If no fleet-pr/land phase is active, leave the verified committed branch and stop.
