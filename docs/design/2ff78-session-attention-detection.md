# RFC: session attention detection for false in-progress spinners

- **Card / ref:** `2ff78` (derived from branch `2ff78-plan-detect-needs-input-dead-sessions-stop-the-false`; no external issue was provided)
- **Slug:** `session-attention-detection`
- **Type:** Design / RFC - no product code changes here
- **Disposition:** implement-here

## Problem statement

An `in_progress` card can show the same spinner for three different session conditions:

- The agent is genuinely running.
- The agent is blocked on a human answer or permission prompt.
- The agent process is gone and no work is happening.

The root cause is not the spinner itself. The board card currently renders from `columnId` plus a coarse
session summary and re-derives attention state locally. `board-card.tsx` even computes
`needsInput = isCardNeedsInput(sessionSummary)` at `web-ui/src/components/board-card.tsx:529`, but
`renderStatusMarker()` ignores it and returns `<Spinner size={12} />` for every `in_progress` card
except `state === "failed"` (`web-ui/src/components/board-card.tsx:530-539`). The CLI similarly exposes
raw session state but no shared interpretation, so the operator cannot scan `fleet task ls` or
`fleet task cat` and know whether to steer with `fleet task say` or restart.

The fix should remove the ambiguity once, at the runtime-summary boundary, so UI and CLI surfaces read
the same derived condition instead of duplicating predicates.

## What exists in the codebase

### Concepts and canonical homes

- **Runtime summary** lives in `src/core/api-contract.ts` and is documented in
  `docs/architecture/concepts/runtime-summary.md`. It is the canonical product-shaped session state,
  with `state`, `reviewReason`, `pid`, `agentSessionId`, and `agentSessionLifecycle`.
- **Task session** lives in `src/terminal/session-manager.ts`,
  `src/cline-sdk/cline-task-session-service.ts`, and `src/terminal/agent-session-launch.ts`; see
  `docs/architecture/concepts/task-session.md`. Lifecycle is runtime-owned, not browser-owned.
- **Card lifecycle / columns** live separately (`backlog`, `in_progress`, `review`, `done`, `trash`);
  see `docs/architecture/concepts/card-lifecycle.md`. A card can remain in `in_progress` while its
  session summary says `awaiting_review`.
- **tRPC contract** is the Zod spine in `src/core/api-contract.ts`; see
  `docs/architecture/concepts/trpc-contract.md`. Schema changes must be additive/optional.

### Prior art read

- `5d7b458` - `feat(kanban): distinguish 'needs input' from 'ready for review'`.
  This added `reviewReason: "needs_input"` to the session summary contract
  (`src/core/api-contract.ts:379-381`), `isNeedsInputReviewHook()` and the
  `hook.to_needs_input` transition (`src/terminal/session-state-machine.ts:22-38`,
  `:75-89`), hook ingestion that lifts matching `to_review` metadata into
  `reviewReason: "needs_input"` (`src/trpc/hooks-api.ts:88-95`), and the existing board-card
  `isCardNeedsInput()` helper (`web-ui/src/components/board-card.tsx:184-186`).
- `8c8b4d5` - `fix: handle codex request_user_input events`.
  This extended Codex rollout parsing so `request_user_input` / `AskUserQuestion` function calls emit
  `to_review` with `notificationType: "request_user_input"` and `toolName`, then extended
  `isNeedsInputReviewHook()` to classify that metadata as needs-input.

### Needs-input detection today

`runtimeTaskSessionReviewReasonSchema` already includes `needs_input`
(`src/core/api-contract.ts:379-381`). `isNeedsInputReviewHook()` recognizes Claude permission prompts
and Codex request-user-input tool calls (`src/terminal/session-state-machine.ts:22-38`). Hook ingest
only transitions to review while the summary is `running` (`src/trpc/hooks-api.ts:33-46`) and calls
`manager.transitionToReview(taskId, "needs_input")` for matching metadata
(`src/trpc/hooks-api.ts:88-95`).

That proves supported needs-input prompts are observable in the session summary, but not as
`state: "running"`. They become:

```ts
state: "awaiting_review"
reviewReason: "needs_input"
pid: <still non-null for PTY agents>
```

The non-null `pid` is intentional: the prior-art tests assert that a permission prompt keeps the PTY
alive so `fleet task say` / `task send-input` can answer it. If a future agent can block on input
without producing either a hook or rollout signal, that is a detection gap in the agent adapter, not a
UI predicate gap. The build should add adapter-specific tests for any such discovered source.

### Dead-session detection today

The process/lifecycle model already exists:

