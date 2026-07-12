# Pi coding-agent harness — SDK vs CLI, and the integration spec

**Status:** Design (no code in this card) · **Card:** `95a9d` · **Owner:** Arthur ·
**Target branch:** `production-line` · **Prior art:** Kiro `52d9d6c`, droid `0098439`,
steer `64bb716`, tail `9a6f8aa`, needs-input `5d7b458`, stub harness `92d7eb5`; upstream
`cline/kanban#223` (+2543) · **Last updated:** 2026-07-13

> **Decision in one line:** integrate Pi as a **CLI subprocess** (like every other agent we run),
> and derive session state from Pi's **structured JSONL session log** — not from its programmatic
> SDK, and not by scraping a TUI. Port the shape of upstream PR #223, adapted to our diverged fork.

---

## 1. Problem & goal

We want to add the **Pi coding agent** (`github.com/badlogic/pi-mono`, `pi.dev`) as a selectable
harness in the fork, alongside claude / codex / droid / kiro / cline. Pi exposes **two** integration
surfaces and the load-bearing decision this doc must make is **which one we build against**:

- **Pi agent SDK** — the programmatic runtime (`@mariozechner/pi-coding-agent`, and the underlying
  `pi-agent-core` runtime + `pi-ai` provider layer; the packages are now also published under the
  `@earendil-works/*` scope). Offers in-process agent execution and a JSON/RPC event stream.
- **Pi CLI** — the `pi` terminal binary: an interactive TUI, plus a non-interactive/RPC mode
  (`--mode rpc`) that speaks a line-delimited JSON protocol on stdio.

The recommendation must be judged **against how our fork actually runs agents** — not against
upstream's assumptions — across the concrete axes the card names: how we **derive** session state,
readiness detection, prompt/steer input (`fleet task say`, `64bb716`), turn-end / needs-input vs
ready-for-review (`5d7b458`), and reading the live conversation (`task tail`, `9a6f8aa`).

**Done =** a chosen surface with the loser's downsides named; an integration outline keyed to the
exact seams; a Given/When/Then test strategy that covers Pi via the deterministic stub harness with
no real Pi process; and a build disposition.

---

## 2. How our fork runs agents (the constraints any Pi surface must satisfy)

Every agent in the fork is launched as a **PTY subprocess** and its session state is **derived**, not
re-streamed or re-persisted. The spine is three files:

- **`src/core/agent-catalog.ts`** — the static catalog: one `RuntimeAgentCatalogEntry` per agent
  (`id`, `label`, `binary`, `baseArgs`, `autonomousArgs`, `installUrl`, optional
  `supportsAgentModelOverride`), plus `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`.
- **`src/terminal/agent-session-adapters.ts`** — one `AgentSessionAdapter` per agent. `prepare()`
  returns a `PreparedAgentLaunch` (`binary`, `args`, `env`, optional `deferredStartupInput`,
  `detectOutputTransition`, `shouldInspectOutputForTransition`). This is where each agent's flags,
  hook wiring, plan-mode, resume, and model-override are assembled.
- **`src/terminal/session-manager.ts`** — owns the PTY lifecycle, the state machine
  (`session-state-machine.ts`), auto-restart, and the `onExit` handler.

State is **derived from the agent's own artifacts** through two channels:

1. **Hooks → `fleet hooks ingest` / `notify`.** claude/droid/kiro/gemini/cline all have a *native
   hook system*; the adapter writes a hook config that shells back into our CLI on lifecycle events
   (`to_in_progress`, `activity`, `to_review`). `hooks-api.ts` reduces those into the state machine.
   This is how a card moves running → awaiting-review, and how `latestHookActivity` (the tool/label
   shown on the card) is populated.
2. **TUI output detectors** (`detectOutputTransition`). Where an agent has *no* hook for a signal we
   need, the adapter scrapes rendered output. Example: `codexPromptDetector` watches for the `›`
   prompt glyph to know codex is ready for input again after a hook-driven review.

Two derived fork capabilities constrain the Pi design directly:

- **Steering — `fleet task say` (`64bb716`).** Writes into the **live PTY** via
  `terminalManager.writeInput`, wrapping the text in a **bracketed paste**
  (`toBracketedPasteSubmission`) so a mid-turn agent buffers it cleanly. **It requires a live PTY:**
  if the session has ended (`pid === null`) the command reports "not live — resume it first."
