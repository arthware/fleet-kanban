# One owner for "how do we drive a CLI agent" — the `AgentDriver` port

**Ref / slug:** this card set no external issue ref, so the doc is named after the card id per
`AGENTS.md`: ref `161b5`, slug `cli-driver` → `docs/design/161b5-cli-driver.md` (the path the card's
Definition of Done names).

**Card:** 161b5 · **Status:** design (no implementation in this card) · **Base:** `epic/session-kinds`
· **Sibling:** [`44010-session-kinds.md`](44010-session-kinds.md) · **Acceptance case:**
[`95a9d-pi-agent-harness.md`](95a9d-pi-agent-harness.md)

**Root cause in one sentence:** there is no boundary between *the agent harness* and *the board*, so
each harness's native vocabulary (`Stop`, `AfterAgent`, a `›` in the PTY) is translated **directly
into board-lifecycle verbs** at whichever site happens to need it — which means the same question is
answered ~20 times by ~20 authors, per-harness behaviour is only tested where an interface happens to
exist, and there is no seam a second transport could ever plug into.

---

## Problem statement

### Observed symptoms

Three, which look unrelated and are the same defect:

1. **Gemini card sessions have to be pinged by hand** to keep going (operator report). Gemini is the
   only harness whose entire lifecycle is squeezed through one hook command classified at runtime,
   and the only one with **no second, independent signal path** when that one misses.
2. **Gemini conversations render empty.** `readAgentTranscript({ agentId: "gemini", … })` returns
   `{ present: true, messages: 0 }` against a real Gemini transcript — verified below. The card
   flagged this as an open question; it is a live bug.