- `runtimeAgentSessionLifecycleSchema` is `attached | resumable | gone`
  (`src/core/api-contract.ts:384-385`).
- `classifyAgentSessionLifecycle()` returns `attached` when there is a live process, `resumable` when
  there is a stored session id plus transcript, and `gone` otherwise
  (`src/terminal/agent-session-launch.ts:49-75`).
- `TerminalSessionManager.refreshAgentSessionLifecycle()` asks
  `classifyEntryAgentSessionLifecycle()` and then applies
  `reconcileTaskSessionSummaryLiveness()` (`src/terminal/session-manager.ts:298-314`).
- `reconcileTaskSessionSummaryLiveness()` keeps attached summaries unchanged; for a non-attached
  `running` summary it clears `pid` and changes `state` to `interrupted` when `startedAt` exists, or
  `idle` when it does not (`src/core/session-liveness.ts:3-30`).
- Normal process exit also clears `pid` through the state machine
  (`src/terminal/session-state-machine.ts:104-116`).

The existing lifecycle names are resume-oriented, not display-oriented: `resumable` and `gone` both
mean "not actively running" for an `in_progress` card. The UI already consults `"gone"` for archive
restore labels (`web-ui/src/components/board-card.tsx:565-570`, `:809-815`), but the in-progress
marker does not use lifecycle.

### CLI output today

`src/commands/task.ts` owns `kanban task list` and formats rows through `formatTaskRecord()`.
That record currently includes `session.state`, `agentId`, `pid`, timestamps, `reviewReason`, and
`exitCode`, but not `agentSessionLifecycle`, latest hook activity, or a derived condition
(`src/commands/task.ts:497-533`). `listTasks()` returns those records for `task list`
(`src/commands/task.ts:600-625`).

No `task cat` command is registered in the current file; a build should either add the alias if
`fleet task cat` is required by the product surface, or update the actual cat implementation if it
lives outside this file. In either case, it should consume the same formatted task record.

`fleet-cli/fleet.py` also reads persisted Kanban `sessions.json` directly for its overview rows. It
currently carries `session_state = s.get("state")` (`fleet-cli/fleet.py:704-714`) and colors live rows
from the board column plus agent detection (`fleet-cli/fleet.py:770-804`). If this Python overview
remains a supported operator surface, it needs the same derivation ported or it will continue to drift.

## Proposed solution

### 1. Add one derived session condition

Introduce a shared runtime-summary derivation in a new core module:

```ts
// src/core/session-condition.ts
export const runtimeTaskSessionConditionSchema = z.enum([
  "none",
  "running",
  "needs_input",
  "dead",
  "review",
  "failed",
  "interrupted",
  "idle",
]);
```

Export `RuntimeTaskSessionCondition` from `src/core/api-contract.ts` and add an optional/defaulted
`condition` field to `runtimeTaskSessionSummarySchema`:

```ts
condition: runtimeTaskSessionConditionSchema.default("none")
```

Keep it additive so older `sessions.json` files parse. The condition is display/product state; it does
not replace the existing state machine yet.

The helper should take both the session summary and the board column because the bug is specifically
about card-plus-session display:

```ts
deriveTaskSessionCondition({
  columnId: RuntimeBoardColumnId,
  summary: RuntimeTaskSessionSummary | null | undefined,
}): RuntimeTaskSessionCondition
```

Exact predicate order:

1. `none`: no summary.
2. `needs_input`: `summary.state === "awaiting_review" && summary.reviewReason === "needs_input"`.
3. `failed`: `summary.state === "failed" || summary.reviewReason === "error"`.
4. `interrupted`: `summary.state === "interrupted" || summary.reviewReason === "interrupted"`.
5. `dead`: `columnId === "in_progress"` and any of:
   - `summary.agentSessionLifecycle === "gone"`;
   - `summary.agentSessionLifecycle === "resumable"`;
   - `summary.pid == null` and `summary.state` is one of `"idle"`, `"awaiting_review"`,
     `"interrupted"`, or `"failed"` and `summary.reviewReason !== "needs_input"`.
6. `running`: `columnId === "in_progress" && summary.state === "running" &&
   summary.agentSessionLifecycle !== "gone" && summary.pid != null`.
7. `review`: `summary.state === "awaiting_review"`.
8. `idle`: everything else with a summary.

Rationale for treating `resumable` as `dead`: for an in-progress card, the old process is gone even
if the transcript can be resumed. The operator action is restart/resume, not wait for current work.
The UI copy can say "Session ended" without implying data loss.

Credit-limit remains an overlay, not the core condition. `isCardCreditLimitError()` should keep taking
precedence in board-card rendering because it is a known, more specific failure/attention reason
(`web-ui/src/components/board-card.tsx:174-182`).

