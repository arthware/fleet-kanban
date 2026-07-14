---
description: Drive one work item to a verified, committed build. Tests first — BDD user-facing interface tests (if any), then RED unit tests — then implement. Stops at a committed branch; no review, no PR.
argument-hint: "[issue or card id] [optional scope notes]"
---

# /fleet-implement — build a work item (tests-first)

Take one work item from pickup to a **verified, committed build**: intake → tests-first → implement
→ verify → commit. This is the **build half**; it stops at a committed feature branch and
deliberately does **not** run a review pass or open a PR — those are later phases, so the two never
overlap.

**Project profile.** This skill is generic. For the concrete details of the repo you're working in
— how to run tests, build, and lint; the house style; and how to spin up a throwaway instance to
verify a UI — read that project's **implement profile**: `.claude/implement-profile.md` if present,
otherwise its `AGENTS.md`. Don't hard-code stack, path, or tooling details in this skill.

## Arguments

`$ARGUMENTS` — the work-item id (an issue id, or a board card id), optionally followed by free-text
scope notes. If no id is given, treat `$ARGUMENTS` as the scope and infer the rest from the current
branch / card.

## Gate (not fully autonomous)

- **Clarify gate** — after reading the item, if the intended surface or acceptance is ambiguous,
  ask via `AskUserQuestion` and wait before writing code.
- **Commit gate** — in supervised mode (default), show the diff summary + message and confirm
  before committing. If `CLAUDE_MODE=semi_autonomous` or `autonomous`, commit and document instead
  of asking.

Between the gates, don't narrate routine progress.

## Steps

### 1. Intake

- Resolve the item: read the issue / board card (description, acceptance criteria, comments,
  relations) and any design note a prior phase produced. If none exists, work from `$ARGUMENTS`.
- **Prior art first.** If the card cites prior-art commits (a `## Prior art` section listing SHAs of
  similar past work), read them **before** exploring — `git show <sha>` on each (and `git log -p -1
  <sha>` for the fuller diff) — and match the pattern they established. This primes context from git
  history instead of re-deriving the tree; see the repo's implement profile / `AGENTS.md`.
- Establish the branch: if you're already on the item's branch / worktree, use it; otherwise create
  `<id>-short-description` off the latest `main`.

### 2. Clarify GATE

Restate the intended change in 2–4 lines: the **module(s)** touched, the **public surface** that
will change (exported functions / types / procedures / hooks / entry points), and the **acceptance
behavior**. If any of that is ambiguous, use `AskUserQuestion` now — don't guess where being wrong
is costly. If it's clear, say so in one line and proceed.

### 3. Write the tests first — BDD surface, then RED units, then implement

Two test layers, **both written before the implementation**, in this order:

1. **Behavior tests — explicit Given / When / Then (first, if any).** If the change has a user-facing
   interface — a component/hook a user drives, an API/procedure a client calls, a CLI command — write
   behavior-driven tests for that surface first, and structure each one as **Given / When / Then**:
   *Given* the starting state/context, *When* the one trigger happens, *Then* the observable outcome
   holds. This is a discipline, not a slogan — make the three parts explicit in both the name and the
   body:
   - **Name** = the spec sentence: `given <context>, when <trigger>, then <outcome>`. A nested
     `describe("given …")` › `it("when …, then …")` split reads the same and is preferred when several
     cases share a Given.
   - **Body** = three visible phases (Given = arrange, When = the single act, Then = assert),
     separated by `// given` / `// when` / `// then` markers or blank-line blocks, so the intent is
     legible without reading the implementation.
   - **One When, one Then per test.** A second trigger or an unrelated second outcome is a second test.
   Exercise the **real interface / seam**, not just an outermost black box. If there is no user-facing
   interface, skip this layer — but a purely internal change still gets Given/When/Then in its unit
   layer wherever a real behavior (not a mechanic) is under test.
2. **Unit tests — classic TDD, RED (then).** Write RED unit tests that pin the **intended behavior**
   of the implementation's own units: branches, edge cases, invariants, error paths. These are the
   tests that drive the implementation — watch them fail before writing any code.
