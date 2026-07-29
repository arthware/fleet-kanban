# A card owns its session history, off the hot path — and its token usage is queryable

**Status:** design (plan card — no code) · **Card:** `03991` · **Base:** `epic/session-kinds`
**Author:** design pass, 2026-07-29

> Deliverable of a design card. No implementation. This is a chapter of
> [`161b5-cli-driver.md`](./161b5-cli-driver.md) (the `AgentDriver` port) and
> [`44010-session-kinds.md`](./44010-session-kinds.md) (`SessionRef`), and it supersedes the
> derive-on-read decision in [`per-card-token-usage.md`](./per-card-token-usage.md) §2/§6 with
> evidence that decision could not have had at the time.

---

## 1. Problem statement

Three symptoms, one model error.

### 1.1 A card's conversation is not durable, and the loss is already scheduled

`sessions.json` holds exactly one pointer to a card's conversation: `agentSessionId`. That field is
also the *only* way any read path can find the conversation — `getTaskTranscript`
(`src/trpc/runtime-api.ts:679`) and `getTaskTokenUsage` (`:709`) both return empty the moment it is
absent. And the record holding it is pruned as soon as the card leaves the board:
`partitionWorkspaceSessions` drops any non-overseer record whose id is not in `getActiveBoardCardIds`
(`src/state/workspace-state.ts:627`), and trash is explicitly excluded from that set (`:417`).

Measured on the live dogfood board (`.fleet/cline/kanban/workspaces/fleet-kanban/`, 2026-07-29):

```
active cards 40 · trash 0 · session records 195
records with no active card: 156        (of which 130 still carry an agentSessionId)
of those 130 → transcripts still on disk: 118    already gone: 12
                            claude 68 · codex 44 · gemini 18
```

