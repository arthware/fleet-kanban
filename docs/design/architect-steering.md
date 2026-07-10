# Architect Steering — an overarching agent that runs the software production line

**Status:** Phase A **landed** (via the CLI-tools route) · Phase B (observe) next, partially blocked
by a transcript bug · **Owner:** Arthur · **Builds on:** durable sessions (landed) ·
**Vision:** `fleet/docs/kanban-ui-epic.md` · **Last updated:** 2026-07-10

> The human sits in the pilot seat and steers **one** agent — the architect. The architect steers
> the coding agents. The board makes the whole production line transparent.

---

## 1. Context

We run an agent-driven SDLC across several repos. Today the "lead architect / feature-owner" role —
scope work into cards, dispatch impl agents, observe them, review, re-steer — is played **manually**
by a Claude Code session rooted at the parent directory. This design productizes that role into a
board-native **overarching agent**.

It rests on durable sessions (landed): an overseer can only observe and re-steer sessions that
survive crashes and restarts. That substrate now exists.

Competitive note: `unleashd`/`oompa` put a *human* in the overseer seat or use a *dumb* reviewer
split. An **AI lead-architect** is the whitespace this design occupies.

## 2. Principles

- **agent config = f(cwd).** The architect runs with cwd = the parent dir, so it loads the
  parent-level `.claude/` + `AGENTS.md` + `CLAUDE.md`. Impl agents run with cwd = their repo and load
  that repo's config. No cross-contamination.
- **The architect dispatches; it never hand-codes in sub-repos.** Edits are the impl agents' job, in
  their own worktrees. (Same rule the manual architect follows today.)
- **Thin wrapper; derive state.** fleet-kanban is a thin **view + remote-control** over agent CLI
  sessions (codex / claude / gemini). Conversation, live/ended, resumable — "derivable state" — is
  **derived from the CLI's own artifacts** (on-disk transcript, process state), not re-streamed or
  separately persisted. **Corollary (2026-07):** prefer surfacing the architect's cross-repo powers
  through the existing **`fleet` CLI injected as tools** over building bespoke board machinery — this
  is why Phase A landed the way it did (below).
- **Card = durable state; session = ephemeral compute.** A card outlives the process that works it.
- **Human in the pilot seat.** The human steers the architect; the architect steers the impl agents.
  Every side-effectful step the architect proposes is visible and interruptible.

## 3. Architecture

```
./            architect workspace — cwd here; parent config; reads all sub-repos; dispatches & steers
./repo1       impl workspace — cwd here; repo1 config; agents run in repo1 worktrees
./repo2       impl workspace — cwd here; repo2 config
```

**Architect detection — auto-detect by containment (landed).** A registered workspace whose
`repoPath` *contains* the `repoPath` of other registered workspaces is the architect/overseer. No
explicit flag. From the current board: `tools -> ~/code/repos/tools` contains
`fleet-kanban -> …/fleet-kanban`, so `tools` is the architect and `fleet-kanban` is an impl repo.
(Registry: `$CLINE_HOME/kanban/workspaces/index.json` — see `AGENT-OPS.md`.)

The architect workspace gets three powers a normal repo workspace does not:
1. **Parent config** — its agent loads the parent-dir config (by cwd). **Landed.**
2. **Cross-repo visibility** — sees the cards + impl-agent status of all contained workspaces.
   **Landed via the `fleet` CLI** (`fleet task ls`/`cat`), not native board-surface aggregation.
3. **Cross-repo dispatch** — create/start/steer impl cards in contained workspaces. **Landed via the
   `fleet` CLI** (`fleet task create --repo <child> --start`), injected as an architect tool.

**The CLI-tools route (what actually landed, and why).** Rather than build native board aggregation
and a native dispatch UI (the original A3/A4), we gave the architect agent the `fleet` CLI as tools
(its help is injected into the system prompt) and let it *see* and *dispatch* across repos through
the CLI. This follows the thin-wrapper principle, shipped far faster, and keeps board code small. The
native-UI versions of A3/A4 are now **optional polish**, not blockers.

## 4. Layers (phases) — roadmap