- **needs-input vs ready-for-review (`5d7b458`).** A `to_review` hook that carries
  `notificationType: "permission_prompt"` / `hookEventName: "PermissionRequest"` is classified
  (`isNeedsInputReviewHook`) into `reviewReason: "needs_input"` — a *distinct* "blocked, answer me"
  badge — while keeping the PTY alive so `fleet task say` can answer. This is driven **purely by hook
  metadata**.

**Reading the conversation — `task tail` (`9a6f8aa`)** derives entirely from the agent CLI's own
on-disk transcript via `readAgentTranscript`; the board never re-streams.

**The invariant that decides everything below:** our fork is a *thin wrapper that derives state from
an agent's own on-disk artifacts and a PTY it owns*. It does **not** host an agent runtime in-process,
own a message loop, or re-persist a conversation. Any Pi surface we pick must fit that shape.

---

## 3. What Pi actually offers on each surface

Grounded in the code of upstream PR #223 (its `pi-readiness.ts` and `pi-session-log.ts` are the
authoritative description of Pi's real protocol, more than the high-level README):

### 3a. The CLI surface

- **Interactive TUI**, launched as a normal subprocess. Takes the task as a positional prompt.
- **A structured JSONL session log.** With `--session-dir <dir>`, Pi writes `*.jsonl` where each line
  is `{"type":"message","message":{"role":"user"|"assistant"|"toolResult","content":[…]}}`. Assistant
  turns carry `toolCall` entries and text blocks; a final answer is marked by a text block whose
  `textSignature` decodes to `{"phase":"final_answer"}`. **This is a first-class, machine-readable
  session log — not a TUI to scrape.** `pi-session-log.ts` maps each entry to exactly the same
  `RuntimeHookEvent`s our hooks emit (`to_in_progress` on a user message, `activity` on tool
  call/result, `to_review` on final answer).
- **JSON-RPC mode** (`--mode rpc --no-session`): send `{"id","type":"prompt","message":…}` on stdin,
  receive `{"type":"response","command":"prompt","success","error"}` on stdout. Upstream uses this
  **only** for a fast readiness probe (is the API key present? is the model resolvable?).
- **Flags in use:** `--session-dir`, `--append-system-prompt`, `--continue`/`-c`, `--model`.

### 3b. The SDK surface

- Importable runtime (`pi-agent-core` + `pi-ai`): construct an agent in-process, feed it a prompt,
  and consume a **structured/streamed event feed** programmatically — no subprocess, no PTY.
- This is the "embed the agent in your app" path. It gives the richest event data with zero parsing,
  but only to a process that is willing to **host the agent loop itself**.

---

## 4. Decision: build against the **CLI** surface

**We integrate Pi as a CLI subprocess and derive state from its `--session-dir` JSONL log.** This is
the only option that preserves the fork invariant (§2). The evaluation, axis by axis:

| Axis | CLI (chosen) | SDK (rejected) |
|---|---|---|
| **How we derive session state** | Tail the structured JSONL log → map entries to our existing `RuntimeHookEvent`s. Pi already emits a clean, typed session record; we consume it the same way we consume every other agent's artifacts. **No TUI scraping** — the "CLI" path here is log-derived, not screen-derived. | We'd host Pi's runtime in-process and consume its event stream, then **re-emit and re-persist** that state into the board — exactly the "re-stream / re-persist" our architecture forbids. A second, privileged state source parallel to the PTY path. |
| **Process model** | Identical to claude/codex/droid/kiro: `agent-catalog` entry + adapter + `session-manager` PTY. Reuses restart, transcript reader, worktree, and terminal panel wholesale. | Requires a new in-process agent host, its own lifecycle, crash handling, and cancellation — a parallel runtime the `session-manager` doesn't manage. Breaks durable-sessions assumptions (a card = a PTY the manager can adopt/restart). |
| **Readiness detection** | Pi's RPC mode gives a *purpose-built* pre-flight (`probePiReadiness`): spawn `pi --mode rpc --no-session`, send one prompt, classify `missing_api_key` / `model_not_found`. Cheap, structured, and it is the *one* place we use RPC. | The SDK surfaces auth/model errors as thrown exceptions inside our process — usable, but now auth failures live in *our* address space rather than an isolated probe subprocess. |
| **Prompt / steer input (`fleet task say`)** | Prompt is passed as the launch arg; steering reuses the existing bracketed-paste PTY write **iff Pi stays interactive between turns** (open question §6). | Steering would mean calling an SDK method — a *third* input path distinct from the PTY and Cline transports, with no reuse of `sendTaskSessionInput`. |
| **Turn-end / needs-input vs review (`5d7b458`)** | The JSONL `final_answer` block → `to_review`; a Pi "ask the user" tool call can be mapped to `needs_input` metadata, reusing the existing classifier. Same enum, same badge, no new lifecycle column. | We'd translate SDK events into the same review reasons anyway — but from inside a bespoke host, duplicating the mapping the log-tailer already gives us for free. |
| **Read live conversation (`task tail`)** | The JSONL log **is** an on-disk transcript; `task tail` keeps working via `readAgentTranscript` (with a small Pi normalizer if its shape differs). | Conversation lives in process memory; `task tail` (a read-only, cross-process CLI) would have nothing on disk to read unless the SDK host also writes a transcript — i.e. we'd re-implement what the CLI gives us. |
| **Upstreamability** | PR #223 already integrates Pi via the CLI/log path. Matching its shape keeps us rebase-friendly on `upstream`. | Diverges hard from upstream; every rebase fights it. |
| **Maintenance surface** | One adapter + two pure parser modules + a thin wrapper command. Pi CLI flag/log changes are contained. | We take on Pi's runtime API as a hard dependency in our hot path; every Pi SDK bump can break card execution. |

**Why the CLI wins even though the SDK's events are "richer":** the SDK's advantage — structured
events with no parsing — is *already delivered by the CLI* through the JSONL session log. Pi is
unusual (and lucky for us) in that its CLI is not a black-box TUI: it persists the same structured
record the SDK would stream. So the CLI path gets ~all of the SDK's data quality **without** paying
the SDK's architectural cost (hosting a runtime, re-persisting state, a parallel input path, a
non-upstreamable divergence). The decision is not "structured vs unstructured" — both are structured
— it is "**derive from an artifact the subprocess writes**" vs "**own the runtime and re-emit**," and
our whole fork is built on the former.