3. **The wake rule has taken four patches** (`ea3ca19` #130, `9ca30b7` #143, `08e1f0d` #164,
   `158f9a3` #172) and still has three implementations that disagree. That is the sibling design's
   subject; it is here because *two* of its three copies disagree along the **harness** axis, not the
   session-kind axis.

### Expected behaviour

Adding or fixing a harness is **one file with a compiler-enforced contract**. A harness's native
event names never reach board-lifecycle logic. Whether a harness runs as a subprocess or as an
in-process SDK is invisible above one interface.

### Root cause — three layers

**Layer 1 — a missing boundary, not a missing branch.** `RuntimeHookEvent` is
`"to_review" | "to_in_progress" | "activity"` (`core/api-contract.ts`, consumed at
`commands/hooks.ts:29`). Those are **board verbs**. So the translation from *"the agent did X"* to
*"the card should move"* happens at the outermost edge of the system — inside the CLI subprocess that
the harness shells out to — and every layer inward inherits a decision it cannot revisit. The clearest
instance is `mapGeminiHookEvent` (`commands/hooks.ts:522-533`):

```ts
if (eventName === "AfterAgent") { return "to_review"; }
if (eventName === "BeforeAgent") { return "to_in_progress"; }
```

`AfterAgent` means *"a turn ended"*. `to_review` means *"a human should look at this card"*. Those
are different propositions and there is nowhere in the type system to keep them apart. The recovery
hack is `isNeedsInputReviewHook(metadata)` (`terminal/session-state-machine.ts:23-39`), called at
`trpc/hooks-api.ts:95`, which sniffs `notificationType`/`toolName` strings to reconstruct — after the
fact — a distinction that was thrown away one process earlier. Its own doc-comment admits it:
*"the claude adapter already emits the raw distinction … Both currently collapse to
`reviewReason: "hook"`."*

**Layer 2 — one meaning, three mechanisms, no contract.** "The turn ended" is produced three different
ways:

| Harness | Mechanism | Where |
|---|---|---|
| claude, cursor, opencode, droid, kiro, cline | config-time hooks bound to a specific `RuntimeHookEvent` | `buildHookCommand("to_review", …)`, `agent-session-adapters.ts:840` |
| gemini | **one** hook command on every hook point, classified at runtime | `buildHooksCommand(["gemini-hook"])`, `agent-session-adapters.ts:1111-1138` → `hooks.ts:522` |
| codex | **terminal output scraping** | `codexPromptDetector`, `agent-session-adapters.ts:979-991` |

Three mechanisms, one meaning, no shared test. They drifted, and nothing failed.

**Layer 3 — behaviour split from the interface that should own it.** An adapter interface exists and
works, but owns exactly one lifecycle moment. Everything else was re-derived at the point of use. The
consequence is measurable in the test suite (§"Coverage follows the contract"): the one owned surface
has 56 tests across all eight harnesses; the un-owned surfaces have approximately none.

---

## What exists in the codebase

Verified by reading `epic/session-kinds` at `6fe289c`. Every `path:line` below was opened.

### Prior art read

| SHA | What it establishes |
|---|---|
| `158f9a3` (#172) | The fourth patch on the wake rule. Threads `taskId` into `canTransitionTaskForHookEvent` and branches on `isHomeAgentSessionId`, renaming `canReturnToRunningFromHumanInput` → `canWakeFromAnyReviewReason` in the *other* module. Two files, one rule. |
| `08e1f0d` (#164) | The regression. It edited **two functions with the same exported name in two modules to different values** in one commit — `session-state-machine.ts:47` `canReturnToRunning` → `needs_input`, `cline-session-state.ts:172` `canReturnToRunning` → `attention \| needs_input` — and the suite stayed green. That is the shape this design exists to make impossible. |

### The abstraction that already exists, and is amputated

`terminal/agent-session-adapters.ts:87`:

```ts
interface AgentSessionAdapter {
	prepare(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch>;
	submitEnterDelayMs?: number;
}
```

with an exhaustive `const ADAPTERS: Record<RuntimeAgentId, AgentSessionAdapter>` at `:1696`. **This
is the right pattern and the design keeps it.** Its problem is surface area: it owns *build the launch
argv/env* and nothing else. `PreparedAgentLaunch` (`:65-73`) already leaks the shape of what's
missing — `detectOutputTransition` and `shouldInspectOutputForTransition` are the codex driver trying
to own state detection through a data field, and failing (see §"The manager's codex branches are
adapter spill").

### Where the rest of a harness's lifecycle actually lives

The card's table, verified and extended:

| Concern | Location today | Shape |
|---|---|---|
| Launch argv / env / hook wiring | `ADAPTERS[id].prepare()` | **owned** (registry) |
| Binary, base args, `supportsAgentModelOverride` | `core/agent-catalog.ts:18-94` | second home: data, no behaviour |
| Launch-supported subset | `core/agent-catalog.ts:98-107` | a commented-out list |
| Auto-select allow-list | `config/runtime-config.ts:81-88` | an eight-way `||` chain |
| "Is it installed" | `terminal/agent-registry.ts:96` | `id === "cline" ? true : hasDetectedBinary` |
| Session-id minting | `session-manager.ts:359` (claude), `:656` (codex), `:662` (gemini), `agent-session-launch.ts:43` | four sites, three files |
| Transcript **location** | `agent-transcript-locator.ts:39-50` | `switch` (claude/codex/gemini/default-absent) |
| Transcript **parsing** | `agent-transcript-reader.ts:52` | **ternary**, codex vs *everything else → claude* |
| Usage derivation | `agent-usage-reader.ts:43-47` | `Record<string, deriver>` with an absent default |
| State detection from PTY output | `agent-session-adapters.ts:979-998` + `session-manager.ts:525-541` | data field + manager branches |
| Prompt-ready / deferred input | `session-manager.ts:239-257, 512-523` | codex-only, inside the manager |
| Terminal quirks | `session-manager.ts:621` | `suppressDeviceAttributeQueries: agentId === "droid"` |
| Steer/Enter quirks | `session-manager.ts:955-964`, `getAgentSubmitEnterDelayMs():743` | codex-only + optional adapter field |
| Workspace trust | `claude-workspace-trust.ts:74`, `codex-workspace-trust.ts:81` | two files, one idea |
| System-prompt delivery | `prompts/append-system-prompt.ts` | `switch` over eight ids for **prompt content** (`:60-79`) |
| Hook payload shapes | `commands/hook-events/{codex,droid,kiro}-hook-events.ts` | three files |
| Per-harness config paths | `opencode-paths.ts`, `codex-hook-config.ts`, `codex-session-capture.ts`, `gemini-session-capture.ts` | a flat directory of quirks |
| Execution path fork | `trpc/runtime-api.ts:612` `useClinePath` | a second runtime, chosen by string equality |

Three homes for one concept — a static catalog, a two-method adapter, and ~20 inline branches — plus a
second execution path bolted alongside.

`docs/architecture/component-overview.md:145` says adding a new agent CLI touches five files. The real
count above is thirteen-plus. **Even the map that exists to tell you where code goes understates this
surface**, which is a good measure of how invisible the sprawl is.

### The manager's codex branches are adapter spill, not manager logic

`session-manager.ts:525-541` is the clearest single illustration of the missing boundary:

```ts
const adapterEvent = entry.active.detectOutputTransition?.(data, entry.summary) ?? null;
if (adapterEvent) {
	const requiresEnterForCodex =
		adapterEvent.type === "agent.prompt-ready" &&
		entry.summary.agentId === "codex" &&
		!entry.active.awaitingCodexPromptAfterEnter;
	if (!requiresEnterForCodex) { … }
}
```

The adapter *did* hand back a detector — and then the manager had to add three codex branches around
it, because the adapter had no way to express *"…and this fact is only real after the user pressed
Enter"*. The bookkeeping flag `awaitingCodexPromptAfterEnter` is set 400 lines away in `writeInput`
(`:955-964`). A detector that owns its own state would keep all of this private. **The branch leaked
because the interface was a data field instead of a stateful collaborator.**

### The two-path fork

`src/cline-sdk/` — **17 modules, 7,098 lines of source and 4,262 lines of tests** — is a second,
in-process execution path selected by `effectiveAgentId === "cline"` at `trpc/runtime-api.ts:612`.
It is reachable from 7 other `src/` modules and 23 `web-ui/src/` files. It also carries the second
copy of the wake rule (`cline-session-state.ts:172`) and five sites in `cline-event-adapter.ts` that
patch `state`/`reviewReason` directly without going through the reducer at all.

`docs/architecture/concepts/task-session.md` currently records the two-path split as **intended**:

> **Do not duplicate:** don't push Cline toward "just another CLI"; keep the two paths distinct.

That doctrine is exactly what this design reverses, and the concept map must be corrected in the same
change (concept-map curation rule).

### Coverage follows the contract

This is the strongest single piece of evidence that the interface — not the harnesses — is the
problem.

| Surface | Has an interface? | Tests |
|---|---|---|
| `prepare()` / launch | **yes** (`ADAPTERS`) | `agent-session-adapters.test.ts`, 56 tests, all 8 harnesses (claude 49 mentions, codex 31, gemini 16, opencode 9, cline 11, cursor 8, droid 4, kiro 4) |
| Transcript parsing | no (ternary) | 3 tests: `claude`, `codex`, `unknown agent`. **No gemini test**, although gemini is a *known* agent to the locator |
| PTY state detection | no (data field + manager branches) | **zero** — `codexPromptDetector` is never exercised |
| Session-id minting per harness | no (4 sites) | `agent-session-launch.test.ts` covers the pure resolver only |
| Terminal quirks / trust / steer | no | per-file unit tests, no cross-harness contract |

Where a contract exists, every harness is tested. Where it doesn't, the tests describe a two-agent
world that stopped being true three harnesses ago.

### Verdict: the Gemini transcript parser — **bug, confirmed**

The card left this open. It is a live bug, verified twice.

Gemini's on-disk record shape (`~/.gemini/tmp/<slug>/chats/session-*.jsonl`):

```json
{"id":"…","timestamp":"2026-07-27T10:57:25.594Z","type":"user","content":[{"text":"…"}]}
{"id":"…","timestamp":"…","type":"gemini","content":"I will activate the …","thoughts":[…],"toolCalls":[…],"tokens":{…}}
```

Claude's, which `parseClaudeTranscript` (`agent-transcript-reader.ts:83-161`) is written against, is
`{"type":"user"|"assistant","message":{"content":…}}`. So for a Gemini file:

- `type === "gemini"` fails the `type !== "user" && type !== "assistant"` guard at `:91` → **every
  assistant turn is dropped**;
- `type === "user"` passes the guard, but `record.message` is `undefined`, so `content` is `undefined`
  and both the string branch and `asArray(content)` yield nothing → **every user turn is dropped**.

Result: `present: true, messages: []` — a *located* transcript that renders as an empty conversation,
which is worse than "absent" because the caller has no way to tell. Confirmed by running the real
function against a real transcript:

```
$ ./node_modules/.bin/tsx /tmp/probe-transcript.mts
gemini transcript: { present: true, messages: 0 } usage: { present: false, usage: null }
```

(Session `bd5343ee`, 201 lines, 40 `user` + 79 `gemini` records.)

Two things make this diagnostic rather than merely a bug:

- The **same dispatch idea, done twice, with opposite quality.** `agent-usage-reader.ts:43` uses
  `Record<string, deriver>` and correctly reports absent for gemini. `agent-transcript-reader.ts:52`
  uses a ternary whose *default branch is claude*. One is safe by construction, one silently
  mis-parses. Nothing forces them to agree because they are two ad-hoc implementations of an
  unnamed concept.
- The locator **knows** gemini (`agent-transcript-locator.ts:44`) while the reader does not. The
  location half and the parse half of one concern live in two files with two different notions of
  which harnesses exist. Under a driver, `locate` and `parse` are two members of one object and the
  question cannot be asked.

Gemini token usage is also absent entirely (no deriver) — a card run on gemini reports no usage at all.

### The Gemini stall — what I can and cannot confirm

**I disagree with the card's traced mechanism, and this matters.** The card's chain says
`AfterAgent → to_review → reviewReason "hook" → BeforeAgent (to_in_progress) rejected by
`canTransitionTaskForHookEvent` (`hooks-api.ts:45-50`)`. Every step of that chain is real code and I
verified each one. But the chain does **not** distinguish gemini, and here is why:

Gemini's `AfterAgent` is the *end-of-user-turn* hook, not an internal tool-loop boundary. From the
installed CLI (`@google/gemini-cli`, `bundle/chunk-ZPOKXMLO.js`):

```js
async fireAfterAgentEvent(prompt, promptResponse, stopHookActive = false) { … }
async fireBeforeAgentEvent(prompt) { … }
```

`prompt` / `prompt_response` / `stop_hook_active` — this is the same semantics as Claude's `Stop`
(and `stop_hook_active` is Claude's field name). So `AfterAgent → to_review` and
`BeforeAgent → to_in_progress` is **structurally the same mapping claude already uses** (`Stop` →
`to_review` at `adapters.ts:840`, `UserPromptSubmit` → `to_in_progress` at `:891`), and claude does
not stall. The card's chain is therefore a correct description of a *shared* rule, not the gemini
differentiator. Building a fix on it would fix nothing.

What **is** gemini-specific, verified in code:

1. **No redundancy.** Claude binds 8 hook points to 4 distinct meanings, including
   `PermissionRequest` and `Notification(permission_prompt)` → `to_review` with
   `notificationType: "permission_prompt"` (`adapters.ts:845-888`), which `isNeedsInputReviewHook`
   lifts to `reviewReason: "needs_input"` — and `needs_input` **is** wake-able for a card
   (`hooks-api.ts:50`). Codex has a second, independent recovery path in `codexPromptDetector`.
   **Gemini has neither.** Its `Notification` maps to `"activity"` (`hooks.ts:529-531`), and
   `activity` returns `false` from `canTransitionTaskForHookEvent` (`:39-41`) — so a gemini
   attention-prompt can never become `needs_input`, and therefore can never be woken by a hook. One
   lost or mis-classified signal is unrecoverable.
2. **Two processes per signal.** `runGeminiHookSubcommand` (`hooks.ts:558-593`) writes `{}` to stdout
   and then calls `spawnBackgroundKanban` (`:407-419`), which spawns a *second* `kanban hooks notify`
   process (`detached: false`, `stdio: "ignore"`, `unref()`), and then the gemini-hook process exits.
   Gemini sees a successful hook; the actual tRPC ingest happens in an orphan whose scheduling,
   ~200-500 ms node boot, and 3 s ingest timeout (`hooks.ts:392-401`) are all outside anyone's
   control. **Gemini is the only harness whose signal can be lost after the harness has already
   declared the hook a success**, and it is the only one whose two hook processes can invert order.
   Non-deterministic loss is exactly the shape of *"stalls roughly every other turn"*.

Live board state is consistent with, but does not prove, this. Across 92 recorded gemini sessions in
`.fleet/cline/kanban/workspaces/*/sessions.json`: 62 ended `awaiting_review`/`exit` and 28
`awaiting_review`/`hook`, all with `latestHookActivity.hookEventName = "AfterAgent"`; only 2 ever
recorded a `BeforeAgent` as their last hook, and both are `interrupted`. No gemini session is alive,
so I could not catch one mid-stall.

**Marked as an assumption, not a fact:** that (1)+(2) are *the* cause of the operator's ping-by-hand
symptom. What would settle it: run one gemini card to a stall and capture (a) `sessions.json` state at
that moment, (b) whether the `gemini` process is alive at a prompt, and (c) whether a
`kanban hooks notify` process ever ran for the missing turn. That is a one-session experiment and it
should be the first task of the characterization card (§Disposition, card 0) — **not** something the
build cards assume.

**Independent evidence that the class is real and cross-harness.** Two claude cards
(`fleet-kanban` tasks `1adc9`, `4367b`) are recorded at `awaiting_review` with
`reviewReason: "error"` and `latestHookActivity.hookEventName: "PostToolUse"` — a `to_in_progress`
signal that arrived *after* the process had already exited and was silently absorbed by
`applyHookActivity` (`hooks-api.ts:84-86`). Late/out-of-order signal delivery is not a gemini quirk;
it is the ambient condition, and nothing in the current design has an opinion about it.

---

## Proposed solution

### Name the pattern

**Ports and adapters (hexagonal), with the harness boundary expressed as a *capability port* whose
members are total, and an *anti-corruption layer* on the inbound edge.**

Concretely, three commitments, each doing a specific job:

1. **Port, not plug-in list.** `AgentDriver` is a port the *runtime* defines and each harness
   satisfies. The runtime never asks "which harness is this"; it asks the driver to do a thing. This
   is Constitution Article 6 (capability over identity) applied to the harness axis rather than the
   Cline axis.
2. **Total members, explicit refusal.** Every driver implements every member. A driver that cannot do
   something returns an explicit `unsupported(reason)` value rather than omitting the member. Optional
   members reproduce today's "remember to ask" failure; a required member that must answer
   "no, because …" is a decision that is recorded, typed, and testable.
3. **Anti-corruption on the inbound edge.** A driver emits **normalized facts about the agent**, never
   board verbs. This is the load-bearing choice of the whole design and is argued in §Technical
   rationale.

### The port

New concept home `src/agents/` (one directory, one file per harness). The port:

```ts
// src/agents/driver.ts

export interface AgentDriver {
	readonly id: RuntimeAgentId;
	/** Static facts about the CLI, co-located with the behaviour they describe. */
	readonly catalog: AgentCatalogEntry;
	readonly launch: LaunchPort;
	readonly identity: IdentityPort;
	readonly observe: ObservationPort;
	readonly signals: SignalPort;
	readonly control: ControlPort;
}

export const DRIVERS: Record<RuntimeAgentId, AgentDriver> = { … }; // exhaustive, as ADAPTERS is today
```

Capabilities are total and refusable:

```ts
export type Capability<T> =
	| { readonly supported: true; readonly value: T }
	| { readonly supported: false; readonly reason: string };
```

`supportsAgentModelOverride?: boolean` (`agent-catalog.ts:15`) becomes
`applyModel(args, model): Capability<string[]>` returning
`unsupported("gemini CLI has no --model flag")`. The information is the same; the difference is that
today's optional boolean defaults to `false` in silence for a harness nobody thought about, and the
new form does not compile until someone decides.

**The five sub-ports, and why the seam falls there.** Each is a *reason a harness differs*, not a
grouping of methods we happen to have:

| Sub-port | Owns | Replaces |
|---|---|---|
| `launch` | argv, env, config files, hook installation, prompt/system-prompt **delivery mechanism** | `ADAPTERS[id].prepare()`, `codex-hook-config.ts`, `opencode-paths.ts`, `*-workspace-trust.ts` |
| `identity` | mint / derive / discover / resume a session id | `session-manager.ts:359,656,662`, `agent-session-launch.ts:43`, `*-session-capture.ts` |
| `observe` | locate the harness's own artifact; parse it to messages and to usage; report artifact presence | `agent-transcript-locator.ts`, `agent-transcript-reader.ts`, `agent-usage-reader.ts` |
| `signals` | produce the normalized `AgentFact` stream from hooks, artifacts, or output | `hooks.ts:522` mapping, `codexPromptDetector`, `hook-events/*.ts`, `session-manager.ts:525-541` |
| `control` | steer, submit, interrupt, restart-eligibility, terminal quirks | `session-manager.ts:239-257,621,955-964`, `getAgentSubmitEnterDelayMs` |

### What stays outside the driver — the important half

A driver **MUST NOT** know about, and cannot express:

- **Board lifecycle.** `to_review`, `awaiting_review`, `reviewReason`, columns. A driver has no
  vocabulary for "review". This is what makes `mapGeminiHookEvent`'s defect unrepresentable.
- **Session kind.** Card vs overseer is the sibling design's concern. The driver *receives* a
  `SessionRef`; it never classifies one.
- **Policy of any kind** — wake rules, checkpointing, PR backstop, notifications, auto-restart.
- **Prompt content.** The driver owns *delivery* (`--append-system-prompt` vs `-c
  developer_instructions=…` vs prepending to the prompt body — all three exist today at
  `adapters.ts:912`, `:1036`, `:753-762`). It never owns *what the prompt says*. The one place this is
  currently violated is `append-system-prompt.ts:60-79`, an eight-way `switch` producing per-harness
  *English* about Linear MCP setup — that is per-harness **data** (one `mcpSetupHint` string on
  `catalog`), consumed by a prompt composer that stays the single owner of the sentence.
- **Worktrees, git, `GH_REPO`, checkpoints, persistence, the tRPC contract, `RuntimeTaskSessionSummary`'s
  shape.**

The rule that decides all of these: **the driver answers questions about the harness; it never
answers questions about the product.** If a proposed member's answer would change when the *board's*
rules change rather than when the *CLI* changes, it is on the wrong side.

### The inbound edge: facts, not verbs

```ts
// src/agents/session-signal.ts

export type AgentFact =
	| { readonly type: "turn.started" }
	| { readonly type: "turn.ended"; readonly finalMessage: string | null }
	| { readonly type: "attention.required"; readonly cause: "permission" | "question" | "error" }
	| { readonly type: "progress" }
	| { readonly type: "session.ended"; readonly outcome: "completed" | "failed" | "interrupted" };

export interface SessionSignal {
	/** Monotonic per session, assigned by the driver. Lets the reducer drop stale/duplicate signals. */
	readonly seq: number;
	readonly at: number;
	readonly fact: AgentFact;
	/** Display-only. Never influences lifecycle. */
	readonly activity: RuntimeTaskHookActivity | null;
}
```

Each harness binds its native signal to this vocabulary **inside its own driver**:

| Harness | native | fact |
|---|---|---|
| claude | `Stop` | `turn.ended` |
| claude | `PermissionRequest`, `Notification(permission_prompt)` | `attention.required{permission}` |
| claude | `UserPromptSubmit`, `PostToolUse` | `turn.started` / `progress` |
| gemini | `AfterAgent` | `turn.ended` |
| gemini | `BeforeAgent` | `turn.started` |
| gemini | `Notification` / ask-user tool | `attention.required` ← **new; today it is `activity` and unreachable** |
| codex | rollout `agent-turn-complete` | `turn.ended` |
| codex | `›` prompt in PTY output | `turn.ended` (fallback path) |
| pi | JSONL log entry | per `95a9d` §5 |

`turn.ended` and `attention.required` being **different facts** is what deletes
`isNeedsInputReviewHook`. There is nothing to sniff, because the distinction was never lost.

### The reducer: three axes, three owners

```ts
// src/core/session-reducer.ts — the ONLY owner of board lifecycle
export function reduceSessionSignal(
	summary: RuntimeTaskSessionSummary,
	signal: SessionSignal,
	policy: SessionPolicy,   // from the sibling design, keyed by SessionKind
): SessionTransitionResult;
```

- **fact** — the driver's job (what the harness did)
- **policy** — the session kind's job (what this kind of session does about it)
- **current state** — the summary

Today every one of those three is decided in a different place per call site, and two of the three are
re-derived by hand. Afterwards each has exactly one owner, and adding a harness or a kind cannot
change the other axis.

This is why the two designs compose rather than collide, and it makes the epic's ordering question
concrete — see §"Interlock with the session-kind design".

### `session-manager.ts:359` — the worked example

```ts
// today: two un-owned axes multiplied in one condition
const isHomeAgentTask = request.workspaceId !== undefined && isHomeAgentSessionId(request.taskId);
const homeAgentSessionId =
	request.agentId === "claude" && request.workspaceId && isHomeAgentTask
		? deriveHomeAgentClaudeSessionId(request.workspaceId, request.agentId, generation)
		: null;
```

Afterwards:

```ts
const plan = driver.identity.resolve({
	ref,                       // SessionRef — narrowing to "overseer" also narrows workspaceId to string
	stored: entry.summary.agentSessionId,
	lifecycle,
	generation: entry.summary.homeAgentSessionGeneration ?? 0,
});
```

- The claude driver returns a deterministic, resumable id when `ref.kind === "overseer"`, and a
  freshly minted per-launch id otherwise.
- The codex and gemini drivers return `{ agentSessionId: null, discoverAfterSpawn: true }`, which is
  also where `captureCodexSessionIdInBackground` / `captureGeminiSessionIdInBackground`
  (`session-manager.ts:656-664`) move to.
- `request.workspaceId &&` disappears: it was a hand-written proof that an overseer has a workspace,
  and `SessionRef`'s overseer variant carries `workspaceId: string` as a type-level fact.

The manager keeps the orchestration (spawn, wire, emit) and loses the harness knowledge. That is the
whole shape of the migration in one line of code.

### Transport-agnosticism, expressed member by member

The four concerns most likely to leak a subprocess, and the contract that keeps them honest:

| Concern | Today | Port member | Why it survives an SDK driver |
|---|---|---|---|
| **Liveness** | `entry.active` (a PTY handle) → `hasLiveProcess` boolean → `classifyAgentSessionLifecycle` (`agent-session-launch.ts:68`); `pid` persisted into `sessions.json` (GitHub **#94**) | `driver.liveness(): "attached" \| "resumable" \| "gone"` | The PTY driver answers from its pid; an SDK driver answers from its handle. **Liveness is derived or observed, never persisted and trusted** — the invariant becomes a member signature instead of a convention. `pid` stays in the summary as *diagnostics*, and stops being an input to any decision. |
| **Observation** | `locateAgentTranscript` returns a **path**; `classifyAgentSessionLifecycle` consumes `transcriptPresent` | `observe.artifactPresent(): Promise<boolean>`, `observe.messages()`, `observe.usage()` | A path is a filesystem leak sitting inside a liveness computation. Returning `boolean` + parsed messages lets an SDK driver answer from persisted session records with no file anywhere. Pi already needs this (`95a9d` §6C). |
| **Control** | bytes to a PTY (`writeInput`), `toBracketedPaste`, `submitEnterDelayMs`, `deferredStartupInput` | `control.steer(text, { submit })`, `control.interrupt()` | Bracketed paste and the 50/300 ms Enter delay are *PTY-driver private implementation*, not interface. An SDK driver's `steer` is a method call. |
| **Failure** | `onExit(exitCode, wasInterrupted)` → `process.exit` transition | `session.ended` fact with `outcome` | Exit codes and signals are one transport's encoding of failure. `outcome` is the fact. |

**Sanity check on the interface:** if a member's signature mentions a pid, a file path, bytes, an exit
code, or a signal, it is wrong. Every one of those appears in the current code above and none appears
in the proposed port.

### Keeping the abstraction honest after Cline is retired — the fake driver

Retiring Cline removes the only non-subprocess implementation, so nothing structural stops the port
from silently ossifying around PTY assumptions. The card's proposed mitigation is the right one and
this design **adopts** it:

`test/agents/fake-driver.ts` — a fully in-process `AgentDriver` implementing every member, backed by a
scripted list of facts and an in-memory message log. It is:

- a **real second transport**, so a PTY assumption in the port fails to compile or fails a test rather
  than being discovered years later;
- the harness that lets every layer above the port be tested **without spawning a CLI**, which is
  most of the reason today's manager is untestable;
- ~200 lines, and it is the reference implementation new driver authors read.

It is not optional decoration; it is the load-bearing mitigation for the one risk this design cannot
otherwise manage.

### Testability: one conformance suite, every driver

```ts
// test/agents/driver-contract.ts
export function describeDriverContract(driver: AgentDriver, fixtures: DriverFixtures): void;

// test/agents/drivers.contract.test.ts
const FIXTURES: Record<RuntimeAgentId, DriverFixtures> = { … }; // exhaustive — adding an id breaks the build
```

Each driver supplies **recorded** fixtures — a real captured transcript, real hook payloads, real PTY
output bytes. The suite asserts, once, for every driver:

1. **Vocabulary** — every fixture signal maps to a declared `AgentFact`; no fixture produces an
   unmapped native event silently.
2. **Turn/attention separation** — the fixture set must include at least one `turn.ended` and one
   `attention.required`, or the driver must `unsupported("…")` the latter with a reason. *Gemini
   would have to declare, in writing, that it cannot report attention* — which is exactly the fact
   that is invisible today.
3. **Idempotence** — replaying the same `seq` twice produces one transition.
4. **Ordering tolerance** — a `seq` older than the last applied one is dropped, not applied.
5. **Observation round-trip** — parsing the recorded transcript yields a non-empty, correctly-roled
   message list. **This single assertion would have caught the gemini bug**, because the fixture is a
   real gemini file and the expectation is "not empty".
6. **Identity round-trip** — `resolve` for each `SessionKind` × lifecycle produces a launchable plan.

Per-driver quirks stay in per-driver tests. The contract suite is what stops three implementations of
one meaning from drifting apart unnoticed, which is what happened.

### Stability failure modes — prevented vs merely surfaced

Honest scorecard, in the sibling design's format.

| Failure mode | Mechanism today | Under this design | Impossible, or managed? |
|---|---|---|---|
| A harness's turn boundary is read as "needs a human" | `AfterAgent → to_review` (`hooks.ts:523`) | `to_review` is not in the driver's vocabulary; `turn.ended ≠ attention.required` | **Impossible** — unrepresentable |
| The wake rule written a second time | 3 copies, `08e1f0d` edited 2 of them differently | one reducer, one policy table (sibling card B) | **Impossible** — the second place is deleted |
| Signal arrives twice | nothing dedupes | `seq` + idempotent reducer | **Impossible** |
| Signal arrives out of order | two racing processes for gemini | `seq`; stale signals dropped; the gemini double-hop deleted | **Impossible for the reducer**; the *emission* race is removed for gemini specifically |
| Signal never arrives | one path per harness for gemini; none for a harness without hooks | the port **requires** an answer for artifact-derived signals; a driver with no second path must declare `unsupported` with a reason | **Managed, not impossible.** A harness that produces neither hooks nor artifacts can still go dark. What changes is that this is a *declared, compile-time-visible* property of that driver rather than a surprise |
| Hook subprocess fails / is killed | gemini spawns two processes and reports success after the first | the driver's watcher runs **in the runtime**, not in a spawned CLI; the hook client's only job is one ingest call | **Impossible for gemini's specific shape**; a hook that the harness never fires is the row above |
| Harness exits silently mid-turn | `process.exit` nulls `pid`; the turn's result is lost | `session.ended{outcome}` + the artifact re-read (`95a9d`'s `resolveExitReviewActivity`, generalized to a port member) | **Managed** — the outcome is recovered from the artifact when one exists |

Two rows are deliberately *not* claimed as impossible. Per Article 2, making a stall loud is diagnosis,
not a fix — so those two rows are the honest boundary of what an interface can buy, and the design
should not be sold as if they were solved.

**Acceptance property.** *"No human ping is ever required for a healthy session"* is the property to
judge against. This design removes the mechanisms by which a *delivered* signal is mis-read, dropped,
duplicated, or re-ordered, and removes gemini's uniquely fragile delivery. It does not, and cannot,
guarantee a harness fires a signal at all — which is why the design mandates that every driver either
provide an artifact-derived second path or declare in the type system that it has none.

### Pi is the falsification test

Under this design, `95a9d`'s integration outline collapses:

| `95a9d` step | Today | Under the port |
|---|---|---|
| A · catalog & identity | 3 files (`api-contract`, `agent-catalog`, `runtime-config`) | `api-contract` enum + `catalog` field on the driver |
| B · launch adapter | new adapter + **two new `PreparedAgentLaunch` fields** | `launch` member |
| C · parser modules | 2 new `src/terminal/pi-*.ts` files | `observe` + `signals` members, driver-private |
| D · wrapper command | new `src/commands/pi-hooks.ts` + wiring in `hooks.ts` | driver-private watcher; no CLI subcommand |
| E · session-manager wiring | **edit `onExit`, thread `autoRestartOnExit`** | none — `session.ended{outcome}` already covers it |
| F · readiness/resume | `runtime-api.ts` edits | `launch.preflight(): Capability<…>` |
| G · UI | selector list | driven from `DRIVERS` |

**The test:** adding pi must be *one new file in `src/agents/` plus one enum entry*. If a build card
for pi has to touch `session-manager.ts`, `agent-transcript-reader.ts` or `hooks.ts`, the carve was
wrong and card 7 in the disposition is where we find out — cheaply, and before the port ossifies.

Note that `95a9d` step E is the tell: pi needs two *new* fields on `PreparedAgentLaunch` and two new
branches in `onExit`, for behaviour (`the harness exits at a turn boundary`) that is not exotic at
all. That is the eighth harness demanding the ninth and tenth manager branches. It is the clearest
available evidence that the current shape does not scale, written down before this card existed.

---

## Technical rationale

### Why normalized facts at the driver, not harness-native events plus a shared reducer

This is the load-bearing decision and the card correctly identifies it as such.

**Rejected: driver emits native events, a shared reducer interprets.** It sounds cheaper — one
reducer, thin drivers — and it is what exists today in degraded form (`hooks-api.ts` receives
`RuntimeHookEvent` + a metadata blob and re-derives meaning at `:95`). It fails for three reasons:

1. The reducer would need a per-harness table to interpret native names, which is the same
   `Record<RuntimeAgentId, …>` we were trying to avoid — only now it lives *away* from the driver
   that produced the event, so the two can drift. That is precisely the
   locator-knows-gemini/reader-doesn't split, reproduced at the lifecycle layer.
2. It cannot be transport-agnostic. "Native event" for a PTY driver is a hook payload; for an SDK
   driver it is an SDK event object; for codex it is a regex match on bytes. There is no type that
   spans them except `unknown`.
3. It makes the conformance suite impossible. You cannot write one test that every driver passes if
   each driver's output is in a different vocabulary.

**Chosen: the driver normalizes.** The driver is the *only* place that knows both the harness's
vocabulary and the runtime's, so it is the only correct place for the translation. Downstream sees one
alphabet. This is the anti-corruption layer of ports-and-adapters, applied where it belongs.

Cost, stated: each driver carries a little more logic, and a harness whose native events don't map
cleanly must make a judgement call inside its driver rather than deferring it. That is the right place
for the judgement call to be made and reviewed.

### Why the driver produces facts but does not own state

The card was explicitly unsure whether *state* belongs to the driver or to the state machine. It
belongs to neither alone, and the reason is a counting argument: board state is a function of
**(fact, kind policy, current state)**. The driver knows one of the three. Giving it state ownership
would force every driver to know about session kinds — reintroducing the exact `agentId === "claude"
&& isHomeAgentTask` multiplication this design exists to delete, one level down.

The corollary matters for the migration: `codexPromptDetector` *does* belong to the driver, because
detecting "the harness printed its prompt" is a fact about the harness. What does not belong to it is
`session-manager.ts:527-535`'s decision about what that fact means for the card.

### Why total members with explicit `unsupported`, not optional members

`supportsAgentModelOverride?: boolean` (`agent-catalog.ts:15`) and `submitEnterDelayMs?: number`
(`adapters.ts:89`) are the current pattern, and both silently default. Optional members re-create the
"remember to ask" failure that the sibling design diagnoses for session kinds: the compiler is happy,
the harness is wrong, nothing fails. A required member returning `unsupported("gemini CLI has no
--model flag")` costs one line per driver and converts an omission into a documented decision that the
conformance suite can assert against.

### Why merge the catalog into the driver

Today a harness is *an entry in `agent-catalog.ts`* plus *an adapter in `agent-session-adapters.ts`*
plus *a line in `runtime-config.ts`* plus *a special case in `agent-registry.ts:96`*. The catalog grew
separately from the behaviour it describes, and `agent-registry.ts:96`
(`id === "cline" ? true : hasDetectedBinary`) is what that looks like when the data can't express a
behavioural fact. One module per harness, exporting one `AgentDriver` whose `catalog` field carries
the static facts, means the four places become one and the "is it installed" question becomes a driver
member the Cline-shaped special case can't survive.

### Why the seven `<agent>-*.ts` files become driver-private

`claude-permission-strategy.ts`, `claude-workspace-trust.ts`, `codex-workspace-trust.ts`,
`codex-hook-config.ts`, `codex-session-capture.ts`, `gemini-session-capture.ts`, `opencode-paths.ts` —
a flat directory of quirks with no owner, importable from anywhere. Moving them under
`src/agents/<id>/` makes the blast radius of a harness quirk exactly one harness. `claude-workspace-trust.ts:74`
(`agentId === "claude" && isTaskWorktreePath(cwd)`) stops needing to ask which agent it is, because
only the claude driver can reach it.

### Rewrite vs refactor — recommendation: **strangler-fig, and Cline's retirement is step one**

| Option | Cost | Risk | Verdict |
|---|---|---|---|
| **1. Incremental refactor in place** — widen `AgentSessionAdapter` site by site | Lowest per step | Each widening is another optional field, another manager branch. This is what produced `PreparedAgentLaunch`'s two detector fields and `95a9d`'s request for two more. No point at which a contract exists to test against | **Rejected.** It is indistinguishable from what we already do, and the four wake-rule patches are the evidence of where it leads |
| **2. Strangler-fig** — build the port + conformance suite + fake driver behind the existing surface, migrate one concern at a time across all harnesses, delete the old path as each lands | Highest total, spread over ~7 shippable cards; every card green | The seam between old and new during migration; `session-manager.ts` is 1,305 lines and hot | **Recommended** |
| **3. Big-bang rewrite** of `src/terminal/` + the state machine | Shortest total if it works | Behaviour is **not pinned** (see below). A rewrite reproduces unpinned behaviour badly, and there is no way to ship it incrementally — the board is dogfooding itself on this runtime, so a bad landing costs the team its tooling | **Rejected** |

**Why not big-bang, specifically.** The card asks not to assume incrementalism is right, and the
counterweight (upstream tracking) is gone. The argument against a rewrite here is not conservatism, it
is that **we do not know what the code does**. §"Coverage follows the contract" is the measurement:
the only per-harness surface with real tests is the one with an interface. `codexPromptDetector` has
zero tests. The transcript reader's tests describe a two-agent world. The existing suite was green
through `08e1f0d`, through every wake-rule regression, and through the gemini transcript bug — so it
is **weak evidence about reality**, and a big-bang rewrite validated by it would be validated by
nothing.

**What must be pinned before any of this, and why it is a card, not a paragraph:**

1. codex prompt-ready detection (`codexPromptDetector` + the manager's Enter bookkeeping) — currently
   zero coverage, and the only PTY-derived state signal in the system.
2. codex deferred-startup-input × workspace-trust auto-confirm sequencing
   (`session-manager.ts:239-257, 486-523`) — a timing-sensitive interaction across two subsystems.
3. codex and gemini session-id discovery timing (`:656-664`, 20 attempts × 500 ms).
4. per-harness transcript parse fidelity — **pin the *desired* behaviour for gemini, not the current
   one**, since the current one is the bug.
5. claude deterministic overseer session id + resume (`:357-365`).
6. droid device-attribute suppression (`:621`) and the gemini 300 ms submit delay — small, but they
   are exactly the kind of undocumented quirk a rewrite silently drops.
7. **The gemini stall itself**, per §"what I can and cannot confirm" — one live session, captured.

**Why Cline's retirement is step one rather than a side quest.** It is the largest available
simplification (17 modules, 7,098 source lines, 4,262 test lines), it deletes one of the three copies
of the wake rule and the five out-of-band `state`/`reviewReason` patches in `cline-event-adapter.ts`,
it removes the `useClinePath` fork at `runtime-api.ts:612`, and it makes the sibling design's "fold in
the Cline copy" step evaporate. Doing it *before* the port is built also means the port is designed
against seven harnesses of one transport rather than being retro-fitted around an implementation we
are about to delete.

**Cost of the retirement, honestly.** Not free:

- 7 `src/` modules import `src/cline-sdk/` (`trpc/runtime-api.ts`, `trpc/workspace-api.ts`,
  `workspace/task-worktree.ts`, `cli.ts`, `terminal/agent-usage-reader.ts`,
  `server/runtime-state-hub.ts`, `server/runtime-server.ts`) — all shallow.
- **23 `web-ui/src/` files**, including a whole chat panel (`cline-agent-chat-panel.tsx`), the
  provider/model picker, the runtime-settings dialog, and the onboarding carousel. This is the real
  cost and it is UI, not runtime.
- The operator loses: native in-app chat (no PTY), Cline provider/OAuth settings, Cline MCP settings,
  and SDK-reported usage.
- **Recommendation:** scope the retirement card to the **runtime** (delete `src/cline-sdk/`, the
  adapter, the catalog entry, the `useClinePath` fork) and reduce the web-ui surfaces to dead-code
  removal in the same card. Do not leave `web-ui` half-wired: a chat panel with no backend is worse
  than either state.

**The route back stays open.** Nothing above assumes a subprocess (§"Transport-agnosticism"), and the
fake driver keeps it honest by construction. An SDK-backed driver — Cline's return, or anything else —
is a new file in `src/agents/` and an enum entry.

### Upstream tracking is stale doctrine — and it does not carry the argument

Verified: `origin/production-line` is **239 commits ahead of `upstream/main` and 2 behind**; the
last-fetched upstream tip is `87cfd64`, dated **2026-07-12**. `AGENTS.md:36` in the parent repo still
says *"Keep changes small and **upstreamable** (we rebase on `upstream`)"*. That is no longer true and
**MUST NOT** constrain this design. **Flag to the operator:** the line needs correcting at its source
in `/Users/arthur/code/repos/tools/AGENTS.md`, not just noted here.

But note what this does and does not do. It removes the main *counterweight* to a rewrite; it is not
an argument *for* one. The recommendation above rests entirely on engineering grounds — behaviour is
unpinned, blast radius on a self-hosting runtime is high, and a strangler gets the contract in place
without either. If upstream tracking were still live, the recommendation would be the same, just with
one more reason.

### Interlock with the session-kind design — one refinement to the epic's ordering

`44010` is approved and this design **builds on it, with one adjustment I am flagging rather than
taking**.

Where they interlock: `reduceSessionSignal(summary, signal, policy)` is `44010`'s reducer with the
driver's fact substituted for today's `SessionTransitionEvent`. `44010`'s `SessionRef` is exactly the
input `driver.identity.resolve` needs, and its `Record<SessionKind, SessionPolicy>` is exactly the
policy argument. Neither design has to know the other's internals.

**The adjustment:** the operator decided the driver lands first. That is right for the *signal* work
and for the Cline retirement. But `44010`'s **card A** (`session-kind.ts` + `session-policy.ts`, zero
behaviour change, low risk) is a **prerequisite for driver card 3**, because `identity.resolve` takes a
`SessionRef` and there is no honest way to write that member without the type. This is not a
reordering of the epic — it is a one-card, zero-behaviour prerequisite that can land in parallel with
the characterization card. I am flagging it rather than deciding it; the call is the architect's.

I found nothing in `44010` I believe is wrong. One thing it says that this design *changes*: its
card B "folds in the Cline copy" of the wake rule. Under this plan the Cline copy is **deleted**
instead, which makes B strictly smaller.

### What we lose

- **Indirection.** "What does codex do at startup" becomes one file to read instead of four greps —
  better. "Why did *this one session* behave oddly" gains a hop: you read a driver, then a reducer,
  then a policy, instead of a single inline branch. That is a real cost on the debugging path and I
  do not think it is avoidable.
- **A bigger contract for a trivial harness.** Adding an experimental CLI means answering every port
  member, several with `unsupported(…)`. `Record<RuntimeAgentId, AgentDriver>` means it cannot be
  half-added. That is the intended trade — it is the same property that makes `ADAPTERS` reliable
  today — but it is friction, and someone will feel it.
- **Churn on the hottest file in the runtime.** `session-manager.ts` is 1,305 lines and every card
  from 3 onward touches it.
- **The fake driver is code we maintain** that ships no user value directly. Its value is entirely in
  what it prevents.

**Is there a cheaper design that gets 80%?** Yes, and it should be said plainly: **cards 0, 1, 4 and 5
alone** — characterize, retire Cline, make transcript/usage dispatch a table, and normalize the signal
vocabulary — would remove the gemini transcript bug, the gemini double-hop, the `to_review`-at-the-edge
defect and one of the three wake-rule copies, at maybe 40% of the total cost. What it would *not* buy
is the property the card actually asks for: **adding a harness is one file**. Launch, identity and
control would still be scattered, and pi would still need to touch `session-manager.ts`. If the
operator wants the stability win and not the extensibility win, that subset is the honest smaller
scope — and it is a legitimate choice, not a degraded one.

### Rejected alternatives

- **Rejected: extend `AgentSessionAdapter` in place with more optional fields.** This is option 1
  above and it is what `95a9d` §6B already proposes for pi (`autoRestartOnExit?`,
  `resolveExitReviewActivity?`). Two more optional fields, two more manager branches, no contract, no
  shared test. It is the third workaround on the same surface, which per Article 2 is a stop sign.
- **Rejected: keep the catalog and the driver separate.** "Data and behaviour are different concerns"
  sounds principled, but the data *is* about the behaviour, and the split is what produced
  `agent-registry.ts:96`'s Cline special case and `runtime-config.ts:81-88`'s eight-way `||`. One
  home.
- **Rejected: make the runtime robust by adding retries/timeouts around hook delivery.** This is
  instrumenting the symptom. The gemini signal is fragile *because* it goes through two processes; a
  retry around the second one leaves the first one's success-report lying. Delete the hop.
- **Rejected: a per-harness "quirks" config object instead of a port.** A data-only description cannot
  express `codexPromptDetector`'s stateful Enter bookkeeping, pi's exit-resolver, or gemini's runtime
  classification. We know this because `PreparedAgentLaunch` already tried it and the state leaked
  into the manager within one commit.
- **Rejected: `RuntimeHookEvent` as the normalized vocabulary (i.e. keep three verbs, add a fourth).**
  Adding `to_needs_input` to the wire enum is tempting and cheap. It does not fix the layer-1 defect:
  the CLI subprocess would still be deciding board lifecycle, one process and one machine boundary
  away from any policy. Facts, not verbs — the wire enum can stay as the transport encoding, but it
  must be an implementation detail of the hook-based drivers, not the runtime's vocabulary.

### Risk

Card 5 (signals) is a behaviour change on the hook path, landing on top of a wake-rule quickfix that
is days old, in an epic whose sibling is changing the same reducer. The mitigation is ordering:
`44010` card B (single reducer owner) lands *before* driver card 5, so the signal work changes the
reducer's *input alphabet* rather than its *ownership* at the same time. If those two land together,
we will not be able to tell which one broke the board.

---

## Open questions

1. **Does the gemini stall reproduce as described?** §"what I can and cannot confirm" gives two
   candidate mechanisms (no redundancy; two-process delivery) and rejects the card's traced chain as
   non-differentiating. This must be settled by one captured live session before card 5 is scoped.
   **Recommendation:** first task of card 0.
2. **Is `progress` (`activity`) worth keeping as a fact at all?** It never moves the board; it only
   feeds `latestHookActivity` for display. It could be a separate, lower-priority channel rather than
   a `SessionSignal` variant, which would make the fact vocabulary purely lifecycle. Leaning towards
   keeping it as a variant for one delivery path, but it is a real choice.
3. **Where does auto-restart policy sit?** `shouldAutoRestart` (`session-manager.ts`) is board policy,
   but pi needs `autoRestartOnExit: false` (`95a9d` §6B) which is a harness fact. Proposed split: the
   driver reports `session.ended{outcome: "completed"}` vs `"failed"`, and the *policy* decides — so
   pi needs no flag. Needs checking against pi's real exit behaviour.
4. **How much of `web-ui` does the Cline retirement take?** 23 files touch it. Card 1 should scope
   this explicitly; a half-removed chat panel is worse than either end state.
5. **Does `RuntimeHookEvent` stay on the wire?** It is the persistence/wire boundary
   (Constitution Article 7), so changes must be additive. Proposal: it survives as the hook CLI's
   transport encoding, `to_needs_input` is added additively, and the runtime's vocabulary is
   `AgentFact`. Confirm no persisted state carries `RuntimeHookEvent` values.
6. **GitHub #180 (column moves in a browser `useEffect`)** is out of scope and this design does not
   fix it. It does remove the excuse: once the server distinguishes `turn.ended` from
   `attention.required`, it has the information a server-side column move needs, which it does not
   have today. Worth noting when #180 is scoped; not a dependency.

---

## Disposition

**Split into build cards** — eight, ordered, each independently shippable and green.

| # | Card | Scope | Agent | Depends on | Risk |
|---|---|---|---|---|---|
| **0** | Characterize | Golden fixtures + tests for the seven unpinned behaviours in §"What must be pinned". No behaviour change. Includes the **one live gemini session capture** that settles open question 1. | codex | — | Low; high information |
| **1** | Retire Cline | Delete `src/cline-sdk/` (17 modules), the `cline` adapter + catalog entry, the `useClinePath` fork (`runtime-api.ts:612`), the second wake-rule copy, and the dead `web-ui` surfaces. | codex | — | **Medium-high** — wide, but mechanical and mostly deletion |
| **2** | Define the port | `src/agents/driver.ts`, `session-signal.ts`, `Capability<T>`, `describeDriverContract`, **the fake driver**. No production wiring. | codex | — | Low — green by construction |
| **3** | Bind launch + identity | Fold `ADAPTERS` + `agent-catalog` + the four id-minting sites into `DRIVERS`. `session-manager.ts:359` becomes `identity.resolve`. | codex | 2, `44010` card A | Medium |
| **4** | Bind observation | `locate` + `parse` + `usage` become `observe`. **Fixes the gemini transcript bug and gemini usage.** | codex | 2 | Low, high value |
| **5** | Bind signals | Drivers emit `AgentFact`; `hooks-api.ts` stops mapping to board verbs; delete `isNeedsInputReviewHook`; delete gemini's `spawnBackgroundKanban` double-hop; move `codexPromptDetector` + the manager's three codex branches into the codex driver. | codex | 2, 4, **`44010` card B** | **Highest** — the load-bearing seam |
| **6** | Bind control + environment | steer/submit/interrupt/restart-eligibility/terminal quirks; the seven `<agent>-*.ts` files become driver-private. | codex | 3, 5 | Medium |
| **7** | Add pi | One driver file + one enum entry. **If any other file must change, the carve was wrong** — report that rather than working around it. | codex | 6 | Low; it is the test |

**Parallelism.** 0, 1 and 2 are independent and can run together. 3 and 4 can run together once 2
lands. 5 is the serialization point.

**Cheaper subset**, if the operator wants the stability win without the extensibility win: **0, 1, 4,
5**. Stated with its cost in §"What we lose".

**Carry into the card prompts:**

- Card 0: the gemini live-session capture is a *deliverable*, not a nice-to-have. Everything in card 5
  is scoped from it.
- Card 4: pin the *desired* gemini parse behaviour; the current behaviour is the bug (evidence in
  §Verdict).
- Cards 3–6: update `docs/architecture/concepts/agent-catalog.md`, delete
  `concepts/cline-sdk-boundary.md`, rewrite `concepts/task-session.md` (its "keep the two paths
  distinct" rule is reversed by this design), add `concepts/agent-driver.md`, and correct
  `component-overview.md:145`'s five-file claim — same-PR curation, per the concept-map rule.
- **To the operator, outside this epic:** `/Users/arthur/code/repos/tools/AGENTS.md:36`'s
  "keep changes small and upstreamable" is stale (239 ahead / 2 behind, upstream tip 2026-07-12) and
  should be corrected at source.