### 2. Materialize condition in server summaries and formatted task records

Add a small helper that decorates summaries when the board column is known:

```ts
withTaskSessionCondition(summary, columnId)
```

Thread it through:

- `src/core/api-contract.ts` - enum/type plus optional field on
  `runtimeTaskSessionSummarySchema`.
- `src/core/session-condition.ts` - pure derivation.
- `src/terminal/session-manager.ts` - `createDefaultSummary()` sets `condition: "none"` or relies on
  the schema default; every `cloneSummary()` path may leave it untouched because board column is not
  known there.
- Server snapshot builders that know board columns should decorate each task session before returning
  or streaming state. Start with `src/server/workspace-registry.ts` and
  `src/server/runtime-state-hub.ts` call sites that build workspace state, plus
  `src/trpc/app-router.ts` / `workspace.getState` if decoration is not already centralized.
- `src/commands/task.ts` - `formatTaskRecord()` should compute `condition` from `(columnId, session)`
  and include it inside `session`. Also include `agentSessionLifecycle` and a compact `activity`
  string from `latestHookActivity.finalMessage ?? activityText` so CLI output can explain attention.
- `fleet-cli/fleet.py` - either read a persisted `condition` when present or port the exact same
  predicate over `column`, `state`, `reviewReason`, `pid`, and `agentSessionLifecycle`. Prefer reading
  the field if the server persists decorated summaries; if not persisted, port the predicate in one
  clearly named helper and add a comment pointing to `src/core/session-condition.ts`.

Be careful with the reducer/mapping gotcha: adding a schema field is not enough. The build must verify
that runtime snapshots, workspace getState responses, stream updates, web-ui normalized state, and CLI
formatting all preserve or recompute the condition.

### 3. UI markers

Replace the unconditional in-progress spinner branch in
`web-ui/src/components/board-card.tsx:530-539` with condition-based rendering:

| Condition | Marker | Tooltip | Notes |
|---|---|---|---|
| `running` | existing `<Spinner size={12} />` | `Agent is working` | Spinner only here. |
| `needs_input` | `MessageCircleQuestion size={12}` in `text-status-blue` | `Waiting for your input` | Reuse imported Lucide icon already used by the badge. |
| `dead` | `AlertTriangle size={12}` in `text-status-orange` | `Session ended - restart or resume` | Use warning, not failure, because resumable may be recoverable. |
| `failed` | `AlertCircle size={12}` in `text-status-red` | `Agent failed` | Keep existing red failure treatment. |
| `interrupted` | `AlertTriangle size={12}` in `text-status-orange` | `Session interrupted` | Distinct from a crash but still attention-worthy. |
| credit limit | existing `AlertTriangle` orange | existing/no new copy | Keep first priority. |

Keep the existing blue "Needs input" badge and `getCardSessionActivity()` copy
(`web-ui/src/components/board-card.tsx:188-199`). The marker is the compact top-line signal; the badge
and activity row provide detail.

Also audit other status/spinner surfaces:

- `web-ui/src/components/card-detail-view.tsx` and the detail agent panels should use the same
  condition in headers/tab badges if they display a running spinner.
- `web-ui/src/components/detail-panels/agent-terminal-panel.tsx` should avoid implying the terminal is
  live when the condition is `dead`; this is especially relevant because live PTY panels are gated by
  `pid != null`.
- Do not add explanatory in-app text beyond concise tooltips and status labels.

### 4. CLI display

For JSON output, include `session.condition` in both list rows and single-task records:

```json
"session": {
  "state": "awaiting_review",
  "condition": "needs_input",
  "reviewReason": "needs_input",
  "agentSessionLifecycle": "attached",
  "pid": 4242
}
```

For human-readable `fleet task ls`, add a short status token per row:

| Condition | Token | Operator action |
|---|---|---|
| `running` | `running` | wait/watch |
| `needs_input` | `needs-input` | `fleet task say` / `kanban task send-input` |
| `dead` | `dead` | restart/resume |
| `review` | `review` | inspect/move forward |
| `failed` | `failed` | inspect logs/restart |
| `interrupted` | `interrupted` | resume/restart |
| `idle` | `idle` | start if needed |

If the current command only emits JSON, add a `status` or `sessionStatus` field rather than building a
new table renderer. If `fleet task cat` is not currently registered, the build should add a `cat`/`show`
command only if acceptance requires it; it can call `formatTaskRecord()` for one resolved task so the
new condition is identical to `task list`.

### 5. Detection gaps to verify during implementation