**118 conversations that still exist on disk become permanently unreachable on the first cold load
under `18d92ef` (#192).** They are not deleted — `~/.claude/projects` and `~/.codex/sessions` still
hold them — we simply throw away the only key we kept. The live board has not yet run that build
(the 195 records are still there), so the window to harvest those pointers is open *now* and closes
at the next restart on a build containing #192. This is the concrete form of "the conversation was
simply gone", and it is the reason card 1 of the breakdown is urgent rather than merely first.

Note the asymmetry this exposes: a trashed card's *body* is preserved with care
(`archived-cards.json`, 810 KB on the same board), while its *conversation pointer* is dropped in the
same operation.

### 1.2 Narrative data on the hot path, and per-field caps do not bound it

`sessions.json` is 432 KB across 195 records. Field-by-field byte share, measured:

| field | bytes | share |
|---|---:|---:|
| `latestHookActivity` | 243,157 | 56% |
| `latestTurnCheckpoint` | 25,915 | 6% |
| `previousTurnCheckpoint` | 25,225 | 6% |
| `workspacePath` | 14,242 | 3% |
| `agentSessionId` | 6,526 | 2% |
| `state` | 3,181 | <1% |

One `latestHookActivity` reached **51,515 bytes** (card `9a349`). This whole file is re-read,
re-parsed, re-serialised and rewritten on every workspace-state assembly and every atomic mutation
(`workspace-state.ts:1063`, `:1116`) — the operation that blew a 10 s timeout.

#192 supplied two mitigations: prune-to-active-cards, and `boundLatestHookActivity`
(`workspace-state.ts:576`), which caps three strings at 1000 chars each. Replaying both against the
live file:

```
post-prune + cap: 64,626 bytes over 41 records   ≈ 1.6 KB per record
```

Better by 6.7×, and **still not bounded**: 3 capped strings × 1000 chars is a 3 KB per-record
ceiling, so the file's worst case is `3 KB × cards`, which grows without limit as the board grows.
A control-only record is ~300 bytes. The cap is a smaller symptom, not an invariant.

### 1.3 Usage costs a full re-parse, and dies with the transcript

`observe.richUsage` re-reads and re-parses the entire artifact to produce four totals.
`getTaskTokenUsage` (`runtime-api.ts:698`) does that per card, in parallel, and
`use-task-token-usage.ts:16` polls it every **4 seconds** while any session is active. Measured:

- Bytes re-parsed per poll, for the 22 live cards with a locatable transcript: **15.8 MB**.
- Node cost for the single largest transcript on this host (54 MB claude JSONL): `readFile` 184 ms
  + `JSON.parse` per line **648 ms** — 648 ms of *synchronously blocked event loop*, for one card,
  for four numbers. That is the same event loop that assembles workspace state.
- The cost grows monotonically with conversation length, forever, and is paid again every 4 s.

And the answer is mortal: when the artifact is pruned, the totals are gone — so no card can ever be
costed after the fact, and "how much has this card cost across its three restarts" is unanswerable
even today, because `agentSessionId` is single-valued and a fresh claude launch **overwrites** it
(`agent-session-launch.ts:43-44`).

### 1.4 Expected behaviour

- A card's conversation and its token totals survive its agent dying, its board restarting, its
  worktree being removed, its card being trashed, and its harness pruning its own store.
- No amount of accumulated history changes the cost of a board snapshot.
- Usage for one session, and cumulative usage for a card across restarts, are O(1)-ish reads that
  keep answering after the source artifact is gone, and refuse honestly where a harness cannot count.

---

## 2. Root cause

**One record is being asked to be three things at once: control state, live display text, and the
durable index to a card's history — so the rules for one keep destroying another.**

Three consequences, each independently checkable:

1. **Ownership inversion (Article 3).** The index to cold data lives *inside* the hot record. So the
   hot path's correct instinct — "prune what isn't live" — is simultaneously an act of permanent data
   loss. There is no way to fix the hot path without losing history, and no way to keep history
   without bloating the hot path, *while the same record owns both*. #192 chose the hot path, and
   §1.1 is the bill.
2. **No stated boundary, so no field can be rejected.** `runtimeTaskSessionSummarySchema`
   (`api-contract.ts:371`) is 20 fields accreted over time; nothing in the type says what may join it.
   `latestHookActivity` was added as display text and grew to 56% of a file on the read-every-snapshot
   path. `boundLatestHookActivity` is a *guard on one field* — the third patch on this surface
   (Article 2's stop sign) — and it does not stop the fourth.
3. **Derivation is treated as free.** `per-card-token-usage.md` §2 made "derive, don't re-track" a
   rule, and it was right about *ownership* (we must not re-stream the agent) but wrong about *cost*:
   it assumed a transcript parse is "cheap but not free" (§6). At 15.8 MB per poll and 648 ms for one
   card, derive-on-read is not a caching problem, it is a wrong place to derive. **The cost of an
   answer must not be proportional to the length of the history it summarises.**

The general fix is not a better cap or a smarter cache. It is to **split the record by lifetime and
by who asks**: a fixed-width control record on the hot path, and a per-card cold ledger that owns
history and pre-computed totals. Then pruning the hot record is free of consequence, and no read path
ever touches an 800 MB harness store.

---

## 3. What exists in the codebase

### 3.1 Prior art read

| SHA / doc | What it establishes |
|---|---|
| `d2d8869` (#183) | The `AgentDriver` design: five sub-ports, `Capability<T>`, facts-not-verbs, the TCK as a deliverable. This design must not add a sixth sub-port or leak storage into a driver. |
| `8461ba1` | `observe` bound for claude/codex/gemini: `artifactPresent`, `messages`, `transcript`, `usage`, `richUsage`, `artifactPath`. This is what makes an archive possible — one uniform way to read three different stores. |
| `18d92ef` (#192) | The sibling fix: scope, prune, reconcile, and per-field cap on cold load. Supplies half the invariant (bound the *set*); this design supplies the other half (bound the *record*) and repairs the loss the prune causes. |
| `1c16d96` (#182) | Turn-start hooks honored in `session-state-machine`; the reducer is where facts already land. The archive attaches there, not to the driver. |
| `per-card-token-usage.md` | The normalized 4-counter shape, the per-harness field mappings (verified against real transcripts), the price-table deferral, and the derive-on-read decision this design revises. Its §11 already names the mtime/size skip-reparse guard as the follow-up; this design promotes it. |
| `durable-agent-sessions.md` | Established `agentSessionId` + `attached`/`resumable`/`gone`. Rejected "kanban owns the transcript" as Option C — see §9.2, where I argue that rejection was about *resume* and does not bind *reading*. |
| `44010-session-kinds.md` | `SessionRef` as a parsed discriminated ref; overseer role is a workspace fact, not an id fact. Every rule below is stated over `SessionRef`. |

### 3.2 Concepts touched (Article 1)

Consulted `docs/architecture/concepts/`. Nothing there owns durable session history or usage
accounting, so this is a genuinely new concept — added deliberately, once:

- **New:** `concepts/session-ledger.md` — the per-card cold store and its query API.
- **Extended, not cloned:** `persistence-cline-home.md` (a new per-workspace subtree),
  `task-session.md` (a session now has a sealed, readable afterlife), `agent-driver.md`
  (`catalog` gains a counter-support declaration; no sub-port added), `runtime-summary.md` (the
  summary becomes a *typed* control record).
- **Reused as-is:** `Capability<T>`, `SessionRef`, `RuntimeTaskTokenUsage`,
  `RuntimeTaskChatMessage`, `home-agent-session.md`'s id format.

### 3.3 What the harnesses actually give us (probed on real artifacts, 2026-07-29)

| | claude | codex | gemini |
|---|---|---|---|
| artifact | `~/.claude/projects/<slug>/<id>.jsonl` | `~/.codex/sessions/**/rollout-*-<id>.jsonl` | `~/.gemini/tmp/<projectHash>/chats/session-*-<id8>.jsonl` |
| host store size | 412 files, 411 MB | **45,923 files, 802 MB** | 80 files |
| `locate` cost | scan 140 project dirs | walk the whole tree (45,923 entries) | walk all project dirs × `chats/` |
| inputTokens | `input_tokens` (cache excluded) | `input_tokens − cached_input_tokens` | `tokens.input` |
| outputTokens | `output_tokens` | `output_tokens` (incl. reasoning) | `tokens.output` |
| cacheReadTokens | `cache_read_input_tokens` | `cached_input_tokens` | `tokens.cached` |
| cacheCreationTokens | `cache_creation_input_tokens` | **none — hardcoded `0`** (`codex/driver.ts:314`) | **none — hardcoded `0`** (`gemini/driver.ts:260`) |
| aggregation | sum per assistant record, dedup by `message.id`+`requestId` | last cumulative `token_count` | last `tokens` record |
| model identity | `message.model` → `claude-opus-5` | `payload.model` → `gpt-5.5` | record `model` → `gemini-3.5-flash` |

Two findings the card asked about, answered from the code rather than assumed:

- **The fabricated zero already ships.** Codex and gemini return `cacheCreationTokens: 0` for a
  counter their harness has no concept of. A board rendering a 4-lane total is quietly asserting a
  measurement nobody made.
- **Model identity is already read and then discarded.** `claude/driver.ts:320` reads
  `message.model`, uses it to pick a price, and drops it — `richUsage` returns numbers plus
  `costUsd`, never the model. All three harnesses report a model; none of it reaches a record.

Also worth stating, because it decides how a lazy backfill is even possible: **all three artifacts are
locatable by cwd, not only by id** — claude by its path slug, codex by the rollout's cwd, gemini by
`projectHash`. Card worktree paths are deterministic (`getTaskWorktreePath`). So a card's *lost*
generations are recoverable by cwd scan, which is what makes §6.3's backfill more than wishful.

---

## 4. The invariant

> **The hot record is a fixed-width control record: a closed set of scalar fields, each bounded at
> declaration, none of whose size depends on what the agent did. Anything that grows with the
> conversation is cold, lives in the card's own ledger, and is read only when someone asks for it.**

Two clauses, deliberately. #192 supplied "bound the set" (prune to live cards). This adds "bound the
record". Either alone re-bloats: 40 live cards × 3 KB of capped narrative is still 120 KB on the
read-every-snapshot path.

### 4.1 How it is enforced, not merely intended

A rule nobody can violate beats a rule that must be remembered, so the primary gate is the compiler.

```ts
// src/core/hot-state.ts — the ONE place the hot/cold rule is expressed.

declare const boundedBrand: unique symbol;
/** A string whose maximum length is declared at the schema. Produced only by `bounded()`. */
export type BoundedString<Max extends number> = string & { readonly [boundedBrand]: Max };

/** The complete vocabulary admissible on the hot path. Note: no array arm, no bare `string`. */
export type HotValue =
	| number | boolean | null | undefined
	| BoundedString<number>
	| { readonly [key: string]: HotValue };   // fixed-key groups (e.g. a checkpoint) are fine

export type HotRecord<T> = { readonly [K in keyof T]: HotValue };

/** The only way to declare a hot string. Emits `z.string().max(max)` and brands the output type. */
export function bounded<Max extends number>(max: Max): z.ZodType<BoundedString<Max>>;
```

`runtimeTaskSessionSummarySchema`'s inferred type then carries a `satisfies` obligation:

```ts
export type RuntimeTaskSessionSummary = z.infer<typeof runtimeTaskSessionSummarySchema>;
const _hot: HotRecord<RuntimeTaskSessionSummary> = {} as RuntimeTaskSessionSummary; // compile gate
```

- Adding `z.array(...)`, `z.record(...)`, or a bare `z.string()` to the summary **fails to compile**.
  Bare `string` is not assignable to `BoundedString<number>` because of the brand — the developer is
  forced to state a maximum, which is the decision we want made consciously.
- Belt to the compiler's braces, a module test walks the zod shape and asserts every string leaf has
  a `max` check and that the serialised worst case fits the budget:

```ts
it("keeps a worst-case session record under the hot budget", () => {
  expect(JSON.stringify(worstCaseSummary()).length).toBeLessThanOrEqual(512);
});
it("admits no unbounded field on the hot record", () => {
  expect(unboundedFields(runtimeTaskSessionSummarySchema)).toEqual([]);
});
```

`worstCaseSummary()` is generated *from the schema* (every string at its declared max, every optional
present), so it cannot go stale when a field is added — the test fails on the new field rather than
ignoring it. **512 bytes** is the budget: measured control-only records are ~300 bytes, and 512 × 200
cards is 100 KB worst case with every field saturated, against 432 KB today for 195.

`boundLatestHookActivity` (`workspace-state.ts:576`) is then **deleted**: an ad-hoc capper in the
persistence layer is exactly the symptom instrument Article 2 says not to ship as a fix. Bounds belong
at the declaration, where every writer inherits them.

### 4.2 What this classifies

| Hot (control) | Cold (ledger) |
|---|---|
| `taskId`, `state`, `mode`, `agentId`, `pid`, `exitCode`, `startedAt`/`updatedAt`/`lastOutputAt`/`lastHookAt`, `reviewReason`, `agentSessionLifecycle` | full conversation, per-turn history, full hook/final-message text |
| `agentSessionId` — the id needed to **resume** | every generation's id, as history |
| `sessionGeneration` (number) — which ledger dir the live session writes to | per-generation manifests, usage totals, model identity |
| `latestHookActivity`, re-declared to a **512-byte total** (see §6.2) | the verbatim text the activity summarised |
| `latestTurnCheckpoint` / `previousTurnCheckpoint` (4 scalars each) | older checkpoints (already git refs; not our storage) |
| `warningMessage` (bounded), `lastReviewNotificationKey` (bounded) | — |

`workspacePath` stays hot but is flagged: it is 14 KB of state derivable from `(repoPath, taskId)` —
`task-worktree.ts:283` computes it deterministically, and the workspace context already holds
`repoPath` — i.e. mirrored state (Article 3). Removing it is a clean follow-up, not part of this
design.

---

## 5. The session ledger

### 5.1 Layout

Per workspace, per card, per generation. Under the workspace state dir — **never in the worktree**, so
it survives worktree removal, which is a stated requirement:

```
$CLINE_HOME/kanban/workspaces/<workspaceId>/sessions/
  <taskId>/                        # card id, or "__home_agent__:<workspaceId>" for an overseer
    index.json                     # this card's generations — bounded by restart count
    <generation>/
      manifest.json                # ~300 B: identity, timing, outcome, usage totals, body state
      messages.jsonl               # normalized RuntimeTaskChatMessage per line; optional (§6.3)
```

Three properties, each load-bearing and each a direct answer to the card's asks:

1. **The path is derivable from `SessionRef`.** No pointer is needed anywhere, so the hot record
   stops being the index. Pruning `sessions.json` can no longer destroy history — the fix is
   structural, not a rule to remember.
2. **Per-card granularity is physical.** Reading one card touches one directory. "One card's long
   history must never be a cost anyone else pays" is enforced by the filesystem rather than by a
   query predicate. This is why there is deliberately **no** workspace-wide ledger index file: a
   single `index.json` over all sessions would re-create the shared-cost failure one directory over.
3. **Generations are first-class.** A card that restarted three times has `0/`, `1/`, `2/`. The
   single-valued, overwritten `agentSessionId` stops being the model.

`agentSessionId` appears both hot and in the manifest. That is not mirroring: hot holds *the current
generation's* id for control (resume), the ledger holds *each* generation's id as history. Different
facts, different lifetimes — and it gives a recovery path when `sessions.json` is lost, since the
newest manifest can restore the resume id.

### 5.2 The manifest

```ts
// src/core/session-ledger.ts
export interface SessionLedgerManifest {
	readonly schemaVersion: 1;
	readonly taskId: string;
	readonly kind: SessionKind;               // from 44010; the ledger is kind-agnostic (§7)
	readonly generation: number;
	readonly agentId: RuntimeAgentId;
	readonly agentSessionId: string | null;   // null while codex/gemini discovery is pending
	readonly openedAt: number;
	readonly closedAt: number | null;         // null ⇒ open, or the board died mid-session
	readonly outcome: "completed" | "failed" | "interrupted" | "unknown";
	readonly usage: SessionUsageRecord;       // §6.4 — capability-valued counters
	readonly source: {
		readonly artifactPath: string | null; // last known location; diagnostics only, never a key
		readonly artifactSeenAt: number | null;
		readonly artifactMtimeMs: number | null;  // re-derive guard
		readonly artifactBytes: number | null;    // re-derive guard
	};
	readonly body: {
		readonly captured: boolean;
		readonly capturedAt: number | null;
		readonly messageCount: number;
		readonly bytes: number;
		readonly truncated: boolean;          // body hit the cap; head+tail kept
	};
}

/** `<taskId>/index.json` — the only per-card fan-in, bounded by restart count. */
export interface SessionLedgerIndex {
	readonly schemaVersion: 1;
	readonly taskId: string;
	readonly generations: readonly {
		readonly generation: number;
		readonly openedAt: number;
		readonly closedAt: number | null;
		readonly agentId: RuntimeAgentId;
	}[];
}
```

`index.json` is a convenience denormalisation of the manifests (one read instead of K). It is
rebuildable from the manifest files by directory scan, so a corrupt or missing index is a
self-healing condition, not data loss — the manifests are authoritative.

### 5.3 When the archive is captured — decided

The card offers four options (continuous / at review-done / lazy / combination). **Decision: eager on
open and close for the cheap facts, background-debounced for usage, lazy-backfilled for the body.**
Split by cost, because the four options are not alternatives — they answer different questions.

| what | when | cost | why not otherwise |
|---|---|---|---|
| manifest + index entry | **at session open** (and on id discovery) | one ~300 B write per launch | Capturing at the review/done boundary loses everything to a crash — which is the exact failure that motivated the card. A pointer must exist before it can be needed. |
| usage totals | **on `turn.ended`, debounced, single-flight, mtime-guarded, off both the read and the hot path** | one artifact re-parse per turn at most, and skipped entirely when `(mtime, bytes)` are unchanged | See §6.1 — neither of the card's two options works as stated. |
| outcome, `closedAt` | **on `session.ended`** | one write | — |
| body (`messages.jsonl`) | **at close, plus lazy backfill on first read** | one bounded copy per session | Continuous append would duplicate the harness's own writes turn by turn for a file most cards never read. Close-only loses sessions that predate the ledger or whose close was missed — hence both. |

**When the source artifact is already gone.** The manifest is the answer, and it answers honestly:

- Totals last derived are retained (`usage.derivedAt` stamps their age) — a card stays costed after
  its transcript is pruned. This is the property derive-on-read structurally cannot have.
- If `body.captured === false` and the artifact is gone, `readHistory` returns
  `unsupported("source artifact is gone and no body was captured for generation N")`. Never an empty
  message list that reads like "this card never said anything" — which is what happens today.
- A backfill attempt that finds nothing records `artifactSeenAt` unchanged and does not clear
  anything. Absence of a source never mutates a total.

### 5.4 Authority when the ledger and the artifact disagree

- **Closed generation → the ledger wins.** It is the record; the artifact is a copy we do not own and
  cannot stop the harness from rewriting or deleting.
- **Open generation → the artifact wins**, and the manifest is a cache carrying `usage.derivedAt` so a
  reader can see its staleness. A live conversation's truth is the harness's file mid-turn.
- **Counters are monotonic within a generation.** Merge is per-counter `max`, never overwrite: a
  truncated, rotated or partially-written artifact must not be able to reduce a card's history to
  zero. Across generations there is no merge at all — separate directories — which is precisely why
  generations must be modelled rather than collapsed into one field.

---

## 6. Decisions the card asked for

### 6.1 Why neither "accumulate incrementally" nor "derive on read and cache"

The card frames a choice between the two. Both fail, for reasons only visible in the code:

- **Incremental accumulation is not available.** `AgentFact.turn.ended` carries `finalMessage` and
  nothing else (`agents/session-signal.ts`). No harness pushes counters to us; every number comes
  from re-reading the artifact. "Accumulate from the same turn-end signal" would still be a full
  parse per turn — worse than today on a chatty card, not better.
- **Derive-on-read-and-cache leaves the first read at 648 ms** and the answer still dies with the
  transcript. A cache in front of a mortal source does not make the source immortal.

**The third option, and the recommendation: derive on write, off both paths.** `turn.ended` marks the
generation usage-dirty; a single-flight worker (one in-flight derive per session, coalescing bursts,
debounce ~2 s) re-derives via the existing `observe.richUsage` and merges into the manifest. Guarded
by `(artifactMtimeMs, artifactBytes)`, an unchanged artifact skips the parse entirely — this is the
skip-reparse guard `per-card-token-usage.md` §11 already named as the follow-up, promoted from
optimisation to mechanism. Reads never parse an artifact.

Costs, stated per the card's demand that an expensive answer is a broken answer:

| query | today | with the ledger |
|---|---|---|
| usage, one session | locate (walk ≤45,923 files) + full parse; 648 ms worst case measured | 1 read, ~300 B |
| usage, whole visible board (22 cards) | **15.8 MB re-parsed every 4 s** | 22 reads, ~7 KB |
| usage, card across 3 restarts | **impossible** | 1 index read + 3 manifest reads |
| usage after the transcript is pruned | **impossible** | unchanged — it is a stored number |
| history, one session | locate + full parse | 1 bounded read |

### 6.2 `latestHookActivity` — bounded hot, dropped cold (against the card's framing)

The card asks whether it survives bounded, moves to the archive, or disappears. **It survives hot in
bounded form and is NOT archived**, and I disagree with the "move it to the archive" option on both
halves:

- It cannot simply move. Three live consumers read it every render:
  `board-card.tsx:174` (credit-limit chip), `:196` (the agent's pending question), `:199` (the
  activity line), and `use-review-ready-notifications.ts:49` (notification body). Moving it cold
  trades a performance bug for a UX regression — a card would go quiet while its agent is working.
- It is not worth archiving. It is a *lossy summary* of text the transcript already holds verbatim.
  Archiving it would store a worse copy of something we are also storing properly. The transcript is
  the record. `SessionSignal.activity` already carries the comment "Display-only. Never influences
  lifecycle." (`agents/session-signal.ts`) — that is precisely the property that makes it safe to
  truncate hard and pointless to keep forever.

So: keep it, and bound it at declaration to a **512-byte total** across the group, allocated to what a
card can actually render — `activityText` 120, `toolName` 40, `hookEventName` 40,
`notificationType` 40, `source` 24, `toolInputSummary` 80, `finalMessage` 160 (a question preview;
the full question is one ledger read away). Measured effect: 41 records × ≤512 B ≈ **21 KB**, versus
64.6 KB post-#192 and 432 KB today — and, unlike a cap, it does not grow with the field count because
the *record* is budgeted, not each string.

### 6.3 Retention and the card lifecycle

Bounding the archive matters as much as bounding the hot record — "an archive that grows without limit
is the same failure one directory over" is the card's phrase and it is right.

| event | ledger |
|---|---|
| card → `review` / `done` | current generation sealed (`closedAt`, `outcome`); body captured. Nothing dropped. |
| card → `trash` (archived to `archived-cards.json`) | **retained.** This is the asymmetry §1.1 named: the card body is preserved, so its conversation must be too. |
| card restored from archive | nothing to do — the ledger was never keyed on board membership. |
| card **hard-deleted** | ledger directory removed. Trash is reversible and keeps history; delete is the operator saying "gone". Exactly one code path may remove a ledger, and it is this one. |
| worktree removed | no effect. The ledger is outside the worktree by construction. |
| session restart | new generation directory; previous one already sealed. |
| workspace removed (`removeWorkspaceStateFiles`) | ledger subtree goes with it — it is workspace state. |

Bounds:

- **Manifests are kept forever.** ~300 B, bounded by restart count. 100 restarts = 30 KB. This is
  what keeps a card costable for its whole life.
- **Bodies are capped**: per generation, `min(5 MB, 5000 messages)`, keeping head + tail with an
  explicit truncation marker and `body.truncated: true`. A middle-elided conversation is honest; a
  silently short one is not.
- **Bodies are evicted**: keep the newest K = 20 generations per card; and a per-workspace body
  budget (default 2 GB) evicting oldest-closed-first. Every eviction flips `body.captured` back to
  `false` on that manifest, so a later read refuses honestly instead of returning a hole.
- **No silent caps.** Eviction and truncation are recorded in the manifest and surfaced by the read
  API, per the project's rule against invisible truncation.

### 6.4 The usage API

Driver-agnostic, capability-valued, and the one surface the CLI, the board and a future cost report
all call.

```ts
// src/core/session-usage.ts
export type TokenCounter = Capability<number>;   // reuses agents/driver.ts — not a new shape

export interface SessionUsageRecord {
	readonly inputTokens: TokenCounter;
	readonly outputTokens: TokenCounter;
	readonly cacheReadTokens: TokenCounter;
	readonly cacheCreationTokens: TokenCounter;
	/** Harness-reported model identity — the price key. Already read and discarded today. */
	readonly model: Capability<string>;
	readonly derivedAt: number;
	readonly derivedFrom: "artifact" | "manifest";
}

export interface CardUsageRollup {
	readonly ref: SessionRef;
	readonly sessions: number;
	readonly total: SessionUsageRecord;
	/** True when ≥1 generation refused ≥1 counter, or a manifest was unreadable. */
	readonly partial: boolean;
}
```

```ts
// src/state/session-archive.ts — driver-agnostic. Knows storage; knows no harness.
export interface SessionArchive {
	// reads — none of these touch a harness artifact
	listSessions(ref: SessionRef): Promise<readonly SessionLedgerIndex["generations"]>;
	readUsage(ref: SessionRef, generation: number): Promise<Capability<SessionUsageRecord>>;
	readCardUsage(ref: SessionRef): Promise<CardUsageRollup>;
	readHistory(
		ref: SessionRef,
		generation: number,
		window?: { readonly limit: number; readonly from: "head" | "tail" },
	): Promise<Capability<SessionHistory>>;

	// writes — driven by facts, never by a caller's opinion
	openSession(input: OpenSessionInput): Promise<SessionLedgerManifest>;
	noteIdentityDiscovered(ref: SessionRef, generation: number, agentSessionId: string): Promise<void>;
	noteTurnEnded(ref: SessionRef, generation: number): void;      // marks dirty; returns immediately
	closeSession(input: CloseSessionInput): Promise<void>;
	backfill(ref: SessionRef, generation: number): Promise<Capability<SessionLedgerManifest>>;
}

export interface SessionHistory {
	readonly messages: readonly RuntimeTaskChatMessage[];
	readonly truncated: boolean;
	readonly totalMessageCount: number;
	readonly capturedAt: number;
}
```

**Which counters are real, and the refusal shape.** Per §3.3, `cacheCreationTokens` does not exist for
codex or gemini. Each driver declares that on its existing static-facts home — the `catalog` — so no
existing port member changes (the card puts that out of scope) and the declaration sits with the
behaviour it describes:

```ts
// added to RuntimeAgentCatalogEntry
readonly usageCounters: {
	readonly inputTokens: boolean;
	readonly outputTokens: boolean;
	readonly cacheReadTokens: boolean;
	readonly cacheCreationTokens: boolean;   // claude true · codex false · gemini false
	readonly model: boolean;                 // all three true
};
```

The archive maps `richUsage`'s plain numbers to capabilities *through* that declaration, so a
harness that never measured a lane yields `unsupported("codex reports no cache-write counter")`
instead of `0`. `RuntimeTaskTokenUsage` (persisted, wire-facing) is untouched — Article 7's
persistence exception. A later card may add a native `observe.usageRecord()` returning capabilities
directly; it is not needed for this and would change a port that just landed.

**Summing refusals is where a fabricated zero comes back, so define it once.** A counter in a rollup
is `supported` only if *every* contributing generation supported it; otherwise it is
`unsupported("2 of 3 sessions do not report this counter")` and `partial: true`. Treating a refusal as
0 in a sum is the same lie as zero-filling one record, committed one layer up. Mixed-harness cards
(a card restarted on a different agent) are the normal case for this, not an edge case.

**A driver that reports no usage at all** — the fake driver, and any future harness — returns
`supported(null)` or `unsupported` from `richUsage`. Every counter is then refused, the rollup is
`partial`, and open/close/history/backfill all still work: usage is one field of the manifest, not its
reason to exist. That is asserted in the TCK rather than assumed (§6.5).

**Cost per query is a documented property of each member**, since this is monitoring:
`readUsage` = 1 file read; `listSessions` = 1 file read; `readCardUsage` = 1 + K reads, K = restart
count; `readHistory` = 1 bounded read. No member walks a harness store. Price attaches at
`model` + counters in `SessionUsageRecord` — deliberately not computed here (out of scope), but the
record is the right place and it now retains the model that `claude/driver.ts:320` currently discards.

### 6.5 How this attaches to the driver port

The line the card asks about, stated as a rule: **the driver returns values; the archive decides when
to ask and where to put them.**

| Driver (harness-specific) | Archive service (driver-agnostic) |
|---|---|
| locate its own artifact; parse to messages; derive counters; report `(mtime, bytes)`; declare `usageCounters`; emit `turn.ended` / `session.ended` | storage layout, manifest, generations, capture scheduling and debouncing, monotonic merge, retention and eviction, the query API |
| knows nothing about `$CLINE_HOME`, ledgers, generations, retention | knows nothing about JSONL, rollouts, `projectHash`, cwd slugs |

**Which signal it subscribes to: the reducer's, not the driver's.** Signals flow driver → reducer.
Note the target does not exist yet: `161b5` §"The reducer: three axes" plans
`src/core/session-reducer.ts`, and today's home is `src/terminal/session-state-machine.ts`
(`reduceSessionTransition`). The archive attaches to whichever of the two owns reducer output when its
cards land — it must not be wired ahead of that move, or it acquires a second owner. The archive is an
**effect consumer of reducer output**, keyed by `SessionRef`, for three reasons: the reducer is already the
single owner of session transitions (Article 3); it already holds the `SessionRef` and therefore the
kind, which the driver by design does not; and it already drops stale and duplicate `seq` values, so
the archive inherits idempotence instead of reimplementing it. A driver must never be able to cause a
write to our storage.

Facts consumed: `turn.ended` → `noteTurnEnded`; `session.ended` → `closeSession` (its `outcome` maps
straight to the manifest's); session start (existing launch path, not a fact) → `openSession`;
identity discovery (codex/gemini post-spawn capture) → `noteIdentityDiscovered`.

**TCK additions** (the TCK is a deliverable per `161b5`, so new guarantees are asserted there):

7. **Counter honesty** — a driver declaring `usageCounters.X === false` must never return a non-zero
   `X` for any fixture; a driver declaring `true` must return a non-zero `X` for at least one fixture.
   This fails today for codex and gemini and is the assertion that makes the fabricated zero
   unrepresentable rather than merely deprecated.
8. **Archive round-trip on a usage-less driver** — with the fake driver's `richUsage` refusing,
   open → turn.ended → close → `readUsage` yields all-refused counters, `readHistory` still returns
   the captured body, and no manifest field is silently zeroed.

---

## 7. Overseers (per `44010`)

Every rule above is stated over `SessionRef`, so the ledger is kind-agnostic by construction. The
kind-dependent behaviours are enumerated here, in one table, once — because "a rule written for one
kind and silently wrong for the other" is this area's recurring bug:

| aspect | card | overseer |
|---|---|---|
| ledger key | `<taskId>` | `__home_agent__:<workspaceId>` — an existing, stable, id-derivable key |
| generation source | new `sessionGeneration` (see below) | the existing `homeAgentSessionGeneration`, which already means exactly this |
| lifecycle events | done / trash / delete apply | none of them ever fire; only restart-with-bumped-generation |
| id recoverability | random UUID minted per launch → **only** a persisted pointer can find it | `uuidV5(workspaceId:agentId:generation)` (`home-agent-session-id.ts:19`) → **recomputable**, so past generations are enumerable without any stored pointer |
| retention | body caps + K=20 generations | identical rules; overseer chats run for weeks, so eviction bites first here |
| why you'd query it | what did this card cost | what does the board itself cost — the overseer rollup is the standing overhead of running fleet |

The recoverability row has a practical consequence: the migration can **reconstruct** an overseer's
entire ledger from generation 0 upward by recomputing ids and probing for artifacts. Cards cannot be
reconstructed that way — hence §1.1's urgency applies to cards only.

**Reuse, don't clone (Article 1).** Cards need a generation counter to name their ledger directory.
`homeAgentSessionGeneration` already *is* that concept, restricted to one kind. Recommendation:
generalise to **`sessionGeneration`** for both kinds — additive, default 0, read the old field as a
fallback during migration and stop writing it (the persistence-boundary exception, Article 7). One
field, one meaning, one owner; the alternative is a second counter that means the same thing, which is
precisely the near-duplicate Article 1 forbids.

---

## 8. Migration, blast radius, and what breaks if we do nothing

### 8.1 The harvest (this is the urgent part)

A one-shot idempotent migration reads every record in each workspace's `sessions.json` — **including
the 156 the prune is about to drop** — and, for each with an `agentSessionId`, opens a sealed
generation-0 ledger entry: `(taskId, agentId, agentSessionId)`, `outcome: "unknown"`, `closedAt` from
`updatedAt`, `body.captured: false`, and one usage derive if the artifact is still present.

Measured expectation on the live board: 195 records → 130 manifests → 118 with an artifact still on
disk (68 claude, 44 codex, 18 gemini). It is idempotent (an existing manifest is left alone), so it
can run on every boot and needs no completion flag.

**Ordering risk, stated plainly:** #192's reconcile drops those records on the first cold load of a
build containing it. The live board has not yet run that build. If the harvest does not land before
the operator's next `fleet update`, 118 recoverable conversations are lost and no later card can get
them back. This is why the harvest is card 1 and is independent of everything else in this design.

### 8.2 Consumers, and what each must change

| site | change |
|---|---|
| `src/core/api-contract.ts:371` summary schema | fields re-declared via `bounded()`; `sessionGeneration` added; `satisfies HotRecord<…>` gate |
| `src/core/api-contract.ts:352` `runtimeTaskHookActivitySchema` | per-field maxima summing to ≤512 B (§6.2) |
| `src/state/workspace-state.ts:576` `boundLatestHookActivity` | **deleted** — bounds move to the declaration |
| `src/state/workspace-state.ts:607` `partitionWorkspaceSessions` | unchanged in behaviour, but pruning is now consequence-free; add a comment naming the ledger as the reason it is safe |
| `src/state/workspace-state.ts:1021` `removeWorkspaceStateFiles` | remove the ledger subtree with the rest of workspace state |
| `src/trpc/runtime-api.ts:698` `getTaskTokenUsage` | reads the ledger; response shape unchanged (wire-compatible); becomes O(1) per card |
| `src/trpc/runtime-api.ts:674` `getTaskTranscript` | ledger fallback when the summary has no session id → **a trashed/archived card's conversation comes back** instead of rendering empty |
| `src/terminal/agent-usage-reader.ts` | stops being a read path; it becomes the capture worker's derive helper (or folds into it) |
| `web-ui/src/hooks/use-task-token-usage.ts` | the null-must-not-overwrite flicker guard (`mergeTaskTokenUsage`) becomes unnecessary — ledger reads are monotonic and never transiently empty. Deleting it is a simplification the new model earns. |
| `web-ui/src/components/board-card.tsx:174,196,199` | tolerate a 160-char `finalMessage` preview |
| `src/commands/task.ts:1102` `fleet task cat` | inherits the ledger fallback for free |
| `docs/architecture/concepts/` | new `session-ledger.md`; touch-ups to `persistence-cline-home.md`, `task-session.md`, `agent-driver.md`, `runtime-summary.md` |

Not changed: the driver port's existing members; `RuntimeTaskTokenUsage`; the tRPC response shapes for
usage and transcript. A client that never learns about the ledger keeps working.

### 8.3 If we do nothing

1. 118 conversations with artifacts still on disk become unreachable at the next board restart.
2. `sessions.json` re-bloats: the per-field cap leaves a 3 KB per-record ceiling, so the file grows
   with card count and the 10 s-timeout failure returns on a bigger board.
3. Every 4 s, the board re-parses 15.8 MB (growing without bound) on the same event loop that
   assembles workspace state; one 54 MB transcript is 648 ms of blocked loop by itself.
4. Usage stays unanswerable per card across restarts and unanswerable at all once a transcript is
   pruned — so cost monitoring cannot be built on it.

---

## 9. Where I disagree with the card

The card asks to be argued with rather than transcribed. Six places:

1. **"O(1) per card" is not the invariant.** 195 O(1) records became 432 KB. The rule needs both
   clauses — bound the record *and* bound the set — and #192 shipped only the second. Stated as O(1),
   the rule is satisfiable by the exact file that took the board down. §4.
2. **The archive's load-bearing half is the index, not the body.** The card treats "a card-scoped
   store we own" as one thing. Copying bodies eagerly duplicates a store we do not own (802 MB of
   codex rollouts alone) for files most cards never read; and a pointer + totals alone already fixes
   §1.1 and §1.3 at ~300 B per session. Tiered: index always, body at close with lazy backfill and
   hard caps. §5.3, §6.3.
3. **Neither of the card's two usage options works.** Incremental accumulation is impossible —
   `turn.ended` carries no counters, so "accumulate from the turn-end signal" is still a full parse
   per turn. Derive-on-read-and-cache leaves the first read at 648 ms and the answer still mortal. The
   answer is a third thing: derive on write, debounced, single-flight, mtime-guarded, off both paths.
   §6.1.
4. **`latestHookActivity` should not move to the archive.** It has four live per-render consumers, and
   it is a lossy summary of text the transcript already holds verbatim. Bounded hot, and *not*
   archived. §6.2.
5. **Capability-per-counter is necessary but insufficient.** The card stops at the record; the
   fabricated zero reappears the moment refusals are summed. Rollup counters must themselves be
   capability-valued, with `partial` on the rollup. §6.4.
6. **Generations should reuse `homeAgentSessionGeneration`, not add a parallel counter.** The card
   asks for a generation model without saying that the concept already exists for one kind. Cloning it
   for cards would be the near-duplicate Article 1 forbids. §7.

And one place I think the card understates its own case: it describes §1.1 as a past incident. It is a
**scheduled** loss with a closing window and a countable size — 118 conversations — which is what
makes the sequencing in §10 non-negotiable rather than tidy.

---

## 10. Card breakdown

One verifiable outcome each. Ordered; independence noted. Sized deliberately small — an oversized
card in this repo cost 879 k tokens once already.

| # | Card | Verifiable outcome | Depends on |
|---|---|---|---|
| 1 | **`feat: harvest and preserve every card's session pointer in a per-card ledger`** — `SessionLedgerManifest`/`Index`, layout, `openSession`/`listSessions`, plus the idempotent boot harvest of existing `sessions.json` records. | Against a fixture home built from the live 195-record file: 130 manifests written, re-running writes none; a dry-run reports 118 artifacts still present. | — (**urgent: must precede the next board restart on a build containing #192**) |
| 2 | **`refactor: make the hot session record structurally unable to hold narrative`** — `src/core/hot-state.ts`, re-declare summary + activity fields via `bounded()`, add the `satisfies` gate and the schema-reflection test, delete `boundLatestHookActivity`. | Adding `z.array(...)` or a bare `z.string()` to the summary fails `tsc`; the schema-generated worst-case record serialises ≤512 B. | independent of 1 |
| 3 | **`feat: record token usage as sessions run instead of re-parsing transcripts on read`** — the capture worker: reducer-effect subscription, debounce + single-flight, `(mtime, bytes)` guard, monotonic merge into the manifest. | A scripted 3-turn fake-driver session leaves correct totals in the manifest; an unchanged artifact records zero re-parses (assert the derive call count). | 1 |
| 4 | **`feat: report token counters a harness cannot measure as unsupported, not zero`** — `catalog.usageCounters`, `SessionUsageRecord` mapping, capability-aware summation, TCK assertions 7–8. | codex/gemini `cacheCreationTokens` reads `unsupported(reason)`; a mixed-harness 3-generation rollup is `partial` with the refusal reason; TCK 7 fails when a driver's declaration lies. | 1 (parallel with 3) |
| 5 | **`fix: a trashed card keeps its conversation and its token totals`** — `getTaskTranscript` / `getTaskTokenUsage` read the ledger; drop `mergeTaskTokenUsage`'s flicker guard. | A card moved to trash, then cold-loaded, still renders its transcript and its usage chip; usage response is served with zero artifact reads. | 1, 3 |
| 6 | **`feat: keep a card's conversation after its harness prunes the transcript`** — body capture at close, lazy backfill on first read, caps, eviction, truncation markers. | A sealed session whose artifact is then deleted still returns its messages; an over-cap body returns head+tail with `truncated: true`; eviction flips `body.captured` and the read refuses honestly. | 1 |
| 7 | **`refactor: one session-generation counter for cards and overseers`** — generalise `homeAgentSessionGeneration` → `sessionGeneration`; reconstruct overseer ledgers for generations 0..N by recomputed id. | An overseer with 3 past generations lists 3 sealed entries after migration; an old `sessions.json` carrying only the legacy field still parses and resumes. | 1 |

Independent: 1 and 2 (either order). 3 and 4 parallel after 1. 5 after 3. 6 and 7 after 1.
Suggested order: **1 → 2 → 3 ‖ 4 → 5 → 6 → 7**.

---

## 11. Risks, open questions, out of scope

### Risks

- **The harvest window closes.** Mitigation is scheduling, not code: land card 1 first, and until it
  lands, do not restart the live board on a build containing #192. Named in card 1's title for that
  reason.
- **One more store to keep consistent.** `board.json`, `sessions.json`, `archived-cards.json`, and now
  `sessions/`. Mitigated by making the ledger *derivable-keyed* (no cross-file pointers), manifests
  authoritative over the index, and every write append-or-replace-one-small-file under the existing
  workspace lock. The ledger is never read on the hot path, so it cannot cause a snapshot stall.
- **Debounced capture can miss the final turn** if the board dies between `turn.ended` and the derive.
  Bounded loss (one turn's counters), self-healing on the next open/backfill, and strictly better than
  today's zero durability. Worth stating rather than hiding.
- **Body capture writes bytes we did not author.** A conversation copy under `$CLINE_HOME` is a second
  place sensitive prompt text lives. It inherits the same filesystem permissions as `board.json`,
  which already holds card prompts — no new class of exposure, but a real one to name.

### Open questions

- **Does `readCardUsage` want a workspace-wide rollup sibling** (board-level burn)? K reads per card
  × N cards is fine at 40 cards; at 400 it wants a per-workspace totals file, which is exactly the
  shared-cost structure §5.1 refuses. Defer until asked; do not pre-build it.
- **Should `openSession` be synchronous with launch or fire-and-forget?** Synchronous costs a ~300 B
  write on the launch path but closes the crash window completely. Lean synchronous; measure at
  implement time.
- **`workspacePath` removal** (derivable, 14 KB) — a clean follow-up, deliberately not bundled.
- **Native `observe.usageRecord()`** returning capabilities directly, retiring the catalog-declaration
  indirection in §6.4. Correct eventually; changing a just-landed port member is not this card.

### Out of scope

- Implementing any of the above, including "small" refactors along the way.
- Cost in dollars and pricing tables. Price attaches to `SessionUsageRecord.model` + counters
  (§6.4); `per-card-token-usage.md` §7 already holds the table design.
- Changing the driver port's existing members.
- A UI for browsing archived conversations. The read API is designed for it; the surface is not.
- Cross-host / remote archives. Ledgers are host-local, like the artifacts they describe.
