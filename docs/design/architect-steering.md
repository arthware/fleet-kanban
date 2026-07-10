# Architect Steering — an overarching agent that runs the software production line

**Status:** design · **Owner:** Arthur · **Builds on:** durable sessions (Phases 1–3, landed) ·
**Vision:** `fleet/docs/kanban-ui-epic.md`

> The human sits in the pilot seat and steers **one** agent — the architect. The architect steers
> the coding agents. The board makes the whole production line transparent.

---

## 1. Context

We run an agent-driven SDLC across several repos. Today the "lead architect / feature-owner" role —
scope work into cards, dispatch impl agents, observe them, review, re-steer — is played **manually**
by a Claude Code session rooted at the parent directory. This design productizes that role into a
board-native **overarching agent**.

It rests on durable sessions (already landed): an overseer can only observe and re-steer sessions
that survive crashes and restarts. That substrate now exists.

Competitive note: `unleashd`/`oompa` put a *human* in the overseer seat or use a *dumb* reviewer
split. An **AI lead-architect** is the whitespace this design occupies.

## 2. Principles

- **agent config = f(cwd).** The architect runs with cwd = the parent dir, so it loads the
  parent-level `.claude/` + `AGENTS.md` + `CLAUDE.md`. Impl agents run with cwd = their repo and load
  that repo's config. No cross-contamination.
- **The architect dispatches; it never hand-codes in sub-repos.** Edits are the impl agents' job, in
  their own worktrees. (Same rule the manual architect follows today.)
- **Card = durable state; session = ephemeral compute.** A card outlives the process that works it.
- **Human in the pilot seat.** The human steers the architect; the architect steers the impl agents.
  Every side-effectful step the architect proposes is visible and interruptible.

## 3. Architecture

```
./            architect workspace — cwd here; parent config; reads all sub-repos; dispatches & steers
./repo1       impl workspace — cwd here; repo1 config; agents run in repo1 worktrees
./repo2       impl workspace — cwd here; repo2 config
```

**Architect detection — auto-detect by containment (decided).** A registered workspace whose
`repoPath` *contains* the `repoPath` of other registered workspaces is the architect/overseer. No
explicit flag — it falls straight out of the `./` over `./repoN` nesting. Concretely, from the
current board: `tools -> ~/code/repos/tools` contains `fleet-kanban -> …/fleet-kanban`, so `tools`
is the architect and `fleet-kanban` is an impl repo.

The architect workspace gets three powers a normal repo workspace does not:
1. **Parent config** — its agent loads the parent-dir config (already true by cwd).
2. **Cross-repo visibility** — its surface sees the cards + impl-agent status of all contained
   workspaces.
3. **Cross-repo dispatch** — its chat can create/start/steer impl cards in the contained workspaces
   (today only the `fleet` CLI can).

## 4. Layers (phases)

| Phase | Layer | Delivers |
|---|---|---|
| **A** | Overarching agent skeleton | detection + parent-rooted agent + cross-repo visibility + dispatch |
| **B** | Observe | tail a running agent's live conversation (verb + board panel) |
| **C** | Steer | send an instruction to a running impl agent from the architect chat |
| **D** | Architect persona | the overseer *behaves* as lead-architect: scope → plan → dispatch → review → re-steer, phase-aware |
| **E** | Production-line dashboard | pilot-seat overview: in-flight / blocked / awaiting-your-decision |

Each phase is independently valuable and testable. Ship A → B → C → D → E.

### What exists today vs. the gap
- **Exists:** parent registered as a workspace; `fleet` CLI cross-repo dispatch; transcript-locator
  (Card 3.2); durable sessions; per-card hook-activity capture.
- **Gap:** containment detection; overseer chat semantics; *chat-driven* cross-repo dispatch;
  observe/steer verbs surfaced in the chat; architect persona; dashboard.

## 5. Phase A — Overarching agent skeleton (detailed)

**Card A1 — Detect the architect workspace by containment.**
- *Scope:* pure function over the workspaces index: given the registered `{workspaceId → repoPath}`
  map, return which workspace (if any) is the architect and the set of impl workspaces it contains.
  Deepest containing path wins; a workspace never contains itself; no registered parent → no
  architect (all peers).
- *Accept:* `tools` containing `fleet-kanban` ⇒ architect = `tools`, children = `[fleet-kanban]`.
  Flat/peer layout ⇒ no architect. Nested three-deep resolves to the nearest parent.
- *Tests (RED):* a containment table (peer, one-child, multi-child, three-deep, path-prefix false
  positives like `…/tools` vs `…/tools-x`).

**Card A2 — Root the architect agent at the parent + load parent config.**
- *Scope:* when an agent starts for the architect workspace, cwd = the parent `repoPath`, so it
  resolves the parent-level `.claude/`, `AGENTS.md`, `CLAUDE.md`. Confirm it does NOT descend into a
  child repo's config.
- *Accept:* the architect agent's effective instructions come from `./`, an impl agent's from
  `./repoN`.
- *Tests (RED):* config-resolution unit — architect resolves parent config, impl resolves repo
  config, given the A1 classification.

**Card A3 — Cross-repo visibility on the architect surface.**
- *Scope:* the architect workspace's board/chat surface lists the cards + live impl-agent state
  (column, session state, latest hook activity) of every contained workspace, not just its own.
- *Accept:* opening the architect surface shows `fleet-kanban`'s cards and their agent states.
- *Tests (RED):* aggregation unit over multiple child workspaces; surface/tRPC test that the
  architect view returns children's cards.

**Card A4 — Chat-driven cross-repo dispatch.**
- *Scope:* from the architect surface, create + start an impl card in a *child* workspace (the thing
  `fleet task create --repo … --start` does today), targeting the child by workspaceId.
- *Accept:* the architect dispatches a card into `fleet-kanban`; it appears there and its impl agent
  runs in a `fleet-kanban` worktree with `fleet-kanban` config.
- *Tests (RED):* dispatch routes the card to the child workspace; the child agent's cwd/config is the
  child's, not the parent's.

## 6. Phase ordering rationale

Phase A is the structural foundation — without a parent-rooted, cross-repo-aware overseer there is
nowhere for observe/steer/persona to live. B (observe) buys transparency (the "overview of the
production line") on the smallest substrate we already have. C (steer) adds the write path. D
(persona) makes the overseer actually *lead*. E (dashboard) is the pilot-seat cockpit. Build in
order; each phase stands on its own.