3. **Then implement** — minimal code to green, then refactor with every layer green.

Never write implementation before the RED unit tests exist; write the BDD surface layer before the
units.

**Clean tests, intent-first documentation.** Test code is production code — keep it clean and
readable. The test names and structure are the spec; treat them as the documentation of intended
behavior:

- **Name the behavior, not the mechanics.** A test description states *what the software is for* and
  *why*, never how the code does it. It should still make sense if the implementation is rewritten.
- **Read each name as a Given/When/Then specification sentence** — `given <context>, when <trigger>,
  then <outcome>`. This is the default form for every behavior test, not just an option; keep the
  three clauses even when one is trivial (`given a fresh board, …`).
- **Capture intent, not just assertions.** The test — its name, its Given setup, its Then — must make
  the *contract* legible to a future agent changing this behavior: what capability is protected and
  why, so they can tell an intended change from an accidental regression. The suite is the living
  behavior spec; write it to be read by whoever edits the behavior next.
- **One behavior per test** (one When, one Then), so the name predicts the single assertion. A failing
  test's name alone should tell you exactly which capability regressed.
- **Group by capability**, not by method — `describe` blocks name the behavior (often the shared
  *Given*) under test, not the file or function.

| ✅ Given / When / Then — documents intent | ❌ mechanics / says nothing |
|---|---|
| `given a configured repo, when the board starts, then it is registered as a project` | `calls projects.add` |
| `given a repo already on the board, when init runs again, then it is left unchanged` | `test dedupe` / `works correctly` |
| `given an expired session token, when a request arrives, then it is rejected with 401` | `isExpired returns true → 401` |
| `given a review card with a linked backlog card, when it is moved to done, then the linked card auto-starts` | `test 2` |

A behavior test then reads as its own spec — the three phases visible in the body:

```ts
describe("given a review card with a linked backlog card", () => {
  it("when the review card is moved to done, then the linked card auto-starts", async () => {
    // given
    const board = seedBoard({ review: ["A"], backlog: ["B"], links: [["B", "A"]] });
    // when
    await moveToColumn(board, "A", "done");
    // then
    expect(columnOf(board, "B")).toBe("in_progress");
  });
});
```

**Clean logging — a test run should tell a story.** A passing run reads as a spec (nested
`describe`/`it` names that flow top to bottom); a failing run should hand you the diagnosis, not a
puzzle:

- Let the reporter's structure carry the narrative — don't add log noise to passing tests. If a
  test needs logs to be understood, its names or arrange/act/assert shape are wrong.
- Make failures self-explanatory: assert on meaningful values with clear expected-vs-actual, and add
  an assertion message (or assert a whole object at once) so the failure line alone says *what* broke
  and *why* — no re-running under a debugger to find out.
- One reason to fail per test, so a red name points at exactly one cause.
- Keep fixtures/setup readable and named for intent; a reader scanning only the output should be able
  to reconstruct what was exercised and where it broke.

Use the project's test runner and layout — see its implement profile.

### 4. Implement

- Follow the repo's house rules (its `AGENTS.md` / implement profile).
- Plan first (`EnterPlanMode`) when the change spans several files or packages. Keep the tests green
  as you go.

### 5. Verify

- **Build + tests:** run the project's build and the affected test suite to green (exact commands in
  the implement profile).
- **Behavior / UI changes — verify on a throwaway, isolated instance, never a production or shared
  one.** Spin up the app in isolation, exercise the real flow, check the console / logs for errors,
  capture evidence, then tear the instance down. The profile gives the concrete recipe (port,
  isolation env, how to launch and kill).
- If verification fails, fix the root cause and re-verify before continuing.

### 6. Commit (stop here)

- Stage the relevant files and commit on the feature branch, referencing the id. Follow the repo's
  commit convention (its `AGENTS.md`); let the diff show the how.
- Honor the Commit gate.
- **Do not open a PR and do not run a review pass** — the review / land phase owns those.

## Terminal condition

Print:

> ✅ `<id>` implemented — BDD + unit tests green, verified, committed on `<branch>`. Next: review / land.

Then stop. Stop only at the Clarify and Commit gates; elsewhere, decide and document.