| Phase | Layer | Delivers | Status |
|---|---|---|---|
| **A** | Overarching agent skeleton | detection + parent-rooted agent + cross-repo visibility + dispatch + pinned architect chat | ✅ **landed** (via CLI-tools route) |
| **B** | Observe | read/tail a running (or finished) agent's conversation — verb + board panel | ⏳ **next** — partially blocked (see §7) |
| **C** | Steer | send an instruction to a running impl agent from the architect chat | later |
| **D** | Architect persona | the overseer *behaves* as lead-architect: scope → plan → dispatch → review → re-steer, phase-aware | later |
| **E** | Production-line dashboard | pilot-seat overview: in-flight / blocked / awaiting-your-decision | later |

Each phase is independently valuable and testable. B is the smallest next increment on the substrate
we already have.

## 5. Phase A — what landed

| Card | Scope | Landed as |
|---|---|---|
| **A1** Detect architect by containment | pure function over the workspace registry; deepest container wins; peers ⇒ no architect | `5adb544` |
| **A2** Root architect at parent + parent config | architect agent cwd = parent `repoPath`; loads parent `.claude/`/`AGENTS.md`/`CLAUDE.md`, not a child's | `5adb544` |
| **A3** Cross-repo visibility | architect *told* its sub-repos in its preamble (`503564e`) + `fleet task ls`/`cat` injected as tools (`8c20810`) — **CLI route, not native surface aggregation** | `503564e`, `8c20810` |
| **A4** Chat-driven cross-repo dispatch | `fleet task create/start` injected as architect tools (`8c20810`); architect dispatches into child repos via the CLI | `8c20810` |
| **A5** Pin architect chat, detached from project selector | the single overarching chat persists across project switches (was bound to one repo) | `9847778` |

Supporting substrate (durable sessions), landed earlier: resume groundwork `a76522c`, resume-by-id
`3b1e478`, reopen-resumes-or-starts-fresh `776568c`. Design note `3bdadbe`.

The token-efficient `fleet task` verbs (`ls`/`cat`, text not JSON) + `fleet help --agent` (curated,
instruction-style tool list injected into the architect prompt, incl. Linear access) live in the
**parent `fleet` CLI** and are what make the CLI-tools route ergonomic for the agent.

## 6. Phase ordering rationale

Phase A is the structural foundation — a parent-rooted, cross-repo-aware overseer with a persistent
chat. B (observe) buys transparency on the smallest substrate we already have. C (steer) adds the
write path. D (persona) makes the overseer actually *lead*. E (dashboard) is the pilot-seat cockpit.

## 7. Current state & known issues (2026-07-10)

**Working:** architect detected + rooted at parent; pinned architect chat survives project switches;
architect can list and dispatch cards across repos via the injected `fleet` CLI (verified live on the
dogfood board, port 3500).

**Blockers/bugs on the path to Phase B (observe):**

1. **No read-only transcript view (primary).** A Claude/Codex card renders its conversation *only*
   through a **live PTY**, gated on `pid != null` for `in_progress`/`review`. The moment the session
   ends (→ done, → review after the turn, PTY exit, or worktree removed) the terminal unmounts and
   **nothing renders the persisted transcript** — the card's detail pane goes **blank**, even though
   the transcript is still on disk. Observe (B) needs a transcript-derived read path
   (`agent-transcript-locator.ts` already resolves the file via `agentSessionId`), agent-agnostic
   (Claude `.jsonl` + Codex rollout), rendered read-only when the PTY is gone.
2. **Missing `.jsonl` after resume (data durability).** For some *resumed/reopened* cards the
   top-level `<agentSessionId>.jsonl` is gone while the companion `<agentSessionId>/` dir (subagents,
   tool-results) remains → that conversation isn't recoverable. Our code never deletes transcripts,
   so this is the CLI's own handling on resume; must be understood before relying on transcript-read
   for observe.
3. **`fleet kanban stop`/`restart` are unreliable.** Silent no-ops (stale/empty pidfile → nothing
   signalled), and the server doesn't reap its `claude` children on shutdown (orphans that ignore
   SIGTERM). Fix: pid-tracking + child-reaping, or adopt the launchd daemon (`fleet kanban daemon
   install`) so restart is one supervised operation.

**Next step for B:** build a read-only, transcript-derived conversation view (and a `fleet task tail
<id> [--lines N | --since 3m]` verb) that works for ended/cleaned-up cards and both agent types —
resolving issue #2 enough to trust the on-disk transcript. Resume-on-open is a separate *steer* (C)
affordance, not the observe path.
