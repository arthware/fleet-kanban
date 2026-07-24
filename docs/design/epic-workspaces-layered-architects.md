# Epics as scoped workspaces with layered Senior-Architect / Epic-Owner sessions

**Ref / slug:** This card set no external issue ref, and it dictated the deliverable filename
explicitly. Following that instruction over the numeric-id convention, the doc lives at the named path
`docs/design/epic-workspaces-layered-architects.md` (ref-less descriptive slug
`epic-workspaces-layered-architects`). If a Linear/GitHub issue is later attached, rename to
`<ISSUE>-epic-workspaces-layered-architects.md`.

**Status:** design (no implementation in this card) · **Base:** `production-line` ·
**Implementation agent:** Gemini (Codex budget exhausted).

---

## Problem statement

We want to run large, ambiguous features ("epics") on an **isolated integration branch off
`production-line`**, decompose each into cards that land into that branch, keep the branch green, and
integrate the whole feature with **one PR `epic/<name> → production-line`** when it is done —
**without freezing mainline**: bugfixes and improvements keep flowing on `production-line` in
parallel.

```
main
└── production-line              ← mainline; bugfixes/improvements keep flowing
    └── epic/<name>              ← the epic integration branch (off production-line)
        ├── <cardA>-…            ← card worktrees, each branched off epic/<name>
        ├── <cardB>-…              their PRs target epic/<name>, not production-line
        └── …
```

Alongside the branch topology the operator wants a **layered agent hierarchy**:

- **Senior Architect** — the existing root-workspace home agent (today's `tools` architect). Sees all
  epics + mainline, decides which epics exist, spawns Epic Owners, drives `production-line` directly.
- **Epic Owner** (one session per epic) — scoped to the epic's integration worktree. Decomposes the
  epic into cards based off the epic branch, steers/lands them into the branch, keeps it integrated
  and green, opens the final `epic → production-line` PR, and **reports up** to the Senior Architect.

**Root cause / why it doesn't exist today.** The board already models a *home agent per workspace*
and an *architect* (§ next), but exactly **one** architect is resolvable (the outermost container),
the sidebar chat is pinned to that single identity, and there is no first-class notion of an epic —
so "a coordinator session per epic" and "an isolated integration branch per epic" have no home. The
missing concept is a **scoped epic workspace** whose home agent *is* the Epic Owner.

---

## What exists in the codebase

Prior-art SHAs read for this design (via `git show`):

| SHA | Area | What it establishes |
|-----|------|---------------------|
| `1f49ec3` | `src/core/home-agent-session.ts`, `review-notification.ts`, `runtime-api.ts` | #27789 Phase 2 — **one architect identity per workspace**, session id derived, not minted |
| `36f9d82` | `src/server/architect-workspace.ts` | Architect classification by path containment; home-agent preamble + fleet-tools assembly |
| `e9c73a2` | `src/server/workspace-registry.ts` | Workspace registration / listing / snapshot derivation |
| `83aaa59` | `src/workspace/task-worktree.ts` | Card worktrees created from a base-ref into a shared pool |
| `3359d75` | `src/prompts/append-system-prompt.ts` | Home-agent system prompt; architect preamble injection point |
| `9aa0d65` | `web-ui/src/state/board-state.ts` | Card reducer that **silently drops any un-threaded field** |

Concrete findings that decide the design:

**Workspaces are keyed by path, not repo identity.**
`src/state/workspace-state.ts` keys the index by `repoPath` (`repoPathToId`, `ensureWorkspaceEntry`
at `:711`), and the id base is the **path basename** (`toWorkspaceIdBase` `:669`). `resolveWorkspacePath`
(`:839`) resolves the workspace via `git rev-parse --show-toplevel`, which for a **linked worktree
returns the worktree's own path** — so a worktree of an already-registered repo resolves to a
*distinct path* → a *distinct workspace id*. Nothing assumes one-workspace-per-repo.

**Card worktrees live in a shared pool, never nested in the source checkout.**
`getTaskWorktreePath` (`task-worktree.ts:237`) → `join(getTaskWorktreesHomePath(), <taskId>, <repoLabel>)`
= `<CLINE_HOME>/worktrees/<taskId>/<repoLabel>` (`workspace-state.ts:179`). Worktree creation
(`ensureTaskWorktreeIfDoesntExist` `:674`) runs `git worktree add -b <branch> <poolPath> <baseCommit>`,
where `baseCommit` is `rev-parse` of the card's `baseRef` **resolved in the workspace's repo path**.
The card's branch name is deterministic (`deriveTaskBranchName`, wired at `workspace-api.ts:382`; see
`docs/design/36ab1-branch-at-worktree-creation.md`).

