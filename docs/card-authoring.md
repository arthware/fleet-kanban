# Authoring cards as Markdown

A Kanban card can be authored as a single **Markdown document with optional YAML
frontmatter** instead of hand-massaging many `task create` flags. The frontmatter
is the structured envelope (agent, auto-review, issue, …); the Markdown body is
the card prompt, kept verbatim.

This page covers both halves. Everything up to **Validation** is the envelope —
the fields, their flags, and what the tool rejects. **[The card body](#the-card-body)**
at the end is the writing standard for the prompt itself: what a good card
contains, and why. The envelope decides whether a card is *accepted*; the body
decides whether the right thing gets built.

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
card-type: feature               # optional card workflow type (defaults to `feature`)
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
| `card-type`       | `--card-type`                    | Workflow card type; alias: `cardType` (defaults to `feature`). |
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

---

# The card body

Everything above is mechanics. This is the part that decides whether the right
thing gets built.

**None of it is enforced.** Card bodies are free text; no parser, schema, or
validation rule knows about the sections below. This is a writing standard, not a
format — follow it because it produces cards that work, and depart from it when a
card genuinely needs a different shape.

Cards have two readers with different needs, and both matter:

- **A human** — reviewing, triaging, or reading the card months later to work out
  why something was built. They need the point in ten seconds.
- **An agent** — which needs enough grounding to build the right thing, without
  being handed a solution it will implement whether or not the solution works.

## Structure — progressive disclosure

Ordered so a reader can **stop at any point** and still have a coherent picture. A
human usually reads the first two sections and moves on; an agent reads to the
bottom. Sections you have nothing to say in are omitted, not left empty.

```markdown
# Title — the outcome, not the mechanism

**As a** <role>, **I want** <capability>, **so that** <outcome>.

## Context — why now        Observable symptom or motivation. A human stops here and gets it.
## Related concepts         Existing domain concepts/docs to orient in. Prevents re-invention.
## Confirmed                Verified facts + HOW verified (file:line, SHA, command output).
## Assumed                  Unverified premises. "If one is wrong, stop and say so."
## Definition of Done       Given/When/Then. MUST include the normal resting state.
## Out of scope             Explicit non-goals.
## Suggested approach       OPTIONAL and non-binding (MAY). Omit when you haven't diagnosed it.
## Verification             How light the tests should be.
## Prior art                SHAs to read first.
```

## The rules

**Lead with the story.** `As a / I want / so that`, before anything technical. A
card is a unit of intent, not a work order. The title states the **outcome**, never
the mechanism — "Idle boards shouldn't reload themselves", not "Add a client
staleness watchdog".

**Separate Confirmed from Assumed, and never state an unverified premise as fact.**
Confirmed means you checked and can say how — a `file:line`, a SHA, command output.
Everything else is Assumed. **Claims about platform, browser, or API behavior belong
under Assumed by default**: that is where operators are most often wrong and where
the agent most often knows better. Say plainly what should happen when an assumption
breaks: *"if one of these is wrong, say so and stop."*

**Related concepts ≠ Prior art.** Both orient; neither prescribes.

| | What it is | What it prevents |
|---|---|---|
| **Related concepts** | The **domain model** — what already exists, what it's called, `docs/architecture/concepts/` | Re-inventing a near-duplicate (Constitution Article 1: reuse before rebuild) |
| **Prior art** | **History** — SHAs of similar past work, read with `git show` | Re-deriving the tree from zero, and drifting from an established pattern |

**Use RFC 2119 keywords** to mark binding versus advisory. The invariant is a MUST;
a mechanism you're proposing is a MAY. If everything in a card reads as equally
mandatory, the agent cannot tell which part it is allowed to improve.

**Specify the invariant, not the mechanism.** This is INVEST's *Negotiable*: a card
is a placeholder for a conversation, not a spec. Say what must be true when the work
is done; let the agent choose how to get there. The agent is closer to the code than
the card is.

**Omit "Suggested approach" when you haven't actually diagnosed the cause.** An empty
section beats a confident guess, because the guess is what gets implemented. If you
have a hunch, it goes under **Assumed** — as something to check first, not to build.

**"Don't re-investigate" scopes to the symptom only.** It is a legitimate instruction:
it stops an agent from re-deriving a diagnosis you already paid for. It never extends
to the **solution design** — the agent must stay free to conclude your proposed
mechanism won't work.

**The Definition of Done must name the normal resting state.** Idle, empty, cold-start,
zero-items, nothing-happening. Writing acceptance as Given/When/Then forces you to
enumerate initial states, which is exactly how the bug below would have been caught:
every criterion described a *busy* board, so nobody asked what happens on a quiet one.

## Worked example: a card that shipped a bug

Card `5596f` (WebSocket keep-alive) was detailed, well-researched, and correctly
diagnosed. It became PR [#103] (`49d384b`), which reloaded every idle board every 60
seconds. Card `6e39a` ([#156]) fixed it a few days later.

The card **contained the fact that would have prevented it.** In the client section:

> track the timestamp of the last received message (snapshot, update, OR the low-level
> ping — **note the browser auto-answers WS pings and does NOT surface them to JS**, so
> the visible signal is that *some* server message keeps arriving …)

Eight lines earlier, in the server section, describing the same ping sweep:

> This both frees dead server-side sockets and **gives the client traffic to observe**.

Both cannot be true. Pings the browser answers invisibly are *not* traffic the client
can observe. The agent resolved the contradiction in favor of the prescription, built
a 60s watchdog reset only by visible messages, and on an idle board — where no visible
messages exist — the watchdog fired every 60s and forced a reconnect. Then it
**re-derived the operator's wrong rationale in its own PR body**, presenting it as
analysis:

> This window of **60s safely exceeds the server ping interval of 20s** by a factor of
> 3x. This multiplier provides a safe buffer allowing up to two missed/delayed pings …

That reasoning only holds if pings reset the watchdog. They don't. Nothing in the
process caught it, because the card's own invariants only described the busy path:

> **No false reconnect storms.** A healthy, **active** socket must never be torn down …

Three rules would each have caught this independently:

1. **Confirmed/Assumed separation.** "Pings give the client traffic to observe" is a
   claim about browser behavior — Assumed by default, and it would have been checked.
2. **Resting-state acceptance.** A Given/When/Then for *"Given an idle board with no
   state changes"* has no plausible passing answer under the proposed design.
3. **Invariant over mechanism.** The card specified the watchdog's shape. Asked
   instead for *"an established socket MUST detect its own death"*, the agent picks a
   heartbeat it can actually see — which is what [#156] finally did.

## Worked example: the same standard applied

Card `32bf7` ("One card should open exactly one PR, against its own base") is written
to this shape. Its distinguishing move is what it **doesn't** do: the operator hadn't
diagnosed the cause, so there is no "Suggested approach" section at all.

It opens with the story, then separates what it knows from what it's guessing —
including a Confirmed entry that **rules a fix out**:

> ## Confirmed (verified — don't re-derive)
>
> - `fleet-pr`'s directive **already forbids this**, explicitly: *"open one idempotent
>   PR against this card's base branch `${baseRef}` … Never open the PR against the
>   repository's default branch."* So this is a violated contract, not a missing rule —
>   **adding more instruction text is unlikely to be the fix.**

> ## Assumed (unverified — check these first; if one is wrong, say so and stop)
>
> - That both PRs came from the same agent session rather than a retry/resume opening a second one.
> - That `${baseRef}` interpolated correctly at injection time …
>
> Start by establishing **which** of these is true. The right fix depends entirely on
> the answer, and I have not diagnosed it.

Its acceptance names the edge state rather than only the happy path:

> - Given the base ref is somehow unavailable at PR time, When the agent would otherwise
>   fall back to the default branch, Then it fails loudly instead of opening a PR against
>   the wrong base.

And it closes by inviting the correction it expects to need:

> ## Pushback invited
>
> The Assumed list is my best guess, not a diagnosis. If the cause is somewhere I haven't
> named, follow the evidence and tell me the list was wrong — that's the useful outcome,
> not a deviation from the card.

## Where else to look

- Which agent to give a card, when to split design from build, and the `## Prior art`
  convention: **`AGENTS.md`** in the fleet root.
- How light to scope a card's test gate: the testing-scope rules in **`AGENTS.md`** —
  cards should point at them, not restate them.
- The domain concepts a card's *Related concepts* section links to:
  **`docs/architecture/concepts/`**.

## The agent half

A writing standard helps a careful author. It cannot protect against a wrong one — and
`5596f` shows the failure is not carelessness but **confident wrongness**, which draws
*less* scrutiny than vagueness because there is nothing to be confused about.

So the guarantee doesn't rest on the card. Every build card's injected directive tells
its agent that card premises are **claims, not givens**: a premise it can check and finds
false is to be **reported, not implemented around**, and contradicting the card is
expected work rather than deviation. That reaches every build card regardless of who
wrote it or how well. See `.agents/skills/fleet-implement/SKILL.md` → **Intake**.

[#103]: https://github.com/arthware/fleet-kanban/pull/103
[#156]: https://github.com/arthware/fleet-kanban/pull/156
