# One ordered stream of session events, with subscribers

**Ref / slug:** This card set no external issue ref, so the doc is named after the card id per
`AGENTS.md`: ref `a4896`, slug `session-events` → `docs/design/a4896-session-events.md`.

**Card:** `a4896` · **Status:** design (no implementation in this card) · **Base:** `epic/session-kinds`
**Author:** design pass, 2026-07-30

> Deliverable of a design card. No `src/` or `test/` change. Chapter of
> [`44010-session-kinds.md`](./44010-session-kinds.md) (the fact × policy × state reducer model) and
> [`03991-session-archive-and-usage.md`](./03991-session-archive-and-usage.md) (the hot/cold
> invariant and the ledger this writes into).

**Root cause in one sentence:** the runtime keeps only the *latest* value of session state and
throws away the transition that produced it, so every question about a session — is it working or
parked, did it wake and park again, did the runtime act on what the harness said — can only be
answered by guessing from a snapshot, and every test that asks one is a poll on a terminal
condition that cannot distinguish "parked" from "dead".

---

## 1. Card premises, checked

Three of the card's claims are load-bearing and one of them is wrong. Per the build-card rule that
premises are claims and not givens, here is the verification.

| Card claim | Verdict |
|---|---|
| "`src/` contains 24 `console.*` calls, all in `src/cli.ts` and `src/update/update.ts`" | **Confirmed.** `grep -rn "console\." src \| wc -l` → 24; `grep -rln` → exactly those two files. There is no runtime logging of any kind. |
| "`AgentFact` / `SessionSignal` already model harness events with a monotonic `seq`" | **Confirmed** (`src/agents/session-signal.ts:3-17`) — with a large caveat, §3.2: the vocabulary is **declared but never consumed in production**. |
| "The session ledger already writes durable per-generation records" | **Confirmed** (`src/core/session-ledger.ts:69-141`), and `openSession` is already called from the launch path (`session-manager.ts:639`). |
| "`SignalSequenceTracker` (`src/agents/signal-sequence.ts`) exists but solves dedup of native signals" | **False — the file does not exist.** `src/agents/` contains only `claude/ codex/ gemini/ driver.ts launch-utils.ts session-signal.ts`. The only seq-drop logic in the tree is `applySignalsBySeq` at **`test/agents/tck/driver-tck.ts:27`**, a *test-only* helper. This changes decision 7 (§7): there is nothing to reuse, so the question is not "reuse or separate" but "where does dedup live when it is finally needed". |
| "the 512-byte hot-field budget is the precedent" | **Partly false.** 512 bytes is a *design decision in `03991` §4.1/§6.2*, not shipped code. The shipped bound is `boundLatestHookActivity` (`src/state/workspace-state.ts:577-595`): 3 fields × 1000 chars. The *discipline* is the precedent; the number is a proposal. This design adopts the number anyway (§6), and says so. |

Nothing here invalidates the card. The `signal-sequence.ts` correction removes an option rather than
the problem, and it is the one place the card's framing would have led an implementing agent to
"extend" a file it would have had to invent first.

---

## 2. Problem statement

### 2.1 Observed symptom

Three symptoms, one missing record.

**A stall is invisible.** The architect's `card-watch` tool infers whether a card is alive from git
mtimes, because that is the only signal the runtime leaves behind. It missed a 43-minute stall. The
runtime knows exactly when the turn started and when it ended; it stores neither.

**Every selfcheck scenario asserts a terminal condition.** The house pattern is a `waitFor` poll on
the final summary (`test/selfcheck/scenario-api.ts:384`, used by `expectColumn` at `:156`,
`expectSessionGone` at `:188`, `expectAgentRunning` at `:196`). A poll on
`state === "awaiting_review"` cannot tell "parked because the turn ended" from "parked because the
process died" — both land on `awaiting_review`, differing only in a `reviewReason` the poll usually
does not read. It collapses park → wake → park into one observation. And it is the shape that let
`890ed`'s first scenario pass *before* its own fix.

**The column/state divergence (`a7306`) is not even reachable by a server-side test.** Verified, and
it is worse than the card states: the `awaiting_review → review` column projection is a **React
`useEffect` in the browser** (`web-ui/src/hooks/use-board-interactions.ts:422-456`). The only
server-side column moves in the whole tree are PR-state driven (`runtime-state-hub.ts:98-119`) and
CLI-driven (`commands/task.ts:922,986`). A third copy of the same projection exists as a *count*
adjustment in `workspace-registry.ts:172-173`:

```ts
if (summary.state === "awaiting_review" && columnId === "in_progress") {
    next.in_progress = Math.max(0, next.in_progress - 1);
}
```

The consequence is measurable in the selfcheck suite itself: the steer scenario is the **only** one
that needs a browser. `run-selfcheck.ts:56-63` runs it through Playwright and marks it
`knownFailureIssue: "#180"`. And `test/selfcheck/scenarios/givenReviewCardWhenSteeredThenMovesToInProgress.ts`
— the tRPC-only version — is **dead code**: it is not imported by `run-selfcheck.ts`, and its
`steerCard` calls a procedure named `runtime.sendTaskInput` that does not exist (the real one is
`runtime.sendTaskSessionInput`, `runtime-api.ts:166`). A dead scenario against a non-existent
procedure is what "assert the terminal condition" degrades into when the mechanism under test lives
in a browser.

### 2.2 Expected behaviour

A test asserts a **sequence**, not a final state. An operator reads liveness, rather than inferring
it from file timestamps. And cause sits next to effect: what the harness said, and what the runtime
decided in response, in one ordered record with one format, readable in-process, out-of-process, and
by a human.

### 2.3 Root cause

**The runtime models session state as a value and not as a history, so every transition is a write
that destroys its own evidence.**

Three consequences, each checkable:

1. **`changed` is computed and discarded — twice.** `reduceSessionTransition` returns
   `{ changed, patch, clearAttentionBuffer }` (`session-state-machine.ts:41-45`).
   `applySessionEvent` (`session-manager.ts:1220-1234`) uses `changed` only to decide whether to
   write, then returns a summary. `44010` §"`canTransitionTaskForHookEvent` is 100% duplicated
   logic" already named this discarded bit as the reason the wake rule acquired a second owner.
   Same bit, second cost: a **declined** transition is indistinguishable from one that never
   arrived. `hooks-api.ingest` returns `{ ok: true }` either way (`hooks-api.ts:73-80`, `:159`).
