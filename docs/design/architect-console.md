# Architect Console — the powers the overseer needs to run a fleet

**Status:** design / review · **Owner:** Arthur · **Last updated:** 2026-07-10
**Builds on:** `docs/design/architect-steering.md` (Phase A landed — the CLI-tools route) ·
durable sessions (landed) · **Vision:** `fleet/docs/kanban-ui-epic.md`

> A human sits in the pilot seat and steers **one** agent — the **architect**. The architect steers
> the impl agents. This doc designs the architect's **console**: the capabilities it needs to
> actually run the production line, designed from the architect's seat.

This is a **fork differentiator**, not an upstream target. It is tailored for our overseer topology
(parent repo = architect workspace; child repos driven via the `fleet` CLI injected as tools). We
deliver these powers primarily by **extending the `fleet` CLI**, per the thin-wrapper corollary
(§ Principles), and touch board machinery only where the CLI genuinely cannot reach.

---

## 1. Problem & symptom

Phase A gave the architect a *seat*: it is detected by containment, rooted at the parent, sees cards
across sub-repos (`fleet task ls`/`cat`), and dispatches new cards (`fleet task create --start`). But
the seat has **no controls**. Walking the architect's operating loop, four of six steps are missing
or broken:

| Loop step | Capability the architect needs | Today | Gap |
|---|---|---|---|
| **1. Scope** | Find prior related work to prime a new card instead of re-researching from zero | nothing — every card starts cold | **No institutional memory.** Each impl agent re-discovers the codebase with expensive sub-agents. |
| **2. Dispatch** | Create + start a card in a child repo, at the *right cost* for the job | `fleet task create --start`, but **every CLI-agent card runs on the expensive default model** | **No per-card model/thinking** for claude/codex. Burns session limits on research-grade cards. |
| **3. Observe** | See what an agent is doing and has said | `fleet task cat` (status + last diff only); the detail pane **goes blank when the session ends** | **No read-only transcript view / tail.** (In flight — card `4934b`.) |
| **4. Steer** | Send an instruction to a *running* impl agent; answer its question; unblock it | **NOTHING** — once dispatched, the architect cannot talk to the card | **No communication channel, either direction.** *This is the priority.* |
| **5. Review** | Inspect the diff, accept or redirect | `fleet task cat` (diff), human reads it | Adequate; add "review against the change-index." |
| **6. Record** | On completion, capture what shipped so step 1 can find it next time | nothing | **No change-index ledger.** Closes the loop back to Scope. |

The **cross-cutting symptom** the pilot feels: session limits evaporate. Every impl agent re-reads
the codebase via Opus sub-agents because (a) it has no primed context from prior work (gap 1) and
(b) it runs on the most expensive model regardless of task difficulty (gap 2). The architect cannot
intervene mid-flight to stop a spiralling agent (gap 4) and cannot even watch it burn (gap 3).

---

## 2. Root cause (grounded in code)

Each gap is a concrete absence in today's code, not a bug:

1. **Scope / memory.** There is no artifact that records "what landed, where." `fleet task cat`
   reads live board + git state (`fleet/fleet:466`) and nothing historical. Completed cards are
   trashed and their worktrees pruned (`src/workspace/task-worktree.ts` `removeTaskWorktreeInternal`),
   so their diffs and rationale are unrecoverable at kickoff time.

2. **Dispatch / per-card model.** The `kanban task create` CLI *does* expose model/thinking — but
   only for the **Cline SDK path**: `--cline-provider/--cline-model/--cline-reasoning-effort` feed
   `clineSettings` (`src/commands/task.ts:1128-1140`, schema `runtimeTaskClineSettingsSchema`
   `src/core/api-contract.ts:93-98`). For **CLI agents** (claude/codex/…), which is how the fleet
   actually runs, there is **no model field on the card and no `--model` passed at launch**. The
   claude adapter builds args from `input.args` + hooks + resume flags and never adds a model
   (`src/terminal/agent-session-adapters.ts:614-729`); codex likewise (`:759-838`). The `fleet task
   create` wrapper has no `--model`/`--think` flag at all (`fleet/fleet:348-408`).

