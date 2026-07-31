# One ordered stream of session events, with subscribers

**Ref / slug:** This card set no external issue ref, so the doc is named after the card id per
`AGENTS.md`: ref `a4896`, slug `session-events` → `docs/design/a4896-session-events.md`.

**Card:** `a4896` · **Status:** design (no implementation in this card) · **Base:** `epic/session-kinds`
**Author:** design pass, 2026-07-30 · **Revised** after rebase onto `a101114` (#199); all
`file:line` citations re-verified against that tree.

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

Premises are claims, not givens. This design was first written against `99049ed` (#200); it has been
rebased onto `a101114` (#199), which changed three of the answers below. Every row is re-verified
against the current tree.

| Card claim | Verdict |
|---|---|
| "`src/` contains 24 `console.*` calls, all in `src/cli.ts` and `src/update/update.ts`" | **Confirmed.** `grep -rn "console\." src \| wc -l` → 24, in exactly those two files. There is no runtime logging of any kind. |
| "`AgentFact` / `SessionSignal` already model harness events with a monotonic `seq`" | **Confirmed** (`src/agents/session-signal.ts:3-17`), and **as of #199 they are finally consumed** — see §3.3. |
| "The session ledger already writes durable per-generation records" | **Confirmed** (`src/core/session-ledger.ts:69`), called from the launch path at `session-manager.ts:642`. |
| "`SignalSequenceTracker` (`src/agents/signal-sequence.ts`) exists but solves dedup of native signals" | **Confirmed as of #199** — the file exists (50 lines) with a per-session monotonic counter, an `observedAt`-inclusive dedup fingerprint, a 10-entry sliding window, and `evictSession`. The first draft of this doc reported it missing; that was true at #200 and is now stale. **The §7 decision does not change** — see §7 for why, and for a prediction this doc made that #199 then fulfilled. |
| "the 512-byte hot-field budget is the precedent" | **Still partly false.** 512 bytes is a design decision in `03991` §4.1/§6.2, not shipped code. The shipped bound is `boundLatestHookActivity` (`src/state/workspace-state.ts:577-595`): 3 fields × 1000 chars (`:583`). The *discipline* is the precedent; the number is a proposal. This design adopts it anyway (§6) and says so. |

**And one correction to this document's own first draft, which matters more than any of the above.**
The first draft claimed `test/selfcheck/scenarios/givenReviewCardWhenSteeredThenMovesToInProgress.ts`
was dead code. **That was wrong.** It is imported by `web-ui/tests/selfcheck.spec.ts:9` and is the
body of the Playwright scenario. The first draft grepped only `run-selfcheck.ts`'s import list and
concluded "zero importers" from a search that could not have found the real one. The
recommendation built on it — "card 5 should delete it" — would have deleted a live test. Corrected
in §2.1, §12 card 5, and §13. The *interesting* half of that finding survives, and is sharper than
the wrong half was (§13).

---

## 2. Problem statement

### 2.1 Observed symptom

Three symptoms, one missing record.

**A stall is invisible.** The architect's `card-watch` tool infers whether a card is alive from git
mtimes, because that is the only signal the runtime leaves behind. It missed a 43-minute stall. The
runtime knows exactly when the turn started and when it ended; it stores neither.

**Every selfcheck scenario asserts a terminal condition.** The house pattern is a `waitFor` poll on
the final summary (`test/selfcheck/scenario-api.ts:443`, used by `expectColumn` at `:191`,
`expectSessionGone` at `:223`, `expectAgentRunning` at `:231`, and — new in #199 —
`expectReviewReason` at `:276`). A poll on `state === "awaiting_review"` cannot tell "parked because
the turn ended" from "parked because the process died": both land on `awaiting_review`. It collapses
park → wake → park into one observation. And it is the shape that let `890ed`'s first scenario pass
*before* its own fix.

**The column never moves server-side at all.** See §8. This is the largest finding in the document
and it is stronger than "the two writes drifted".

### 2.2 Expected behaviour

A test asserts a **sequence**, not a final state. An operator reads liveness rather than inferring it
from file timestamps. And cause sits next to effect: what the harness said, and what the runtime
decided in response, in one ordered record with one format, readable in-process, out-of-process, and
by a human.

### 2.3 Root cause

**The runtime models session state as a value and not as a history, so every transition is a write
that destroys its own evidence.**

Four consequences, each checkable in the current tree:

1. **`changed` is computed and discarded.** `reduceSessionTransition` returns
   `{ changed, patch, clearAttentionBuffer }` (`session-state-machine.ts:11-15`).
   `applySessionEvent` (`session-manager.ts:1247`) uses `changed` only to decide whether to write,
   then returns a summary. `44010` already named this discarded bit as the reason the wake rule
   acquired a second owner. Same bit, second cost: a **declined** transition is indistinguishable
   from one that never arrived.

2. **#199 added two more silent exits, so `hooks.ingest` now has four.** All four return
   `{ ok: true }` and leave no trace:

   | `hooks-api.ts` | silent exit |
   |---|---|
   | `:76-81` | no resolvable `agentId` → activity applied, nothing else |
   | `:100-105` | `mapNativeSignal` returned `unsupported` → the native event is discarded |
   | `:111-114` | `signal.seq <= lastProcessedSeq` → dropped as stale/duplicate |
   | `:155-164` | the transition was declined, or changed nothing |

   Two of those did not exist a day ago. This is not a criticism of #199 — dropping stale signals is
   correct — it is the point: **the runtime's decisions are getting richer while its evidence stays
   at zero.** A dropped signal and a signal that never arrived are the same observation today.

3. **The only fan-out is a snapshot, not an event.** `onSummary` (`session-manager.ts:266`) delivers
   `RuntimeTaskSessionSummary` — the *current* value. Its single subscriber
   (`runtime-state-hub.ts:536`) coalesces by taskId into a debounce map
   (`queueTaskSessionSummaryBroadcast`), so two transitions inside one window arrive as one. Park →
   wake → park is structurally unobservable downstream, by design, because the design is a state
   mirror.

4. **A kind-specific lifecycle rule has just been written outside the reducer.** #199 added, inside
   `transitionToReview` (`session-manager.ts:1026-1033`):

   ```ts
   if (isHomeAgentSessionId(taskId) && entry.summary.state === "idle") {
       const summary = updateSummary(entry, { state: "awaiting_review", reviewReason: reason });
       this.emitSummary(summary);
       return cloneSummary(summary);
   }
   ```

   An overseer-only state write that **bypasses `applySessionEvent` entirely**. It is the
   `1c16d96` shape again — a rule right for one session kind, placed where the other kind's answer
   is not adjacent — three commits later, and `44010`'s policy table has not landed to catch it. It
   also has a direct design consequence here: `state.changed` cannot be emitted *only* from the
   reducer (§5.1, §9).

`1c16d96` (#182) remains the class of bug this makes visible. It made `hook.to_in_progress` wake
**any** session at `awaiting_review` regardless of `reviewReason` — right for an overseer resting
between turns, arguable for a card a human parked. The commit is small and correct-looking; what it
changed is *which sessions silently move*. Under this design that same edit changes a card's stream
from `state.unchanged{rejected:"hook.to_in_progress"}` to `state.changed{awaiting_review→running}` —
a visible, assertable difference.

---

## 3. What exists in the codebase

### 3.1 Prior art read

| SHA / doc | What it establishes for this design |
|---|---|
| `a101114` (#199) | Read via `git show`. Binds `signals.mapNativeSignal` into `hooks-api` as its first production consumer, adds `SignalSequenceTracker`, deletes `canTransitionTaskForHookEvent` and `isNeedsInputReviewHook`, routes ingest by `AgentFact` type, and removes the `#180` known-fail marker. Changes §4.1 and §7's framing; changes none of the decisions. |
| `44010-session-kinds.md` | `SessionRef`, the policy table, and the observation that `applySessionEvent` throws away `changed`. Note `src/core/session-kind.ts` and `session-policy.ts` **still do not exist** — that doc's cards have not landed, so this design must not import them. |
| `03991-session-archive-and-usage.md` | The hot/cold invariant, the ledger layout, and the rule that the archive is an **effect consumer of reducer output**, never wired to a driver (§6.5). This stream is that output. |
| `1c16d96` (#182) | A lifecycle rule right for one session kind and silently wrong for the other — and the *silence* is the defect, not the rule. Recurs at `session-manager.ts:1026` (§2.3.4). |
| `b62d9` | Why §5's citation discipline matters: a stale `file:line` in a design doc sends the next card to the wrong file. Every citation here was re-checked after the rebase. |
| `givenArchivedCardWhenBoardReloadsThenLedgerKeepsItsPointer.ts` | **The precedent that decides §5.3:** a selfcheck scenario already reads ledger files off `context.instance.homeDir`, sets `CLINE_HOME`, and asserts on `manifest.json`. Runner and runtime share a filesystem. |
| `web-ui/tests/selfcheck.spec.ts` | How the one browser scenario is wired, and the answer to §13's question. |

### 3.2 Concepts and their canonical homes (Article 1)

- **Agent driver** (`concepts/agent-driver.md`, `src/agents/driver.ts`) — owns `AgentFact` /
  `SessionSignal`. Its doc states the boundary this design must respect: *"Drivers emit facts like
  `turn.ended` and `attention.required`; they never emit board verbs such as review, columns, or
  lifecycle states."* That sentence is why the session-event union **cannot** extend `AgentFact` (§4).
- **Task session** (`concepts/task-session.md`, `session-manager.ts`) — *"Do not scatter process
  launch, lifecycle management … outside of `TerminalSessionManager`."* The emission point,
  pre-decided by an existing concept (§5.1).
- **Session ledger** (`concepts/session-ledger.md`, `src/core/session-ledger.ts`) — the durable
  per-card, per-generation store, *"kept deliberately off the hot path."* Extended with one file per
  generation; **no fourth persistence location**.
- **Runtime state fanout** (`concepts/runtime-state-fanout.md`) — *"don't add polling or a second
  summary-derivation path."* The event stream is not a second summary path: it carries transitions,
  the hub carries values, and the stream never reaches the browser (card's out-of-scope).
- **New:** `concepts/session-event-stream.md`, added in the same change that introduces the type
  (Article 1, step 4). Nothing in the concept map owns "the ordered history of one session".

### 3.3 The decision points that exist today

Re-derived against `a101114`. Every "what the runtime decided" the card names, located:

| Decision | Where it happens now | Reachable from the manager? |
|---|---|---|
| session launched, with `resumeSession` | `session-manager.ts:343`; `identity.resolve` at `:367`; summary write at `:621` | yes |
| launch refused | `identity.resolve` → `throw` at `:375`; `launch.preflight`/`prepare` refusals in `prepareAgentLaunch` | yes |
| state → `awaiting_review` / `running` | `applySessionEvent` (`:1247`), called by `transitionToReview` (`:1018`), `transitionToRunning` (`:1110`), `resumeFromHumanInput` (`:1138`), PTY exit, prompt-ready detection — **plus one bypass at `:1026`** (§2.3.4) | yes |
| steer delivered and submitted | `writeInput` (`:961`), driven by `sendTaskSessionInput` (`runtime-api.ts:166`) | yes |
| harness fact received | `hooks-api.ts:91` `driver.signals.mapNativeSignal(...)` → routed by `signal.fact.type` at `:119-153` | via the manager it already holds (`:56`) |
| signal dropped as stale | `hooks-api.ts:110-115`, against `manager.getLastProcessedSeq` (`session-manager.ts:1126`) | yes |
| **column → `review`** | **nowhere on the server. `web-ui/src/hooks/use-board-interactions.ts:433-443`** | **no** |

Everything except the last funnels through, or holds, `TerminalSessionManager`. The last is §8.

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
          /** `SessionSignal.seq` — the driver's dedup key, retained. See §7. */
          readonly driverSeq: number;
      }
    /** A native event the runtime received and did NOT act on. New: see §4.1. */
    | {
          readonly type: "signal.dropped";
          readonly reason: "unmapped" | "stale_seq" | "no_agent_id";
          readonly nativeName: string;
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
    /** The runtime moved the session. `trigger` covers the reducer plus its bypasses. */
    | {
          readonly type: "state.changed";
          readonly from: RuntimeTaskSessionState;
          readonly to: RuntimeTaskSessionState;
          readonly reviewReason: RuntimeTaskSessionReviewReason;
          readonly trigger: SessionTransitionEvent["type"] | "overseer.cold_park";
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
          readonly by: "projection" | "pr-state" | "cli" | "archive-restore";
      }
    /** Steering reached the PTY. Byte COUNT, never bytes. */
    | { readonly type: "steer.delivered"; readonly bytes: number; readonly submit: boolean };

export type SessionEvent = SessionEventEnvelope & SessionEventBody;
```

Eight arms. Three things about the shape are deliberate.

**Why embed `AgentFact` instead of extending or flattening it.** Adding `state.changed` or
`column.changed` arms to `AgentFact` would put board verbs into the driver's vocabulary, which
`concepts/agent-driver.md` forbids in as many words, and would grow the type three drivers
`satisfies` against. Flattening the five fact types into five session-event arms
(`agent.turn_ended`, …) was the other option and is rejected: it is a second copy of an existing
five-value union that must then be kept in sync — the near-duplicate Article 1 exists to prevent.
The cost is one extra hop for readers (`event.fact.type` rather than `event.type`), which is a
`switch` inside a `case`, and it is the cheaper of the two costs. **#199 raised the value of this
choice**: `hooks-api.ts:119-153` now switches on `signal.fact.type` with an exhaustiveness check
(`:150`), so the embedded arm carries exactly the value the runtime already routes on.

**Why `state.unchanged` and `signal.dropped` are in the union.** They are the arms that make the
record non-fakeable. Everything else describes something that happened; these describe a rule
*firing and declining*, which today produces exactly zero observable output across the four silent
exits catalogued in §2.3.2. `signal.dropped` is **new since the first draft** and is a direct
response to #199: two of those four exits did not exist when the vocabulary was first written, and
both are now on the hot ingest path. Without this arm the stream would inherit a blind spot on its
first day.

**The `cause` field is what the card asked for and the reason both halves live in one union.**
`state.changed{trigger:"hook.to_review"}` carries `cause` = the `seq` of the
`agent.fact{turn.ended}` that produced it. "What the harness said" and "what the runtime decided" are
one hop apart in one ordered list; a reader never joins two streams by timestamp.

### 4.1 Where `agent.fact` events come from — resolved by #199

The first draft had to invent a `factFromHookEvent` mapping, because `mapNativeSignal` had no
production caller and there was no `SessionSignal` to embed. **That is no longer true, and the
proposed function is deleted from this design.**

`hooks-api.ts:91-107` now calls `driver.signals.mapNativeSignal({ name, payload, observedAt })` and
receives a real `Capability<SessionSignal>`. So:

- `agent.fact` embeds the actual `SessionSignal.fact`, and `driverSeq` is `SessionSignal.seq` — a
  real value, not a `null` placeholder. `driverSeq` is therefore non-nullable on that arm.
- The classification the first draft would have hand-written (`to_review` + permission metadata →
  `attention.required` vs `turn.ended`) now lives **in the drivers**, where the harness knowledge
  belongs. `isNeedsInputReviewHook` was deleted by #199 for exactly that reason.
- `emit` is called at the four points `hooks-api` already distinguishes: once for the mapped fact,
  and once for each of the three drop paths as `signal.dropped`.

This is the better outcome and it removes ~15 lines from the plan. It is also a reuse win the first
draft asked for and could not have: the vocabulary now has one owner (the drivers) for the fact half
and one owner (the log) for the decision half.

---

## 5. Decisions 2–4 — emission, subscribers, readers

### 5.1 Decision 2 — the emission point is the session manager, not the driver

**`SessionEventLog`, one instance per workspace, owned by that workspace's
`TerminalSessionManager`.**

Why not the driver, stated as the card asks:

- `DRIVERS` is a **module-level singleton** (`src/agents/driver.ts:147`), constructed once at import
  and shared by every workspace and every card on the board. Registering per-session subscribers on
  it puts per-session mutable state on a process-global object — the never-evicted module-level
  `Map` that `491de` deleted — unbounded in card count, forever.
- It destroys the property that makes drivers testable: today a driver is pure enough to exercise
  with a fixture and no PTY (`test/agents/tck/driver-tck.ts`). A driver holding subscribers holds a
  lifecycle. **#199 is the live proof of the hazard**: `SIGNAL_SEQUENCE_TRACKER`
  (`signal-sequence.ts:50`) is a module-level singleton holding per-session `Map`s, and it needs an
  explicit `evictSession` call from `hooks-api.ts:142` to avoid the leak. That is the shape we are
  refusing to add a second instance of.
- Drivers structurally **cannot** emit six of the eight arms. They do not know `SessionRef` (kind is
  a runtime fact — `44010`), they do not know `generation`, and their concept doc forbids them board
  verbs. `state.changed` is not a thing a driver can say.

Why the manager, and why that is *one* point rather than several:

- It already owns per-session mutable state keyed by taskId (`entries`, `session-manager.ts:234`),
  created and evicted with the workspace — and it is already where #199 put `lastProcessedSeq`
  (`:1126-1136`), i.e. the codebase has already chosen the manager as the home for per-session
  sequence state.
- It already has this exact subscription idiom: `onSummary(listener): () => void` (`:266`).
- The decision arms come from three call sites in that one file: `startTaskSession` (`:343`),
  `applySessionEvent` (`:1247`), `writeInput` (`:961`). One object, one owner.
- `agent.fact` and `signal.dropped` are emitted at `hooks-api.ingest`, which already holds the
  manager (`hooks-api.ts:56`), so they emit *through* the manager's log rather than owning one.

**One correction the rebase forces.** The first draft said all state writes funnel through
`applySessionEvent`, so `state.changed` needed one emission site. #199's overseer bypass
(`session-manager.ts:1026-1033`, §2.3.4) writes `state`/`reviewReason` **outside** the reducer.
Emitting only from `applySessionEvent` would therefore miss a real transition — silently, which is
the failure mode this whole design exists to remove. So:

- `state.changed` gains the `trigger` value `"overseer.cold_park"` for that path, keeping the field
  total over "every way the state can change" rather than over `SessionTransitionEvent` alone.
- The honest read: this is **two** emission sites for one arm, and that is a smell pointing at the
  bypass, not at the stream. The right fix is `44010`'s policy table absorbing the bypass back into
  the reducer, after which `"overseer.cold_park"` is deleted and the arm returns to one site. Named
  in §11 rather than fixed here — it is `44010`'s card, not this one's.

`column.changed`'s emitter is deferred to `a7306` (§8), which puts the projection server-side and
becomes its single emitter.

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
order. Not per-taskId order, because the value of the stream is that a filtered subscriber and an
unfiltered one agree about what came first.

**Sync or queued: synchronous, inside `emit()`, after `seq` assignment.** Reasons: it matches
`emitSummary` (`session-manager.ts:1339`, a plain sync loop) and `attach`'s sync initial `onState`
(`:321`); and a queued dispatch would let a `state.changed` be delivered *after* the summary
broadcast it caused, so a module test could no longer assert that the transition precedes the state
the UI sees. The **persistence** side is deliberately not synchronous (§6).

**A subscriber that throws.** Each callback runs in its own `try/catch`; the throw is swallowed, the
remaining subscribers still receive the event, and a `subscriberErrors` counter increments. The
counter is written to the generation's `events.meta.json` next to the drop count (§6), so "what this
log lost" has exactly one place. A subscriber can therefore never break a session, never reorder the
stream, and never hide its own failure.

### 5.3 Decision 4 — three readers, one record

| Reader | Surface | Why this one |
|---|---|---|
| **module tests** (vitest, in-process) | `log.subscribe()` and `log.recent(taskId)` | Direct, synchronous, no polling. The only reader that can assert *sync* ordering and subscriber isolation. |
| **selfcheck** (runtime out-of-process over HTTP) | **reads `events.jsonl` off disk**, via a new `ScenarioDriver.expectEventSequence` | See below. |
| **operator / architect** | the same `events.jsonl` | `agent.fact` with `fact.type` `turn.started` / `turn.ended` and its `at` answers "working or parked" directly. This replaces `card-watch`'s git-mtime inference. |

**Where I disagree with the card.** It proposes "a trpc `sessionEvents(taskId)`" for selfcheck. I
recommend against it, on a verified precedent:
`givenArchivedCardWhenBoardReloadsThenLedgerKeepsItsPointer.ts` **already** reads ledger files
directly off `context.instance.homeDir`, sets `process.env.CLINE_HOME`, and asserts on
`manifest.json` — because `startIsolatedKanbanInstance` boots a child process on the same host with
a home the runner knows.

A tRPC procedure would be a *second read path over the same file*, adding a wire contract that
Article 7 makes the most expensive thing in the tree to change, in exchange for nothing the
filesystem read does not already give. The file read is also strictly stronger: it proves the record
is **durable**, which a read of an in-memory ring would not.

The `ScenarioDriver` op the card asks for:

```ts
// test/selfcheck/scenario-api.ts — added to ScenarioDriver (currently declared at :36)
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

Implemented over the existing `waitFor` (`:443`) — so the *polling* is unchanged, but what is polled
is a **sequence**, which is the point. The failure message prints the events that were found, which
is the diagnostic the current terminal-state polls cannot produce.

**Stated limitation.** This assumes the selfcheck runner and the runtime share a filesystem. True
today, verified. If selfcheck ever runs against a remote runtime, a tRPC reader becomes necessary —
purely additive then, over the same file. Do not pre-build it.

---

## 6. Decision 6 — bounds, as invariants

This fires at every turn boundary of every card, so `03991`'s hot/cold rule governs.

> **A session event is a fixed-width record on a cold path. Emission is synchronous only into
> memory; every byte that reaches a disk does so on a deferred flush that no caller awaits. Nothing
> about this enters `sessions.json`.**

**I1 — never synchronous or awaited on the hook ACK path.** `emit()` returns `void`. It assigns
`seq`, dispatches to subscribers, pushes onto a ring, and schedules a flush
(`setTimeout(0).unref()`, coalescing a burst into one write). No caller can await it because there is
nothing to await. This matters more after #199: `hooks.ingest` already does real work per hook
(`mapNativeSignal`, seq bookkeeping, two fire-and-forget effects), and it is the path a 3 s hook
client timeout sits on. *Asserted*: with the store stubbed to reject every write, `hooks.ingest`
still returns `{ ok: true }` and the in-memory sequence is intact.

**I2 — no PTY bytes, no unbounded payloads.** `steer.delivered` carries `bytes: number` and never
the text. `agent.fact.activity` is the only variable-size field and it is the *already-bounded* hot
field (`RuntimeTaskHookActivity`, bounded by `boundLatestHookActivity`,
`workspace-state.ts:577-595`) — reused, not re-bounded, so the budget has one owner. Budget: **512
bytes serialized per event**, adopting `03991` §4.1's number (and noting §1: that number is a design
decision there, not shipped code — today's cap is 3 × 1000 chars at `:583`). Enforced the way
`03991` enforces the summary: a schema-generated worst-case record is asserted `≤ 512`, so the test
fails on a *new field* rather than ignoring it.

**I3 — retention and rotation, per generation.** One file per generation, in the ledger directory
that already exists:

```
$CLINE_HOME/kanban/workspaces/<workspaceId>/sessions/<taskId>/<generation>/
    manifest.json          # already there (session-ledger.ts:69)
    events.jsonl           # this design — one SessionEvent per line
    events.1.jsonl         # one rotation kept
    events.meta.json       # dropped, subscriberErrors, rotations, firstSeq/lastSeq
```

Rotate at **2 MB or 20 000 events**, whichever first; keep **2** files (≤ 4 MB per generation, and
generations are bounded by restart count). The path is derivable from `(workspaceId, taskId,
generation)` — `getTaskSessionsDir` already computes it (`session-ledger.ts:65`) — so no pointer
exists anywhere and pruning `sessions.json` cannot orphan it. Same property that makes the ledger
safe, reused.

**I4 — what is dropped under pressure, visibly.** The in-memory ring is **1 000 events per session**.
Overflow drops the **oldest** and increments `dropped`; consecutive identical `state.unchanged`
records (same `rejected`, same `state`) collapse into one with `repeated: n` rather than filling the
ring. Every loss is counted in `events.meta.json` and reported by `recent()`. A dropped count is
acceptable; silent unbounded growth is not, and neither is silent truncation.

Note the asymmetry with `SignalSequenceTracker`'s own bound: its 10-entry fingerprint window drops
*silently*, and its own comment says a late replay "gets a fresh seq, which the state guards make a
harmless no-op" (`signal-sequence.ts:33`). Under this design that no-op is no longer silent — it
surfaces as `state.unchanged`, which is precisely the observability this stream is for.

**I5 — nothing enters `sessions.json`.** `runtimeTaskSessionSummarySchema` (`api-contract.ts:371`)
gains no field. *Asserted* by a test comparing the schema's key set before and after — the same
schema-reflection idiom `03991` card 2 establishes.

Single writer, so appends are safe without a lock: exactly one runtime process owns a workspace, and
POSIX `O_APPEND` writes below `PIPE_BUF` are atomic. Readers (selfcheck, the operator, the CLI) are
read-only and tolerate a torn final line by ignoring it. `lockedFileSystem`
(`src/fs/locked-file-system.ts`) has no append helper and does not need one here; stated so an
implementing agent does not reach for `writeJsonFileAtomic` per event, which would rewrite the whole
file every turn.

---

## 7. Decision 7 — ordering

**A new counter, owned by the log, and deliberately not the driver's `seq`.** The decision is
unchanged from the first draft; only its framing changes, because the thing to compare against now
exists.

The first draft, written at #200, said "there is nothing to reuse" and predicted:

> *"When the `mapNativeSignal` consumer lands, `applySignalsBySeq`'s logic becomes
> `src/agents/signal-sequence.ts` — the file the card thought existed — as a production dedup filter
> upstream of `emit()`."*

**#199 did exactly that**, hours later: `SignalSequenceTracker` is that file, it is a dedup filter,
and `hooks-api` is that consumer. The prediction is recorded as confirmed rather than deleted,
because it is the argument: the concern that grew a production home grew a **dedup** home, not an
ordering one.

So the real comparison, against real code:

| Option | Verdict |
|---|---|
| Reuse `SessionSignal.seq` (assigned by `SignalSequenceTracker`) as the event order | **Rejected.** It is *"assigned by the driver"* (`session-signal.ts:11`) and exists for exactly one of eight arms; the other seven have no driver seq. It is keyed per **harness session id** (`getSequence(sessionId, …)`, `signal-sequence.ts:6`, called with `summary.agentSessionId \|\| taskId` at `hooks-api.ts:94`), so it resets when a card resumes under a new session id. An ordering key that covers 1/8 of the union and resets mid-card is not a total order. |
| Reuse `manager.lastProcessedSeq` (`session-manager.ts:1126`) | **Rejected, and it is evidence.** It is keyed by **taskId** while the tracker is keyed by **agentSessionId** — two keyspaces for one number, already. It is also a high-water mark, not a counter: it cannot number an event, only reject one. |
| Its own counter, owned by the log | **This.** |

**The decision.** `seq` is a plain integer, monotonic per `(taskId, generation)`, starting at 0,
assigned inside `emit()`. Node's single-threaded event loop makes assignment race-free without a
lock, and the per-generation reset makes it match the file it is written to — `events.jsonl` in
generation 3 starts at 0, so `firstSeq`/`lastSeq` in `events.meta.json` detect a truncated file.

**Dedup keeps its own home, and both facts coexist without conflation.** The driver's `seq` survives
inside the `agent.fact` arm as `driverSeq` (non-nullable now that a real `SessionSignal` exists), and
on `signal.dropped{reason:"stale_seq"}` it is the value that *caused* the drop — so the stream
records the dedup decision without owning it. Two concerns, two homes, one counter each.

The two-keyspace observation above is a real latent defect in #199, not this design's problem to
fix. Recorded in §11 so it is not lost.

---

## 8. Decision 5 — how this subsumes `a7306`, explicitly

**Decision: `a7306` is implemented as one subscriber over this stream, and it is a hard prerequisite
for the `column.changed` event. Neither supersedes the other; the ordering is stream first,
projection second.** Stated plainly so there are not two half-models of one mechanism.

### 8.1 The finding, stated at full strength

**No server-side path moves a card into the `review` column in response to session state. None. A
card reaches Review only if a browser tab is open and rendering the board.**

Verified exhaustively — every `moveTaskToColumn` call site in `src/`:

| Call site | Target column | Trigger |
|---|---|---|
| `core/task-board-mutations.ts:464` (`completeTaskAndGetReadyLinkedTaskIds`) | `done` | explicit completion |
| `core/task-board-mutations.ts:476` (`trashTaskAndGetReadyLinkedTaskIds`) | `trash` | explicit trash |
| `server/runtime-state-hub.ts:117` | `done` or `trash` | PR merged / closed |
| `commands/task.ts:922` | `in_progress` | `fleet task start` |
| `commands/task.ts:986` | `in_progress` | `fleet task start` |

Not one targets `review`. The only server-side write *into* the review column anywhere is
`restoreArchivedWorkspaceTask`'s default target (`state/workspace-state.ts:1147-1150`, reached from
`trpc/workspace-api.ts:478`) — an explicit operator un-trash, not a projection. Everything else that
mentions `"review"` on the server only **reads** it (`shutdown-coordinator.ts:162`,
`runtime-state-hub.ts:111`, `workspace-registry.ts:122`).

The only thing that parks a card is a React `useEffect`:

```ts
// web-ui/src/hooks/use-board-interactions.ts:433-443
if (summary.state === "awaiting_review" && columnId === "in_progress") {
    …
    const moved = moveTaskToColumn(nextBoard, summary.taskId, "review", { insertAtTop: true });
```

**This is the root cause of all three divergences previously read as "two writes drifted".**
Overnight, with no board open, `ffe94` and `5a376` had nowhere to go: their sessions parked at
`awaiting_review` and their cards stayed in `in_progress`, because the only code that could move
them was not running. The review notification follows the column, so the ping went with it. "The
column and the state disagree" describes the symptom; the cause is that **one of the two writers
lives in a browser and is absent by default.**

And the projection is written **three times**, in three layers, which is why it drifts at all:

| Copy | Location | Runs where |
|---|---|---|
| `awaiting_review` → column `review` | `use-board-interactions.ts:433-443` | the browser |
| `running` → column `in_progress` | `use-board-interactions.ts:444-456` | the browser |
| `awaiting_review` while in `in_progress` → decrement the in-progress count | `server/workspace-registry.ts:172-173` | the server |

The server has a copy of the *inference* and no copy of the *action*. That is an Article 3 failure
with a browser in the critical path.

### 8.2 What that means for this design

A reducer plus subscribers **is** the design `a7306` asks for: the projection becomes one
`SessionEventListener` on the server that maps `state.changed` to a board mutation, the browser's
`useEffect` is deleted, and `workspace-registry`'s count copy reads the board instead of re-deriving.

**The consequence, which changes the card breakdown.** The stream cannot emit
`column.changed{to:"review"}` before `a7306` lands, because there is no server-side authority that
moves that column — there is nothing to report. So:

- The `column.changed` arm ships in the vocabulary (card 1) with emitters only for moves that *are*
  server-side today (`by: "pr-state"`, `by: "cli"`, `by: "archive-restore"`). `by: "projection"` has
  no producer.
- The card's headline assertion — *"the stream shows `state.changed → awaiting_review` with no
  following `column.changed → review`"* — **is not writable until `a7306` lands.** Before then it
  would pass vacuously for every card, which is precisely the fakeable shape this design exists to
  remove. Writing it in card 1 would be the same defect in a new costume.
- Until then the honest assertion is the pair's first half: `state.changed{→awaiting_review}` is
  emitted, plus a static test asserting **no `projection` emitter exists** — a deliberate, visible
  gap in the type rather than a promise in prose.

So `a7306`'s scope becomes: *move the projection server-side as a subscriber of this stream, delete
the browser copy, fold the count copy* — and card 6 then adds the `projection` emitter and the
divergence assertion. `a7306` gets smaller (it inherits the mechanism) and this design gets one more
card. That is the trade, named.

---

## 9. Proposed solution — the shape end to end

Three files new, three touched.

**New**

- `src/core/session-event.ts` — `SessionEvent`, `SessionEventBody`, `SessionEventEnvelope`.
  Vocabulary only; no I/O. (No `factFromHookEvent` — §4.1.)
- `src/core/session-event-log.ts` — `SessionEventLog`: `seq` assignment, the 1 000-event ring per
  session, synchronous subscriber dispatch with per-callback isolation, `recent()`, drop and
  subscriber-error accounting, and the deferred flush hand-off.
- `src/core/session-event-store.ts` — `events.jsonl` append, rotation, `events.meta.json`. Reached
  only by the log's flush. Path from `getTaskSessionsDir` (`session-ledger.ts:65`).

**Touched**

- `src/terminal/session-manager.ts` — construct the log; emit `session.launched` /
  `session.launch_refused` in `startTaskSession` (`:343`), `state.changed` /`state.unchanged` in
  `applySessionEvent` (`:1247`), `state.changed{trigger:"overseer.cold_park"}` at the bypass
  (`:1026`), `steer.delivered` in `writeInput` (`:961`); expose `readonly events: SessionEventLog`.
- `src/trpc/hooks-api.ts` — emit `agent.fact` from the mapped `SessionSignal` (`:107`) and
  `signal.dropped` at the three drop paths (`:76`, `:100`, `:111`); pass the fact's `seq` as `cause`
  to the transition that follows (`:119-153`).
- `docs/architecture/concepts/session-event-stream.md` — new concept doc. The ledger module itself
  needs no change (paths are already derivable).

**Not touched:** `src/agents/**` (drivers stay pure — no port change, per the card's out-of-scope),
`api-contract.ts` (no wire or persisted-summary change), `runtime-state-hub.ts` (the stream does not
reach the browser), `sessions.json` (I5).

`state.changed`'s emission, concretely — the discarded bit, recovered:

```ts
// src/terminal/session-manager.ts — applySessionEvent, currently :1247
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

Plus the one bypass site at `:1026`, which emits the same arm with
`trigger: "overseer.cold_park"` — two sites for one arm, for the reason §5.1 names.

---

## 10. Technical rationale

**Why an event log rather than making the summary broadcast richer.** The hub deliberately coalesces
summaries by taskId into a debounce map (`runtime-state-hub.ts`,
`queueTaskSessionSummaryBroadcast`) because the browser wants the latest value, not the history.
Making that path carry transitions would either break the coalescing the UI depends on or lose the
transitions to it. Two consumers with opposite requirements need two records;
`concepts/runtime-state-fanout.md`'s "no second summary-derivation path" is respected because this
is not a summary path.

**Why not an `EventEmitter`.** There is none in `src/` (only `test/selfcheck/runtime-stream.ts` uses
one, for a websocket queue). Adopting one would import untyped `on(name, …)` dispatch into a
codebase whose two subscription surfaces (`TerminalSessionListener`, `onSummary`) are both typed
callbacks with disposers. Matching them costs ~20 lines and keeps `any` out.

**Why the record is a file and not a tRPC procedure.** §5.3. The decisive argument is that the
filesystem read is the *same* read the operator does and proves durability, whereas a wire surface is
the most expensive thing in the tree to change (Article 7) and would be a second path to the same
bytes.

**Why `state.unchanged` and `signal.dropped` earn their place despite the volume risk.** They are the
only arms that observe a rule declining, and the recurring bug on this surface (`ea3ca19`,
`9ca30b7`, `08e1f0d`, `158f9a3`, `1c16d96`, and now the `:1026` bypass — six changes) is *always* a
change in which sessions silently move or silently do not. The volume risk is real
(`agent.prompt-ready` fires off PTY output heuristics; `progress` facts arrive per activity hook) and
is bounded by the `repeated` collapse (I4) rather than by hoping. If measurement shows it still
dominates, the collapse window widens — a constant, not a redesign.

**Why one log per workspace rather than per session.** Per-session logs need a registry keyed by
taskId, which is `entries` again, one layer out. The manager already is that registry.

**Rejected: an `effect.dispatched` arm for the `hooks-api` fire-and-forget side effects** (turn
checkpoint at `:180`, auto-review PR at `:205`, review broadcast at `:222`, overseer ping at `:223`).
Tempting — "did the ping fire?" is a session question — but it is the line where a session-event
stream becomes the general operation log the card puts out of scope, and the existing
`givenReviewHookWhenIngestedThenOverseerIsNotified` scenario already proves the ping over the
websocket. Additive later if a card needs it.

**Rejected: streaming events to the browser.** The card's out-of-scope, and correct: the consumers
are tests and the operator. A live feed would put the hot path back on the fan-out.

**Rejected: emitting from the driver.** §5.1. It is the `491de` defect, `SIGNAL_SEQUENCE_TRACKER` is
a live instance of the hazard, and it breaks PTY-free driver tests.

**Risks, named.**

- *The stream can lie by omission before `a7306`.* `column.changed{by:"projection"}` has no producer,
  so a naive reader concludes the column never moves. Mitigated by the `by` discriminator making the
  gap explicit and by refusing to write the divergence assertion early (§8.2) — but it is a real
  sharp edge for six cards' worth of time.
- *Two emission sites for `state.changed`.* A third bypass added later would be missed the same way
  #199's was. The structural fix is `44010`'s policy table, not this design; until then a module test
  asserting "every `updateSummary` call that changes `state` has an adjacent emit" is the best
  available guard, and it is a lint-shaped assertion, not a strong one.
- *Volume on a chatty card.* Bounded by the ring, the `repeated` collapse, and rotation — but the
  numbers (1 000 / 2 MB / 20 000) are chosen from the shape of the data, not measured. First
  measurement is card 4's.
- *Two writers if a second runtime process ever opens a workspace.* Append-without-lock assumes one.
  True today. If that changes, `events.meta.json` counters disagree with the file and the fix is the
  existing `lockedFileSystem`, not a redesign.

---

## 11. Open questions

Written down rather than resolved with invented confidence.

1. **Does `state.unchanged` actually need coalescing?** I do not know the real rate of declined
   `agent.prompt-ready` events on a live card; that needs measurement the design cannot do. The
   `repeated` collapse is cheap insurance; if the rate is negligible it is dead weight. Measure in
   card 3.
2. **Should `progress` facts be recorded at all?** They are the highest-volume arm and
   `turn.started`/`turn.ended` already answer the liveness question. Lean: record them, because they
   are the only heartbeat *inside* a long turn, and drop them first under pressure. Genuinely
   uncertain.
3. **Is per-generation, per-card the right granularity for the operator's liveness read?** Liveness
   is a *board-wide* question ("which cards are parked?"), and per-generation files make that a
   fan-in read over N directories. `03991` §5.1 refuses a workspace-wide index because it re-creates
   shared cost — the same argument applies, but the use case pulls the other way. Unresolved; do not
   pre-build a workspace-wide log.
4. ~~How does `factFromHookEvent` retire?~~ **Answered by #199.** `mapNativeSignal` has a production
   consumer (`hooks-api.ts:91`), the classification lives in the drivers, and
   `isNeedsInputReviewHook` and `canTransitionTaskForHookEvent` are deleted. `factFromHookEvent` is
   removed from this design (§4.1); `agent.fact` embeds a real `SessionSignal`.
5. **The two-keyspace seq defect in #199 — whose card?** `SignalSequenceTracker` keys by
   `summary.agentSessionId || taskId` (`hooks-api.ts:94`) while `manager.lastProcessedSeq` keys by
   `taskId` (`session-manager.ts:1126`). A card that resumes with a *new* `agentSessionId` restarts
   the tracker at 1 while the manager's high-water mark is still high, so **every signal from the new
   session is dropped as stale** until it climbs past it. I have not reproduced this and it may be
   masked by `evictSession` on `session.ended` (`hooks-api.ts:142`) — which only runs if the
   `session.ended` fact actually arrives. Not this design's fix. Worth its own card, and this stream
   would make it visible as a run of `signal.dropped{reason:"stale_seq"}`.
6. **Does the `:1026` overseer bypass belong in the reducer?** I think yes, and that it is `44010`'s
   policy-table card. Until then `state.changed` has two emission sites (§5.1).
7. **Where does the `fleet` CLI reader live?** `fleet` is outside this repo. This design guarantees
   the file's shape and documents the `tail`/`jq` read; the CLI surface is the parent repo's call.
8. **Does the ledger's `openSession` become an event subscriber?** `03991` §6.5 says the archive
   should be "an effect consumer of reducer output". This stream is that output. Folding
   `openSession`'s launch-path call (`session-manager.ts:642`) into a subscriber of
   `session.launched` would remove a direct call from the hot start path — probably right, definitely
   not this design's card.

---

## 12. Card breakdown

Six cards, one verifiable outcome each. An oversized card on this epic already cost 879 k tokens, so
sizing is part of the deliverable: no card below owns more than one new file plus one wiring site.

For each card, the **event sequence a test would assert** is given — so the next card's prompt does
not leave the implementing agent choosing what its own check proves.

---

### Card 1 — `feat: model a session's history as one ordered event stream`

**Scope.** `src/core/session-event.ts` (vocabulary + envelope), `src/core/session-event-log.ts`
(seq, ring, sync dispatch, `recent`, isolation and drop counters),
`docs/architecture/concepts/session-event-stream.md`. **No emission sites. No persistence.**

**Verifiable outcome.** A module test over `SessionEventLog`'s public API only:

| Given / When | Then |
|---|---|
| three `emit`s for one `(taskId, generation)` | `recent()` returns them with `seq` `0,1,2` and `at` non-decreasing |
| a subscriber, then its disposer, then another `emit` | the disposed subscriber receives nothing |
| two subscribers where the **first throws** | the second still receives the event; `subscriberErrors === 1`; `recent()` unaffected |
| 1 001 emits into a 1 000 ring | `recent()` has 1 000, `dropped === 1`, and the **oldest** is gone |
| two consecutive identical `state.unchanged` bodies | one record with `repeated: 2` |
| a `filter: {taskId}` subscriber while two sessions emit | receives only its own, in global `seq` order |

**Prompt note:** the card premise that `src/agents/signal-sequence.ts` does not exist is stale — it
exists as of #199 and is a **dedup** concern. Do not extend it, do not reuse its `seq`, and read §7
before touching ordering.

**Files:** 2 new source + 1 new doc. **Shares files with:** nothing. **Depends on:** nothing.

---

### Card 2 — `feat: record what the runtime decided at every session transition`

**Scope.** Wire the log into `src/terminal/session-manager.ts`: `session.launched` /
`session.launch_refused` in `startTaskSession` (`:343`), `state.changed` /`state.unchanged` in
`applySessionEvent` (`:1247`), `state.changed{trigger:"overseer.cold_park"}` at the bypass (`:1026`),
`steer.delivered` in `writeInput` (`:961`). Expose `readonly events: SessionEventLog`.

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
collapses into one observation. Plus two negatives: a refused `identity.resolve` emits
`session.launch_refused{reason}` and **no** `session.launched`; and an overseer at `idle` receiving
`transitionToReview` emits `state.changed{trigger:"overseer.cold_park"}` — the `:1026` bypass, which
a reducer-only emit would have missed.

Note `session.launched` carries the resulting `state` and there is **no** `state.changed` for a
launch: launch writes via `updateSummary` (`:621`), not through the reducer.

**Files:** `session-manager.ts`. **Shares files with:** card 3 — **serialize, do not parallelize.**
**Depends on:** card 1.

---

### Card 3 — `feat: make a dropped signal and a declined transition visible instead of silent`

**Scope.** In `src/trpc/hooks-api.ts`: emit `agent.fact` from the mapped `SessionSignal` (`:107`),
threading its `seq` as the `cause` of the transition that follows; emit `signal.dropped` at the three
silent-exit paths (`:76` `no_agent_id`, `:100` `unmapped`, `:111` `stale_seq`).

**Verifiable outcome — three sequences, one per silent exit that exists today:**

```
# the happy path: cause and effect, one hop apart
agent.fact    { fact: { type: "turn.ended" }, driverSeq: 7 }                       seq 0
state.changed { to: "awaiting_review", reviewReason: "hook",
                trigger: "hook.to_review", cause: 0 }                              seq 1

# a replayed native event, dropped by the seq guard — invisible today
signal.dropped { reason: "stale_seq", nativeName: "Stop", driverSeq: 7 }            seq 2
# and NO state.changed follows

# a card parked at awaiting_review/"exit" declines a turn-start hook
agent.fact      { fact: { type: "turn.started" } }                                 seq 3
state.unchanged { state: "awaiting_review", reviewReason: "exit",
                  rejected: "hook.to_in_progress", cause: 3 }                      seq 4
```

The third is the assertion that would have made `1c16d96` a visible behaviour change rather than a
four-line diff: flipping that rule flips the arm from `state.unchanged` to `state.changed`, and the
test names which. The second could not have been written before #199, because the drop path did not
exist.

**Files:** `hooks-api.ts` (+ `session-manager.ts` for the `state.unchanged` emit landed in card 2).
**Depends on:** card 2.

---

### Card 4 — `feat: keep a session's event stream on disk, off the hot path`

**Scope.** `src/core/session-event-store.ts`: `events.jsonl` per generation under
`getTaskSessionsDir`, deferred coalesced flush, rotation at 2 MB / 20 000 events keeping 2 files,
`events.meta.json` (`dropped`, `subscriberErrors`, `rotations`, `firstSeq`, `lastSeq`). Amend
`concepts/session-event-stream.md` with the on-disk format and the operator's read.

**Verifiable outcome.**

| Given / When | Then |
|---|---|
| card 2's five-event sequence | `events.jsonl` holds the five lines, in `seq` order, parseable |
| a store stubbed to **reject every write** | `hooks.ingest` still returns `{ok:true}`; `recent()` still has the full sequence; `emit` never threw |
| the worst-case record generated from the schema | `JSON.stringify(...).length <= 512` |
| `runtimeTaskSessionSummarySchema`'s key set | unchanged — **I5** |
| 20 001 events | `events.1.jsonl` exists, `events.jsonl` holds the tail, `rotations === 1` |

**Files:** 1 new source + `session-event-log.ts` (flush hand-off) + the doc. **Shares files with:**
card 1 — serialize. **Depends on:** card 1; its first row needs card 2, so run it **after** card 2.

---

### Card 5 — `feat: assert a card's real sequence in selfcheck, not its final state`

**Scope.** `ScenarioDriver.expectEventSequence` (subsequence match over `events.jsonl`, built on
`waitFor`, `scenario-api.ts:443`), one new scenario, registered in `run-selfcheck.ts`.

**⚠️ Do NOT delete `givenReviewCardWhenSteeredThenMovesToInProgress.ts`.** The first draft of this
doc called it dead code; that was wrong. It is imported by `web-ui/tests/selfcheck.spec.ts:9` and is
the body of the live Playwright scenario. §13 has the full correction.

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
would produce it identically if the agent had died. That contrast belongs in the card prompt.

**Files:** `test/selfcheck/scenario-api.ts`, `test/selfcheck/run-selfcheck.ts`, one new scenario
file. ⚠️ **`scenario-api.ts` and `run-selfcheck.ts` are contention files** — #199 already edited
both. Do **not** dispatch this in parallel with any other selfcheck card.
**Depends on:** cards 2, 3, 4.

---

### Card 6 — `feat: a parked card cannot look like it is working` — blocked on `a7306`

**Scope.** Once `a7306` moves the projection server-side as a `SessionEventListener`: emit
`column.changed{by:"projection"}` from it, delete the browser `useEffect`
(`use-board-interactions.ts:433-456`), and fold `workspace-registry.ts:172-173`'s count copy to read
the board.

**Verifiable outcome — the `a7306` divergence, finally assertable:**

```
state.changed  { to: "awaiting_review", reviewReason: "hook" }   seq n
column.changed { from: "in_progress", to: "review",
                 by: "projection", cause: n }                    seq n+1
```

and the negative, which is the actual regression test: **with no browser anywhere near the run**, the
sequence must still reach `seq n+1`. Today it cannot — that is §8.1. This is also the first test in
the repo to cover the forward `awaiting_review → review` projection at all (§13).

**Files:** the new projection subscriber, `workspace-registry.ts`, `use-board-interactions.ts`, one
scenario. **Depends on:** cards 2, 5, **and `a7306`**.

---

### Order and parallelism

```
1 ──▶ 2 ──▶ 3 ──▶ 5 ──▶ 6 (also gated on a7306)
 └──▶ 4 ─────────▶┘
```

- **Card 1 first, alone.** Everything consumes its vocabulary.
- **Card 4 needs only card 1 to start**, but its end-to-end row needs card 2 — run 2 first.
- **Cards 2 and 3 share `session-manager.ts`** — serialize.
- **Cards 1 and 4 share `session-event-log.ts`** — serialize.
- **Card 5 owns the selfcheck files exclusively** — never parallel with another selfcheck card.
- **Card 6 is blocked on `a7306`** and is the only card touching `web-ui`.

---

## 13. Why the `#180` scenario passes — determined, not guessed

#199 removed the `knownFailureIssue: "#180"` marker from the browser scenario
(`run-selfcheck.ts:57-59`) and the suite now reports 9 PASS with zero known-fails. The question was
whether the stated cause could be the real one, since the fix (`runtime.sendTaskInput` →
`runtime.sendTaskSessionInput`, `scenario-api.ts:181`) lives in the tRPC driver while the scenario
that runs is `runBrowserScenario("review-steering")` → Playwright.

**Both proposed branches are true, and they are not alternatives.** The wiring resolves it:

```ts
// web-ui/tests/selfcheck.spec.ts:19-46
function createBrowserDriver(page: Page): ScenarioDriver {
    const trpcDriver = attachContext(createTrpcScenarioDriver(context), context);
    return {
        ...trpcDriver,                                    // ← inherits the tRPC ops
        steerCard: async (taskId, text) => {
            await page.goto("/");
            await expect(cardInColumn(page, taskId, "review")).toBeVisible();
            await trpcDriver.steerCard(taskId, text);     // ← the op #199 fixed
            await trpcDriver.expectColumn(taskId, "in_progress");
        },
    };
}
```

**Branch 1 — the stated cause is correct.** The browser driver spreads `...trpcDriver` and its
`steerCard` override *delegates to* `trpcDriver.steerCard`. So the Playwright path does call the op
#199 renamed. Before #199 it hit a non-existent procedure, `assertOk` threw, and the scenario failed
— which is exactly why it carried a known-fail marker. The attribution in #199's history stands, and
the doubt about it came from assuming the spec does not use `scenario-api`'s ops; it does, by
composition.

I can also rule out the rival explanation cleanly: **#199 did not touch `src/trpc/runtime-api.ts` at
all**, and did not touch the `human.input_submitted` arm of the reducer. The steer → wake path
(`sendTaskSessionInput` → `resumeFromHumanInput`, `runtime-api.ts:225-227`) worked before #199. So
the procedure name was the *only* blocker, and **#180 was a broken test, not a product bug.**

**Branch 2 — and this is the finding that matters.** The scenario is **structurally incapable of
failing the way production fails**, for two independent reasons:

1. It asserts the `running → in_progress` move (`expectColumn(taskId, "in_progress")`) *with a page
   open and rendered* — `page.goto("/")` and a visibility assertion happen first, by construction.
   That is the only condition under which the projection exists (§8.1). A headless production board
   with no tab open cannot be reproduced by a test whose first step is opening a tab.
2. It never exercises the forward projection at all. The scenario body places the card directly in
   `review` (`createCard({ column: "review" })`), so its `expectColumn(taskId, "review")` is
   **vacuous** — the card was put there, never projected there.

**Therefore: the `awaiting_review → review` projection — the exact mechanism that failed overnight
for `ffe94` and `5a376` — has zero coverage anywhere in the repo.** The one scenario that looks like
it covers this behaviour covers the reverse move, under the one condition that guarantees a pass.
That is the fakeable-check problem wearing a browser, and card 6 is the first test that would catch
the real bug.

**Actions this creates:**

- Card 6's negative assertion must be *"with no browser anywhere near the run"* — written that way
  above.
- `givenReviewCardWhenSteeredThenMovesToInProgress.ts` **stays**. It is live, it is the Playwright
  body, and it is honest about what it tests once you know it needs a browser. What it deserves is a
  comment saying so, and a sibling that does not — which is card 6.
- The suite's green is legitimate. What is not legitimate is reading it as coverage of the column
  projection.

---

## 14. Disposition

**Split into build cards** — six, in the order in §12.

Per the memory note that implementation cards go to gemini, cards 1–5 are implementation cards. Card
6 is gated on `a7306` and should be re-scoped when that card's plan lands, since `a7306` shrinks to
"move the projection server-side as a subscriber" under this design (§8.2) and the two prompts should
be written together.

**Carry into card 1's prompt:** the card's premise about `src/agents/signal-sequence.ts` is stale
(the file exists as of #199, and is a dedup concern) — read §7 before touching ordering.

**Carry into card 5's prompt:** do **not** delete
`test/selfcheck/scenarios/givenReviewCardWhenSteeredThenMovesToInProgress.ts`. It is live via
`web-ui/tests/selfcheck.spec.ts:9`.

**Carry into card 6's prompt, and into `a7306`'s:** §8.1 and §13. No server-side path moves a card to
`review`; the forward projection has zero test coverage; and the one scenario that appears to cover
it requires a browser to pass.

**Worth its own card, found while verifying this one:** the two-keyspace seq defect in #199 (§11.5) —
`SignalSequenceTracker` keyed by `agentSessionId`, `manager.lastProcessedSeq` keyed by `taskId`, so a
resume under a new session id may drop every signal as stale until it climbs past the old high-water
mark. Unreproduced; named so it is not lost.
