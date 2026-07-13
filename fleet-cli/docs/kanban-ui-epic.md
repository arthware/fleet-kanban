# Epic — Kanban board tailored for the Fleet agent-SDLC workflow

**Status:** proposal · **Owner:** Arthur · **Scope:** a tailored (likely forked) Cline Kanban UI + the `fleet` glue around it.

> Keep it lightweight. The goal is **more columns + grouping by initiative/project + nicer artifact
> review + actually using dependency links** — not a workflow engine.

---

## 1. Context

We run an agent-driven SDLC across a set of repos with two tools:

- **`fleet`** (`~/code/repos/tools/fleet`) — the control tower: cross-repo/epic overview
  (`fleet`, `fleet linear`, `fleet initiatives`), Linear ingestion (`fleet agent plan|implement`),
  and worktree/port tooling (`wt`, `port-for`). Project-bound config in `<project>/.fleet/`.
- **fleet-kanban** — our fork of **Cline Kanban** (`~/code/repos/tools/fleet-kanban`, forked at
  v0.1.69, runs on `http://127.0.0.1:3484`) — the execution board: each card = its own worktree +
  agent; review → Commit/Open PR; git interface. Managed via `fleet kanban …` (command name already
  matches the fork). We track upstream `cline/kanban` by rebasing.

**The workflow (two lanes):**

1. **Design lane** (iterative) — `fleet agent plan ENG-XXX` → an agent validates the Linear issue
   against the codebase and writes `docs/design/ENG-XXX.md` → lands in review → iterate via kanban's
   review/comment loop → **PR merge = design sign-off** (git is the source of truth for the doc).
2. **Implementation lane** — `fleet agent implement ENG-XXX` (small) or `drilldown` (big) → agent(s)
   build per the design and run the repo's **`/ship`** command (review → PR → CI → squash-merge →
   Linear Done). Doc + code ship together for small changes; separate PRs per sub-task for big ones.

Linear is the source of truth for **issues/initiatives**; git for **design docs + code**.

---

## 2. Problem — where the board falls short for this workflow

- **Only 4 fixed columns** (Backlog · In Progress · Review · Done). Can't see whether a card is in
  the **design** phase or the **implementation** phase — both collapse into "In Progress / Review".
