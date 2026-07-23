---
name: fleet-pr
description: use when working an auto-review PR card - commit as you go, push, and open one idempotent PR against the card base
---

The **fleet-pr** skill defines when the card is done. Done = committed + branch pushed + PR open (or its absence explained) — nothing less. You are not done until the PR exists (or you've said exactly why it can't).

Commit as you work. After each meaningful, self-consistent step, stage and commit with
`git add -A && git commit` and a semantic-commit subject (`feat:`, `fix:`, `refactor:`, ...). Do not
wait until the end to save; the card should reach Review with its work already committed on the
task worktree branch.

Do not run destructive git commands (`git reset --hard`, `git clean -fdx`, `git worktree remove`,
or `rm`/`mv` on repository paths). Do not touch the base worktree.

When the task is done and your work is committed:
1. **Push the task branch** to remote (e.g., `git push origin <branch>`). This is an explicit, mandatory step; without pushing, `gh pr create` will fail or the remote will be out of sync.
2. **Open a pull request** using the GitHub CLI (`gh`):
   - Use the card's deterministic task branch as the PR head.
   - Use the card's base ref as the PR base (e.g., `gh pr create --base <cardBase>`); if no other base is specified, this is `production-line`.
   - If an open PR already exists for the same branch, do not create a duplicate. Report the existing PR
     URL instead.
   - If the repo is local-only (no `origin` remote) or `gh` is unavailable/not authenticated, leave the
     committed work on the branch and say exactly why a PR was not opened.

Once your work is committed, the branch is pushed, and the PR is open (or its absence explained), you're done — the card
moves to Review on its own once your session ends. Don't run a card-move command yourself. A human
reviews and merges the PR.