**Named downsides of the rejected SDK path** (so the impl card doesn't reconsider it lightly):
in-process agent hosting breaks the "card = a PTY the session-manager owns" model that durable
sessions and auto-restart depend on; it creates a second state-authority the board must reconcile
with the PTY; it makes `task tail` / `task say` — deliberately cross-process CLI tools — unable to
reach an in-memory session; and it welds Pi's runtime API into our launch hot path, the exact coupling
`AGENTS.md`'s "prefer direct process launches" guidance warns against.

---

## 5. The one genuinely-hard problem: Pi's exit semantics vs our persistent-PTY model

Every other PTY agent we run stays alive at a prompt between turns, so `hook.to_review` moves the card
to `awaiting_review` **without nulling `pid`** — which is precisely what lets `fleet task say` steer a
"blocked" card (`5d7b458`, `64bb716`). Pi is different in two ways that the design must handle:

1. **Pi has no native hook system.** There is no `Stop`/`PermissionRequest` callback to shell back
   into `fleet hooks`. State must come from the JSONL log instead.
2. **Pi can exit at turn boundaries** (and definitely exits when it errors, e.g. unauthenticated).
   When a PTY process exits, `session-manager.onExit` fires `process.exit`, which **nulls `pid`** →
   the card reads as "ended, not steerable."

Upstream PR #223 solves both with a **wrapper + watcher + exit-resolver**, and adds two new adapter
seams to `session-manager` that **our fork does not yet have** (confirmed: our `onExit` handler at
`session-manager.ts:516` matches the *pre-Pi* upstream shape exactly):

- **`autoRestartOnExit?: boolean`** on `PreparedAgentLaunch`. Pi sets it `false` so a clean Pi exit is
  *not* treated as a crash to auto-restart. `shouldAutoRestart()` must honor it.
- **`resolveExitReviewActivity?`** on `PreparedAgentLaunch`. On a clean exit (`code === 0`) while the
  summary is still `running`, the manager calls it; it reads the latest `to_review` entry from the
  JSONL log (`resolvePiExitReviewActivityFromSessionDir`) and applies a `hook.to_review` transition —
  so a Pi turn that *ended by exiting* still lands the card in review with the final message attached.

The **wrapper** (`fleet hooks pi-wrapper --real-binary pi --session-dir <dir> -- <args>`,
`src/commands/pi-hooks.ts`) launches the real `pi` with `stdio: "inherit"` (preserving the TUI),
**polls the JSONL log** (`startPiSessionWatcher`, 250 ms) and forwards mapped events into
`fleet hooks ingest` in real time, then on child exit resolves the final review activity. This is the
Pi analogue of the other agents' native hooks — a file-tail watcher standing in for a hook system.

**needs-input for Pi.** `needs_input` is metadata-driven (§2). Pi's autonomous run has no
permission-prompt concept, so most Pi turns are plain `to_review`. *If* Pi has an "ask the user"
tool, the mapper can tag that entry with `notificationType: "permission_prompt"` (or an equivalent)
so `isNeedsInputReviewHook` lifts it — but this is **opportunistic, not required for v1**. Flag it as
an open question (§9), don't block on it.

**The steering caveat that must be resolved by the impl card, not assumed:** whether `fleet task say`
works on a live Pi card depends on whether Pi *stays interactive at a prompt* after a turn (pid alive
→ bracketed-paste write reaches it) or *exits* (pid null → must resume). Upstream's
`needsManualPromptResend` + "Resume task" button (re-send the original prompt after a readiness
re-probe) exists precisely because Pi's **first** launch can exit before processing the prompt (e.g.
interactive login). The design's position: **derive-and-review works regardless**; steering-mid-turn
is best-effort and its exact behavior is an impl-time empirical check against a real `pi` binary.

---

## 6. Integration outline (the exact seams to touch)

Mirrors how Kiro (`52d9d6c`) and droid (`0098439`) were added, plus the Pi-specific modules from
PR #223. **Ordered; each is a concrete edit, no code here.**

