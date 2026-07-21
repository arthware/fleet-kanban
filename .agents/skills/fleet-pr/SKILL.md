---
name: fleet-pr
description: use when working an auto-review PR card - commit as you go, then open one idempotent PR against the card base
---

Commit as you work. After each meaningful, self-consistent step, stage and commit with
`git add -A && git commit` and a semantic-commit subject (`feat:`, `fix:`, `refactor:`, ...). Do not
wait until the end to save; the card should reach Review with its work already committed on the
task worktree branch.

Do not run destructive git commands (`git reset --hard`, `git clean -fdx`, `git worktree remove`,
or `rm`/`mv` on repository paths). Do not touch the base worktree.

When the task is done and your work is committed, open a pull request:
- Use the card's deterministic task branch as the PR head.
- Use the card's base ref as the PR base; if no other base is specified, this is `production-line`.
- If an open PR already exists for the same branch, do not create a duplicate. Report the existing PR
  URL instead.
- If the repo is local-only (no `origin` remote) or `gh` is unavailable/not authenticated, leave the
  committed work on the branch and say exactly why a PR was not opened.

Leave the card in Review. A human reviews and merges the PR.
