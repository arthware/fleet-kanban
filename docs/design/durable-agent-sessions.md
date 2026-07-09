# Durable agent sessions

**Status:** design · **Epic:** `fleet/docs/kanban-ui-epic.md` §4.6 · **Scope:** fleet-kanban (fork) ·
**Applies to:** external CLI/PTY agents (claude, codex, gemini, droid, kiro, opencode)

> Deliverable of `/plan`. No implementation code here. Hand this to `/implement`.

---

## 1. Problem & symptom

An agent's coding session does not survive the death of its parent process. When the kanban board
process (or a task's agent process) is killed or crashes — or the terminal that launched it closes —
the running agent session is lost. Reopening or resuming that task then either:

- fails with the CLI's own error **"No conversation found to continue"**, or
- silently starts a **brand-new conversation**, discarding the accumulated context.

The same class of failure appears when a card whose session has ended (moved to Done/Trash, then
reopened) is restored: there is no reliable way to reattach to the underlying conversation.

Users expect a session to be **durable**: survive a crash/restart and resume with the conversation
and context intact, rather than starting over.

---

## 2. Root cause (cited to code)

The live session handle is **in-memory only**, and the one datum needed for a *deterministic* resume
— the underlying CLI's **session id** — is **never captured or persisted**. Resume is delegated
entirely to each CLI's fragile "continue the most recent conversation" heuristic.

### 2.1 The live handle dies with the parent

- `TerminalSessionManager` tracks every task session in a plain in-process map:
  `private readonly entries = new Map<string, SessionEntry>()` — `src/terminal/session-manager.ts:206`.
- The live PTY lives inside `SessionEntry.active.session` (a `PtySession`) —
  `src/terminal/session-manager.ts:51-68`. `PtySession` is a thin `node-pty` wrapper with no
  persistence (`src/terminal/pty-session.ts:65-104`). When the kanban process dies, the map and every
  child PTY die with it.
- The scrollback mirror (`TerminalStateMirror`) is likewise an in-memory headless xterm; its snapshot
  is produced on demand and never written to disk (`src/terminal/terminal-state-mirror.ts:19-65`).

### 2.2 What *does* survive a restart — and what's missing from it

Per-task session **summaries** are persisted and rehydrated, but they carry no CLI session id:

- Written to `<CLINE_HOME>/kanban/workspaces/<id>/sessions.json`
  (`src/state/workspace-state.ts:28,185,677`), sourced from `terminalManager.listSummaries()`
  (`src/trpc/workspace-api.ts:369-371`).
- Rehydrated on boot: `manager.hydrateFromRecord(existingWorkspace.sessions)`
  (`src/server/workspace-registry.ts:237-240`) rebuilds each entry with **`active: null`**
  (`src/terminal/session-manager.ts:245-258`) — summary only, no live process.
- The persisted shape is `runtimeTaskSessionSummarySchema` (`src/core/api-contract.ts:282-299`):
  `taskId, state, mode, agentId, workspacePath, pid, …`. **There is no field for a claude/codex CLI
  session UUID.** `pid` is stored but stale after restart. `agentId` is only the agent *kind*
  (`"claude"`), used to route the relaunch to the right adapter.
- The board card schema (`runtimeBoardCardSchema`, `src/core/api-contract.ts:132-149`) likewise stores
  no session id, worktree path, or branch — the worktree is re-derived deterministically from the
  taskId (`getTaskWorktreePath`, `src/workspace/task-worktree.ts:634`).

### 2.3 Resume is a recency/cwd heuristic, never an id

No adapter ever passes or captures a concrete session id. `resumeFromTrash` is a single boolean that
makes each adapter append its CLI's own "resume last" flag (`src/terminal/agent-session-adapters.ts`):

| Agent | Resume behavior | Line |
|---|---|---|
| **claude** | `--continue` (most recent conversation *in cwd*) | `:625-627` |
| **codex** | `resume --last` (most recent codex session, **not cwd-scoped**) | `:752-759` |
| **gemini** | `--resume latest` | `:816-818` |
| **opencode** | `--continue` | `:1117-1119` |
| **droid / kiro** | `--resume` | `:1184-1186`, `:1270-1272` |

A grep of `src/terminal/` for `--session-id`, `sessionId`, `.jsonl`, or stdout parsing of a printed id
returns nothing: kanban never sets an id at spawn and never reads one back.

### 2.4 Why the symptom appears

- **claude `--continue`** prints **"No conversation found to continue"** whenever it can't locate a
  transcript for the current cwd's project slug (`~/.claude/projects/<slug-of-cwd>/*.jsonl`). This
  happens when the transcript is absent for that exact path — e.g. the session crashed before claude
  first flushed a transcript, the worktree path/slug differs from when it ran, or (after a full
  restart) the reopen resolves the wrong agent kind and runs the wrong CLI's resume against an empty
  store.
- **codex `resume --last`** is *global-recency*, not cwd-scoped, so it can reattach to a **different
  task's** most recent codex session — silent context corruption rather than a clean error.
- **Reopen of a non-trash card** (in `in_progress`/`review`) after a crash does not pass
  `resumeFromTrash`, so no resume flag is added at all → a **fresh conversation** starts silently.
  `startTaskSession` only returns the existing process when `entry.active != null`
  (`src/terminal/session-manager.ts:301-309`); once `active` is null it always spawns fresh.
- The only post-restart reconciliation, `recoverStaleSession` (`src/terminal/session-manager.ts:705-728`),
  treats *dead* as *gone*: it resets the summary to `state:"idle"`, `pid:null` and clears checkpoints.
  There is **no "dead-but-resumable" state** — so the UI has nothing to offer a Resume against.

**In one sentence:** kanban keeps the live session only in memory and, lacking a persisted CLI
session id, can resume only through each CLI's recency/cwd heuristic — which fails ("No conversation
found") or resumes the wrong/empty conversation whenever that heuristic can't unambiguously locate the
transcript.

### 2.5 Not affected — the native Cline SDK agent

The in-process Cline agent already persists and rehydrates its own message history
(`cline-message-repository.ts:91-107`, `hydratePersistedSessionMessages`) and rebinds via
`rebindPersistedTaskSession` (`src/trpc/runtime-api.ts:211-216`). This design targets the **external
CLI/PTY agents**, which have no such kanban-owned durability.

---

## 3. What must be persisted to make a session resumable

1. **The underlying CLI's session id** per task — the missing datum. UUID for claude/codex.
2. **The agent kind** — already persisted (`summary.agentId`); keep using it to pick the adapter.
3. **The deterministic worktree cwd** — already derivable from taskId; no new storage needed.

The transcript *bodies* already live durably in each CLI's own store, outside `CLINE_HOME`:

- claude → `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`
- codex → `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<date>-<session-id>.jsonl`
  (kanban already locates these by cwd: `findCodexRolloutFileForCwd`, `src/commands/hook-events/codex-hook-events.ts:322-351`).

Kanban should store only the **id** (a pointer), not copy transcripts.

---

## 4. Options considered

### Option A — Persist a CLI session id; resume by id *(recommended)*

Generate/capture the CLI session id at spawn, persist it on the session summary, and resume with the
explicit id. Add a three-way lifecycle (`attached` / `resumable` / `gone`) derived from whether the
transcript for that id exists on disk.

- **claude** supports `--session-id <uuid>` (set a known id at spawn) and `-r/--resume <uuid>` (resume
  a specific id) — verified via `claude --help`. Kanban generates the UUID, so no discovery is needed.
- **codex** has no "set my id" flag but accepts `codex resume <SESSION_ID>` (verified via
  `codex resume --help`). Kanban captures the id post-spawn from the rollout file matched by cwd
  (reusing existing `findCodexRolloutFileForCwd`), then resumes by id.
- Other agents (gemini/droid/kiro/opencode): keep the current flag heuristic as a **best-effort
  fallback** until they expose an id.

*Tradeoffs:* deterministic and restart-safe; robust when several sessions exist concurrently; fixes
the codex wrong-session bug. Additive schema field → back-compatible and upstreamable. Cost: per-agent
capture logic (claude clean; codex needs a short discovery step; others fall back). Blast radius:
adapters + session-manager + summary schema + resume routing + a small transcript-locator util.
Reversible (falls back to today's behavior when no id is stored).

### Option B — Keep CLI heuristics, only fix the reopen wiring *(minimal)*

Don't store an id. Make any reopen of a dead session always add the CLI's resume flag, and mark
"resumable" in the UI by probing the transcript directory for the cwd.

*Tradeoffs:* smallest change, no schema change. But it inherits every heuristic failure: codex
`--last` still resumes globally (wrong session), claude `--continue` still errors when the slug/
transcript mismatches. It papers over the common case without making sessions durable. Rejected as the
primary fix; its "probe the cwd transcript" idea is folded into Option A's fallback.

### Option C — Kanban owns the transcript (mirror/replay) *(heavy)*

Copy the full conversation into kanban state under `CLINE_HOME` and reconstruct on resume.

*Tradeoffs:* independent of CLI pruning, but massive complexity: duplicates each CLI's transcript
format, brittle to format changes, and interactive PTY CLIs won't ingest a foreign transcript anyway —
you must still hand control back via the CLI's own id. Over-engineered. Rejected.

---

## 5. Recommended approach

**Option A**, with Option B's cwd-probe as the graceful fallback.

Flow:

1. **Spawn.** For a fresh start, kanban mints `sessionId = randomUUID()`. Adapters that can set an id
   inject it (claude `--session-id <sessionId>`); adapters that can't (codex) get the id **discovered**
   just after spawn. The id is written to `summary.agentSessionId` and persisted to `sessions.json`.
2. **Resume.** On reopen of a non-active session that has a stored `agentSessionId` **and** a transcript
   on disk, relaunch by explicit id (claude `--resume <id>`, codex `resume <id>`). If no id/transcript,
   fall back to the current `--continue`/`--last` heuristic, then to a fresh start.
3. **Lifecycle.** Replace the "dead → idle" collapse in `recoverStaleSession` with a derived state:
   - `attached` — `active != null`.
   - `resumable` — `active == null` **and** the transcript for `agentSessionId` exists.
   - `gone` — `active == null` and no transcript.
   The UI offers **Resume** for `resumable` and **Start fresh** for `gone`, instead of failing.

**Locating claude transcripts robustly:** because kanban sets the UUID, the transcript can be found by
globbing `~/.claude/projects/*/<sessionId>.jsonl` — the UUID is globally unique, so we avoid
reconstructing the fragile `/`- and `.`→`-` cwd-slug rule entirely.

**Synergy with §4.4 (PR-aware lifecycle):** together they make the board restart-safe — the column is
recomputed from git while the agent session reattaches from its persisted id, so an interrupted card
neither jumps to Done nor orphans its conversation.

---

## 6. Implementation outline

### 6.1 Schema — `src/core/api-contract.ts`

- Add to `runtimeTaskSessionSummarySchema` (`:282`):
  `agentSessionId: z.string().nullable().default(null)`. Persisted in `sessions.json`; back-compat via
  default `null` for existing files.
- Optionally surface a derived `lifecycle: "attached" | "resumable" | "gone"` in the summary *response*
  (computed, not stored) so the UI can render Resume/Start-fresh without re-probing.

### 6.2 Transcript locator — new `src/terminal/agent-transcript-locator.ts`

- `claudeTranscriptPath(sessionId): Promise<string | null>` — glob `~/.claude/projects/*/<id>.jsonl`.
- `codexRolloutPathForSession(sessionId): Promise<string | null>` — reuse the rollout scan in
  `codex-hook-events.ts` (extract a shared helper) to find `rollout-*-<id>.jsonl`.
- `transcriptExistsFor(agentId, cwd, sessionId): Promise<boolean>` — dispatch by agent kind.
- Pure, filesystem-only, unit-testable with a temp `HOME`.

### 6.3 Adapters — `src/terminal/agent-session-adapters.ts`

- Extend the adapter launch input with `agentSessionId?: string` and a `resume: boolean` intent
  (distinct from `resumeFromTrash`, which stays the coarse trigger).
- **claude** (`:606`): when starting fresh with an id → push `--session-id <id>`; when resuming with an
  id → push `--resume <id>` (not `--continue`); else keep `--continue`. Never pass both `--session-id`
  and `--resume` (claude errors if the id already exists).
- **codex** (`:736`): when resuming with a known id → `resume <id>` instead of `resume --last`; on
  fresh start, no flag (id is discovered post-spawn).
- Others: unchanged (heuristic fallback), but plumb the id through so future support is a small edit.

### 6.4 Session manager — `src/terminal/session-manager.ts`

- `startTaskSession` (`:295`): mint or reuse `agentSessionId`; store it on the summary before/at spawn;
  pass it and the resume intent to `prepareAgentLaunch`.
- **Codex id capture:** after spawn, briefly watch/poll `findCodexRolloutFileForCwd(cwd)` (bounded
  timeout) to resolve the rollout UUID, then `updateSummary(entry, { agentSessionId })`. On timeout,
  leave null and fall back to `resume --last`.
- Replace the "reset to idle" in `recoverStaleSession` (`:705`) with lifecycle computation: keep
  `agentSessionId`; do not clear it. A `resumable` session must not be downgraded to `idle`.
- Ensure `hydrateFromRecord` (`:245`) round-trips `agentSessionId` (automatic once it's on the schema).

### 6.5 Resume routing — `src/trpc/runtime-api.ts`

- In `startTaskSession` (`:168`): read `summary.agentSessionId`; when reopening a non-active session,
  set the resume intent and pass the id so the terminal path resumes deterministically. Keep the
  existing `previousTerminalAgentId` agent-kind routing (`:199-202`).

### 6.6 UI — `web-ui/src/hooks/use-task-sessions.ts`, `board-card.tsx`

- Surface the lifecycle state; "Open" on a `resumable` card issues a resume mutation; a `gone` card
  offers Start-fresh. Reuse existing `startTaskSession(task, { resumeFromTrash })` plumbing
  (`use-board-interactions.ts:562`) extended with the resume intent.

---

## 7. Test strategy (for `/implement`, RED-first)

### Unit

- **Adapters** (`agent-session-adapters`): claude fresh-start with an id emits `--session-id <id>` and
  no `--continue`; claude resume with an id emits `--resume <id>`; claude with no id falls back to
  `--continue`. codex resume with an id emits `resume <id>`; without an id emits `resume --last`.
- **Transcript locator**: `claudeTranscriptPath` finds `<HOME>/.claude/projects/*/<id>.jsonl` via glob
  and returns null when absent; `codexRolloutPathForSession` matches `rollout-*-<id>.jsonl`;
  `transcriptExistsFor` dispatches per agent kind. (Temp `HOME`, no network.)
- **Session manager**: `startTaskSession` persists `agentSessionId` on the summary; `hydrateFromRecord`
  round-trips it; the lifecycle resolver returns `attached`/`resumable`/`gone` for the three
  (active, transcript-present) combinations; `recoverStaleSession` no longer clears `agentSessionId`.
- **Schema round-trip**: `sessions.json` with and without `agentSessionId` both parse (missing → null).

### BDD / surface

- **`startTaskSession` procedure** (drive the tRPC handler with a fake terminal manager / adapter spy):
  a fresh start captures and persists an id; a second start for the same taskId with `active` cleared
  resumes **by that id** (assert the argv handed to the adapter), and does **not** start a fresh
  conversation when a resumable transcript exists.
- **`use-task-sessions` hook** (react-dom + `act`, pattern from
  `web-ui/src/hooks/use-workspace-sync.test.tsx`): reopening a card whose summary is `resumable` issues
  a resume mutation, not a fresh start; a `gone` card offers Start-fresh.

All red first: assert the persisted `agentSessionId` and the resume argv before wiring the capture.

---

## 8. Risks, open questions, out-of-scope

### Risks / mitigations

- **Codex discovery race** — the rollout file may not exist at the instant of spawn. Mitigate with a
  bounded watch/poll and match by cwd (`findCodexRolloutFileForCwd`); on timeout, fall back to
  `resume --last` (today's behavior). Note `--last` is global-recency and can grab the wrong session —
  capturing the id is the actual fix.
- **`--session-id` collision** — resuming must use `--resume <id>`, never `--session-id <id>` (claude
  rejects an already-existing id). Branch strictly on fresh-vs-resume.
- **Transcript pruned / user cleared `~/.claude/projects`** — state becomes `gone`; resume impossible.
  Acceptable and correctly surfaced (no more misleading "No conversation found").
- **Store location vs `CLINE_HOME`** — claude/codex transcripts live in the real `$HOME`, not under
  `CLINE_HOME`. Sessions are therefore host-local and shared across boards on the same host. Fine for
  the single-host dogffood setup; call it out.

### Open questions

- Do we also mirror `agentSessionId` onto `runtimeBoardCardSchema` (epic §4.6 wording) or keep it only
  on the session summary? Recommendation: summary only — it's already the persisted, hydrated,
  per-task record; the card stays user-authored. Decide at implement time.
- Should `gone` auto-fall-back to a fresh start, or always require an explicit user click? Lean:
  explicit, to avoid silent context loss.
- Gemini/droid/kiro/opencode id support — confirm per-CLI capabilities; until then they stay
  best-effort heuristic.

### Out of scope

- Native Cline SDK agent durability (already handled — §2.5).
- Home-agent sessions (`isHomeAgentSessionId`).
- PR-aware column reconcile (§4.4) — complementary, separate work item.
- Cross-machine / remote resume (transcripts are host-local).