- **No grouping.** Cards are a flat list per repo. We think in **Initiative → Project → Issue**
  (Linear's hierarchy); the board can't show that, and one board is per-repo so a project that spans
  repos is fragmented.
- **Artifacts reviewed as raw diffs.** A 338-line design doc is reviewed as a `+338` diff, not
  rendered. There's no "here are this card's output documents" view.
- **Dependency links underused.** `task link` + auto-start chains exist but we don't use them; the
  one-line UX ("auto-start when a card moves to Done") is unobvious.

---

## 3. Goals / Non-goals

**Goals**
1. **More columns** that express the design and implementation lanes.
2. **Group cards by Initiative → Project** (hierarchical), with assignee shown.
3. **Resources/Fragments tab** on a card that renders output docs (markdown) properly.
4. **Adopt task relations** — dependency chains for drilldown and design→impl handoff.

**Non-goals (for now)**
- No general workflow/BPM engine or per-project custom column editor.
- No replacing `/ship` or the git-native sign-off (PR merge stays the gate).
- No new heavy card metadata if we can derive from the diff/Linear.

---

## 4. Proposal

### 4.1 Columns — the two lanes, as columns

Today: `Backlog · In Progress · Review · Done` (hardcoded, `src/state/workspace-state.ts`).

Proposed minimal set (6):

| Column | Meaning | Card type |
|---|---|---|
| **Backlog** | queued | any |
| **Designing** | plan agent running | design |
| **Design Ready** | design doc awaiting review / PR merge (= sign-off) | design |
| **Building** | implement agent running | impl |
| **Code Review** | PR open / diff review | impl |
| **Done** | merged, Linear Done | any |

This encodes the lanes without a rules engine: a card's column *is* its phase. If even that's too
much, the smaller step is to **split "Review" into "Design Review" and "Code Review"** and keep the
rest. Columns are currently a fixed enum, so this is a fork change (see §6).

### 4.2 Group by Initiative → Project (swimlanes)

Render cards in collapsible groups:

```
▸ Initiative: Bring Your Own Agent 0.2
    ▸ Project: CLI + Skill (BYOA)
        [ENG-1294] is-not validator        Building   · frudaj
        [ENG-1298] validate → Langium      Design Ready · frudaj
    ▸ Project: (no project)
        [ENG-2044] …                       Backlog
▸ Initiative: (untagged)
```

- Derived from the `ENG-####` in the card title → Linear Initiative/Project (fleet already resolves
  this; the board can call the same Linear enrichment or read fleet's cache).
- Show the **assignee** per card (Linear assignee, or the agent). This is the board version of
  `fleet initiatives` / `fleet linear`.
- Keeps working across repos: grouping is by Linear hierarchy, not by which repo's board you're on.

### 4.3 Card "Resources" tab (render output artifacts)

A new tab in the card detail that lists the agent's **review-worthy output files** (design docs,
plans, reports) and renders them — distinct from the raw code diff.

- **Markdown render already exists** in kanban: `react-markdown` + `remark-gfm` via
  `web-ui/src/components/detail-panels/cline-markdown-content.tsx` (`ClineMarkdownContent`). Reuse it;
  no new dependency, and there is **no** tiptap to add.
- **Derive resources from the diff** (lowest effort, no schema change): filter the already-loaded
  `useRuntimeWorkspaceChanges` files by glob (`docs/design/**.md`, `*.md`); their `newText` is already
  in the payload (`getChanges` → `runtimeWorkspaceFileChangeSchema`).
- **Two mount points, one renderer.** `ClineMarkdownContent` is currently used only by
  `cline-chat-message-item.tsx:201`. Reuse it in:
  1. **Card Resources tab** — `web-ui/src/components/card-detail-view.tsx` (tab next to the diff
     toolbar, ~lines 264–309 / mobile tabs ~197–231) + new
     `web-ui/src/components/detail-panels/resources-panel.tsx`.
  2. **Git-history file viewer** — `web-ui/src/components/git-history/git-commit-diff-panel.tsx`
     (the commit→file pane). For `.md`/`.mdx`, add a **Source / Rendered** toggle (default Rendered)
     and an **Expand** button that promotes the rendered doc to a full-width **document view** filling
     the content area (collapse commit list + file tree).
- **Content source caveat:** the card diff (`getChanges`) already returns full `newText`; the
  git-history panel works from the diff **patch**, so a rendered view needs the full file text at the
  commit — for an added file the patch is the whole file; for edits, strip diff markers or add a small
  "read file at ref" call.
- Backend/schema untouched for the diff-derived version. ~1 day. Later: a `workspace.readFile`/
  `listResources` tRPC procedure for unchanged/committed files, and/or a `resources` field on
  `runtimeBoardCardSchema` for explicit declaration.

### 4.4 PR-aware card lifecycle (derive column from git, not session)

Today a card's column is driven by **session/manual** state: an agent finishing (or a runtime
restart) can move a card to Review or Done regardless of whether the work actually shipped. That's
what produced the bug where a crash-interrupted card with an **open PR** landed in **Done**.

**Desired model — the column follows the branch/PR:**

| Git/PR state | Column |
|---|---|
| agent working | In Progress / Building |
| agent done, no PR yet | Review |
| **PR open** | **Review — stays here** (Code Review) |
| PR merged (branch merged into base) **or** branch deleted | **Done** |
| PR closed unmerged | back to Review (or a "Closed" state) |

Consequences:
- A card **stays in Review as long as its PR is open** — the merge is the only thing that moves it
  to Done, matching the git-native sign-off (PR merge = done).
- **Restart-safe:** on runtime restart, a card's column is recomputed from its branch/PR, so an
  interrupted card with an open PR returns to Review instead of being parked in Done.