Needs-input detection is proven for supported Claude permission prompts and Codex `request_user_input`
events. It is not proven for arbitrary assistant questions that do not use those events. The build
should not infer "idle with no output" as needs-input; that would recreate the ambiguity with a timer.
If a specific agent blocks without hook metadata, add or extend that agent adapter to emit
`hook.to_needs_input` or `to_review` metadata recognized by `isNeedsInputReviewHook()`.

Dead-session detection should be based on the current process/lifecycle signals after liveness
refresh, not on `lastOutputAt` age. A legitimately quiet long-running command is still `running` if it
has an attached live process.

## Technical rationale

- **One source of truth.** The runtime summary is already the contract between long-running agents and
  surfaces. A derived condition there lets board, detail, CLI, and future surfaces agree.
- **Reuse before rebuild.** `needs_input`, `agentSessionLifecycle`, and liveness reconciliation already
  exist. The design composes those signals instead of adding a parallel browser-only stuck detector.
- **Dead vs resumable.** Lifecycle remains resume-oriented (`attached | resumable | gone`), while
  condition is operator-oriented (`running | needs_input | dead | ...`). Keeping both avoids overloading
  lifecycle names.
- **No idle timeout.** Time-since-output is not a reliable proof that a session is blocked or dead.
  Process liveness and hook metadata are stronger signals.
- **Additive contract change.** `condition` can default for old state files and does not require a
  migration.

Alternatives rejected:

- **Patch only `board-card.tsx`.** This would stop one false spinner but leave CLI and future surfaces
  to repeat the same derivation.
- **Add a new session state `needs_input`.** Prior art intentionally modeled needs-input as
  `awaiting_review` plus `reviewReason`, preserving the existing state machine and `fleet task say`
  behavior. A new state would broaden persistence/wire impact without solving dead sessions.
- **Use `agentSessionLifecycle` directly in every renderer.** That keeps lifecycle and operator status
  coupled in each surface and invites drift.

## Open questions

- Is `fleet task cat` a planned alias outside the current `src/commands/task.ts` surface, or should the
  build add `task cat` / `task show` in this change?
- Should `condition` be persisted into `sessions.json`, or only materialized on read/stream/format? The
  safer first implementation is to materialize on read and format, because the value is derived from
  board column plus session summary and can go stale if persisted independently.
- Native Cline summaries have `pid: null` by design in several tests. The build must verify how
  `agentSessionLifecycle` is set for active Cline SDK sessions and ensure the `dead` predicate does not
  mark live Cline work dead solely because `pid` is null.
- Should the Python `fleet-cli/fleet.py` overview remain part of acceptance for `fleet task ls`, or is
  the Node `kanban task list` command the only supported task-list surface?

## Test plan

- Add module tests for `deriveTaskSessionCondition()`:
  - in-progress + `state: "running"` + lifecycle `attached` + `pid` present => `running`;
  - in-progress + `state: "awaiting_review"` + `reviewReason: "needs_input"` + `pid` present =>
    `needs_input`;
  - in-progress + lifecycle `gone` => `dead`;
  - in-progress + lifecycle `resumable` => `dead`;
  - review column + `awaiting_review` + `reviewReason: "hook"` => `review`, not `dead`;
  - credit-limit remains outside the helper and is tested in board-card rendering if touched.
- Add or update command-format tests around `formatTaskRecord()` so `session.condition` and
  `agentSessionLifecycle` appear in `task list`/single-task JSON.
- Add focused UI tests for `BoardCard` status markers, or the closest existing component test harness:
  needs-input renders `MessageCircleQuestion`/tooltip and no spinner; dead renders warning marker and
  no spinner; running still renders the spinner.
- Add a runtime-state fanout or workspace getState test proving the condition survives the server to
  web-ui path if it is materialized server-side.
- Functional check on an isolated runtime (not ports 3500/3200): seed one running card, one
  needs-input card, and one dead-session card; verify the board markers and `fleet task ls` tokens.

Verification gate for the build card:

- `npm run typecheck`
- `npm run test:fast`
- targeted tests added/changed, for example:
  - `npx vitest run test/runtime/core/session-condition.test.ts`
  - `npx vitest run test/runtime/commands/task-session-condition.test.ts`
  - `npm --prefix web-ui run typecheck`
  - targeted web-ui component test command if the repo has one for board-card rendering

## Disposition

implement-here

This is a single coherent build card: add the shared derived condition, thread it through the runtime
summary/CLI formatting, and update the UI marker rendering. It should not be split unless the Cline SDK
liveness open question reveals that active Cline sessions cannot be distinguished with the existing
summary fields.
