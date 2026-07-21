# Authoring cards as Markdown

A Kanban card can be authored as a single **Markdown document with optional YAML
frontmatter** instead of hand-massaging many `task create` flags. The frontmatter
is the structured envelope (agent, auto-review, issue, …); the Markdown body is
the card prompt, kept verbatim.

Because a card is just a file, it can live on disk — the suggested home is
`docs/scratch/tasks/` — so it can be reused, committed, and referenced by path.

## Creating a card

```bash
# From a file
task create --file docs/scratch/tasks/add-widget.md

# Inline
task create --markdown "$(cat add-widget.md)"

# From stdin
task create --file - < add-widget.md
```

Explicit CLI flags **override** frontmatter, so one file can be reused with a
single field tweaked:

```bash
# Reuse the file but run it under claude instead of the file's agent
task create --file add-widget.md --agent-id claude
```

The classic flag-only form still works unchanged:

```bash
task create --prompt "Fix the flaky test" --agent-id codex
```

## The template

```markdown
---
title: Add the widget            # optional — see "Title" below
agent: codex                     # codex | claude (any configured agent id, or `default`)
model: claude-haiku-4-5          # optional per-card model override
skill: fleet-smoke               # optional Agent Skills / SKILL.md pointer
base-ref: main                   # optional — defaults to the current branch
auto-review: pr                  # pr | off — DEFAULT pr (see below)
plan: false                      # optional — start in plan mode (default false)
issue: ENG-123                   # optional external issue ref (Linear/GitHub)
code-references:                 # optional — pointers to read before coding
  - 40cc6b6                      #   commit SHA
  - '#43'                        #   PR number (quote it — YAML treats # as a comment)
links:                           # optional — task ids this card should wait on
  - 5f2a1c
---

Everything below the frontmatter is the card prompt, kept verbatim.
Markdown is preserved.
```

Everything after the closing `---` is the prompt. A document with **no**
frontmatter is treated as a bare prompt.

### Fields

| Field             | Maps to                          | Notes |
| ----------------- | -------------------------------- | ----- |
| `title`           | card title                       | Optional; derived from the body when omitted (see below). |
| `agent`           | `--agent-id`                     | `default` clears the override (workspace default). |
| `model`           | `--agent-model`                  | Per-card model for the CLI agent. |
| `skill`           | `--skill`                        | Per-card Agent Skills / `SKILL.md` pointer; only the skill name is injected into the launch prompt. |
| `base-ref`        | `--base-ref`                     | Defaults to the current branch. |
| `auto-review`     | `--auto-review-enabled` + `--auto-review-mode` | `pr` / `off`. Legacy `commit` is treated as off. |
| `plan`            | `--start-in-plan-mode`           | Boolean. |
| `issue`           | `--external-issue`               | Same accepted forms as the flag. |
| `code-references` | rendered prompt section          | See below — the tool never runs git/gh. |
| `links`           | `task link` after creation       | Each id becomes a dependency the new card waits on. |

### Title

If `title` is omitted, it is derived from the body: the text of the first ATX
heading (`# Heading` → `Heading`), or, if there is no heading, the first
non-empty line.

### auto-review defaults to `pr`

For the Markdown-card path, `auto-review` **defaults to `pr`**. Use
`auto-review: off` to disable auto-review entirely. Legacy `auto-review: commit`
cards are migrated to off.

### code-references

`code-references` records pointers to prior work the agent must read **before
writing any code**. Entries are commit SHAs (`40cc6b6`) or PR numbers (`#43` or
`43`). The create command does **not** run git/gh and does **not** embed diffs —
it only records the list and renders a short section into the prompt telling the
agent to expand each one itself:

```markdown
## Code references (read these first)

Expand each reference yourself before writing any code — the card records the pointers only, not the diffs:
- `40cc6b6` — run `git show 40cc6b6` and read the diff before writing code.
- PR #43 — run `gh pr view 43 --diff` and read the diff before writing code.
```

If the body already contains its own `## Code references` section, nothing is
appended (the section is never duplicated).

## Validation

The command fails with a clear error for:

- **Unknown frontmatter keys** (lists the valid keys).
- **Bad `agent` or `auto-review` values** (lists the valid values).
- **A malformed `code-references` entry** (not a commit SHA or PR number).
- **Passing both `--file` and `--markdown`.**
- **No prompt** available from either the body or `--prompt`.