3. **Observe.** CLI-agent conversation renders **only through a live PTY**, gated on `pid != null`
   (`web-ui/src/terminal/terminal-session-liveness.ts` `hasLiveTerminalSession`). When the session
   ends the terminal unmounts and nothing renders the persisted transcript — even though it is still
   on disk and `locateAgentTranscript` (`src/terminal/agent-transcript-locator.ts`) can find it.
   This is architect-steering.md §7 issue #1; **card `4934b` is already addressing it** — this doc
   sequences around it and does not duplicate it.

4. **Steer.** There is no verb and no board affordance to write into a running session *from the
   architect*. Notably, the **server substrate already exists but is unused by the architect**:
   `sendTaskSessionInput` (`src/trpc/runtime-api.ts:385-405`) routes text to either the Cline session
   or, for a PTY agent, `terminalManager.writeInput(taskId, buffer)`
   (`src/terminal/session-manager.ts:846-861` → `PtySession.write` `src/terminal/pty-session.ts:110`).
   The web-ui uses this for the live terminal; **no `fleet` verb exposes it**, so the architect (a
   headless agent driving `fleet` via Bash) cannot reach it. The reverse direction — agent → architect
   — has no distinct signal: a permission prompt and an end-of-turn stop **both collapse to
   `reviewReason: "hook"`** (`src/terminal/session-state-machine.ts:31-43`; hooks in the claude
   adapter map `Stop`, `PermissionRequest`, and `Notification` all to `to_review`,
   `agent-session-adapters.ts:663-705`). The architect cannot tell "done, review me" from "blocked,
   answer me."

5. **Record.** Same absence as (1), viewed from the write side: nothing appends a durable record at
   done-time.

---

## 3. Principles (inherited + sharpened)

- **Thin wrapper; derive state.** `fleet-kanban` is a view + remote-control over the agent CLIs'
  on-disk artifacts. **No new persisted transcript store** — the Observe read path derives from the
  CLI's own `.jsonl`/rollout files via `locateAgentTranscript`.
- **Extend the `fleet` CLI first.** The CLI is the architect's primary interface and is *meant to
  grow*. Prefer a new verb over new board UI. Board machinery changes only where the CLI cannot
  express the capability (e.g. a new card state must be a schema field so the UI can render it).
- **The change-index is the one new durable artifact** — and it is a plain file in the repo, not a
  new service. It is the deliberate exception to "derive state," justified in § 6.
- **Card = durable state; session = ephemeral compute.** Steering writes into the ephemeral session;
  signals and the change-index live in durable state.
- **Human in the pilot seat.** Every write the architect makes (dispatch, steer, record) is a
  `fleet` command the human sees in the architect chat and can interrupt.

---

## 4. The architect operating loop — target design

```
        ┌──────────────────────────────────────────────────────────────┐
        │                                                              │
  ┌─────▼─────┐   ┌──────────┐   ┌─────────┐   ┌────────┐   ┌────────┐  │
  │ 1. SCOPE  │──▶│2.DISPATCH│──▶│3.OBSERVE│──▶│4. STEER│──▶│5.REVIEW│──┤
  │ read      │   │ create + │   │ tail    │   │ say /   │   │ diff + │  │
  │ change-   │   │ start,   │   │ live &  │   │ answer, │   │ redirect│ │
  │ index     │   │ pick     │   │ ended   │   │ unblock │   │        │  │
  └───────────┘   │ model    │   └─────────┘   └────▲───┘   └────┬───┘  │
        ▲         └──────────┘                      │            │      │
        │                              agent→architect signal    │      │
        │                              (needs-input surfaces      │      │
        │                               as a card state)          │      │
        │                                                         ▼      │
        │                                                  ┌────────────┐│
        └──────────────────────────────────────────────── │ 6. RECORD  │◀┘
                     append to change-index                │ append idx │
                                                           └────────────┘
```

Each capability below names the target verb; the CLI surface is consolidated in § 5.

---

## 5. Proposed `fleet` CLI surface

The `fleet task` verb group (in the bash dispatcher `fleet/fleet`, function `fleet_task`) grows these
verbs. Verbs that write are also added to the architect's injected tool list (`_fleet_help_agent`,
`fleet/fleet:519`) so the overseer knows when to use them.

