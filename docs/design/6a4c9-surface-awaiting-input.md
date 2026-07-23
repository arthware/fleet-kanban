# RFC: a card blocked on an input prompt should show "needs input", not "Thinking…"

- **Card / ref:** `6a4c9` (no external issue set, so the card id is the ref)
- **Slug:** `surface-awaiting-input`
- **Type:** Design / RFC — no product code changes here
- **Disposition:** split into build cards (see [Disposition](#disposition))

## Problem statement

When an agent session blocks **waiting for the operator** — a permission prompt, a
clarifying question, a tool-approval, a folder-trust gate — the board frequently shows
the card as **"Thinking…"** with session state `running`. The board is actively lying:
it looks like the agent is working when it is stuck and will never progress without a
human. No review-ping fires, so the operator has no cue to go unblock it.

**Observed:** a Gemini card hung on the folder-trust prompt sat at "Thinking…".
**Expected:** the card visibly reads "needs input" and the operator is pinged, exactly
as it already does when Claude hits a permission prompt.

**Root cause — not a display nit, a *coverage* gap in one mechanism.** The runtime
already has a first-class "needs input" concept: `reviewReason: "needs_input"` on the
`awaiting_review` session state, with a badge and activity text in the UI. But that
state is only ever *produced* by two agent-specific signals — Claude's permission hooks
and Codex's `request_user_input` — that land on a single classifier
(`isNeedsInputReviewHook`). **Gemini emits neither**, and its blocking prompts map to
`activity` (no transition) or to a generic `to_review` that reads as "done". So the
concept exists but nothing feeds it for Gemini, and the session stays `running` →
"Thinking…". The fix is to *feed the existing concept* for the agents that fall through
— not to add a parallel state or special-case one prompt.

> Note: the specific Gemini **folder-trust** prompt is being handled separately (the
> Gemini adapter now sets `security.folderTrust.enabled: false`, so that gate never
> renders). This RFC is about surfacing *genuine* awaiting-input across agents. A prompt
> the harness auto-confirms must **not** flip the card to needs-input; a prompt only the
> human can answer must.

## What exists in the codebase

### The session-state model

`runtimeTaskSessionStateSchema` — `src/core/api-contract.ts:371`:

```ts
z.enum(["idle", "running", "awaiting_review", "failed", "interrupted"])
```

There is **no `awaiting_input` state**. "Needs input" is modeled as a *review reason* on
`awaiting_review` — `runtimeTaskSessionReviewReasonSchema` (`api-contract.ts:377`):

```ts
z.enum(["attention", "exit", "error", "interrupted", "hook", "needs_input"]).nullable()
```

**Session state is decoupled from the board column.** `awaiting_review` does *not* move a
card to the `review` column — it's a session-liveness marker rendered on the card wherever
it sits. This matters for [decision 5](#5-interaction-with-columns): today a needs-input
card stays in `in_progress` with a badge; it is not moved to review.

### "Needs input" already modeled — prior art `5d7b458`

`5d7b458` (feat: distinguish 'needs input' from 'ready for review') added the whole seam:

- The classifier `isNeedsInputReviewHook(metadata)` —
  `src/terminal/session-state-machine.ts:22` — inspects hook metadata
  (`notificationType` / `hookEventName` / `toolName`) and decides whether a `to_review`
  hook means "blocked — answer me".
- The ingest path — `src/trpc/hooks-api.ts:86-90` — calls
  `manager.transitionToReview(taskId, isNeedsInputReviewHook(body.metadata) ? "needs_input" : "hook")`.
- The state machine also defines a `hook.to_needs_input` transition event
  (`session-state-machine.ts:75-89`) that halts to `awaiting_review` /
  `reviewReason: "needs_input"`. **It is currently unused** — the ingest path sets the
  reason via `transitionToReview` directly, not via this event. It is the natural entry
  point for a *terminal-detected* signal (see [proposed solution](#proposed-solution)).
- The UI already renders it — `web-ui/src/components/board-card.tsx`:
  `isCardNeedsInput` (`:182`), the blue **"Needs input"** badge with
  `MessageCircleQuestion` and complete literal `status-blue` Tailwind classes
  (`:863-870`), and the activity text falls back to the agent's question
  (`getCardSessionActivity`, `:193-197`).

### Per-agent input signals — prior art `8c8b4d5`

`8c8b4d5` (fix: handle codex request_user_input events) generalized the classifier to
Codex: `request_user_input` / `AskUserQuestion` function calls in the Codex rollout log
map to `event: "to_review"` with `notificationType: "request_user_input"` +
`toolName` (`src/commands/hook-events/codex-hook-events.ts`), and
`isNeedsInputReviewHook` was extended to recognize those tool names
(`session-state-machine.ts:29-37`). **The signal is agent-specific**; the classifier is
the shared convergence point.

| Agent | Blocked-on-human signal today | Result |
|---|---|---|
| **Claude** | `PermissionRequest` hook + `Notification(matcher: permission_prompt)` → `to_review` + `notificationType: "permission_prompt"` (`agent-session-adapters.ts:832-870`) | ✅ needs_input |
| **Codex** | `request_user_input`/`AskUserQuestion` in rollout log → `to_review` + metadata (`codex-hook-events.ts`) | ✅ needs_input |
| **Gemini** | `Notification` → `activity` (no transition); `AfterAgent` → `to_review` reason `hook` (`hooks.ts:522-533`) | ❌ stays `running` / reads "done" |
| Cursor / droid / kiro / opencode | no needs-input mapping | ❌ (out of scope; audit follow-up) |

### Gemini hook lifecycle

`mapGeminiHookEvent` — `src/commands/hooks.ts:522`:

```ts
AfterAgent → "to_review"   BeforeAgent → "to_in_progress"
AfterTool | BeforeTool | Notification → "activity"
```

The Gemini adapter (`agent-session-adapters.ts:1070-1159`) wires these five hooks and,
crucially, provides **no `detectOutputTransition`** — so Gemini has neither a needs-input
hook mapping nor any terminal-scrape path. `runGeminiHookSubcommand`
(`hooks.ts:558-593`) already parses the raw payload record, so a `Notification` payload's
contents are available if they carry a machine-readable "awaiting input" type.

### Terminal-prompt detection technique

The workspace-trust detectors show the reusable pattern: `stripAnsiAndControl` +
`normalizeTerminalText` + a regex over a rolling buffer —
`src/terminal/claude-workspace-trust.ts:10-62`, `codex-workspace-trust.ts`. They are fed
by the PTY `onData` handler in `src/terminal/session-manager.ts:452-500`, which maintains
`workspaceTrustBuffer` and auto-confirms by writing `\r` after a settle delay
(`WORKSPACE_TRUST_CONFIRM_DELAY_MS = 100`). The same `onData` handler already runs
`detectOutputTransition` (`session-manager.ts:518-534`) and feeds the result through
`applySessionEvent` — this is the seam a Gemini terminal detector would use.

### The review notify — prior art `4687f74`

`notifyTaskReadyForReview` fires the architect ping. It is called **only** from
`hooksApi.ingest` on a `to_review` event (`src/trpc/hooks-api.ts:132-143`).
`applySessionEvent` in the session manager — the path a *terminal-detected* transition
takes — **does not notify** (`session-manager.ts:518-534`). The message
(`buildTaskReadyForReviewMessage`, `src/core/review-notification.ts:5-8`) is generic:
*"…was moved to review and is awaiting your review."* — it does not distinguish
needs-input from done.

## Proposed solution

Keep the existing concept (`reviewReason: "needs_input"`) and make it **reliably
produced** for Gemini, with notify parity for whichever producer fires. One concept, two
producers converging on it (Constitution Article 1 — extend, don't clone).

### 1. Feed needs-input for Gemini (the crux)

Two candidate producers; pick per a short spike ([open questions](#open-questions)),
preferring the structured one:

- **(Preferred) Hook-based**, *if* Gemini's `Notification` payload carries a
  machine-readable "awaiting your input / approval" type. Then:
  - In `mapGeminiHookEvent` (`hooks.ts:522`), return `"to_review"` instead of
    `"activity"` for a Notification whose payload indicates awaiting-input, and set
    `notificationType` on the metadata (via `runGeminiHookSubcommand`, which already has
    `payloadRecord`) so `isNeedsInputReviewHook` lifts it to `needs_input`.
  - Extend `isNeedsInputReviewHook` (`session-state-machine.ts:22`) to recognize the
    Gemini notification type — the same one-line addition pattern `8c8b4d5` used.
  - This rides the existing ingest path, so **notify already works** for free.

- **(Fallback) Terminal-scrape**, if Gemini emits no usable structured event. Add a
  `geminiPromptDetector: AgentOutputTransitionDetector` and attach it as
  `detectOutputTransition` on the Gemini adapter (`agent-session-adapters.ts:1148-1157`):
  - Reuse `stripAnsiAndControl` + a normalized regex over the decoded buffer to match
    Gemini's approval/question prompt markers.
  - Return the **already-defined but currently-unused** `{ type: "hook.to_needs_input" }`
    event, finally wiring that latent state-machine path
    (`session-state-machine.ts:75-89`).
  - This path goes through `applySessionEvent`, so it needs the notify fix in step 3.

**Union signal:** a session flips to `needs_input` when *either* a hook ingest satisfies
`isNeedsInputReviewHook` *or* an adapter's `detectOutputTransition` returns
`hook.to_needs_input`. Both land on the one review reason. Also **audit Claude** — a bare
clarifying question (no permission prompt) currently ends the turn as `Stop` →
`reviewReason: "hook"` ("done"), not needs-input; capture whether that needs the same
treatment.

### 2. No false positives / no flapping (hard requirement)

- **Exclude auto-confirmed prompts.** The needs-input signal must be the *complement* of
  what the harness auto-handles. Folder-trust is already off for Gemini
  (`folderTrust.enabled: false`), so it never renders — nothing to detect. For any
  terminal detector, it must **not** match a prompt that `shouldAutoConfirm*WorkspaceTrust`
  handles, and it must only fire *after* the auto-confirm settle window
  (`WORKSPACE_TRUST_CONFIRM_DELAY_MS`) elapses with the prompt still pending — so the
  auto-`\r` wins the race and the badge never flickers on launch.
- **Auto-clear on resumed activity.** needs_input already clears via
  `hook.to_in_progress` / `agent.prompt-ready` (`session-state-machine.ts:90-103`);
  Gemini's `BeforeAgent`/`BeforeTool` hooks map to `to_in_progress`, so the moment the
  operator's `fleet task say` reaches the PTY and the agent resumes, the badge clears. The
  terminal detector must not re-assert needs_input once activity resumes.
- **Debounce/coalesce.** Terminal output is chunked and a prompt can render partially.
  Detect over a rolling buffer with a small settle delay, and require the prompt to still
  be the tail of the buffer (not followed by fresh activity) before flipping — mirroring
  the trust-buffer approach.

### 3. Notify parity + honest message

- Fire the review-notify for a **terminal-detected** needs_input too. Today only
  `hooksApi.ingest` notifies; a `hook.to_needs_input` via `applySessionEvent` surfaces the
  badge but pings no one (`session-manager.ts:518-534`). Route that transition through the
  same `notifyTaskReadyForReview` (inject the notify dep into the manager, or emit a
  needs-input event the ingest/notify layer observes) so every producer alerts the
  operator.
- Make `buildTaskReadyForReviewMessage` (`review-notification.ts:5`) branch on the review
  reason: *"is waiting for your input"* vs *"is ready for review"*, so the ping is honest
  about which it is.

### 4. Surfacing (already built — verify only)

The UI is done: `isCardNeedsInput` + the blue "Needs input" badge + the question as
activity text (`board-card.tsx:182-197, 863-870`). No new UI is needed; the fix is
entirely upstream (produce the state). The build card should visually verify a Gemini card
shows the badge on an isolated instance.

### 5. Interaction with columns

**Recommendation: keep needs-input in `in_progress` with the badge — do not move the card
to `review`.** Session state is already decoupled from column, so this is the current
behavior and it matches the operator's mental model: the `review` column is "finished work
to look at"; a stuck in-progress card is "unblock me in place". No column change.

## Technical rationale

- **A blocked agent shown as "Thinking…" is a wrong-model symptom, not a cosmetic bug**
  (Article 2). The board asserts progress that will never happen. The fix models the state
  once and surfaces it — it does not special-case the one Gemini prompt that triggered the
  report.
- **Extend the one seam; don't fork it** (Article 1). Codex's event→classifier path
  (`8c8b4d5`) and the needs-input reason (`5d7b458`) are the foundation. Gemini becomes a
  third producer feeding the *same* `isNeedsInputReviewHook` / `hook.to_needs_input`
  convergence, reusing terminal detection only where no structured event exists. We add a
  producer, not a parallel concept.
- **Reject a new `awaiting_input` enum state** — recommended, with tradeoffs stated. A new
  session state would ripple through every switch on `RuntimeTaskSessionState` (state
  machine, `workspace-api` liveness `:132`, board-card, and their tests) for **zero added
  behavior**: the card doesn't change column, and the "blocked vs done" distinction is
  already fully carried by `reviewReason` end-to-end (API → UI → notify). That is exactly
  the compatibility-scaffolding churn Article 7/8 tell us to avoid. The one real weakness —
  `awaiting_review` *reads* like "done" — is already neutralized in the UI by the
  needs-input badge and activity text, so the enum buys clarity we already have.
- **Prefer the structured hook over PTY scraping for Gemini** — terminal-scrape is
  regex-on-a-TUI: brittle across Gemini versions, locales, and redraws. Use it only if the
  spike shows Gemini emits no machine-readable awaiting-input event; even then, scope it to
  the adapter and gate it hard against the auto-confirm window to keep it from flapping.
- **Notify parity is the non-obvious risk.** The terminal-scrape path silently skips the
  ping because only `hooksApi.ingest` notifies. Missing this would ship a badge that
  changes but never alerts — the exact "looks handled, isn't" trap. Calling it out here so
  the build card treats notify as in-scope, not an afterthought.

## Open questions

1. **Does Gemini CLI emit a machine-readable "awaiting input / approval" event** (e.g. a
   typed `Notification` payload), or is terminal detection the only path? This decides
   between the preferred hook route and the fallback scrape route — resolve with a short
   spike inspecting `Notification` payloads from a real non-`--yolo` Gemini approval prompt.
2. **Is the new enum truly unwarranted?** Recommendation is review-reason only; confirm no
   future consumer needs `awaiting_input` as a distinct *state* (e.g. a column-move policy)
   before committing.
3. **Should needs-input auto-clear purely on next input, or also time out?**
   Recommendation: clear on resumed activity only (no timeout) — a stuck card should stay
   visibly stuck until acted on. Flag if any card type wants a TTL.
4. **Claude clarifying-question gap:** does a bare question (turn-ending `Stop`, no
   permission prompt) warrant needs-input too, or is that acceptably rare? Audit in the
   detection card.

## Disposition

**Split into build cards** — a small fan-out; the UI is already built:

- **Card A — Gemini needs-input detection + no-flapping.** Spike hook-vs-terminal
  (open question 1), implement the chosen producer, wire the latent `hook.to_needs_input`
  if terminal, enforce the auto-confirm-window / debounce / auto-clear guarantees, and
  audit Claude's clarifying-question path. → Codex.
- **Card B — notify parity + honest message.** Fire `notifyTaskReadyForReview` for
  terminal-detected needs_input, and branch `buildTaskReadyForReviewMessage` on the review
  reason. → Codex. (Can follow A, or land together if A takes the hook route — in which
  case notify already rides ingest and B shrinks to just the message wording.)

No UI card required beyond visual verification on an isolated instance.

## Prior art

- `5d7b458` — feat(kanban): distinguish 'needs input' from 'ready for review' — the
  needs-input review-reason seam.
- `8c8b4d5` — fix: handle codex request_user_input events — the per-agent
  input-event → classifier path to generalize.
- `4687f74` — feat: notify architect when task enters review (#75) — the notify path a
  needs-input card must ride, including the terminal-detected producer.