2. **The only fan-out is a snapshot, not an event.** `onSummary` (`session-manager.ts:265`) delivers
   `RuntimeTaskSessionSummary` — the *current* value. Its single subscriber
   (`runtime-state-hub.ts:536`) then **coalesces by taskId into a debounce map**
   (`queueTaskSessionSummaryBroadcast`), so two transitions inside one debounce window arrive as
   one. Park → wake → park is structurally unobservable downstream, by design, because the design
   is a state mirror.
3. **The vocabulary for the missing record already exists and is unused.** `AgentFact` (five arms,
   `session-signal.ts:3-8`) is exactly "what the harness said". `SessionSignal` adds `seq`, `at`,
   and a display-only `activity`. `SignalPort.mapNativeSignal` is implemented by all three drivers
   — and has **zero production callers** (`grep -rn "mapNativeSignal" src` → the port declaration
   and the three implementations, nothing else). We built the noun and never wrote the verb.

`1c16d96` (#182) is the class of bug this makes visible. It removed the kind branch from
`canTransitionTaskForHookEvent` and made `hook.to_in_progress` wake **any** session at
`awaiting_review` regardless of `reviewReason` — right for an overseer resting between turns,
silently arguable for a card a human parked at `awaiting_review/"exit"`. The commit is small and
correct-looking; what it changed is *which sessions silently move*. Under this design that same
edit changes a card's stream from `state.unchanged{rejected:"hook.to_in_progress"}` to
`state.changed{awaiting_review→running}` — a visible, assertable difference at the one place the
rule lives.

---

## 3. What exists in the codebase

### 3.1 Prior art read

| SHA / doc | What it establishes for this design |
|---|---|
| `44010-session-kinds.md` | `SessionRef` as a parsed discriminated ref; the policy table; and the observation that `applySessionEvent` already computes and throws away `changed`. Note: `src/core/session-kind.ts` and `session-policy.ts` **do not exist yet** — that doc's cards have not landed, so this design must not import them. |
| `03991-session-archive-and-usage.md` | The hot/cold invariant, the ledger layout (`sessions/<taskId>/<generation>/`), and the rule that the archive is an **effect consumer of reducer output**, never wired to a driver (§6.5). This design is the stream that consumer should have been reading. |
| `1c16d96` (#182) | Read via `git show`. A lifecycle rule that was right for one session kind and silently wrong for the other — and the *silence* is the defect, not the rule. |
| `test/agents/tck/driver-tck.ts:27` `applySignalsBySeq` | The only seq-ordering code in the tree, and it is test-only. Where dedup will have to come from. |
| `givenArchivedCardWhenBoardReloadsThenLedgerKeepsItsPointer.ts` | **The precedent that decides §5.2:** a selfcheck scenario already reads ledger files directly off `context.instance.homeDir`, sets `CLINE_HOME`, and asserts on `manifest.json`. The runner and the runtime share a filesystem. |

### 3.2 Concepts and their canonical homes (Article 1)

Consulted `docs/architecture/concepts/`. What exists, and how this design relates:

- **Agent driver** (`concepts/agent-driver.md`, `src/agents/driver.ts`) — owns `AgentFact` /
  `SessionSignal`. Its own doc states the boundary this design must respect: *"Drivers emit facts
  like `turn.ended` and `attention.required`; they never emit board verbs such as review, columns,
  or lifecycle states."* That sentence is why the session-event union **cannot** be an extension of
  `AgentFact` (§4).
- **Task session** (`concepts/task-session.md`, `session-manager.ts`) — *"Do not scatter process
  launch, lifecycle management … outside of `TerminalSessionManager`."* That is the emission point,
  pre-decided by an existing concept (§5.1).
- **Session ledger** (`concepts/session-ledger.md`, `src/core/session-ledger.ts`) — the durable
  per-card, per-generation store, *"kept deliberately off the hot path."* Extended with one file per
  generation; **no fourth persistence location**.
- **Runtime state fanout** (`concepts/runtime-state-fanout.md`) — *"don't add polling or a second
  summary-derivation path."* The event stream is not a second summary path: it carries transitions,
  the hub carries values, and the stream never reaches the browser (card's out-of-scope).
- **New:** `concepts/session-event-stream.md`, added in the same change that introduces the type
  (Article 1, step 4). Nothing in the concept map owns "the ordered history of one session", so this
  is a genuinely new concept — one, added deliberately.

### 3.3 The decision points that exist today

Every "what the runtime decided" the card names, located:

| Decision | Where it happens now | Reachable from the manager? |
|---|---|---|
| session launched, with `resumeSession` | `session-manager.ts:340-666`; `identity.resolve` at `:364`, result destructured at `:375` | yes |
| launch refused | `identity.resolve` → `throw` at `:372`; `launch.preflight`/`prepare` refusals in `prepareAgentLaunch` | yes |
| state → `awaiting_review` / `running` | `applySessionEvent` (`:1220`) — the single reducer chokepoint, called by `transitionToReview` (`:1015`), `transitionToRunning` (`:1099`), `resumeFromHumanInput` (`:1115`), PTY exit, and the prompt-ready detector (`:515`, `:541`) | yes — **one function** |
| steer delivered and submitted | `writeInput` (`:958`), driven by `sendTaskSessionInput` (`runtime-api.ts:166-220`) | yes |
| session ended | PTY exit → `applySessionEvent({type:"process.exit"})` | yes |
| **column → `review`** | **`web-ui/src/hooks/use-board-interactions.ts:438` — the browser** | **no** |

Five of six funnel through `TerminalSessionManager`, and four of those through the single
`applySessionEvent` call. The sixth is the `a7306` problem, and its absence from that column is the
whole of §8.

---

## 4. Decision 1 — the event vocabulary

**One type, one home: `SessionEvent` in `src/core/session-event.ts`.** It is a superset of
`AgentFact` **by embedding, not by extension**.

```ts
// src/core/session-event.ts — the ONE vocabulary for a session's history.
import type { AgentFact } from "../agents/session-signal";
import type {
    RuntimeBoardColumnId, RuntimeTaskHookActivity, RuntimeTaskSessionReviewReason,
    RuntimeTaskSessionState,
} from "./api-contract";
import type { SessionTransitionEvent } from "../terminal/session-state-machine";

/** Envelope. Identical on every arm; the only place `seq` is assigned. */
export interface SessionEventEnvelope {
    /** Monotonic per (taskId, generation), assigned by the log. See §7. */
    readonly seq: number;
    readonly at: number;
    readonly taskId: string;
    readonly generation: number;
    /** `seq` of the event this one is a response to, when there is one. Cause and effect, in order. */
    readonly cause: number | null;
}

export type SessionEventBody =
    /** What the harness said. The `AgentFact` is embedded verbatim — never re-declared. */
    | {
          readonly type: "agent.fact";
          readonly fact: AgentFact;
          /** Display-only, already bounded on the hot path. Never re-bounded here. */
          readonly activity: RuntimeTaskHookActivity | null;
          /** The driver's own dedup key when the fact came from a `SessionSignal`; null otherwise. */
          readonly driverSeq: number | null;
      }
    /** The runtime launched a process. */
    | {
          readonly type: "session.launched";
          readonly agentId: string;
          readonly agentSessionId: string | null;
          readonly resumeSession: boolean;
          readonly state: RuntimeTaskSessionState;
      }
    | { readonly type: "session.launch_refused"; readonly reason: string }
    /** The reducer moved the session. `trigger` is total over `SessionTransitionEvent`. */
    | {
          readonly type: "state.changed";
          readonly from: RuntimeTaskSessionState;
          readonly to: RuntimeTaskSessionState;
          readonly reviewReason: RuntimeTaskSessionReviewReason;
          readonly trigger: SessionTransitionEvent["type"];
      }
    /** The reducer DECLINED to move. The bit `applySessionEvent` throws away today. */
    | {
          readonly type: "state.unchanged";
          readonly state: RuntimeTaskSessionState;
          readonly reviewReason: RuntimeTaskSessionReviewReason;
          readonly rejected: SessionTransitionEvent["type"];
          /** Consecutive identical declines collapse into one record. ≥1. */
          readonly repeated: number;
      }
    /** The board's column followed (or failed to follow) the state. Emitter arrives with `a7306` — §8. */
    | {
          readonly type: "column.changed";
          readonly from: RuntimeBoardColumnId | null;
          readonly to: RuntimeBoardColumnId;
          readonly by: "projection" | "pr-state" | "cli";
      }
    /** Steering reached the PTY. Byte COUNT, never bytes. */
    | { readonly type: "steer.delivered"; readonly bytes: number; readonly submit: boolean };

export type SessionEvent = SessionEventEnvelope & SessionEventBody;
```

Seven arms. Two things about the shape are deliberate.

**Why embed `AgentFact` instead of extending it.** Adding `state.changed` or `column.changed` arms
to `AgentFact` would put board verbs into the driver's vocabulary, which `concepts/agent-driver.md`
forbids in as many words, and would make `AgentFact` — the type three drivers `satisfies` against —
grow with runtime concerns. Flattening the five fact types into five session-event arms
(`agent.turn_ended`, …) was the other option and is rejected: it is a second copy of an existing
five-value union that must then be kept in sync — the near-duplicate Article 1 exists to prevent.
The cost is one extra hop for readers (`event.fact.type` rather than `event.type`), which is a
`switch` inside a `case`, and it is the cheaper of the two costs.

**Why `state.unchanged` is in the union at all.** It is the arm that makes the record non-fakeable.
Everything else describes something that happened; this one describes a rule *firing and declining*,
which today produces exactly zero observable output — `applySessionEvent` returns the unchanged
summary (`:1223`) and `hooks-api` returns `ok: true` (`:79`). It is also the arm that makes the
`1c16d96` class visible: a change to *which sessions decline* is invisible in a state mirror and
loud in an event stream.

**The `cause` field is what the card asked for and the reason both halves live in one union.**
`state.changed{trigger:"hook.to_review"}` carries `cause` = the `seq` of the `agent.fact{turn.ended}`
that produced it. "What the harness said" and "what the runtime decided" are one hop apart in one
ordered list; a reader never joins two streams by timestamp.

### 4.1 Where `agent.fact` events come from today

`mapNativeSignal` has no production caller (§2.3), so **there is no `SessionSignal` to embed yet.**
The runtime's real fact sources are `hooks.ingest` (`RuntimeHookEvent = to_review | to_in_progress |
activity`, `api-contract.ts:1304`) plus its metadata, and the PTY prompt-ready detector.

The mapping is already implicit in `isNeedsInputReviewHook` (`session-state-machine.ts:23-39`),
which classifies a `to_review` hook as "blocked — answer me" vs "done — review me". This design makes
it explicit, once:

```ts
// src/core/session-event.ts
export function factFromHookEvent(
    event: RuntimeHookEvent,
    metadata: Partial<RuntimeTaskHookActivity> | null | undefined,
): AgentFact {
    if (event === "activity") return { type: "progress" };
    if (event === "to_in_progress") return { type: "turn.started" };
    return isNeedsInputReviewHook(metadata)
        ? { type: "attention.required", cause: metadata?.toolName ? "question" : "permission" }
        : { type: "turn.ended", finalMessage: metadata?.finalMessage ?? null };
}
```

This is an *extension* of an existing classifier, not a new one, and it is the same mapping a later
card will move into a `mapNativeSignal` consumer — replacing this function, not duplicating it.
Recorded as an open question (§11) because that consumer does not exist and I cannot specify its
migration from here.

---

## 5. Decisions 2–4 — emission, subscribers, readers

### 5.1 Decision 2 — the emission point is the session manager, not the driver

**`SessionEventLog`, one instance per workspace, owned by that workspace's
`TerminalSessionManager`.**

Why not the driver, stated as the card asks:

- `DRIVERS` is a **module-level singleton** (`src/agents/driver.ts:147-151`), constructed once at
  import and shared by every workspace and every card on the board. Registering per-session
  subscribers on it puts per-session mutable state on a process-global object — the never-evicted
  module-level `Map` that `491de` deleted — and the leak is unbounded in card count, forever.
- It destroys the property that makes drivers testable: today a driver is pure enough to exercise
  with a fixture and no PTY (`test/agents/tck/driver-tck.ts`). A driver holding subscribers holds a
  lifecycle.
- Drivers structurally **cannot** emit five of the seven arms. They do not know `SessionRef` (kind
  is a runtime fact — `44010`), they do not know `generation`, and `concepts/agent-driver.md`
  forbids them board verbs. `state.changed` is not a thing a driver can say.

Why the manager, and why that is *one* point rather than three:

- It already owns per-session mutable state keyed by taskId (`entries`, `:233`), created and
  evicted with the workspace.
- It already has this exact subscription idiom: `onSummary(listener): () => void` (`:265-270`).
- **Four of the seven arms come from one function.** `state.changed` and `state.unchanged` are both
  emitted inside `applySessionEvent` (`:1220-1234`) — the single reducer chokepoint that all five
  transition callers already funnel through. `session.launched` /`launch_refused` come from
  `startTaskSession`; `steer.delivered` from `writeInput`. That is three call sites in one file, not
  three emission points: one object, one owner.
- `agent.fact` is emitted at `hooks-api.ingest`, which already holds the manager
  (`hooks-api.ts:64`), so it emits *through* the manager's log rather than owning one.

`column.changed` is the exception and it is the honest one: the board is not the manager's state.
Its emitter is deferred to `a7306` (§8), which puts the projection server-side and becomes the
single emitter. **Until then the arm exists in the union with no emitter**, which is a stated,
visible gap rather than a silent one.

### 5.2 Decision 3 — the subscriber contract

Matching the house idiom (`TerminalSessionListener`, `terminal-session-service.ts:4-8`): optional
callbacks, disposer return, no `EventEmitter`.

```ts
// src/core/session-event-log.ts
export interface SessionEventListener {
    onEvent?: (event: SessionEvent) => void;
    /** The buffered tail at subscribe time, mirroring `attach`'s initial `onState`. */
    onReplay?: (events: readonly SessionEvent[]) => void;
}

export interface SessionEventLog {
    /** Never fails, so unlike `attach` it returns a non-null disposer. */
    subscribe(listener: SessionEventListener, filter?: { readonly taskId?: string }): () => void;
    /** In-memory tail. Cheap; for tests and a same-process liveness read. */
    recent(taskId: string, limit?: number): readonly SessionEvent[];
    /** The only writer. Returns void — never a promise, never awaited, never throws. */
    emit(taskId: string, generation: number, body: SessionEventBody, cause?: number | null): void;
}
```

**Delivery order.** Global emission order — the `seq` order — and within one event, subscription
order. Not per-taskId order, because the whole value of the stream is that a filtered subscriber and
an unfiltered one agree about what came first.

**Sync or queued: synchronous, inside `emit()`, after `seq` assignment.** Reasons: it matches
`emitSummary` (`:1312-1317`, a plain sync loop) and `attach`'s sync initial `onState` (`:318`); and a
queued dispatch would let a `state.changed` be delivered *after* the summary broadcast it caused, so
a module test could no longer assert that the transition precedes the state the UI sees. The
**persistence** side is deliberately not synchronous (§6).

**A subscriber that throws.** Each callback is invoked in its own `try/catch`; the throw is swallowed,
the remaining subscribers still receive the event, and a `subscriberErrors` counter increments. The
counter is written to the generation's `events.meta.json` next to the drop count (§6), so "what this
log lost" has exactly one place. A subscriber can therefore never break a session, never reorder the
stream, and never hide its own failure.

### 5.3 Decision 4 — three readers, one record

| Reader | Surface | Why this one |
|---|---|---|
| **module tests** (vitest, in-process) | `log.subscribe()` and `log.recent(taskId)` | Direct, synchronous, no polling. The only reader that can assert *sync* ordering and subscriber isolation. |
| **selfcheck** (runtime out-of-process over HTTP) | **reads `events.jsonl` off disk**, via a new `ScenarioDriver.expectEventSequence` | See below. |
| **operator / architect** | the same `events.jsonl` | `agent.fact{turn.started}` / `{turn.ended}` with their `at` answer "working or parked" directly. This is what replaces `card-watch`'s git-mtime inference. |

**Where I disagree with the card.** It proposes "a trpc `sessionEvents(taskId)`" for selfcheck. I
recommend against it, and the reason is a verified precedent:
`givenArchivedCardWhenBoardReloadsThenLedgerKeepsItsPointer.ts` **already** reads ledger files
directly off `context.instance.homeDir`, sets `process.env.CLINE_HOME` to the isolated instance's
state dir, and asserts on `manifest.json` — because `startIsolatedKanbanInstance` boots a child
process on the same host with a home the runner knows.

A tRPC procedure would be a *second read path over the same file*, adding a wire contract that
Article 7 makes the most expensive thing in the tree to change, in exchange for nothing the
filesystem read does not already give. The file read is also strictly stronger: it proves the record
is **durable**, which a tRPC read of an in-memory ring would not.

The `ScenarioDriver` op the card asks for:

```ts
// test/selfcheck/scenario-api.ts — added to ScenarioDriver
/**
 * Waits until the task's `events.jsonl` contains `expected` as an ordered SUBSEQUENCE.
 * Subsequence, not contiguous: a real run interleaves `progress` and `state.unchanged`.
 */
expectEventSequence(
    taskId: string,
    expected: readonly SessionEventMatcher[],
    options?: { readonly generation?: number },
): Promise<readonly SessionEvent[]>;
```

Implemented over the existing `waitFor` (`:384`) — so the *polling* is unchanged, but what is polled
is a **sequence**, which is the whole point. The failure message prints the events that were found,
which is the diagnostic the current terminal-state polls cannot produce.

**Stated limitation.** This assumes the selfcheck runner and the runtime share a filesystem. True
today, verified. If selfcheck ever runs against a remote runtime, a tRPC reader becomes necessary —
and it is purely additive then, reading the same file server-side. Do not pre-build it.

---

## 6. Decision 6 — bounds, as invariants

This fires at every turn boundary of every card, so `03991`'s hot/cold rule governs.

> **A session event is a fixed-width record on a cold path. Emission is synchronous only into
> memory; every byte that reaches a disk does so on a deferred flush that no caller awaits. Nothing
> about this enters `sessions.json`.**

**I1 — never synchronous or awaited on the hook ACK path.** `emit()` returns `void`. It assigns
`seq`, dispatches to subscribers, pushes onto a ring, and schedules a flush
(`setTimeout(0).unref()`, coalescing a burst into one write). No caller can await it because there is
nothing to await. *Asserted*: with the store stubbed to reject every write, `hooks.ingest` still
returns `{ ok: true }` and the in-memory sequence is intact.

**I2 — no PTY bytes, no unbounded payloads.** `steer.delivered` carries `bytes: number` and never the
text. `agent.fact.activity` is the only variable-size field and it is the *already-bounded* hot field
(`RuntimeTaskHookActivity`, bounded by `boundLatestHookActivity`) — reused, not re-bounded, so the
budget has one owner. Budget: **512 bytes serialized per event**, adopting `03991` §4.1's number
(and noting §1: that number is a design decision there, not shipped code — today's cap is 3×1000
chars). Enforced the way `03991` enforces the summary: a schema-generated worst-case record is
asserted `≤ 512`, so the test fails on a *new field* rather than ignoring it.

**I3 — retention and rotation, per generation.** One file per generation, in the ledger directory
that already exists:

```
$CLINE_HOME/kanban/workspaces/<workspaceId>/sessions/<taskId>/<generation>/
    manifest.json          # already there (session-ledger.ts)
    events.jsonl           # this design — one SessionEvent per line
    events.1.jsonl         # one rotation kept
    events.meta.json       # dropped, subscriberErrors, rotations, firstSeq/lastSeq
```

Rotate at **2 MB or 20 000 events**, whichever first; keep **2** files (≤ 4 MB per generation, and
generations are bounded by restart count). The path is derivable from `(workspaceId, taskId,
generation)` — `getTaskSessionsDir` already computes it (`session-ledger.ts:65`) — so no pointer
exists anywhere and pruning `sessions.json` cannot orphan it. This is the same property that makes
the ledger safe, reused.

**I4 — what is dropped under pressure, visibly.** The in-memory ring is **1 000 events per session**.
Overflow drops the **oldest** and increments `dropped`; consecutive identical `state.unchanged`
records (same `rejected`, same `state`) collapse into one with `repeated: n` rather than filling the
ring. Every loss is counted in `events.meta.json` and reported by `recent()`. A dropped count is
acceptable; silent unbounded growth is not, and neither is silent truncation.

**I5 — nothing enters `sessions.json`.** `runtimeTaskSessionSummarySchema` (`api-contract.ts:371`)
gains no field. *Asserted* by a test that compares the schema's key set before and after — the same
schema-reflection idiom `03991` card 2 establishes.

Single writer, so appends are safe without a lock: exactly one runtime process owns a workspace, and
POSIX `O_APPEND` writes below `PIPE_BUF` are atomic. Readers (selfcheck, the operator, the CLI) are
read-only and tolerate a torn final line by ignoring it. `lockedFileSystem` has no append helper
(`src/fs/locked-file-system.ts`) and does not need one here; stated so an implementing agent does not
reach for `writeJsonFileAtomic` per event, which would rewrite the whole file every turn.

---

## 7. Decision 7 — ordering

**A new counter, owned by the log, and deliberately not the driver's `seq`.**

The card's premise that `SignalSequenceTracker` exists is false (§1), so this is not "reuse, wrap, or
separate" — there is nothing to reuse. What the alternatives actually are:

| Option | Verdict |
|---|---|
| Reuse `SessionSignal.seq` as the event order | **Rejected.** It is *"assigned by the driver"* (`session-signal.ts:11`), so it exists for exactly one of seven arms; the other six have no driver seq at all. It is per-harness-session, so a resume restarts it. An ordering key that covers 1/7 of the union and resets mid-card is not a total order. |
| Promote `applySignalsBySeq` (`driver-tck.ts:27`) out of the TCK and use it for ordering | **Rejected as ordering, accepted as dedup.** Its job is dropping stale/duplicate driver signals. Conflating dedup with ordering is the trap the card names, and it would make the event log's order depend on a harness's numbering. |
| A third counter, unrelated to both | **This, and it is not a third counter** — it is the *first* ordering counter. There is no existing one. |

**The decision.** `seq` is a plain integer, monotonic per `(taskId, generation)`, starting at 0,
assigned inside `emit()`. Node's single-threaded event loop makes assignment race-free without a
lock, and the per-generation reset makes it match the file it is written to — `events.jsonl` in
generation 3 starts at 0, so `firstSeq`/`lastSeq` in `events.meta.json` detect a truncated file.

**Dedup keeps its own home, and both facts coexist without a third counter.** The driver's `seq`
survives *inside* the `agent.fact` arm as `driverSeq`, so a future dedup pass has its input and the
event log has its order. When the `mapNativeSignal` consumer lands, `applySignalsBySeq`'s logic
becomes `src/agents/signal-sequence.ts` — the file the card thought existed — as a production dedup
filter *upstream* of `emit()`. Two concerns, two homes, one counter each. Not designed here (the
consumer does not exist), flagged in §11.

---

## 8. Decision 5 — how this subsumes `a7306`, explicitly

**Decision: `a7306` is implemented as one subscriber over this stream, and it is a hard prerequisite
for the `column.changed` event. Neither supersedes the other; the ordering is stream first,
projection second.** Stated plainly so there are not two half-models of one mechanism.

The evidence for "one subscriber over this stream" is that the projection is currently written **three
times**, in three layers:

| Copy | Location | Runs where |
|---|---|---|
| `awaiting_review` → column `review` | `web-ui/src/hooks/use-board-interactions.ts:433-443` | the browser |
| `running` → column `in_progress` | same file, `:444-456` | the browser |
| `awaiting_review` while in `in_progress` → decrement the in-progress count | `server/workspace-registry.ts:172-173` | the server |

That is an Article 3 failure with a browser in the critical path. A reducer plus subscribers **is**
the design `a7306` asks for: the projection becomes one `SessionEventListener` on the server that
maps `state.changed` to a board mutation, the browser's `useEffect` is deleted, and
`workspace-registry`'s count copy reads the board instead of re-deriving.

**The consequence the card understates, and it changes the card breakdown.** The stream cannot emit
`column.changed{to:"review"}` before `a7306` lands, because **there is no server-side authority that
moves that column** — there is nothing to report. So:

- The `column.changed` arm ships in the vocabulary (card 1) with an emitter only for the two moves
  that *are* server-side today (`by: "pr-state"`, `by: "cli"`), and `by: "projection"` has no
  producer.
- The card's headline assertion — *"the stream shows `state.changed → awaiting_review` with no
  following `column.changed → review`"* — **is not writable until `a7306` lands.** Before then it
  would pass vacuously for every card, which is precisely the fakeable shape this design exists to
  remove. Writing it in card 1 would be the same defect in a new costume.
- Until then the honest assertion is the pair's first half: `state.changed{→awaiting_review}` is
  emitted, and a static test asserts that **no server-side `projection` emitter exists** — a
  deliberate, visible TODO in the type rather than a promise in prose.

So `a7306`'s scope becomes: *move the projection server-side as a subscriber of this stream, delete
the browser copy, and fold the count copy* — and this design's card 6 then adds the `projection`
emitter and the divergence assertion. `a7306` gets smaller (it inherits the mechanism) and this
design gets one more card. That is the trade, named.

---

## 9. Proposed solution — the shape end to end

Three files new, three touched.

**New**

- `src/core/session-event.ts` — `SessionEvent`, `SessionEventBody`, `SessionEventEnvelope`,
  `factFromHookEvent`. Vocabulary only; no I/O.
- `src/core/session-event-log.ts` — `SessionEventLog`: `seq` assignment, the 1 000-event ring per
  session, synchronous subscriber dispatch with per-callback isolation, `recent()`, drop and
  subscriber-error accounting, and the deferred flush hand-off.
- `src/core/session-event-store.ts` — `events.jsonl` append, rotation, `events.meta.json`. Reached
  only by the log's flush. Path from `getTaskSessionsDir` (`session-ledger.ts:65`) — the existing
  ledger layout, extended.

**Touched**

- `src/terminal/session-manager.ts` — construct the log; emit `session.launched` /
  `session.launch_refused` in `startTaskSession` (`:340-666`), `state.changed` /`state.unchanged` in
  `applySessionEvent` (`:1220-1234`), `steer.delivered` in `writeInput` (`:958`); expose
  `readonly events: SessionEventLog`.
- `src/trpc/hooks-api.ts` — emit `agent.fact` from `factFromHookEvent(event, body.metadata)` before
  the transition, and pass its `seq` as `cause` to the transition that follows.
- `src/core/session-ledger.ts` / `docs/architecture/concepts/session-event-stream.md` — document
  the new file in the generation directory; the ledger's own module needs no change (paths are
  already derivable).

**Not touched:** `src/agents/**` (drivers stay pure — no port change, per the card's out-of-scope),
`api-contract.ts` (no wire or persisted-summary change), `runtime-state-hub.ts` (the stream does not
reach the browser), `sessions.json` (I5).

`state.changed`'s emission, concretely — the discarded bit, recovered:

```ts
// src/terminal/session-manager.ts — applySessionEvent, today's :1220-1234
private applySessionEvent(entry: SessionEntry, event: SessionTransitionEvent): RuntimeTaskSessionSummary {
    const before = entry.summary;
    const transition = reduceSessionTransition(before, event);
    if (!transition.changed) {
        this.events.emit(before.taskId, generationOf(before), {
            type: "state.unchanged", state: before.state,
            reviewReason: before.reviewReason, rejected: event.type, repeated: 1,
        });
        return before;
    }
    // …existing side effects…
    const next = updateSummary(entry, transition.patch);
    this.events.emit(next.taskId, generationOf(next), {
        type: "state.changed", from: before.state, to: next.state,
        reviewReason: next.reviewReason, trigger: event.type,
    });
    return next;
}
```

One function, both arms, no new branch anywhere else — because `44010` already established that
every transition funnels through here.

---

## 10. Technical rationale

**Why an event log rather than making the summary broadcast richer.** The hub deliberately coalesces
summaries by taskId into a debounce map (`runtime-state-hub.ts`, `queueTaskSessionSummaryBroadcast`)
because the browser wants the latest value, not the history. Making that path carry transitions would
either break the coalescing the UI depends on or lose the transitions to it. Two consumers with
opposite requirements need two records; `concepts/runtime-state-fanout.md`'s "no second
summary-derivation path" is respected because this is not a summary path.

**Why not an `EventEmitter`.** There is none in `src/` today (only `test/selfcheck/runtime-stream.ts`
uses one, for a websocket queue). Adopting one would import untyped `on(name, …)` dispatch into a
codebase whose two subscription surfaces (`TerminalSessionListener`, `onSummary`) are both typed
callbacks with disposers. Matching them costs ~20 lines and keeps `any` out.

**Why the record is a file and not a tRPC procedure.** §5.3. The decisive argument is that the
filesystem read is the *same* read the operator does and proves durability, whereas a wire surface is
the most expensive thing in the tree to change (Article 7) and would be a second path to the same
bytes.

**Why `state.unchanged` earns its place despite the volume risk.** It is the only arm that observes a
rule declining, and the recurring bug on this surface (`ea3ca19`, `9ca30b7`, `08e1f0d`, `158f9a3`,
`1c16d96` — five commits) is *always* a change in which sessions silently decline. The volume risk is
real (`agent.prompt-ready` fires off PTY output heuristics) and is bounded by the `repeated` collapse
(I4) rather than by hoping. If measurement shows it still dominates, the collapse window widens — a
constant, not a redesign.

**Why one log per workspace rather than per session.** Per-session logs would need a registry keyed
by taskId, which is `entries` again, one layer out. The manager already is that registry.

**Rejected: an `effect.dispatched` arm for the four `hooks-api` fire-and-forget side effects**
(turn checkpoint, auto-review PR, review broadcast, overseer ping). Tempting — "did the ping fire?"
is a session question — but it is the line where a session-event stream becomes the general operation
log the card puts out of scope, it adds four emission sites to a file that has been patched five
times, and the existing `givenReviewHookWhenIngestedThenOverseerIsNotified` scenario already proves
the ping over the websocket. Additive later if a card needs it.

**Rejected: streaming events to the browser.** The card's out-of-scope, and correct: the consumers
are tests and the operator. A live feed would put the hot path back on the fan-out.

**Rejected: emitting from the driver.** §5.1. It is the `491de` defect and it breaks PTY-free driver
tests.

**Risks, named.**

- *The stream can lie by omission before `a7306`.* `column.changed{by:"projection"}` has no producer,
  so a naive reader concludes the column never moves. Mitigated by the arm's `by` discriminator making
  the gap explicit and by refusing to write the divergence assertion early (§8) — but it is a real
  sharp edge for six cards' worth of time.
- *Volume on a chatty card.* Bounded by the ring, the `repeated` collapse, and rotation — but the
  numbers (1 000 / 2 MB / 20 000) are chosen from the shape of the data, not measured. First
  measurement is card 4's.
- *Two writers if a second runtime process ever opens a workspace.* Append-without-lock assumes one.
  True today (one runtime per board, CLI is a client). If that changes, `events.meta.json` counters
  will disagree with the file and the fix is the existing `lockedFileSystem`, not a redesign.
- *`factFromHookEvent` is an interim mapping.* When the `mapNativeSignal` consumer lands, one of the
  two must be deleted. Named in §11 so it does not quietly become permanent.

---

## 11. Open questions

Written down rather than resolved with invented confidence.

1. **Does `state.unchanged` actually need coalescing?** I do not know the real rate of declined
   `agent.prompt-ready` events on a live card — that requires measurement the design cannot do. The
   `repeated` collapse is cheap insurance; if the rate is negligible it is dead weight. Measure in
   card 3.
2. **Should `progress` facts (hook `activity`) be recorded at all?** They are the highest-volume arm
   and `turn.started`/`turn.ended` already answer the liveness question. Lean: record them, because
   they are the only heartbeat *inside* a long turn, and drop them first under pressure. Genuinely
   uncertain.
3. **Is per-generation, per-card the right granularity for the operator's liveness read?** Liveness
   is a *board-wide* question ("which cards are parked?"), and per-generation files make that a
   fan-in read over N directories. `03991` §5.1 explicitly refuses a workspace-wide index because it
   re-creates shared cost — the same argument applies here, but the use case pulls the other way.
   Unresolved; do not pre-build a workspace-wide log.
4. **How does `factFromHookEvent` retire?** It should be *replaced* by a `mapNativeSignal` consumer,
   not sit beside it. I cannot specify the migration because that consumer does not exist and the
   hook boundary and the native-signal boundary may not carry the same information.
5. **Does the ledger's `openSession` become an event subscriber?** `03991` §6.5 says the archive
   should be "an effect consumer of reducer output". This stream is that output. Folding
   `openSession`'s launch-path call (`session-manager.ts:639`) into a subscriber of
   `session.launched` would remove a direct call from the hot start path — probably right, definitely
   not this design's card.
6. **Where does the `fleet` CLI reader live?** `fleet` is outside this repo. This design guarantees
   the file's shape and documents the `tail`/`jq` read; the CLI surface is the parent repo's call.

---

## 12. Card breakdown

Six cards, one verifiable outcome each. An oversized card on this epic already cost 879 k tokens, so
sizing is part of the deliverable: no card below owns more than one new file plus one wiring site.

For each card, the **event sequence a test would assert** is given — so the next card's prompt does
not leave the implementing agent choosing what its own check proves.

---

### Card 1 — `feat: model a session's history as one ordered event stream`

**Scope.** `src/core/session-event.ts` (vocabulary, envelope, `factFromHookEvent`),
`src/core/session-event-log.ts` (seq, ring, sync dispatch, `recent`, isolation and drop counters),
`docs/architecture/concepts/session-event-stream.md`. **No emission sites. No persistence.**

**Verifiable outcome.** A module test over `SessionEventLog`'s public API only:

| Given / When | Then |
|---|---|
| three `emit`s for one `(taskId, generation)` | `recent()` returns them with `seq` `0,1,2` and `at` non-decreasing |
| a subscriber, then its disposer, then another `emit` | the disposed subscriber receives nothing |
| two subscribers where the **first throws** | the second still receives the event; `subscriberErrors === 1`; `recent()` is unaffected |
| 1 001 emits into a 1 000 ring | `recent()` has 1 000, `dropped === 1`, and the **oldest** is gone |
| two consecutive identical `state.unchanged` bodies | one record with `repeated: 2` |
| `factFromHookEvent("to_review", {notificationType:"permission_prompt"})` | `{type:"attention.required", cause:"permission"}`; plain `to_review` → `{type:"turn.ended"}`; `to_in_progress` → `{type:"turn.started"}` |

**Files:** 2 new source + 1 new doc. **Shares files with:** nothing. **Depends on:** nothing.

---

### Card 2 — `feat: record what the runtime decided at every session transition`

**Scope.** Wire the log into `src/terminal/session-manager.ts`: `session.launched` /
`session.launch_refused` in `startTaskSession`, `state.changed` /`state.unchanged` in
`applySessionEvent`, `steer.delivered` in `writeInput`. Expose `readonly events: SessionEventLog`.

**Verifiable outcome — the sequence.** Module test, fake driver, in-process `subscribe()`:

```
session.launched   { resumeSession: false, agentSessionId: <id>, state: "running" }
state.changed      { from: "running", to: "awaiting_review", reviewReason: "hook",
                     trigger: "hook.to_review" }
steer.delivered    { bytes: 24, submit: true }
state.changed      { from: "awaiting_review", to: "running", trigger: "human.input_submitted" }
state.changed      { from: "running", to: "awaiting_review", reviewReason: "exit",
                     trigger: "process.exit" }
```

**This is park → wake → park as five ordered records** — the sequence today's terminal-state poll
collapses into one observation. Plus: a refused `identity.resolve` emits
`session.launch_refused{reason}` and **no** `session.launched`.

Note `session.launched` carries the resulting `state` and there is **no** `state.changed` for a
launch: launch writes via `updateSummary` (`:618`) and not through the reducer, so keeping
`state.changed` reducer-only is what makes its `trigger` total over `SessionTransitionEvent["type"]`.

**Files:** `session-manager.ts`. **Shares files with:** card 3 — **serialize, do not parallelize.**
**Depends on:** card 1.

---

### Card 3 — `feat: make a declined session transition visible instead of silent`

**Scope.** Emit `agent.fact` at `hooks-api.ingest` from `factFromHookEvent`, threading its `seq` as
the `cause` of the transition that follows. Emit `state.unchanged` from the decline branch of
`applySessionEvent`.

**Verifiable outcome — two sequences, one of them the `1c16d96` class:**

```
# a permission prompt is not an ended turn
agent.fact    { fact: { type: "attention.required", cause: "permission" } }        seq 0
state.changed { to: "awaiting_review", reviewReason: "needs_input",
                trigger: "hook.to_needs_input", cause: 0 }                        seq 1

# a card parked at awaiting_review/"exit" declines a turn-start hook
agent.fact      { fact: { type: "turn.started" } }                                seq 0
state.unchanged { state: "awaiting_review", reviewReason: "exit",
                  rejected: "hook.to_in_progress", cause: 0 }                     seq 1
# and NO state.changed follows
```

The second is the assertion that would have made `1c16d96` a visible behaviour change rather than a
four-line diff: flipping that rule flips the arm from `state.unchanged` to `state.changed`, and the
test names which.

**Files:** `hooks-api.ts`, `session-manager.ts`. **Depends on:** card 2.

---

### Card 4 — `feat: keep a session's event stream on disk, off the hot path`

**Scope.** `src/core/session-event-store.ts`: `events.jsonl` per generation under
`getTaskSessionsDir`, deferred coalesced flush, rotation at 2 MB / 20 000 events keeping 2 files,
`events.meta.json` (`dropped`, `subscriberErrors`, `rotations`, `firstSeq`, `lastSeq`). Amend
`concepts/session-event-stream.md` with the on-disk format and the operator's read.

**Verifiable outcome.**

| Given / When | Then |
|---|---|
| card 2's five-event sequence | `events.jsonl` contains the five lines, in `seq` order, parseable |
| a store stubbed to **reject every write** | `hooks.ingest` still returns `{ok:true}`; `recent()` still has the full sequence; `emit` never threw |
| the worst-case record generated from the schema | `JSON.stringify(...).length <= 512` |
| `runtimeTaskSessionSummarySchema`'s key set | unchanged — **I5** |
| 20 001 events | `events.1.jsonl` exists, `events.jsonl` holds the tail, `rotations === 1` |

**Files:** 1 new source + `session-event-log.ts` (flush hand-off) + the doc. **Shares files with:**
card 1 — serialize. **Depends on:** card 1. Its end-to-end row needs card 2, so run it **after** card
2 rather than in parallel with it.

---

### Card 5 — `feat: assert a card's real sequence in selfcheck, not its final state`

**Scope.** `ScenarioDriver.expectEventSequence` (subsequence match over `events.jsonl`, built on the
existing `waitFor`), one new scenario, registered in `run-selfcheck.ts`. Delete the dead
`givenReviewCardWhenSteeredThenMovesToInProgress.ts` (§2.1: not imported, and it calls a
non-existent procedure).

**Verifiable outcome.** Scenario
`givenStartedCardWhenTurnEndsAndIsSteeredThenEventStreamShowsParkWakePark`, asserting from disk
against the isolated instance's home:

```
session.launched { resumeSession: false }
agent.fact       { fact.type: "turn.ended" }
state.changed    { to: "awaiting_review", reviewReason: "hook" }
steer.delivered  { submit: true }
state.changed    { to: "running", trigger: "human.input_submitted" }
```

The same run under today's assertions produces one observation (`state === "awaiting_review"`), and
would produce it identically if the agent had died. That contrast is the card's point and belongs in
its prompt.

**Files:** `test/selfcheck/scenario-api.ts`, `test/selfcheck/run-selfcheck.ts`, one new scenario
file. ⚠️ **`scenario-api.ts` and `run-selfcheck.ts` are contention files** — every selfcheck card
edits them. Do **not** dispatch this in parallel with any other card touching selfcheck.
**Depends on:** cards 2, 3, 4.

---

### Card 6 — `feat: a parked card cannot look like it is working` — blocked on `a7306`

**Scope.** Once `a7306` moves the state→column projection server-side as a `SessionEventListener`:
emit `column.changed{by:"projection"}` from it, delete the browser `useEffect`
(`use-board-interactions.ts:422-456`), and fold `workspace-registry.ts:172-173`'s count copy to read
the board.

**Verifiable outcome — the `a7306` divergence, finally assertable:**

```
state.changed  { to: "awaiting_review", reviewReason: "hook" }   seq n
column.changed { from: "in_progress", to: "review",
                 by: "projection", cause: n }                    seq n+1
```

and the negative, which is the actual regression test: with the projection subscriber unregistered,
the sequence stops at `seq n` and `expectEventSequence` fails naming the missing `column.changed`.
That pair is the assertion §8 says cannot honestly be written before this card.

**Files:** the new projection subscriber, `workspace-registry.ts`, `use-board-interactions.ts`, one
scenario. **Depends on:** cards 2, 5, **and `a7306`**.

---

### Order and parallelism

```
1 ──▶ 2 ──▶ 3 ──▶ 5 ──▶ 6 (also gated on a7306)
 └──▶ 4 ─────────▶┘
```

- **Card 1 first, alone.** Everything consumes its vocabulary.
- **Cards 2 and 4 can start together after 1**, but 4's end-to-end assertion needs 2, so if only one
  agent is free, run 2 first.
- **Cards 2 and 3 share `session-manager.ts`** — serialize.
- **Cards 1 and 4 share `session-event-log.ts`** — serialize.
- **Card 5 owns the selfcheck files exclusively** — never parallel with another selfcheck card.
- **Card 6 is blocked on `a7306`** and is the only card that touches `web-ui`.

---

## 13. Disposition

**Split into build cards** — six, in the order above.

Per the memory note that implementation cards go to gemini, cards 1–5 are implementation cards. Card
6 is gated on `a7306` and should be re-scoped when that card's plan lands, since `a7306` shrinks to
"move the projection server-side as a subscriber" under this design (§8) and the two prompts should
be written together.

**Carry into card 5's prompt, as facts that exist today independent of this design:**
`test/selfcheck/scenarios/givenReviewCardWhenSteeredThenMovesToInProgress.ts` is dead code — not
imported by `run-selfcheck.ts` — and it calls `runtime.sendTaskInput`, a procedure that does not
exist (`runtime.sendTaskSessionInput` is the real one). The steer scenario that *does* run goes
through Playwright and is marked `knownFailureIssue: "#180"`.

**Carry into card 1's prompt:** the card premise that `src/agents/signal-sequence.ts` exists is
false. Do not extend it; do not create it in card 1 either (§7 — it belongs with the
`mapNativeSignal` consumer, which does not exist yet).