| Verb | Purpose | Loop step | Status |
|---|---|---|---|
| `fleet task ls [--repo N] [--column C]` | production-line overview | Observe | **landed** |
| `fleet task cat <id>` | one card: state + worktree + diff | Review | **landed** |
| `fleet task create --prompt … [--repo N] [--model M] [--think L] [--plan] [--start]` | dispatch, now **cost-aware** | Dispatch | **+model/think (new)** |
| `fleet task start --task-id <id> [--repo N]` | (re)launch | Dispatch | landed |
| `fleet task tail <id> [--lines N \| --since 3m] [--json]` | read-only transcript, live or ended | Observe | **new (seq. after 4934b)** |
| `fleet task say <id> "<text>" [--submit]` | inject a steering message into a running session | **Steer** | **new — priority** |
| `fleet task index <verb>` | read/write the change-index (see § 6) | Scope / Record | **new** |

`fleet task index` sub-verbs:

- `fleet task index find <query> [--repo N] [--area A]` — search prior work (Scope, step 1).
- `fleet task index add --sha <sha> --summary <s> --area <a> [--repo N] [--files f1,f2]` — append a
  record (Record, step 6).
- `fleet task index ls [--repo N]` — list recent records.

Design rules for the surface (consistent with the two landed verbs):

- **Text-first, `--json` opt-in.** `ls`/`cat` print human/agent-readable text; machine consumers
  pass `--json`. `tail` follows suit.
- **Repo resolution** reuses `_fleet_repo_path` (`fleet/fleet:335`): omit `--repo` when the project
  has exactly one repo, else it's required.
- **The wrapper stays thin** — each verb shells the underlying `kanban` CLI / HTTP endpoint with the
  right `CLINE_HOME`/`KANBAN_RUNTIME_PORT` already wired (as `create`/`start` do today).

---

## 6. The change-index — institutional memory (Scope ⇄ Record)

### 6.1 What it is

A per-repo, append-only ledger of *what landed*. Written at completion (step 6), read at kickoff
(step 1). It exists to break the cost spiral: instead of an impl agent re-discovering the codebase,
the architect greps the index for prior related work and **primes the new card's prompt with the
files and the prior diff**, so the agent starts warm.

It is the **one** new durable artifact — justified as an exception to "derive state" because the
information (why a change was made, which area it touched, its one-line intent) is **not recoverable**
from git alone once worktrees are pruned, and re-deriving it per kickoff is exactly the expensive
work we are trying to avoid.

### 6.2 Format

A JSONL file checked into **each child repo** at `docs/change-index.jsonl` (co-located with the code
it describes; travels with the repo; survives worktree pruning; diff-reviewable). One record per line:

```jsonc
{
  "id": "ci_<short>",              // stable record id
  "ref": "b313d99",               // commit SHA or "#412" (PR) — see open decision D-A
  "summary": "per-card model + thinking for CLI agents",
  "area": "dispatch/agent-launch", // component/area slug, matches component-overview.md sections
  "files": ["src/terminal/agent-session-adapters.ts", "fleet/fleet"],
  "cardId": "0fe1d",              // originating board card, if any
  "agent": "claude",
  "at": 1752000000                 // completion epoch (stamped by writer)
}
```

Rationale for JSONL over Markdown: append is a single line write (no merge conflicts on a shared
list), and `fleet task index find` can filter structurally (`area`, `files`) rather than grepping
prose. It is still human-readable in a diff.

### 6.3 Read/write lifecycle

- **Read (Scope).** `fleet task index find <query>` ranks records by token match on `summary` +
  `area` + `files`, optionally filtered by `--area`/`--repo`. The architect uses hits to write a
  primed prompt: *"Related prior work: <ref> touched <files> — read that diff first before
  exploring."* This is what replaces a cold Opus-driven codebase sweep.
- **Write (Record).** `fleet task index add …` appends one record when a card reaches done.

### 6.4 Writer decision (the fork)

Who appends the record?