**The home-agent identity is already per-workspace and derived.**
`createHomeAgentSessionId(workspaceId)` (`home-agent-session.ts:12`) returns `__home_agent__:<workspaceId>`
— the `agentId` suffix was dropped in #27789, so identity is *purely* a function of the workspace.
The conversation id is UUIDv5 over `(workspaceId, agentId)` (`terminal/home-agent-session-id.ts`), so
it is restart-stable. The only shipped reaping is **benign for us**: `partitionWorkspaceSessions`
(`workspace-state.ts:579`) drops a home-agent record only when its `workspaceId` component ≠ the
workspace it is stored in (the "foreign bleed" fix), or when derived liveness is `gone`. It does
**not** reap "non-architect" home agents — so additional per-epic home agents survive by construction.

**The architect is one, resolved by containment.**
`classifyArchitectWorkspace` (`architect-workspace.ts:54`) picks the **outermost containing**
workspace as the sole architect; `resolveArchitectHomeAgentWorkspaceId` (`:91`) returns it (or the
active workspace on a flat board). Only the architect workspace receives the fleet-tools + sub-repo
preamble (`resolveHomeAgentContext` `:317`, `buildArchitectContextPreamble` `:161`). The sidebar chat
is pinned to that single id (`resolveAgentChatWorkspace`, `web-ui/src/runtime/agent-chat-workspace.ts`),
and the architect is hidden from the project list (`selectArchitectAwareProjects` `:216`).

**The steering channel is session-id-addressable.**
`sendTaskSessionInput` / `writeInput` (`runtime-api.ts:150`) inject a message into any `taskId`
(including a home-agent session id) scoped to a workspace. The review-ping already targets
`__home_agent__:<architectWorkspaceId>` from a sub-repo card (`review-notification.ts:19`,
`runtime-api.ts:233`) — cross-workspace delivery is a solved pattern.

**`fleet xtools land` is base-ref-aware** (`fleet/xtools/land`): it reads the card's `baseRef`
(`--base` defaults to it, else `production-line`) and fast-forwards *that* branch in the target repo
checkout, falling back to rebase on divergence.

**The card reducer silently drops un-threaded fields.**
`normalizeCard` (`board-state.ts:168`) hand-copies each known field; anything not explicitly read is
lost even if the server persisted it. Any new server→UI field must be threaded here.

---

## Proposed solution

### Verdict on the core hypothesis: **CONFIRMED (with one required extension).**

> *An epic = the epic's integration worktree registered as its own kanban workspace, whose home agent
> IS the Epic Owner.*

The registry keys by path, a worktree resolves to its own path, the home-agent identity is
per-workspace and derived, and the shipped reaper leaves sibling home agents alone. So **"a session
per epic" genuinely reduces to "a workspace per epic"** — the Epic Owner comes essentially for free,
and cards created in that workspace fork from / land into the epic branch with no new worktree code.