**Interim fix (already shipped, no fork needed):** launch kanban with **`--skip-shutdown-cleanup`**
(*"Do not move sessions to done or delete task worktrees on shutdown"*). This stops the shutdown
path from force-moving cards to Done (and from deleting worktrees) — it was also what wedged the
port on stop. `fleet kanban start` and the launchd daemon now pass it. This makes the column *stop
lying* on restart; §4.4's git-derived reconcile is the positive version (actively set Review/Done
from PR state) and supersedes it.

Implementation (full version): kanban already has a git interface + git-sync; add a lightweight
reconcile that, per card with a branch, checks PR state (`gh pr view` / GitHub API) and
branch-merged/-deleted status, and sets the column accordingly. This is kanban-internal (a
fork/upstream change) — the `kanban task` CLI has no "move to Review" verb, so `fleet` can't do it
externally.

### 4.5 Adopt task relations (dependency chains)

**Mechanics (verified):** `kanban task link --task-id A --linked-task-id B` ⇒ **A waits on B**. When
prerequisite **B** finishes review and moves to **Done**, the waiting backlog task **A** becomes ready
/ auto-starts. (Kanban renamed Trash→Done, so this is dependency chaining, not "deleting triggers
work" — the confusing part is just the label.)

Uses in our workflow:

- **Drilldown (big changes):** create N impl sub-cards; **link sequential ones** (`B waits on A`) so
  they auto-advance as each merges; **leave independent ones unlinked** so they run in parallel. This
  is the feature's sweet spot and gives autonomous multi-step execution.
- **Design → Impl handoff (big changes):** create the implement card in **Backlog, linked to the plan
  card**. Approving the design (plan → Done, design PR merged) makes the implement card ready — and it
  branches off `main`, which now contains the design doc. Clean git-native chain. `fleet` surfaces this
  as `plan --then-implement` / `implement --after-plan`.
- **Small changes:** no link — `implement` embeds the doc and runs directly (doc + code, one PR).

### 4.6 Durable agent sessions (resume, don't lose the conversation)

**Symptom:** click **Open** on a card whose agent has stopped and the pane shows
*"No conversation found to continue"* — the whole conversation appears lost. It happens whenever the
agent process ends: the card's session was killed (kanban restart, machine reboot, parent process
exit), so kanban has no live process to reattach to.

**Root cause:** kanban resumes by reattaching to an **in-memory process handle**, which dies with the
parent. But the conversation itself is **not** lost — Claude Code persists every session to disk at
`~/.claude/projects/<cwd-slug>/<session-id>.jsonl` (Codex has an equivalent transcript store). Kanban
just isn't tracking the ID needed to reopen it.

**Fix — persist the session ID with the card and resume from disk:**

1. **Capture the session id at spawn.** Launch the agent with an explicit, known id
   (`claude --session-id <uuid>` / codex equivalent) or capture the id it prints, and store it on the
   card (e.g. `agentSessionId` on `runtimeBoardCardSchema`, alongside worktree path + branch).
2. **Resume from disk, not from a live handle.** When **Open** is clicked and no live process is
   attached, relaunch with `claude --resume <agentSessionId>` in the card's worktree (`codex resume`
   for codex). The transcript file is the source of truth, so this survives kanban/process restarts.
3. **Reconcile "attached" vs "resumable" vs "gone"** in the card UI: *attached* (live process) →
   *resumable* (no process but transcript exists on disk) → *gone* (no transcript). "Open" should offer
   **Resume** in the resumable state instead of failing with "No conversation found."

This pairs with §4.4: a restart shouldn't silently move the card **or** orphan its conversation — the
column recomputes from git, and the agent session reattaches from its persisted id. Together they make
the board **restart-safe**. This is kanban-internal (fork), and a strong upstream PR candidate.

### 4.7 Instance isolation — project-local state (SHIPPED, fork feature #1)

**Problem:** upstream hardcodes all runtime state to `~/.cline/{kanban,worktrees,data}` with no
override, so two servers on different ports are just two windows onto the *same* shared state — same
boards, racing on the same JSON. Port ≠ isolation.

