# One stable, derived-liveness architect identity

**Card:** 27789 · **Status:** design (no implementation code in this card) · **Base:** `production-line`

**Root cause in one sentence:** there is no *"the architect session"* the code can name — the
home/architect agent is modeled along **three independent axes of variation** (per-viewed-workspace,
per-agent-config, and persisted-and-trusted liveness) and **garbage-collected on none**, so duplicate
and dead architect records accumulate and the review-ping (#75) targets the wrong sidebar or a dead
one. This card **removes that model** and replaces it with a single architect identity that is
*derived* from facts the board already owns (the workspace classification + the real process/transcript),
not minted, rotated, and trusted.

This is the same anti-pattern the constitution already forbids — *state must be derived, not
re-persisted and trusted* (Article 3, one source of truth; Article 2, root cause not duct tape) — one
layer below the WebSocket-heartbeat fix (`5596f`): **process liveness** instead of socket liveness.

---

## 1. The current model, and why it is wrong

There are **two id systems** in play, and conflating their jobs is the source of the confusion:

| Id | Where minted | Purpose | Deterministic? |
|----|--------------|---------|----------------|
| **Routing id** `__home_agent__:<workspaceId>:<agentId>` | `createHomeAgentSessionId` (`src/core/home-agent-session.ts:12`) | The synthetic *taskId* used to route tRPC calls, persist in `sessions.json`, and target the review-ping | shape-deterministic, but the **`workspaceId` input varies** (see below) |
| **Conversation id** UUIDv5 over `workspaceId:agentId` | `deriveHomeAgentClaudeSessionId` (`src/terminal/home-agent-session-id.ts:21`) | The Claude CLI `--session-id`/`--resume` value — the actual chat transcript | **fully deterministic and durable** — this one is already correct (bc43b0c relies on it) |

The conversation id is fine: it already survives restart and resumes the same chat. **Every problem is
in the routing-id layer and the liveness around it.** That layer varies along three axes:

### Axis 1 — Identity is per-*viewed-workspace*, not per-*architect*

`createHomeAgentSessionId(workspaceId, agentId)` is minted once per workspace the sidebar was ever
opened in. One board carries **many** workspaces (the live dogfood board has **10**: `tools`,
`fleet-kanban`, and 8 test/throwaway ones). The board process itself derives a home-agent record per
workspace on cold load — `buildWorkspaceStateSnapshot` (`src/server/workspace-registry.ts:333-368`)
walks *every* workspace's `sessions.json` and re-derives any home-agent record it finds. So
`__home_agent__:tools:claude` and `__home_agent__:fleet-kanban:claude` exist as **siblings**, spawned
by the board, not by the operator.

**Half of the fix for this axis already shipped, on the UI side only.**
`web-ui/src/runtime/agent-chat-workspace.ts` (`resolveAgentChatWorkspace`) already pins the sidebar
chat to `architectWorkspaceId ?? currentProjectId` — so the *chat the operator types in* is correctly
the architect's, stable across the project selector. But the **server never got that rule**: the
review-ping resolves the *card's* workspace home agent (`resolveRunningHomeAgentTaskId`), and the
per-workspace snapshot derives a home agent per workspace. The identity is pinned in one place and
free-floating in two others — the definition of "no single source of truth."

### Axis 2 — Identity *rotates* on config change

`use-home-agent-session.ts` builds a `descriptorKey` from agent/provider/model/baseUrl/reasoning-effort
(`buildClineDescriptor`) or agent/command (`buildTerminalDescriptor`) and re-runs the mint whenever it
changes (the `useMemo` deps at `:176-184`, the `homeDescriptorByWorkspaceRef` compare at `:151-162`).
The file's own header says the identity is stable *"while the app stays open"* and rotates *"when the
selected agent configuration meaningfully changes."* On every rotation the previous session is stopped
and `pruneWorkspaceHomeAgentSessions` (`:72`) prunes it *from the local summaries map only* — the
**persisted record and its transcript are left stranded**. An identity you have to prune on rotate is
an identity that should not have rotated.

### Axis 3 — Liveness is *persisted and trusted*, never *derived*

`sessions.json` stores `state:"running"` + `pid` (`src/state/workspace-state.ts`, schema at
`src/core/api-contract.ts:400`). On board restart, `hydrateFromRecord`
(`src/terminal/session-manager.ts`) loads those records with `active: null`, and **nothing reconciles
`state`/`pid` against a real OS process**:

- `markInterruptedAndStopAll` only touches entries with `active != null` (live in *this* process), so a
  hydrated dead record is never marked interrupted.
- `refreshAgentSessionLifecycle` / `classifyEntryAgentSessionLifecycle` (`:284`, `:856`) derive only the
  *display* field `agentSessionLifecycle` (`attached`/`resumable`/`gone`) from `Boolean(entry.active)` +
  transcript. They **do not touch `state` or `pid`.**
- The review-ping's liveness check trusts the persisted pid directly:
  `terminalManager.getSummary(taskId)?.pid != null` (`src/trpc/runtime-api.ts:212`).

Live proof: `__home_agent__:tools:claude` (pid 39091) still reads `state:"running"` today though its
process **died on Jul 10**. The board "never notices it's dead."

### Compounding bug — persistence isn't partitioned

The dead **`tools`** home-agent record is stored *inside the **`fleet-kanban`** workspace's*
`sessions.json`, mixed among ~85 accumulated records. The write path (`saveWorkspaceState` /
`mutateWorkspaceState`) persists the *entire* client-supplied sessions map for a workspace without
filtering out home-agent ids that belong to a *different* workspace — and the web-ui `sessionSummaries`
state carries home-agent records across workspace switches. So a home-agent record has **no
unambiguous home**. Whatever the new model is, it must fix this.

### The consequence the operator hit

`resolveRunningHomeAgentTaskId` (`src/core/review-notification.ts`) resolves the running home agent **of
the card's workspace**. Cards created with `fleet task create --repo fleet-kanban` live in the
`fleet-kanban` workspace, but the architect the operator uses is the **`tools`** sidebar (the parent —
the architect *oversees* fleet-kanban as a sub-repo; prior art 503564e). So the ping targets a home
agent scoped to `fleet-kanban`, which is either a stranded sibling or dead — and the operator sees
**nothing**. Verified: 0 real injected pings in either the `tools` or `fleet-kanban` sidebar; the
mechanism only works in the *aligned* case (leapter/genielabs, where the architect workspace **is** the
card's workspace). The topology mismatch is not a routing bug to patch — it is a **symptom of "no single
architect identity."**

---

## 2. The model that replaces it

> **The architect is a property of the board, resolved through the existing architect classification,
> and its liveness is derived from the real process/transcript. It is never minted per view, never
> rotated on config, and never trusted from a persisted pid.**

Three moves, each dissolving one axis:

### 2.1 One identity, resolved (not minted) from classification — *Axis 1*

The board already knows who the architect is: `classifyArchitectWorkspace`
(`src/server/architect-workspace.ts:52`) resolves the outermost container workspace (or `null` for a
flat/peer board). **The architect home-agent workspace is that classification result, with the active
workspace as the flat-board fallback** — exactly the rule `resolveAgentChatWorkspace` already applies on
the UI.

Reuse-before-rebuild (Article 1): lift that rule into **one shared server-side resolver** —
`resolveArchitectHomeAgentWorkspaceId(index, activeWorkspaceId) = classifyArchitectWorkspace(index).architectWorkspaceId ?? activeWorkspaceId`
— and make **all three** call sites consult it: the UI chat (already does, via
`agent-chat-workspace.ts`, which can delegate to the same rule), the review-ping, and the snapshot
derivation. One rule, one identity, three consumers. Navigating between projects, or delegating a card
into a sub-repo workspace, **cannot mint a second architect**, because none of them mints anything — they
all resolve the same classification.

The routing-id *shape* `__home_agent__:<workspaceId>:<agentId>` is unchanged (it is the persistence/wire
boundary — Article 7 keeps it additive/stable); what changes is that **`<workspaceId>` is always the
architect workspace**, never the viewed one.

### 2.2 Stability across restart / config / tab lifecycle — *Axis 2*

- **Restart:** the id re-derives from `(architectWorkspaceId, agentId)` and the conversation id is
  already UUIDv5-deterministic → the same architect chat resumes. Nothing is persisted *for stability*;
  identity is derived, so a restart cannot strand it. (bc43b0c already made the transcript-derived
  resume work; this removes the last stranding vector around it.)

- **Model / provider / reasoning-effort change:** **reload in place, do not rotate.** The id already
  ignores these inputs; the churn is the descriptor-driven stop/prune/re-start dance. Replace it with the
  same reload path already used for MCP/context changes (`use-home-agent-session.ts:243`,
  `reloadTaskChatSession`): same routing id, same sidebar, the underlying session restarts. No new id, no
  strand. **Delete** `descriptorKey`, `buildClineDescriptor`, `buildTerminalDescriptor`,
  `homeDescriptorByWorkspaceRef`, and the rotate-compare block.

- **Agent change (claude ↔ codex):** this is the only input the id still embeds. Decision, with the
  end-state and a conservative fallback:
  - **End state (recommended):** drop `agentId` from the *routing* identity → `__home_agent__:<architectWorkspaceId>`.
    The agent/panel becomes a *property* of the one architect identity, switched via reload-in-place; the
    *backing* conversation stays per-agent through the existing per-agent conversation-id derivation
    (Claude chat vs. terminal panel are still distinct sessions, keyed by identity + current agent). This
    makes "exactly one architect identity" **structural** — there is no second id to mint. It requires a
    migration that rewrites/reaps the legacy `:<agentId>`-suffixed records (§2.4).
  - **Conservative fallback:** keep `agentId` in the id but rely on derived-liveness reaping (§2.3) so the
    non-current agent's record is `gone` and reaped rather than accumulated. Simpler migration; leaves a
    bounded (≤ one-per-agent) multiplicity that GC keeps from growing.

  Recommend the end state; it is the only option under which a second identity **cannot** exist. The
  fallback is the Phase-1-safe intermediate (§3).

### 2.3 Derived liveness — *Axis 3*

**Principle:** a record is `running`/`attached` **only if a process is actually alive.** Liveness is
derived at exactly one seam and the *whole* summary is reconciled there — not just the display field.

- **Probe:** extend `classifyEntryAgentSessionLifecycle` (`session-manager.ts:856`) so that, when there
  is no in-process `entry.active`, it probes the persisted pid with `process.kill(pid, 0)` (ESRCH ⇒
  dead) before falling through to transcript classification. `attached` ⇔ live in-process session **or**
  pid probes alive; `resumable` ⇔ no live process but conversation id + transcript present; `gone` ⇔
  nothing to resume.
- **Reconcile `state` and `pid`, not only `agentSessionLifecycle`.** Make `refreshAgentSessionLifecycle`
  the single funnel that normalizes the full summary: a hydrated `state:"running"` with a dead pid is
  rewritten to a non-live state (`interrupted` when it had a live run; otherwise `idle`) and `pid: null`.
  This is the direct fix for the Jul-10 record reading `running`, and it means no other code has to
  distrust `state`/`pid` — they are correct at the source.
- **Site:** the one existing liveness/reconcile site — `buildWorkspaceStateSnapshot`
  (`workspace-registry.ts:333`), which already re-derives home-agent lifecycle on cold load — becomes the
  single place `state`/`pid` are normalized from real liveness. No new liveness site is introduced
  (Article 3).
- **GC / reaping (the piece the current model entirely lacks):** because there is exactly one architect
  identity per board, any home-agent record whose workspace component is **not** the current architect
  workspace, or whose derived liveness is `gone`, is stale and reaped from its `sessions.json`. This is
  what turns "accumulate forever" into "converges to one."

### 2.4 Migration for records already stranded in the field

A **one-time start-of-board reconcile sweep**, modeled on the existing
`migrateAllWorkspaceTrashToArchive` already invoked in the registry constructor
(`workspace-registry.ts:199`). Over every workspace's `sessions.json` it:

1. **Normalizes liveness** — runs the §2.3 derivation; `state:"running"` + dead-pid records (the Jul-10
   entry) are rewritten to their derived state with `pid: null`.
2. **Reaps stale home agents** — deletes home-agent records that are `gone`, or whose workspace component
   is not the current architect workspace (the `fleet-kanban:claude` sibling), or (end state §2.2) carry a
   legacy `:<agentId>` suffix, rewriting the surviving one to the canonical id.
3. **Repartitions** — a home-agent record may live **only** in its own workspace's `sessions.json`; the
   sweep removes any foreign home-agent id (the `tools` record wrongly stored under `fleet-kanban`), and
   the write path (§2.5) enforces it going forward.

Idempotent: re-running the sweep on an already-clean board is a no-op.

### 2.5 Review-ping resolution follows the identity — *the operator's failure, fixed by the model*

With one architect identity, `resolveRunningHomeAgentTaskId` no longer searches the **card's** workspace.
It resolves **the board's architect** via the §2.1 shared resolver and returns that identity iff its
**derived** liveness is `attached`:

```
architectWorkspaceId = resolveArchitectHomeAgentWorkspaceId(index, activeWorkspaceId)
architectHomeAgentId = __home_agent__:<architectWorkspaceId>[:<agentId>]   // §2.2 decides the suffix
return isAttached(architectHomeAgentId)  ? architectHomeAgentId : null      // derived, not persisted-pid
```

- A card in a **sub-workspace** (`fleet-kanban`) reaches the **overseeing** architect (`tools`) because
  the target is computed from the classification, not from the card's own workspace — the cross-workspace
  case is covered by the *identity model*, not a special-case lookup.
- The caller in `runtime-api.ts:208` must therefore resolve the **architect workspace's** scoped session
  service to inject the message (today it uses the card-workspace service). That routing is the natural
  consequence of the identity living on the architect, not a new mechanism.
- The `isActive` closure stops trusting `getSummary(taskId)?.pid != null` and calls the derived
  attached-check, so a dead pid can never be a ping target.
- The **aligned case is preserved**: on a flat board (leapter/genielabs) `classifyArchitectWorkspace`
  returns `null`, the resolver falls back to the active/card workspace, and the ping behaves exactly as
  it does today (where it already works).

**Ping-into-`resumable`:** decision — when the architect is `resumable` but not `attached`, the ping
returns `null` (no delivery) rather than silently resuming a dead architect behind the operator's back;
the card is already visible in the Review column. Auto-resume-then-ping is a deliberate future choice,
not a default.

---

## 3. Phasing

Both phases are needed for the whole fix; **Phase 1 is independently shippable and removes the acute
failure.**

- **Phase 1 — derive liveness + reap (dissolves Axis 3 + the compounding bug).**
  Derive `state`/`pid` from the real process at the snapshot seam (§2.3); add the start-time reconcile
  sweep (§2.4); switch the ping's `isActive` to derived liveness; filter foreign home-agent ids on write
  (§2.5). Outcome: the Jul-10 record stops reading `running`, dead records stop accumulating, and the
  ping can no longer be delivered into a dead session. Keeps the `:<agentId>` id shape, so no id
  migration yet.

- **Phase 2 — single identity (dissolves Axes 1 & 2).**
  Add the shared `resolveArchitectHomeAgentWorkspaceId`; point the ping and the snapshot derivation at it
  (§2.1, §2.5); delete the descriptor rotation / prune-on-rotate machinery and adopt reload-in-place
  (§2.2); optionally drop `agentId` from the routing id with its migration. Outcome: exactly one
  architect identity is the only structural outcome, and a sub-repo card reaches the overseeing architect.

---

## 4. What gets deleted or collapsed

| Removed / collapsed | Where | Replaced by |
|---|---|---|
| Per-*viewed-workspace* home-agent minting | `buildWorkspaceStateSnapshot`, `createHomeAgentSessionId` call sites | One classification-derived architect identity (§2.1) |
| `descriptorKey` rotation + `buildClineDescriptor`/`buildTerminalDescriptor` + `homeDescriptorByWorkspaceRef` compare | `use-home-agent-session.ts:50-66,151-184` | Reload-in-place on config/agent change (§2.2) |
| `pruneWorkspaceHomeAgentSessions` (prune-on-rotate) | `use-home-agent-session.ts:72` | Derived-liveness reaping (§2.3) — GC, not UI prune |
| Persisted-`pid`/`state` **trust**; `getSummary(taskId)?.pid != null` active check | `runtime-api.ts:212`, hydrated records | Derived `state`/`pid` at one seam (§2.3) |
| Per-`agentId` identity axis (end state) | routing id shape | Agent-as-property of the one identity (§2.2) |
| Cross-workspace home-agent bleed | `saveWorkspaceState`/`mutateWorkspaceState` write path | Home agent lives only in its own workspace's `sessions.json` (§2.4/2.5) |
| Card-workspace ping lookup | `resolveRunningHomeAgentTaskId` | Architect-resolved, cross-workspace by construction (§2.5) |

Net: fewer identities, fewer states, one source of truth for *who the architect is* and *whether it is
alive*. The simpler design is the deeper one.

---

## 5. Concept-map & contract impact (Article 1 / Article 7)

- **Update** `docs/architecture/concepts/home-agent-session.md`: identity is **board-architect-scoped**
  (resolved via `classifyArchitectWorkspace`, not per-viewed-workspace) and its liveness is **derived**
  (real process/transcript), not persisted-and-trusted; it **does not rotate** on config — it reloads in
  place. Remove the "rotates when config changes" line. Cross-link the derived-liveness rule to
  [`task-session.md`](../architecture/concepts/task-session.md) (which already states "the browser is
  never the source of truth for session lifecycle" — this extends that to the persisted pid).
- **Reuse** `classifyArchitectWorkspace` and the `architectWorkspaceId ?? active` rule already in
  `agent-chat-workspace.ts` — do **not** clone a second architect-resolution path; lift the shared rule
  so UI and server agree (concept: [`architect-workspace.md`](../architecture/concepts/architect-workspace.md)).
- **Persistence boundary stays additive** (Article 7): `sessions.json` and `api-contract.ts` schemas are
  unchanged in shape; the migration is a *reconcile*, not a schema break. Dropping `agentId` from the
  routing id (Phase 2, optional) is the one shape change and is gated behind its own migration.

---

## 6. Verification the implementation must show (Article 4 / 5)

Module tests through public APIs, at the seams this design names — RED before GREEN:

1. **Derived liveness (`session-manager` / `workspace-registry`):** a hydrated `state:"running"` record
   whose pid is not a live process is normalized to a non-live state + `pid: null`; a record whose pid
   *is* alive stays `attached`. (Fixtures over a fake pid + a stub `process.kill`.)
2. **Reconcile sweep migration:** given a `sessions.json` with (a) a dead `running` record, (b) a foreign
   home-agent id, (c) a non-architect-workspace home agent — the sweep normalizes (a), removes (b), reaps
   (c), leaves the canonical architect record, and is idempotent on re-run.
3. **Ping resolution (`review-notification`):** for a card in a **sub-workspace**, `resolveRunning…`
   returns the **architect** workspace's home-agent id when it is attached, `null` when only resumable or
   dead; on a **flat** board it returns the card-workspace home agent (aligned case unchanged). No
   reliance on a persisted pid.
4. **Shared resolver:** `resolveArchitectHomeAgentWorkspaceId` returns the architect for a nested board
   and the active workspace for a flat board — the same rule the UI's `resolveAgentChatWorkspace` uses
   (assert they agree).
5. **No rotation on config change (`use-home-agent-session`):** changing model/provider/effort keeps the
   same routing taskId and triggers a reload, not a new id / prune.

Scope the gate to the surface (per `AGENTS.md`): CLI/runtime changes → `npm run typecheck` +
`npm run test:fast` + the touched `src/**` test files; web-ui changes → `npm --prefix web-ui run
typecheck` + targeted `web:test`. No full `npm run build` on the inner loop.