**A. Catalog & identity**
- `src/core/api-contract.ts` — add `"pi"` to `runtimeAgentIdSchema` enum. (Additive; existing
  `sessions.json` still parses — same additive-enum discipline as `5d7b458`'s `needs_input`.) Add the
  optional `needsManualPromptResend` / `clearNeedsManualPromptResend` fields to the session-input
  request/summary schemas if we adopt the resume-button flow.
- `src/core/agent-catalog.ts` — add the `pi` `RuntimeAgentCatalogEntry` (`binary: "pi"`,
  `installUrl`, `supportsAgentModelOverride: true` since Pi takes `--model`), and add `"pi"` to
  `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`.
- `src/config/runtime-config.ts` — add `"pi"` to `AUTO_SELECT_AGENT_PRIORITY` **and** to the
  `normalizeAgentId` allow-list. (Upstream places Pi 3rd, after claude/codex; our house rule is
  Codex-first for impl work — pick placement deliberately, likely **after** claude/codex, and
  consider *not* auto-selecting Pi for new users à la droid `0098439` until it's proven.)

**B. Launch adapter** (`src/terminal/agent-session-adapters.ts`)
- Add `piAdapter` and register it in the `ADAPTERS` map.
- Resolve/append `--session-dir` (default `getRuntimeHomePath()/sessions/pi/<taskId>`); append
  `--append-system-prompt` (home-agent preamble), `--continue`/`-c` on `resumeFromTrash`, `--model`
  via `applyAgentModel`, and the prompt via `withPrompt`.
- Add the two new `PreparedAgentLaunch` fields **`autoRestartOnExit?`** and
  **`resolveExitReviewActivity?`** (new to our fork) and the `AgentExitReviewActivityResolver` type.
- When hooks are active, return the **wrapper** invocation as the binary/args (`fleet hooks
  pi-wrapper … -- <agentArgs>`) with `autoRestartOnExit: false`; always set `resolveExitReviewActivity`
  to read the session dir on clean exit. Add the small `getCliOptionValue` helper.

**C. Pi parser modules** (new, pure where possible — the two most testable units)
- `src/terminal/pi-session-log.ts` — `mapPiSessionEntry` (JSONL line → `RuntimeHookEvent`s),
  `readPiSessionEntryId`, `findLatestPiSessionLog`, `resolvePiExitReviewActivityFromSessionDir`.
- `src/terminal/pi-readiness.ts` — `probePiReadiness` (RPC pre-flight) + `piReadinessInternals`.

**D. Wrapper command** (`src/commands/pi-hooks.ts`, wired in `src/commands/hooks.ts`)
- `runPiWrapperSubcommand` + `startPiSessionWatcher`; register `hooks pi-wrapper` with
  `--real-binary` / `--session-dir`. Reuse `parseHookRuntimeContextFromEnv` + `ingestHookEvent` with
  the retry-on-"task not found" guard (the watcher can emit before the session row exists).

**E. session-manager wiring** (`src/terminal/session-manager.ts`)
- In `onExit` (currently `:516`): **before** the `process.exit` transition, if
  `active.resolveExitReviewActivity` is set and the summary is still `running`, call it and apply the
  resulting `hook.to_review` (+ `applyHookActivity`) so an exiting-but-successful Pi turn lands in
  review. Thread `autoRestartOnExit === false` into `shouldAutoRestart()`. Carry both fields from
  `PreparedAgentLaunch` onto the active-session record.

**F. Runtime API + readiness/resume** (`src/trpc/runtime-api.ts`) — *optional for v1, recommended*
- On Pi task start, run `probePiReadiness`; on `not_ready`, set a `warningMessage`
  (`applyWarningMessage`) and mark `needsManualPromptResend`. Add the `clearNeedsManualPromptResend`
  path that re-probes and, when ready, re-sends the original prompt. (This is the login-then-resume
  UX; it can be a *second* card if we want a minimal v1 first.)

**G. UI** — *smallest possible, upstreamable*
- Add `pi` to the onboarding carousel / runtime-settings selector list (mirrors droid `0098439`,
  kiro `52d9d6c`). Only add the "Resume task" affordance in `agent-terminal-panel.tsx` if F lands.

### Where our diverged fork differs from upstream's assumptions (do NOT blind-port)
1. **New session-manager seams are genuinely new here.** `autoRestartOnExit` /
   `resolveExitReviewActivity` do not exist in our `onExit` — port them as *additions*, keeping our
   existing `stopWorkspaceTrustTimers` / `onSessionCleanup` / `wasInterrupted` ordering intact.
2. **We already have `needs_input` + steering + `task tail`** (`5d7b458`/`64bb716`/`9a6f8aa`) that
   upstream did not have when #223 was written. The Pi mapper should feed *our* review-reason
   classifier and *our* `latestHookActivity` shape, and Pi's JSONL should slot into *our*
   `readAgentTranscript` (add a Pi normalizer rather than a parallel reader).
3. **Auto-select policy is ours.** Upstream auto-selects Pi 3rd; our operating rules (Codex-first for
   impl, Opus for design) mean Pi should probably be **manually selectable but not auto-selected** at
   first (the droid `0098439` pattern), revisited once proven.
4. **`append-system-prompt` architect preamble.** Our `resolveHomeAgentAppendSystemPrompt` takes an
   `architectContextPreamble`; upstream's Pi adapter calls it without one. Wire ours through.
5. **Commit/PR + `fleet` conventions** are ours; the wrapper shells `fleet hooks`, so verify
   `buildKanbanCommandParts` resolves to the right binary in our layout.

---

## 7. Test strategy (Given/When/Then; stub harness, no real Pi)

Follows `.claude/commands/implement.md` (GWT structure) and the deterministic stub harness
(`92d7eb5`: `KANBAN_TEST_AGENT_BINARY` swaps in a stub for any non-cline agent via
`resolveAgentCommand`; the stub drives lifecycle by POSTing `hooks.ingest`).

### 7a. Unit — Pi log mapper (pure, highest value)
`test/runtime/terminal/pi-session-log.test.ts`, fixture JSONL lines:
- **Given** a `role:"user"` message line, **When** `mapPiSessionEntry` runs, **Then** it yields one
  `to_in_progress` event (`source:"pi"`, "Working on task").
- **Given** an assistant line with `toolCall` entries, **Then** each yields an `activity` event whose
  `activityText` summarizes the tool (command/path/url), and no `to_review`.
- **Given** an assistant line whose text block carries `textSignature.phase = "final_answer"`
  (or a text-only assistant with no tool calls), **Then** exactly one `to_review` with `finalMessage`.
- **Given** a `role:"toolResult"` with `isError:true`, **Then** an `activity` event labeled
  `Failed <tool>`; with a normal result, `Completed <tool>`.
- **Given** a malformed / non-`message` line, **Then** `[]` (no throw).
- **Given** a session dir with several `*.jsonl`, **When** `resolvePiExitReviewActivityFromSessionDir`
  runs, **Then** it returns the metadata of the **last** `to_review` in the newest-mtime log; empty
  dir → `null`.

### 7b. Unit — readiness probe (injected `spawn`)
`test/runtime/terminal/pi-readiness.test.ts`, `deps.spawn` stub emitting canned RPC lines:
- **Given** an RPC `{success:true}` for our probe id, **Then** `status:"ready"`.
- **Given** `error:"No API key found …"`, **Then** `status:"not_ready"`, `reason:"missing_api_key"`,
  and the message is sanitized (doc-suffix stripped).
- **Given** a model-not-found error, **Then** `reason:"model_not_found"`.
- **Given** a probe timeout, **Then** `status:"unknown"` and the child is SIGTERM'd.

### 7c. Unit — adapter (`prepareAgentLaunch` for `pi`)
Extend `test/runtime/terminal/agent-session-adapters.test.ts`:
- **Given** a Pi launch with hooks context, **Then** `binary`/`args` are the `pi-wrapper` invocation,
  `autoRestartOnExit === false`, and `resolveExitReviewActivity` is set.
- **Given** `agentModel` and no user `--model`, **Then** `--model <id>` is appended (and an explicit
  user `--model` is *not* overridden).
- **Given** `resumeFromTrash`, **Then** `--continue` is appended once.
- **Given** no hooks context, **Then** the raw `pi` binary is used (still with the exit-resolver).

### 7d. Unit — wrapper watcher (`startPiSessionWatcher`)
`test/runtime/hooks-pi-watcher.test.ts` (temp dir; append JSONL between polls):
- **Given** a new `*.jsonl` appears then grows, **When** the watcher polls, **Then** `notify` is
  called once per new entry, in order, and **duplicate entry ids are suppressed**.
- **Given** the log is truncated/rotated (size shrinks), **Then** the watcher resets offset without
  double-emitting.
- **Given** stop() after a final partial line, **Then** the remainder is flushed exactly once.

### 7e. Unit — session-manager exit-review seam
Extend `test/runtime/terminal/session-manager*.test.ts` with a fake launch exposing the two new
fields:
- **Given** a running session whose launch has `resolveExitReviewActivity` returning review metadata,
  **When** the process exits with code 0, **Then** the summary transitions to `awaiting_review`
  (reviewReason from the resolver) **before** `process.exit`, and `latestHookActivity.finalMessage`
  is set.
- **Given** `autoRestartOnExit === false`, **When** the process exits, **Then** `shouldAutoRestart`
  is false (no restart scheduled), even with listeners attached.

### 7f. Integration — Pi lifecycle via a Pi-shaped stub (no real Pi)
`test/integration/…` using `startIsolatedKanbanInstance` + the stub harness. Author a **pi-stub**
(sibling of `stub-agent.mjs`) that, instead of POSTing `hooks.ingest` directly, **writes a Pi-shaped
JSONL session log** to its `--session-dir` (user → tool call → tool result → final answer) and exits
0 — exercising the *real* watcher + mapper + exit-resolver end to end:
- **Given** a card started with `agentId:"pi"` and `KANBAN_TEST_AGENT_BINARY` = the pi-stub wrapped by
  `hooks pi-wrapper`, **When** the stub writes its JSONL and exits, **Then** the board observes
  `running → activity(tool) → awaiting_review` with the final message, and **no** auto-restart fires.
- **Given** the same card in `awaiting_review`, **When** `task tail` runs, **Then** it renders the
  stub's conversation from the JSONL transcript (read-only, no re-stream).
- *(If steering lands)* **Given** a Pi card that stays live, **When** `fleet task say` sends text,
  **Then** it is written as a bracketed paste; **Given** an exited Pi card, **Then** `task say`
  reports "not live — resume first."

This gives full lifecycle coverage with **zero** dependency on a real `pi` binary or API key — the
stub is deterministic and the parsers are the real code under test.

---

## 8. Disposition (build plan)

A **small chain of two impl cards** (Codex, per house rules), not one:

- **Card 1 — "Pi CLI agent (derive-and-review)".** Seams A–E + minimal G (selector entry). Ships a
  selectable Pi agent whose lifecycle is derived from the JSONL log: start → activity → review, clean
  exit handled, `task tail` works. Tests 7a–7f. This is the self-contained, upstreamable core.
- **Card 2 — "Pi readiness & resume UX".** Seam F + the "Resume task" affordance in G:
  `probePiReadiness` pre-flight, `warningMessage`, `needsManualPromptResend`, and the
  re-probe-then-resend-original-prompt flow. Tests 7b (already) + runtime-api tests for the resume
  path. Split out because it's the login/first-run polish, not the core lifecycle, and card 1 is
  independently valuable.

Both carry a `## Prior art` block (Kiro `52d9d6c`, droid `0098439`, and — for card 1 — steer/tail/
needs-input SHAs) and point at `component-overview.md`'s "to change X, edit Y" index so the impl
agent primes from these SHAs directly rather than re-sweeping the tree.

---

## 9. Risks, open questions, out of scope

**Open questions (resolve at impl time against a real `pi`):**
1. **Does Pi stay interactive at a prompt between turns, or exit?** Decides whether mid-turn
   `fleet task say` works or steering always requires resume. Empirical — check a real binary.
2. **Package scope & binary name.** `@mariozechner/*` vs `@earendil-works/*`; confirm the installed
   binary is `pi` and the flags (`--session-dir`, `--mode rpc`, `--append-system-prompt`, `-c`,
   `--model`) match the pinned version. The upstream code is the spec; verify against current Pi.
3. **`final_answer` detection stability.** We depend on `textSignature.phase === "final_answer"` (and
   the "assistant text with no tool calls" fallback). If Pi changes its log schema, `to_review`
   detection drifts — cover with fixtures and keep the fallback.
4. **Does Pi expose an "ask the user" tool** we can map to `needs_input`? If yes, opportunistically
   tag it; if no, Pi cards simply never show the blue "needs input" badge (acceptable for v1).

**Risks:**
- **Polling latency.** The 250 ms watcher poll means card state lags Pi by up to a poll interval —
  fine for a board, but note it (unlike native hooks which are edge-triggered).
- **Watcher/manager double-review.** Both the wrapper (on child exit) *and* the manager's
  `resolveExitReviewActivity` can emit `to_review`. The state machine must be idempotent here
  (a second `to_review` while already `awaiting_review` is a no-op) — assert it in tests.
- **`fleet` resolution inside the wrapper.** The wrapper shells back into our CLI; verify
  `buildKanbanCommandParts` resolves correctly under our worktree/`CLINE_HOME` layout.
- **Auto-select regressions.** Adding `pi` to priority could change which agent a fresh board picks;
  prefer the droid pattern (selectable, not auto-selected) initially.

**Out of scope:** the SDK/in-process path (rejected, §4); Pi plan-mode parity (`--start-in-plan-mode`
equivalent) unless trivial; any change to the shared state machine beyond the two additive
`PreparedAgentLaunch` seams; multi-model Pi provider config beyond `--model` passthrough.

---

## 10. Summary

Pi's two surfaces are not "structured (SDK) vs unstructured (CLI)" — Pi's **CLI already writes a
structured JSONL session log**, so the CLI path yields SDK-grade data while staying inside our
"thin-wrapper, derive-from-artifacts, PTY-owned" architecture. **Build against the CLI**, derive state
by tailing `--session-dir`, use RPC only for a readiness probe, and port PR #223's wrapper + the two
new `session-manager` exit-seams into our diverged fork — feeding our existing `needs_input`, steer,
and `task tail` machinery rather than upstream's older assumptions. Two impl cards: core
derive-and-review first, readiness/resume UX second.