**The one thing that is *not* free:** an Epic Owner is not "the architect" under pure containment
(the architect is the single outermost container). The Epic Owner **role** — fleet tools + a scoped
role preamble + hidden-from-project-list + reachable-via-session-dropdown — must be granted by an
**explicit epic marker on the workspace**, not inferred from nesting. This is a deliberate *extension*
of the architect role machinery (Article 1: extend, don't clone), not a second identity system.

### The six answers, concretely

**1. Worktree-of-a-registered-repo as a distinct workspace — YES.** Keyed by path
(`repoPathToId`), id from basename, resolved via `--show-toplevel` (returns the worktree path). The
epic integration worktree at, say, `<CLINE_HOME>/epics/<name>/fleet-kanban` registers as workspace id
`fleet-kanban` (collision-suffixed if the basename repeats — `createWorkspaceId` `:695`). No repo-identity
collision exists because identity is path, not `.git`.

**2. Card worktrees fork from the epic branch and are NOT nested.** Cards created in the epic
workspace default `baseRef` to the epic workspace's current branch (`resolveTaskBaseRef`), i.e.
`epic/<name>`; their worktrees are created into the shared pool `<CLINE_HOME>/worktrees/<taskId>/…`,
resolved from the epic worktree's object store (shared `.git`), so `git worktree add -b <branch>
<pool> epic/<name>` forks correctly off the epic branch. **Directory layout:**

```
<CLINE_HOME>/
  epics/<name>/fleet-kanban        ← epic integration worktree  (checked out on epic/<name>)
  worktrees/<cardA>/fleet-kanban   ← card worktree (branch <cardA>-…, forked off epic/<name>)
  worktrees/<cardB>/fleet-kanban   ← card worktree (forked off epic/<name>)
```

The epic worktree is placed **under `<CLINE_HOME>/epics/`** — not inside the source repo (source
repos stay pristine) and not inside the card pool (that is for cards). Card worktrees are physically
siblings in `<CLINE_HOME>/worktrees/`, so they are **never nested inside** the epic checkout — the
invariant holds by construction, not by a guard.

**3. Multiple concurrent home agents — supported, built ON #27789.** Each epic workspace has a
distinct, path-derived `workspaceId`, hence a distinct home-agent session id
`__home_agent__:<epicWorkspaceId>`. It cannot collide with the root architect
(`__home_agent__:<architectWorkspaceId>`) or another epic (distinct ids). It is restart-stable
(workspaceId persisted in the index; conversation id is deterministic UUIDv5). The reaper
(`partitionWorkspaceSessions`) keeps it because its `workspaceId` component matches its own
sessions.json — it does not resurrect the #27789 duplicate/stale class of bug. **What must change:**
nothing in the identity/session-pid logic assumes a single home agent *per instance* — the assumption
lives only in the **UI chat resolver** (`resolveAgentChatWorkspace` collapses to one architect) and
in **role grant** (`resolveHomeAgentContext` grants tools only to the classification architect). Both
are addressed below; the session-id layer already supports N.

**4a. Board grouping — mark the epic on the workspace (recommended), not the card.** An epic's
identity/branch/owner belongs to the **epic workspace** (one source of truth, Article 3). The
authority is a small `epic` descriptor in the workspace **meta** (`workspace-state.ts` meta file):
`{ name, branch: "epic/<name>", base: "production-line" }`. It is surfaced additively on
`RuntimeProjectSummary` (`epic?: {...}`) via `buildProjectsPayload`
(`workspace-registry.ts:377`) and consumed by the UI to **badge the epic board** and populate the
session dropdown. Because the epic **is** its own board, every card on it belongs to that epic — a
per-card tag would only mirror the workspace (Article 3) and is *not* needed for v1.

> If a later unified/cross-epic view wants per-card badges on a mixed board, add an optional `epic`
> string to the card and **thread it through `normalizeCard`** (`board-state.ts:168`) — the reducer
> drops any field not hand-copied there (that gotcha is exactly why this is called out). v1 does not
> add a card field.

**4b. Session dropdown.** Generalize the single pinned chat into a **selectable set**. Today
`resolveAgentChatWorkspace` returns `architectWorkspaceId ?? currentProjectId`. Extend it to expose
the list `[SeniorArchitect] ∪ [each epic workspace]` and let a **simple dropdown** (Radix `Select`,
per web-ui stack) pick which home-agent workspace the sidebar chat is bound to — defaulting to the
Senior Architect. The chosen id feeds the existing `use-home-agent-session` hook, which is *already*
keyed by workspace (its `desiredTaskIdByWorkspaceRef` etc. are per-workspace maps), so no new session
lifecycle is needed — only the selection input. Dropdown only; no fancier navigation for v1.

**5. Layer semantics (roll-up / steer-down) — reuse the steering channel.**
- **Roll-up (Epic Owner → Senior Architect):** the exact `review-notification` path, generalized —
  the Epic Owner sends a compact epic summary to `__home_agent__:<architectWorkspaceId>` (scoped to
  the architect workspace) via `sendTaskSessionInput`/`writeInput`. The summary is cheap and already
  computable: **cards-by-column** from `summarizeProjectTaskCounts` (`workspace-registry.ts:314`) plus
  the epic branch's integration/CI state (from `gh`/`git` the Epic Owner already runs). No new push
  machinery.
- **Steer-down (Senior Architect → Epic Owner):** the same channel targeted at
  `__home_agent__:<epicWorkspaceId>` scoped to the epic workspace. Addressing a different home-agent
  id is the whole mechanism — nothing new.
- **Awareness seed:** extend `buildArchitectContextPreamble` (`architect-workspace.ts:161`) so the
  Senior Architect's preamble lists **active epics** (name, branch, board path) beside the sub-repo
  list, and so an **epic-marked** workspace's home agent gets an *Epic Owner* preamble (its branch,
  base `production-line`, land-into-epic instruction, and "report up to the Senior Architect").

**6. Epic lifecycle — mostly convention + one CLI helper; minimal new server code.**

| Operation | What happens | New code / convention |
|-----------|--------------|-----------------------|
| **Create epic `<name>`** | `git branch epic/<name> production-line` + push; `git worktree add <CLINE_HOME>/epics/<name>/<repo> epic/<name>`; register it as a workspace with `epic` meta; its home agent boots as the Epic Owner | **`fleet` CLI helper** `fleet epic create` (git + register + set meta). Registration & meta = small server addition |
| **Add a card to the epic** | Create the card in the epic workspace (`--project-path <epic worktree>`); `baseRef` defaults to `epic/<name>`; PR targets `epic/<name>` | **Convention** — existing `task create --base-ref` + PR-mode base |
| **Land a sub-card** | `fleet xtools land <card> --repo <epic worktree> --base epic/<name>` merges the card PR and **fast-forwards the epic branch in the epic worktree** | **Already works** — base-ref-aware land; invariant: the epic worktree stays on `epic/<name>` and fast-forwardable |
| **Complete the epic** | Open one PR `epic/<name> → production-line`; on merge, retire the epic workspace + remove the worktree | **`fleet` CLI helper** `fleet epic complete` (PR + deregister + `git worktree remove`) |

### Component / data-flow sketch

```
Senior Architect (home agent @ __home_agent__:<tools>)          ── steer-down (writeInput) ─┐
   │ decides epics, drives production-line                                                  │
   ▼ fleet epic create <name>                                                               ▼
[git] epic/<name> off production-line ──▶ [worktree] <CLINE_HOME>/epics/<name>/<repo>   Epic Owner
   │                                          │ registered as workspace + epic meta    (home agent @
   │                                          ▼                                      __home_agent__:<epic>)
   │                                   its OWN kanban board (epic cards)                     │
   │   roll-up summary (writeInput → architect home agent) ◀── cards-by-column, CI ─────────┤
   │                                          │ task create --base-ref epic/<name>          │
   │                                          ▼                                             │
   │                             card worktrees in <CLINE_HOME>/worktrees/… (off epic/<name>)
   │                                          │ PR → epic/<name>; fleet xtools land --base epic/<name>
   ▼                                          ▼
production-line ◀────────── one PR: epic/<name> → production-line (fleet epic complete) ─────┘
```

### Identity design (vs #27789)

#27789 collapsed the architect to **one derived identity per workspace** and added a reaper that
enforces "a home-agent record lives only in its own workspace's sessions.json" + "reap `gone`". This
design **adds workspaces, not identity axes**: N home agents = N workspaces, each with its single
derived `__home_agent__:<workspaceId>`. We are not re-introducing the per-viewed-workspace or
per-agent multiplicity #27789 removed — every epic id is stable, distinct, and self-homed. The only
generalization is that the *architect role* (tools + preamble + hidden-from-projects + chat-target) is
no longer uniquely the containment architect: an **explicit epic marker** confers the Epic-Owner
variant of that role. Classification stays the single authority for the *Senior* Architect.

### Minimal UI — epic context lives at the board level, not on the card

Operator-confirmed shape (resolves open-Qs 2 & 5): an epic is a **context you switch into**, not a tag
stamped on every card. Three surfaces, and — by design — **zero change to the card face**.

1. **Epics nav band (left panel).** Alongside `Senior Architect` (the default/home context = mainline
   `production-line` board) and `Projects`, add an **Epics** group listing each active epic (from
   `RuntimeProjectSummary.epic`). Each row shows a compact **roll-up**: cards-by-column counts +
   epic-branch CI (e.g. `card-types  3·2·1  ✓`) — so the Senior Architect sees epics in flight
   **without switching in**. Epic workspaces stay hidden from the plain `Projects` list (reuse the
   `selectArchitectAwareProjects` hide path). The roll-up is **not** injected as tiles into the mainline
   Backlog/In-Progress/Review columns — mainline columns stay pure mainline.
2. **Coupled context switch.** Selecting an epic row switches **board + chat together**: the board binds
   to the epic workspace (its own cards) and the chat rebinds to that epic's Epic-Owner home agent. One
   "context" concept — no split-brain where the board shows mainline while the chat talks to an epic
   owner (so **no** separate chat-only dropdown). The top bar flips from `production-line` to
   `epic/<name>`, showing the epic's **diff vs `production-line`** (a live "how big is this epic
   getting" signal) + an **Epic** badge.
3. **The card face is unchanged.** Every card on an epic board already belongs to that epic, so a
   per-card epic badge is redundant noise (Article 3) — PR badge, branch chip, Auto-PR, model chip,
   token footer all render exactly as today; the only difference (their PR base is `epic/<name>`) is
   implied by the board. A per-card `epic` field is added **only** for a future unified/cross-epic board
   that mixes contexts, and is the deferred seam that must be threaded through `normalizeCard`
   (`board-state.ts:168`). v1 does not touch the card.

**Epic graduation.** When an epic completes, its single `epic/<name> → production-line` PR appears as a
**normal card on the mainline board** — the epic graduates as one reviewable card, no special-casing.

---

## Technical rationale

- **Why workspace-as-epic over a new epic subsystem.** It reuses four existing concepts unchanged
  (path-keyed registry, per-workspace home agent, base-ref worktrees, base-ref land). The alternative
  — a bespoke "epic" entity with its own branch/session/board machinery — would clone all four
  (Article 1 violation) and re-introduce an identity axis #27789 just removed.
- **Why an explicit workspace marker over pure containment.** Containment yields exactly one
  architect by construction; overloading it to also mean "epic" would make nesting depth decide role
  and couple placement to semantics. An explicit `epic` meta flag is a single, legible source of truth
  and keeps the Senior Architect classification intact. Rejected: deriving epic-ness from a branch
  named `epic/*` — branch strings are mutable and not a stable role key.
- **Why workspace-level grouping over a per-card `epic` field (v1).** The epic *is* its own board, so
  a per-card tag mirrors the workspace (Article 3). We surface the marker on the project summary and
  badge the board; the card reducer stays untouched. The per-card field is specified as the *future*
  path for a unified view, with the `board-state.ts` threading gotcha called out so it is not missed.
- **Why reuse the steering channel for both directions.** Roll-up and steer-down are just messages to
  a home-agent session id — the review-ping already proves cross-workspace delivery. Building a
  separate epic-status bus would duplicate a working channel.
- **Risks.**
  - *Placement vs. classification:* if an epic worktree were placed **inside** the `tools` root it
    would be classified as an impl sub-repo and clutter the project list. Mitigation: place under
    `<CLINE_HOME>/epics/` (outside the tools tree) **and** hide epic-marked workspaces from the plain
    project list (reuse the `selectArchitectAwareProjects` hide path).
  - *Shared `.git` locking:* card worktrees and the epic worktree share one object store; concurrent
    `git worktree add` is already serialized by `withTaskWorktreeSetupLock` (`task-worktree.ts:220`).
  - *Land invariant:* `fleet xtools land --base epic/<name>` only fast-forwards correctly while the
    epic worktree stays checked out on `epic/<name>`; the Epic Owner must not repoint it. State this
    as a hard invariant in the Epic-Owner preamble.

---

## Open questions

1. **`fleet epic create/complete` home — `fleet` dispatcher vs. a kanban CLI subcommand?** The git +
   register + meta steps straddle both; leaning `fleet` for the git/topology parts and a small kanban
   runtime addition for register+meta.
2. **RESOLVED** — epic navigation is an **Epics nav band** in the left panel, and selecting an epic is
   a **coupled context switch** (board **and** chat rebind together to the epic workspace / Epic Owner).
   There is **no** separate chat-only dropdown. See "Minimal UI" above.
3. **Roll-up cadence.** On-demand (architect pulls via `fleet task ls`/`kanban status` scoped to the
   epic) vs. Epic-Owner-pushed on state change. v1: on-demand + a manual push; a scheduler is the
   deferred seam.
4. **Multiple epics of the *same* repo simultaneously** — basename collision handling
   (`createWorkspaceId` suffix) works, but the epic **name** should drive the workspace id for
   legibility (e.g. label the worktree dir `<repo>@<epic-name>`). Decide the naming scheme.
5. **RESOLVED (v1)** — the left-panel epic roll-up shows **cards-by-column counts + epic-branch CI
   conclusion** (e.g. `card-types  3·2·1  ✓`). Per-card gate-status aggregation is deferred.

---

## Disposition

**Split into build cards** (implementation agent: **Gemini** — Codex budget exhausted). All three are
small and upstreamable; the machinery is deliberately thin.

- **Card 1 — Epic workspace marker + role grant (server + prompt).** Add the optional `epic` descriptor
  to workspace meta and to `RuntimeProjectSummary` (additive, Article 7); thread it through
  `buildProjectsPayload`; extend `resolveHomeAgentContext` / `buildArchitectContextPreamble` to grant
  the **Epic Owner** role (fleet tools + epic preamble) to an epic-marked workspace and to list active
  epics in the Senior Architect preamble; hide epic workspaces from the plain project list.
  *Module tests through the public resolvers.*
- **Card 2 — Epics nav band + coupled context switch (web-ui).** Add an **Epics** group to the left
  panel listing active epics (from `RuntimeProjectSummary.epic`) with a compact per-row roll-up
  (cards-by-column counts + epic-branch CI); hide epic workspaces from the plain `Projects` list.
  Selecting an epic **couples board + chat**: bind the board to the epic workspace and rebind the chat
  via `resolveAgentChatWorkspace` / `use-home-agent-session` (both already per-workspace) to that epic's
  Epic-Owner home agent — **no** separate chat-only dropdown. Flip the top bar to `epic/<name>` with the
  diff-vs-`production-line` and an **Epic** badge. **Do not alter the card face** — no per-card epic
  field in v1 (that seam, threaded through `normalizeCard`, is deferred to a future cross-epic view).
  *Given/When/Then on the resolver + hook + the projects-payload epic grouping.*
- **Card 3 — `fleet epic create` / `fleet epic complete` helpers.** `create`: branch `epic/<name>` off
  `production-line`, push, `git worktree add` under `<CLINE_HOME>/epics/`, register + set epic meta,
  boot the Epic Owner. `complete`: open the `epic → production-line` PR, then deregister + `git
  worktree remove`. Sub-card **landing is already solved** by `fleet xtools land --base epic/<name>` —
  no new land code.

**Migration / compat (no day-one behavior change).** Every addition is additive and gated on the
`epic` marker: with zero epics, classification, the single pinned chat, the project list, and mainline
`production-line` cards behave exactly as today. `RuntimeProjectSummary.epic` and the workspace-meta
field are optional at the persistence/wire boundary (Article 7). No card-schema change in v1.

**Explicitly out of scope (clean seams left, not built):** auto-transition / autonomous scheduler /
DAG orchestration (roll-up cadence Q3 leaves the seam); the card-types re-model
(`docs/notes/card-types-skill-pipeline.md`) which is the *first feature run through* this machinery,
not part of it; and any change to how mainline cards work today.
