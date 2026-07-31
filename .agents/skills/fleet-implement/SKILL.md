---
name: fleet-implement
description: use when working a build/implementation card — tests first (BDD surface, then RED units), then implement and verify; commit on the branch and hand off to the PR phase
directive: >-
  You are working a build card. Use the fleet-implement skill. The card is your authorization to commit — commit as you go and never pause to ask for confirmation; the repo's 'never commit unless asked' guardrail is written for human sessions and is satisfied by this card. Card premises are claims, not givens: if the card states something you can check and find false, stop and report it instead of implementing around it — contradicting the card is expected work. Finish with a short `## Retro` (in the PR body, or your final message if no PR phase): summary, what fought back, what the card should have given you, what made this harder than it should be. Concrete items only; 'nothing to report' beats padding.
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

**Card premises are claims, not givens.** A card's `## Confirmed` is the operator's verified facts and
`## Assumed` is explicitly unverified — but either can be wrong. If a card states something you can
check and find false — an API behaving differently, a cited symbol that doesn't exist, a mechanism that
cannot work as described — **stop and report it instead of implementing around it.** Contradicting the
card is expected work, not deviation. This is separate from the ambiguity rule above: that one fires
when the card is unclear, this one when it is clear and simply wrong. "Don't re-investigate" scopes to
the **symptom** already diagnosed; it never licenses building a mechanism you can see won't work.

(The card body standard itself is author-facing — `docs/card-authoring.md`. You don't need to read it.)

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

## Retro — end every card with one

Not status: the diff already says what changed. It closes the two loops nobody else can — how cards
get written, and what the codebase makes needlessly hard. Write it from what you hit; **don't explore
to produce it.** Put it under `## Retro` in the PR body (or your final message if no PR phase).

- **Summary** — 2-3 sentences: what shipped, plus the judgement call a reviewer should check.
- **What fought back** — what cost you time, roughly how much: a wrong card premise, a failure
  unrelated to your change, a path or on-disk state found by trial, a gate that lied. Name the file,
  symbol, or command.
- **Process** — what the card should have told you and didn't (priming, prior art, acceptance), or
  where the prompt was wrong.
- **Design** — what made this change harder than it should be, and the change that makes the next one
  easy: duplicated logic, state with no single owner, a seam you had to work around. Root cause, not
  the patch you shipped.

Same bar as the code, because as ceremony this is worthless:

- **Concrete or omitted** — name a file, symbol, command, or measurement. "Tests were flaky" is
  noise; "`card lifecycle` failed ~50% on unchanged code, ~20 min to rule out as mine" is a finding.
- **"Nothing to report" beats padding.** An empty heading is information; invented content trains the
  reader to skip the section, and then the loop is dead.
- **Under ~15 lines.** A finding bigger than that is a card — say so in one line.