**Fix (done in the fork):** a single resolver `clineHomeDir()` (`src/config/cline-home.ts`) returns
`process.env.CLINE_HOME ?? ~/.cline`, routed through the 5 state sites (`runtime-config.ts`,
`workspace-state.ts` ×2, `runtime-api.ts`, `cline-mcp-settings-service.ts`). Set `CLINE_HOME` and
board + worktrees + settings all relocate under one directory. **Not touched:** per-repo
`<repo>/.cline/kanban/config.json` (colocated on purpose).

**`fleet` wires it project-local:** `fleet kanban start` / `daemon` export
`CLINE_HOME=<project>/.fleet/cline` — all runtime state lives *with the project* (like `.git`),
nothing in `$HOME`, and it's already gitignored (`.fleet/*`). The stable vendor build ignores
`CLINE_HOME` (harmless), so projects still on stable keep using `~/.cline`.

**Verified:** dogfood board (`CLINE_HOME=tools/.fleet/cline`, :3500) came up with 0 projects and
wrote to `tools/.fleet/cline/kanban`; a second board (:3484, default `~/.cline`) stayed at 4
projects, untouched. Genuine parallel isolation.

**Cosmetic follow-up (DONE):** trash/done cards used to *display* a hardcoded `~/.cline/worktrees/…`
label (only the `isTrashCard` branch reconstructs client-side; live cards already show the real
server path). Fixed by adding `taskWorktreesRoot` (follows `CLINE_HOME`) to
`runtimeWorkspaceStateResponse`, threaded `App → KanbanBoard → BoardColumn → BoardCard`, so the label
shows the real project-local path. The whole `CLINE_HOME` override + this is a clean upstream-PR
candidate.

---

## 5. Underused kanban features worth turning on

- **Script Shortcuts** (settings) — one-click `npm run dev`; pair with `fleet`'s `port-for` so each
  worktree runs on its own port (kanban itself doesn't assign ports).
- **Checkpointing** — diff since your last message; use during design iteration.
- **Auto-commit / Auto-PR** — for the autonomous drilldown chains (combined with links).
- **Git interface** (navbar branch) — browse/switch/fetch/PR without leaving the board.

---

## 6. Delivery — fork mechanics

- Fork name: **`fleet-kanban`** (fork of `cline/kanban`; `FleetDeck` was taken, so we keep it
  pragmatic). Build from our source checkout via **`fleet kanban install --source ~/code/repos/tools/fleet-kanban`**
  (to add), vendoring the local build instead of `kanban@latest` from npm.
- Track upstream by rebasing the checkout on new releases; **upstream generally-useful pieces as PRs**
  to `cline/kanban` (Resources tab and Linear grouping are good candidates) to minimize fork drift.
- **Phasing (value-first — restart-safety first, it's the worst UX to lose):**
  0. **Fork foundation** — `fleet kanban install --source`, build the checkout, run per-project.
     ✅ DONE (`fleet-kanban`, project-local source build, dogfood board on :3500).
  1. **Instance isolation (§4.7)** — `CLINE_HOME` → project-local state. ✅ DONE (verified: two
     isolated boards side by side). This is what makes dogfooding clean.
  2. **Durable agent sessions (§4.6)** — persist the session id, resume from disk. Fixes data loss
     ("No conversation found"); highest remaining value.
  2. **PR-aware card lifecycle (§4.4)** — recompute column from git on restart. Fixes cards jumping to
     Done; pairs with #1 for a restart-safe board.
  3. **Resources tab + markdown viewer (§4.3)** — small, immediately useful, PR-able upstream.
  4. **Initiative/Project grouping (§4.2)** — read Linear via existing enrichment.
  5. **Columns (§4.1)** (the two lanes) — the biggest change; do after the above prove out.
  6. **Relation-driven chaining in `fleet`** (`drilldown`, `implement --after-plan`) — no kanban fork
     needed; pure `fleet` + `task link`.

---

## 7. Boundaries (who owns what)

| Concern | Owner |
|---|---|
| Issues, initiatives, projects | **Linear** (source of truth) |
| Design docs + code | **git** (PR merge = sign-off) |
| Overview, ingestion, worktree/ports | **fleet** |
| Execution board: worktrees, agents, review, columns, grouping, artifact viewer | **kanban (forked)** |