- **(a) Impl agent at wrap-up** — the agent that did the work runs `fleet task index add` as its last
  step. *Pro:* richest `summary`/`area` (it knows what it did). *Con:* relies on the agent
  remembering; a crashed/interrupted card never records; needs a prompt-contract in each repo's
  `AGENTS.md`.
- **(b) fleet auto-stamps at done-time** — the done-transition (trash/auto-review completion) writes
  a record from board + git state. *Pro:* never forgotten, uniform. *Con:* `summary`/`area` are
  mechanical (title + changed-dir heuristics), lower quality — the very context we want is thin.
- **(c) Hybrid** — fleet auto-stamps a **skeleton** at done-time (guarantees a record exists, with
  `ref`/`files`/`cardId`/`at` from git+board), and the impl agent — when it completes cleanly —
  *enriches* `summary`/`area` via `fleet task index add --card <id>` (upsert by `cardId`).

**Recommendation: (c) hybrid.** It gives the durability of (b) (no card is ever unrecorded, even on
crash) with the context quality of (a) when the agent finishes cleanly. The skeleton is the
derive-from-state fallback; the enrichment is the human-grade summary. Implement (b)'s skeleton first
(it's independently valuable and unblocks Scope immediately), add (a)'s enrichment second via an
`AGENTS.md` wrap-up contract.

### 6.5 Manual precursor — the card `## Prior art` section (shipped)

Before the automated ledger (R1/R2) exists, the same priming is available **by hand**: a card carries
an optional, well-known section in its description that cites the commit(s) of similar past work, and
the implementing agent reads those diffs first. This is the zero-infrastructure version of §6.3's read
step — the operator plays the role the `index find` query will later automate.

The section shape is a documented convention (not enforced by code — the card composer stays
free-form):

```
## Prior art (read with `git show <sha>` before starting)
- <sha> — <one line: what it did / why it's similar>
```

Two homes carry the rule so both sides of the loop honor it:

- **Operator / agent convention** — `fleet-kanban/AGENTS.md` (§ "Don't research from zero" → "Prior-art
  commits") defines the section shape and the read-first rule. It is the canonical definition.
- **Implementing-agent instructions** — the launched card follows `/implement`, whose in-repo copy
  lives at `.claude/commands/implement.md` (generic Intake rule) with fleet-kanban specifics in
  `.claude/implement-profile.md`. Both say: *if the card lists Prior art commits, `git show <sha>`
  (and `git log -p -1 <sha>`) each one BEFORE writing code, and match the established pattern.*

**Relation to the parent `/implement`.** `/implement` is a generic skill; the copy under
`fleet-kanban/.claude/` is the in-repo instance a board card actually runs. If a future parent-fleet
`/implement` command (outside this repo) becomes the real home, the prior-art rule belongs there too —
for now the in-repo half is implemented and this note is the record of intent. When R1/R2 land, the
`## Prior art` section becomes the human-authored complement to `fleet task index find`: the ledger
suggests refs, the operator still hand-cites the ones that matter, and the read-first contract is
unchanged.

---

## 7. Per-card model + thinking (Dispatch, cost)

### 7.1 Schema

Add two **optional** sibling fields to the board card — parallel to the existing `clineSettings`, but
for the **CLI-agent launch path**:

```ts
// src/core/api-contract.ts — runtimeBoardCardSchema, additive/optional
agentModel: z.string().optional(),               // e.g. "claude-sonnet-5", "gpt-5-codex"
agentThinking: runtimeAgentThinkingSchema.optional(), // enum, see D-C
```

`runtimeAgentThinkingSchema` = `z.enum(["none","low","medium","high"])` (vocabulary decision D-C).
Keep it agent-neutral in the schema; each adapter maps it to that CLI's native knob. These are
**distinct from `clineSettings`** (which stays the Cline-SDK path). Additive/optional so existing
`board.json` still parses (per the contract's ripple rule).

Mirror onto the session summary only if we want `fleet task cat` to show the effective model
(recommended: yes, add `agentModel`/`agentThinking` to `runtimeTaskSessionSummarySchema`, set at
launch).

### 7.2 Pass-through to launch

Thread the fields through the existing launch chain (no new plumbing shape — extend the request
object that already carries `agentId`, `startInPlanMode`, etc.):

```
card.agentModel/agentThinking
  → runtime-api startTaskSession (reads card)
  → session-manager StartTaskSessionRequest (new fields, alongside :355-378)
  → prepareAgentLaunch → adapter.prepare(input)
  → adapter pushes native args
```

Per-adapter mapping (in `agent-session-adapters.ts`, guarded by `hasCliOption` so an explicit user
arg always wins):

| Field | claude adapter | codex adapter |
|---|---|---|
| `agentModel` | `args.push("--model", model)` | `args.push("--model", model)` |
| `agentThinking` | map level → Claude Code thinking (env `MAX_THINKING_TOKENS` or the level's model/output-style knob — verify against installed `claude` at build) | `-c model_reasoning_effort=<level>` |

The exact claude thinking knob is an **open decision (D-C)** — confirm what the pinned `claude`
build accepts before wiring; the schema stays agent-neutral so the mapping can change without a wire
change.

### 7.3 `fleet task create` flags + defaults

- New wrapper flags in `fleet_task` create (`fleet/fleet:348`): `--model <id>` and `--think
  none|low|medium|high`, forwarded as `--agent-model`/`--agent-thinking` to `kanban task create`
  (new `kanban` options beside the `--cline-*` ones at `task.ts:1128`).
- **Global default** in `fleet-kanban/.claude/settings.json` (does not exist yet — create it): a
  `fleet.defaultModel` / `fleet.defaultThinking` read by `fleet task create` when the flags are
  omitted. Precedence: explicit flag > settings default > agent's built-in default.
- **Recommended defaults (D-D):** dispatch default **Sonnet**; **Opus** for hard design cards;
  **Haiku** for research/scouting cards. The architect chooses per card from its knowledge of the
  task; the settings default is the safety net (Sonnet).

---

## 8. Communication channel — bidirectional (Steer) — **priority**

### 8.1 architect → agent (inject a steering message)

**Mechanism.** Reuse the existing input path — no new transport. `fleet task say <id> "<text>"`
resolves the card's repo → project path, then POSTs to the existing `sendTaskSessionInput`
endpoint (the same one the web-ui terminal uses, `runtime-api.ts:385`). That routes to either the
Cline session or `terminalManager.writeInput` → `PtySession.write` for a CLI agent.

The subtlety is **delivery semantics for a PTY agent**: writing raw bytes drops text at the prompt
but does not necessarily submit it, and can interleave badly if the agent is mid-generation. Design:

- Wrap the payload as a **bracketed-paste submission** (`[200~…[201~\r`) — the helper
  `toBracketedPasteSubmission` already exists in `agent-session-adapters.ts:610` and is the same
  trick codex startup uses. `--submit` (default on) appends the paste terminator + `\r`; `--no-submit`
  drops the text without sending, for staged multi-line steering.
- **Guard on liveness.** `say` only works when the session is running (`pid != null`); if the card is
  in `awaiting_review`/ended, `say` returns a clear error suggesting `fleet task start` (resume) then
  `say`. (Resume-then-steer is the Phase-C steer affordance, distinct from Observe.)
- The Cline-SDK path already accepts input via `sendTaskSessionInput`, so `say` works for `cline`
  cards for free.

**Verb:** `fleet task say <id> "<text>" [--submit|--no-submit]`. Added to `_fleet_help_agent` as:
*"Answer a question or redirect a running agent. Use when a card is blocked (needs-input) or drifting."*

### 8.2 agent → architect (surface a signal as card state)

Today a permission prompt and an end-of-turn stop both land as `reviewReason: "hook"`
(`session-state-machine.ts:31`), so the architect cannot distinguish "done" from "blocked, answer me."
The claude adapter already emits the raw distinction — `PermissionRequest` and `Notification`
(`permission_prompt`) hooks vs the `Stop` hook (`agent-session-adapters.ts:663-705`) — and the hook
activity already carries `notificationType`/`hookEventName` (`runtimeTaskHookActivitySchema`,
`api-contract.ts:266-275`). We only need to *propagate* that distinction into a state the architect
sees.

**Design:** add a `needs_input` review reason.

- Extend `runtimeTaskSessionReviewReasonSchema` (`api-contract.ts:258`) with `"needs_input"`
  (additive to the enum).
- Add a hook event `to_needs_input` to `runtimeHookEventSchema` (`api-contract.ts:1281`) and route
  the claude `PermissionRequest`/`Notification(permission_prompt)` and codex `*_approval_request`
  hooks to it instead of `to_review`. `reduceSessionTransition` maps `to_needs_input` →
  `state: awaiting_review, reviewReason: needs_input` (a `running`-only transition, mirroring
  `to_review`), and it's `canReturnToRunning` so a subsequent `to_in_progress` clears it.
- **Surface it** at a glance:
  - `fleet task ls` prints a distinct marker for `needs_input` cards (e.g. `🔵 needs-input` in the
    state column) so the architect spots blocked cards in one scan.
  - the board card tile (`web-ui/src/components/board-card.tsx`) renders a `needs-input` badge
    distinct from ordinary review — the one justified board-UI touch, because a CLI cannot render a
    glanceable board.
- **Why not a whole new column state:** `awaiting_review` already halts the agent and asks for human
  attention; `needs_input` is a *reason* refinement, not a new lifecycle state. Keeping it a
  reviewReason avoids a board-column migration and keeps the change additive.

This closes the loop: the architect scans `fleet task ls`, sees `🔵 needs-input` on a card, reads it
with `fleet task tail <id>`, and answers with `fleet task say <id> "…"`.

---

## 9. Observe (tail) — sequence around card 4934b

Card `4934b` is landing the read-only transcript **render** (the blank-pane fix). This doc adds only
the **CLI verb** on top of the same locator so the headless architect (which reads via Bash, not the
web-ui) can observe too:

- `fleet task tail <id> [--lines N | --since 3m] [--json]` — resolve the card's `agentSessionId`,
  call a new `kanban` read that uses `locateAgentTranscript` (`agent-transcript-locator.ts`) to find
  the on-disk `.jsonl`/rollout, parse the last N lines (or since a relative time), and print a
  compact transcript. Agent-agnostic (Claude `.jsonl` + Codex rollout), works for **ended/pruned**
  cards because it reads the transcript, not the PTY.
- **Dependency:** reuse whatever transcript-read tRPC/parse 4934b introduces rather than duplicating
  it. If 4934b lands a server-side transcript reader, `tail` is a thin CLI over it; if not, `tail`
  introduces the reader and 4934b's panel consumes it. Coordinate at implementation time — do not
  build two parsers.

---

## 10. Cost analysis (cross-cutting goal)

The pilot's pain is session-limit burn. Three levers, compounding:

1. **Per-card model (§7).** Today *every* CLI-agent card runs on the default (effectively the most
   capable/expensive model). Routing research/scouting cards to **Haiku** and only hard design cards
   to **Opus**, with **Sonnet** as the default, cuts the dominant cost line directly. This is the
   single biggest win because it applies to *every* card.
2. **Change-index priming (§6).** The second cost sink is *re-discovery*: each impl agent spins up
   Opus sub-agents to re-learn the codebase. Priming a card with "read prior diff `<ref>` in
   `<files>` first" replaces an open-ended sweep with a targeted read — fewer sub-agent turns, on a
   cheaper model.
3. **Anti-research guardrail in `AGENTS.md`.** A one-paragraph rule in each child repo's `AGENTS.md`:
   *"Do not launch broad codebase-discovery sub-agents. Start from the change-index reference in your
   prompt and the component map; escalate to exploration only if that's insufficient, and say so."*
   This makes the primed-context path the default rather than the exception.

Together: (1) lowers the price of every card, (2) lowers the *volume* of expensive discovery, (3)
enforces (2). They are independent — each ships and pays off alone — but reinforce each other.

---

## 11. Phased, prioritized card breakdown

Sequenced by **what unblocks the architect's seat fastest**. Each phase is independently valuable and
testable.

| Phase | Card | Scope | Depends on | Priority |
|---|---|---|---|---|
| **O** | *4934b (in flight)* | read-only transcript render (blank-pane fix) | — | landed-ish |
| **O2** | `fleet task tail` | CLI transcript read for the headless architect | reuse 4934b's reader (§9) | after O |
| **S1** | `fleet task say` + bracketed-paste delivery + liveness guard | **architect→agent steering** | existing `sendTaskSessionInput` (none) | **1 — highest** |
| **S2** | `needs_input` reviewReason + `to_needs_input` hook + `ls`/tile surfacing | **agent→architect signal** | schema (additive) | **2** |
| **G** | anti-research guardrail paragraph in each child repo's `AGENTS.md` (§10.3) | cost lever, **zero code** | — | **ships now** |
| **C1** | per-card `agentModel`: schema → launch pass-through → `kanban --agent-model` flag → `fleet task create --model` | cost lever (§7), the reliable half | schema (additive) | 3 (parallel) |
| **C1b** | per-card `agentThinking`: `--think` mapping to each adapter's native knob | cost lever, blocked on **D-C** | C1 + D-C resolved | 3 — fast-follow |
| **C2** | `fleet-kanban/.claude/settings.json` default + create-dialog surfacing | defaults + UI | C1 | 3 (parallel) |
| **R1** | change-index skeleton auto-stamp at done-time + `fleet task index ls/find` | Record (b) + Scope read | — | 4 (parallel) |
| **R2** | change-index enrichment (`index add --card`, upsert) + `AGENTS.md` wrap-up contract | Record (a) hybrid | R1 | 4 |

**Dependency notes / link the cards:**
- **S1 → S2** ship as a pair (the channel is only useful bidirectionally) but S1 lands first and is
  independently demoable (steer a running card).
- **C1 → C1b → C2**, **R1 → R2** are internal chains; the **S**, **C**, **R** tracks are mutually
  parallelizable after O. **C1b** is gated on open decision **D-C** (native thinking knob), so C1
  (`--model`, rock-solid) ships without waiting on it.
- **G** has no code dependency and lands immediately — don't hold a free cost lever behind the R track.
- Do **S first**: it's the priority gap, has zero new transport (substrate exists), and gives the
  architect its first real control.

---

## 12. Test strategy (two-tier, RED-first)

Per the repo's tiers: **BDD user-facing surface tests** for the CLI verbs and card states, **unit
tests** for the pure transforms. Write RED first.

**Unit (pure, fast):**
- `session-state-machine.test.ts` — `to_needs_input` from `running` → `awaiting_review/needs_input`;
  no-op from other states; `to_in_progress`/`prompt-ready` clears `needs_input`
  (`canReturnToRunning`). *(named for the S2 transition intent)*
- adapter arg-mapping tests (`agent-session-adapters.test.ts`) — given `agentModel`/`agentThinking`,
  claude pushes `--model` + the thinking knob, codex pushes `--model` + `-c
  model_reasoning_effort=`; an explicit user `--model` in `input.args` wins (`hasCliOption` guard).
- change-index tests — `add` appends one valid JSONL line; `find` ranks by `area`/`files`/`summary`
  token match; hybrid upsert-by-`cardId` replaces the skeleton, doesn't duplicate.
- contract parse tests — `board.json`/`sessions.json` written *before* `agentModel`/`needs_input`
  existed still parse (additive/optional guarantee).

**BDD / surface (drive the real seam):**
- `fleet task say` — start a card on an ephemeral isolated instance (unique random port, **never**
  3500/3484; throwaway `CLINE_HOME="$(mktemp -d)/cline"`, **never** `.fleet/cline`), `say` a message,
  assert it reaches the session (Cline path: input recorded; PTY path: bytes written / prompt
  advanced). Assert `say` on an ended card returns the resume hint.
- `fleet task ls` shows `needs-input` for a card whose agent hit a permission prompt (simulate via a
  `to_needs_input` hook ingest), and reverts after `say`.
- `fleet task create --model haiku --think low` — card persists `agentModel`/`agentThinking`, and a
  started session launches with the mapped native args (assert on the spawned argv).
- `fleet task tail <id>` prints the last N transcript lines for both a live and an **ended** card
  (the ended case is the regression that motivates it).

**Harness discipline (from `AGENTS.md`):** verify **only** on an ephemeral, isolated instance —
`PORT=$((3600 + RANDOM % 300))` (unique, **never** 3500 or 3484) and a throwaway
`CLINE_HOME="$(mktemp -d)/cline"` (**never** `~/code/repos/tools/.fleet/cline`), launched with
`--no-open --skip-shutdown-cleanup`. **3500 is the LIVE dogfood board that hosts the architect and
every card, including the session running the test** — booting/killing a test instance there is the
self-destruct that has repeatedly cost us work. 3484 is the product board and equally off-limits.
When done, `kill` only your own pid and `rm -rf` the throwaway home; kill child `claude` procs then
the server. Scrub `KANBAN_RUNTIME_PORT` before running `middleware.test`/committing (see the
pre-commit port-env memory).

---

## 13. Open decisions (each with a recommendation)

- **D-A · change-index identifier: commit SHA vs PR #.** Depends on how cards land. Today fleet cards
  land as **branch commits in a worktree** (auto-review `commit` mode), not PRs — so a SHA is
  available at done-time and a PR # often is not. **Recommend: store `ref` as the commit SHA by
  default, allow `#<n>` when a card lands via PR** (auto-review `pr` mode). The field is a free
  string tagged by shape (`^[0-9a-f]{7,40}$` = SHA, `^#` = PR).
- **D-B · steer-injection mechanism.** Options: raw `writeInput` bytes, bracketed-paste submission,
  or a per-agent "inject" affordance. **Recommend: bracketed-paste submission via the existing
  `sendTaskSessionInput`** — no new transport, reuses `toBracketedPasteSubmission`, and the paste
  markers stop mid-generation interleave from corrupting the prompt. Revisit only if an agent CLI
  mishandles bracketed paste.
- **D-C · thinking-level vocabulary.** Options: agent-native strings (leaky), or a neutral enum.
  **Recommend: neutral `none|low|medium|high`** in the schema, mapped per adapter. Confirm the claude
  build's actual thinking knob before wiring C1 (env vs flag vs output-style); the neutral enum means
  that mapping can change without a wire/schema change.
- **D-D · model defaults.** **Recommend: Sonnet default; Opus for hard design cards; Haiku for
  research/scouting.** Settings default = Sonnet (safety net); the architect overrides per card. Use
  the current model ids (Opus 4.8 / Sonnet 5 / Haiku 4.5) but store whatever the pilot configures —
  the field is a free string so new model ids need no code change.

---

## 14. Risks, out-of-scope

**Risks:**
- **PTY steer fragility.** Injecting into a live PTY mid-turn can still be dropped by some CLIs.
  Mitigation: bracketed paste + `--submit` semantics; document that `say` targets a prompt-ready
  session best, and pair with the `needs_input` signal (which *is* prompt-ready).
- **`api-contract.ts` ripple.** New card/session fields and enum members touch wire + on-disk
  formats. Mitigation: strictly additive/optional; parse-old-data tests (§12).
- **Change-index rot / conflicts.** A shared list invites merge conflicts and staleness. Mitigation:
  JSONL append (line-level, conflict-resistant); hybrid writer so records exist even when agents
  forget; it's advisory (priming), never load-bearing.
- **Coordination with 4934b.** Two transcript parsers if O2 and 4934b diverge. Mitigation: §9 — one
  reader, consumed by both.

**Out of scope (this doc):**
- The architect *persona* (Phase D) — how the overseer *behaves* as a lead architect. This doc gives
  it controls, not judgment.
- The production-line dashboard (Phase E).
- Native board aggregation to replace the `fleet` CLI (explicitly rejected — the CLI route is the
  design).
- Multi-turn conversational memory for the architect chat itself (separate concern from card state).

---

## 15. Ready for `/implement`

Dispatch order: **G (`AGENTS.md` guardrail)** ships now (zero code), alongside **S1 (`fleet task
say`) → S2 (`needs_input` signal)** as the priority channel; then **O2 (`fleet task tail`)** once
4934b's reader is known, with **C1 (per-card `--model`)** and **R (change-index)** in parallel.
**C1b (`--think`)** follows C1 once D-C is resolved. Each card above is independently testable per §12.
