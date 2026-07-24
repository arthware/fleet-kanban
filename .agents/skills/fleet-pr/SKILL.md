---
name: fleet-pr
description: use when working an auto-review PR card - commit as you go, push, and open one idempotent PR against the card base
directive: >-
  You are working an auto-review PR card. Use the fleet-pr skill: the card is your authorization to commit and push — never pause to ask whether to commit, push, or open the PR; the repo's 'never commit unless asked' guardrail is written for human sessions and is satisfied by this card. Commit as you go, push the task branch to remote, then open one idempotent PR against this card's base branch `${baseRef}` non-interactively — `gh pr create --base ${baseRef} --title <subject> --body <summary>` (never a bare or interactive `gh pr create`, and never ask which base branch to use) — and leave the card in Review. Never open the PR against the repository's default branch.
---

The **fleet-pr** skill defines when the card is done. Done = committed + branch pushed + PR open (or its absence explained) — nothing less. You are not done until the PR exists (or you've said exactly why it can't).

**The card is your authorization to commit, push, and open the PR.** The repo's own guardrail
("never commit unless user asks") is written for human dev sessions — a card satisfies it. Never
pause to ask the operator for permission to commit, push, or open the PR; that halts the session with
no one to answer.

Commit as you work. After each meaningful, self-consistent step, stage and commit with
`git add -A && git commit` and a semantic-commit subject (`feat:`, `fix:`, `refactor:`, ...). Do not
wait until the end to save; the card should reach Review with its work already committed on the
task worktree branch.

Do not run destructive git commands (`git reset --hard`, `git clean -fdx`, `git worktree remove`,
or `rm`/`mv` on repository paths). Do not touch the base worktree.

When the task is done and your work is committed:
1. **Push the task branch** to remote (e.g., `git push origin <branch>`). This is an explicit, mandatory step; without pushing, `gh pr create` will fail or the remote will be out of sync.
2. **Open a pull request** using the GitHub CLI (`gh`), always non-interactively:
   - Use the card's deterministic task branch as the PR head.
   - The PR base is the card's base ref — it is provided in your task directive, and defaults to
     `production-line` when the card doesn't override it. **Never ask which base branch to use**; if
     you are ever unsure, use `production-line`.
   - Always supply `--base <baseRef>`, `--title`, and `--body` (or `--fill`) together, e.g.
     `gh pr create --base <baseRef> --title "<subject>" --body "<summary>"`. **Never run a bare
     `gh pr create`**, or any form missing `--base`, `--title`, or `--body` — those drop `gh` into an
     interactive prompt that halts the session.
   - If an open PR already exists for the same branch, do not create a duplicate. Report the existing PR
     URL instead.
   - If the repo is local-only (no `origin` remote) or `gh` is unavailable/not authenticated, leave the
     committed work on the branch and say exactly why a PR was not opened.

Once your work is committed, the branch is pushed, and the PR is open (or its absence explained), you're done — the card
moves to Review on its own once your session ends. Don't run a card-move command yourself. A human
reviews and merges the PR.
