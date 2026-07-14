# Per-card token usage on the board card

**Status:** design (plan card — no code)
**Author:** design pass, 2026-07-11
**Prior art:** `9680766` — *feat(web-ui): show card id and per-card agent model on board cards*
(the token chip lands on the **same** surface and threads through the same layers).

---

## 1. Problem & symptom

An operator dispatching cards across a fleet has no per-card sense of how much an agent has
*burned*. A card running Opus on a research-grade prompt and a card running Haiku on a mechanical
edit look identical on the board. This is the "watch it burn" gap named in
`docs/design/architect-console.md` §10 (Cost analysis — *"cannot even watch it burn (gap 3)"*) and the
per-card token-counter wish behind the same doc's cost levers.

The card already surfaces the **per-card agent model** as a small chip next to the title
(commit `9680766`). Token usage is the natural companion: same surface, same operator question
("what is this card costing me?").

**Desired outcome:** a compact, muted chip on each board card — e.g. `1.2M tok` (and, once cost lands,
`· $3.40`) — sitting beside the existing agent/model chip, derived on read from the agent's own
transcript, backward-compatible, and absent (not zero) when there's nothing to show.

---

## 2. Core constraint — derive, don't re-track

This is the project's central rule (AGENTS.md "thin wrapper / derive state"): the board **observes**
agent artifacts, it never re-streams or re-persists them. Usage MUST be derived from each agent's own
on-disk session output, exactly like `src/terminal/agent-transcript-reader.ts` already derives the
read-only conversation. No new kanban-owned usage store, no live token counter fed by a side channel.

The existing derive-on-read path is the template. `src/trpc/runtime-api.ts` → `getTaskTranscript`
already does the whole dance we need:

```ts
const summary = terminalManager.getSummary(body.taskId);          // agentId + agentSessionId
if (!summary?.agentId || !summary.agentSessionId) return { present: false, ... };
const transcript = await readAgentTranscript({
  agentId: summary.agentId,
  sessionId: summary.agentSessionId,
  homePath: homedir(),
});
```

Usage extraction reuses this exact locate-then-parse pipeline (`locateAgentTranscript` +
JSONL parse), just accumulating `usage` records instead of rendering messages.

---

## 3. The normalized usage shape

One shape every agent reader maps into. It is deliberately identical to the Cline SDK's
`SessionAccumulatedUsage` (`node_modules/@clinebot/core/dist/runtime/host/runtime-host.d.ts:74`) so the
Cline path is a pass-through and the field names come from an SDK source of truth rather than a local
invention:

```ts
// src/core/api-contract.ts (new schema, additive)
export const runtimeTaskTokenUsageSchema = z.object({
  inputTokens: z.number(),          // uncached prompt tokens
  outputTokens: z.number(),         // generated tokens (incl. reasoning)
  cacheReadTokens: z.number(),      // prompt-cache hits
  cacheCreationTokens: z.number(),  // prompt-cache writes
  costUsd: z.number().nullable(),   // null until pricing is known for the model (see §7)
});
export type RuntimeTaskTokenUsage = z.infer<typeof runtimeTaskTokenUsageSchema>;
```

Notes:
- `cacheCreationTokens` maps to Cline's `cacheWriteTokens` (only field rename; same meaning).
- `costUsd` is `null` when the model isn't in the price table — the UI renders tokens only, never a
  wrong dollar figure. Deferred entirely in card 1 (always `null`), populated in card 4.
- Totals only — no per-turn breakdown. The chip needs one cumulative number per card.

---

## 4. Per-agent extraction (verified against real transcripts)

All three sources were inspected against live on-disk transcripts on 2026-07-11. Field names below are
verified, not assumed.

### 4.1 Claude Code (`claude`) — **ships first, it's the default**

Each `type:"assistant"` record carries `message.usage`. Verified shape from a real transcript
(`~/.claude/projects/<slug>/<sessionId>.jsonl`):

```json
{ "type": "assistant",
  "requestId": "req_011C…", "message": {
    "id": "msg_011C…", "model": "claude-opus-4-8",
    "usage": { "input_tokens": 5624, "output_tokens": 430,
               "cache_creation_input_tokens": 31901, "cache_read_input_tokens": 0 } } }
```

Mapping: `input_tokens → inputTokens`, `output_tokens → outputTokens`,
`cache_creation_input_tokens → cacheCreationTokens`, `cache_read_input_tokens → cacheReadTokens`.
(For Claude, `input_tokens` already excludes cache tokens — they're reported separately — so we sum the
four fields independently, no subtraction.)

**Aggregation = sum across every assistant record**, because each record's `usage` describes its own
API request and the numbers do not accumulate across requests.

**Dedup is required.** Claude Code can write the same assistant message more than once (streaming
retries, resumed sessions). Key each contribution by `message.id` + `requestId` and count it once —
this is the same dedup ccusage applies. Both fields are present on the verified record. Skip records
where either the record is `isSidechain`/`isMeta` (subagent/meta bookkeeping — already filtered by the
message parser) or `message.usage` is absent.

`message.model` is captured per record — it is the price-table key for §7 (a session can't switch model
mid-run today, but reading it per-record is free and future-proof).

### 4.2 Codex (`codex`) — follow-up

Codex rollout JSONL emits `type:"event_msg"` records with `payload.type:"token_count"`. Verified shape:

```json
{ "type": "event_msg", "payload": { "type": "token_count", "info": {
    "total_token_usage": { "input_tokens": 17248, "cached_input_tokens": 4992,
                           "output_tokens": 322, "reasoning_output_tokens": 20,
                           "total_tokens": 17570 } } } }
```

**Aggregation = take the LAST `token_count` record**, because `info.total_token_usage` is already
**cumulative** for the session — summing would multiply-count.

Mapping (mind the difference from Claude): Codex `input_tokens` **includes** `cached_input_tokens`, so
`inputTokens = input_tokens − cached_input_tokens`, `cacheReadTokens = cached_input_tokens`,
`outputTokens = output_tokens` (which already includes `reasoning_output_tokens`),
`cacheCreationTokens = 0` (OpenAI-style caching has no separately-billed cache-write). Older rollout
files predate `token_count` and yield no usage → return absent, same total-signal contract as the
transcript reader.

### 4.3 Cline (`cline`) — follow-up

No transcript-file parsing. The Cline SDK exposes usage directly:
`ClineCore.getAccumulatedUsage(sessionId)` → `SessionAccumulatedUsage`
(`{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCost }`). Map straight through
(`cacheWriteTokens → cacheCreationTokens`), and — bonus — Cline gives us `totalCost` for free, so the
Cline path can populate `costUsd` without the price table. Inspect `src/cline-sdk/cline-event-adapter.ts`
and the SDK boundary for exactly where a live `ClineCore` handle is reachable from the runtime; if the
handle isn't available on a read path, defer Cline to when it is (usage is still derived, never tracked).

---

## 5. Where the extraction lives

New module `src/terminal/agent-usage-reader.ts`, sibling to `agent-transcript-reader.ts`, sharing
`agent-transcript-locator.ts` and the JSONL parse helper. Keeping it separate from the message reader
means the transcript-tail path (`src/commands/task-transcript-tail.ts`) isn't burdened with a usage pass
it doesn't need, and vice-versa.

```ts
export interface ReadAgentUsageInput {           // mirrors ReadAgentTranscriptInput
  readonly agentId: RuntimeAgentId | string;
  readonly sessionId: string;
  readonly homePath: string;
}
export interface AgentUsageResult {
  readonly present: boolean;                      // true iff a transcript was located & read
  readonly usage: RuntimeTaskTokenUsage | null;   // null when present but no usage records
}
export async function readAgentUsage(input: ReadAgentUsageInput): Promise<AgentUsageResult>;
```

Same totality contract as `readAgentTranscript`: any I/O error collapses to `{ present: false, usage: null }`.
Pure functions `deriveClaudeUsage(records)` / `deriveCodexUsage(records)` do the accumulation and are the
unit-test surface.

---

## 6. API surface

**Decision: a dedicated `runtime.getTaskTokenUsage` derive endpoint, batched, backward-compatible —
NOT an extension of the streamed session summary.**

Why not the summary: `runtimeTaskSessionSummarySchema` is emitted cheaply and frequently from
`terminalManager` state with no file I/O. Computing usage means reading (potentially large) transcript
files; folding that into every summary emit would put a file read on a hot streaming path for every card
on every tick. That violates the "cheap summary" design and scales badly on a full board.

Instead, a sibling of `getTaskTranscript`, batched so one round-trip covers all visible cards:

```ts
// api-contract.ts
runtime.getTaskTokenUsage: (input: { taskIds: string[] })
  => { usages: Record<string, RuntimeTaskTokenUsage | null> }   // null = unknown/absent per card
```

Server handler mirrors `getTaskTranscript`: for each id, `terminalManager.getSummary(id)` → if it has
`agentId` + `agentSessionId`, `readAgentUsage({ agentId, sessionId: agentSessionId, homePath: homedir() })`;
map to the normalized shape or `null`. Additive endpoint, additive schema — a client that never calls it
is unaffected, and an old board.json/sessions.json still parses.

**Client fetch** (`web-ui/src/hooks/`): a small `use-task-token-usage` hook (a sibling to the existing
`fetchTaskTranscript` in `use-task-sessions.ts`) that batches the currently-rendered card ids and polls
on a slow cadence — derive-on-read is cheap per file but not free, so poll ~every few seconds **while a
card's session is active** and once when it goes idle; cache the last value so the chip doesn't flicker
to empty between polls. Prefer a `react-use` interval hook per the web-ui conventions.

### Cost / perf note (must be documented, per constraints)

Reading N transcript files per poll is the cost. Mitigations, in order: (1) only fetch for cards that
have an `agentSessionId`; (2) batch all visible ids into one request; (3) slow cadence + last-value
cache; (4) the reader is already tolerant/total, so a missing file is a cheap `{present:false}`, not a
throw. A future optimization (out of scope) is an mtime/size guard so an unchanged transcript skips the
re-parse — but derive-on-read stays the contract.

---

## 7. Cost decision

**Ship tokens first (card 1–2 render tokens only, `costUsd` always `null`); add cost as card 4.**
Tokens alone already close the "watch it burn" gap and carry zero pricing-staleness risk.

When cost lands, a small **static price table keyed by model id**, updatable in one file, priced per
million tokens. Values below are the authoritative Claude prices from the `claude-api` skill
(cached 2026-06-24); cache write/read derive from the caching multipliers (write 5m = 1.25×, write 1h =
2×, read = 0.1× of base input):

| model id (`message.model`) | input $/MTok | output $/MTok | cache-write 5m | cache-read |
|---|---|---|---|---|
| `claude-opus-4-8` | 5.00 | 25.00 | 6.25 | 0.50 |
| `claude-sonnet-5` | 3.00¹ | 15.00¹ | 3.75 | 0.30 |
| `claude-haiku-4-5` | 1.00 | 5.00 | 1.25 | 0.10 |

¹ Sonnet 5 has an intro price ($2/$10) through 2026-08-31 — the table notes it but defaults to the
standard rate; pricing precision is best-effort, not billing-grade.

Cost formula (cache priced separately — **do not** lump cache tokens into input):

```
costUsd = inputTokens/1e6 * inputPrice
        + outputTokens/1e6 * outputPrice
        + cacheCreationTokens/1e6 * cacheWritePrice   // 5m TTL rate; Claude Code's default
        + cacheReadTokens/1e6 * cacheReadPrice
```

Rules: unknown model id → `costUsd = null` (render tokens only, never a wrong number). Codex/other-provider
models aren't in this table → `null` for now (their pricing is a later table extension). Cline supplies
`totalCost` directly, bypassing the table. Cache tokens are **accounted for**, not deferred — they're
often the dominant line for a long Claude session and ignoring them would understate cost badly.

Keep the table beside the model catalog (`src/core/agent-catalog.ts` neighborhood) so price and model
metadata live together and updates are one obvious edit.

---

## 8. UI placement

> **Revised 2026-07-11 — headline is real work, not the 4-lane grand total.** The chip headline
> now shows `realWorkTokenCount = inputTokens + outputTokens` (new conversational work), **not** the
> `input + output + cacheRead + cacheCreation` sum this section originally specified. On a real long
> Claude session the cache-read lane (context re-read every turn, billed at 0.1×) dominates the raw
> total by ~100× — a measured transcript had 84.0M cache-read + 3.2M cache-write against just 74K
> input + 608K output, i.e. an 87.9M grand total vs 682K of actual work — so summing all four lanes
> overstated a card's weight ~130×. The grand total moves to the chip **tooltip** (`… · 87.9M total ·
> $X.XX est.`) so the headline↔total gap stays self-explaining vs ccusage-style tools that show the
> sum. Cost is unchanged: it still prices each lane separately (cache-read at 0.1×) per §7.

On `web-ui/src/components/board-card.tsx`, beside the existing agent/model chip. Commit `9680766`
built `taskAgentSettingsLabel` by joining `[agentOverrideLabel, modelOverrideLabel, agentModelLabel]`
with `·`. The usage chip is a **separate, adjacent element** (not another join segment) so it can carry
its own muted styling and its own unknown/zero behavior.

- **Format:** compact tokens — `1.2M tok`, `847K tok`, `2.3K tok` (use a small humanize helper; a
  `react-use`/existing util if one exists, else a tiny formatter). With cost: append `· $3.40`
  (2 decimals; sub-cent shows `<$0.01`).
- **What counts as "tokens":** display the **sum** `inputTokens + outputTokens + cacheReadTokens +
  cacheCreationTokens` (total processed), which is what "burn" means to an operator. (The breakdown is
  available in a tooltip if we want it — nice-to-have, not required.)
- **Dark-theme tokens:** `text-text-tertiary` monospace at `text-[10px]`, matching the card-id label
  from `9680766` (`font-mono text-[10px] text-text-tertiary`). A `Tooltip` (from `@/components/ui/tooltip`)
  can show the input/output/cache split.
- **Unknown / zero:** if usage is `null` or all-zero, **render nothing** (no `0 tok`) — the chip only
  appears once there's something to show, so a fresh card stays clean.

### fleet-CLI surfacing (follow-up, out of scope here)

A later card can add the same normalized usage to `fleet task ls` / `fleet task cat` (they already read
board state). Noted so the shape is CLI-friendly (plain numbers), not built here.

---

## 9. Serial implementation breakdown

Each card is small and independently shippable via its own PR.

1. **`feat: derive per-card Claude token usage + normalized shape + API`** — add
   `runtimeTaskTokenUsageSchema`; `src/terminal/agent-usage-reader.ts` with `deriveClaudeUsage`
   (dedup by `message.id`+`requestId`, sum-across-records); `runtime.getTaskTokenUsage` batched
   endpoint mirroring `getTaskTranscript`. Claude only. `costUsd` always `null`. No UI.
2. **`feat(web-ui): show a per-card token-usage chip on board cards`** —
   `use-task-token-usage` hook (batched, slow-poll, last-value cache) + the chip on `board-card.tsx`
   beside the model label. Renders nothing when unknown/zero. Tokens only.
3. **`feat: derive token usage for codex and cline agents`** — `deriveCodexUsage` (last cumulative
   `token_count`, subtract cached from input) and the Cline `getAccumulatedUsage` pass-through
   (also fills `costUsd` from `totalCost`). Chip lights up for those agents with no UI change.
4. **`feat: estimate per-card cost from a static Claude price table`** — price table keyed by model id,
   cost formula with cache tokens priced separately; populate `costUsd`; append `· $X.XX` in the chip.

(Optional 5: fleet-CLI `task ls|cat` usage column — separate follow-up.)

---

## 10. Test strategy (for `/fleet-implement`, RED-first)

**Unit (the derive functions — the core risk):**
- `agent-usage-reader.test.ts` — `deriveClaudeUsage`:
  - sums `usage` across multiple assistant records;
  - **dedups** two records sharing `message.id`+`requestId` (counts once);
  - ignores records without `message.usage` and sidechain/meta records;
  - maps all four Claude fields to the right normalized fields;
  - empty/absent transcript → `{ present:false, usage:null }`.
- `deriveCodexUsage`: takes the **last** `token_count` (not a sum); `inputTokens = input − cached`;
  `outputTokens` includes reasoning; `cacheCreationTokens = 0`; pre-`token_count` file → absent.
- Cost table (card 4): known model prices each category correctly incl. cache; unknown model → `null`;
  a zero-usage card → `costUsd` 0 or `null` per the render-nothing rule.
- Reuse a real captured transcript fixture (small, checked-in) so field names can't silently drift.

**API:** `getTaskTokenUsage` returns `null` for a card with no `agentSessionId`; returns the normalized
shape for a card with a resolvable session; batched call returns one entry per requested id.

**BDD / surface (board-card):** mirror `board-card.test.tsx` from `9680766` — a card with usage renders
the chip with the humanized total; a card with `null`/zero usage renders **no** chip; the chip sits
next to the model label. Format helper: `1_200_000 → "1.2M tok"`, `2_345 → "2.3K tok"`.

---

## 11. Risks, open questions, out of scope

- **Poll cost on a big board.** N file reads per tick. Mitigated by §6 (session-gated fetch, batch,
  slow cadence, last-value cache, total reader). Open follow-up: mtime/size skip-reparse guard.
- **Claude dedup fidelity.** `message.id`+`requestId` matches ccusage's approach and both fields are
  present on the verified record; if a future Claude Code version drops `requestId`, fall back to
  `message.id` alone. Fixture test guards the field names.
- **Cost is an estimate, not a bill.** Static table drifts; Sonnet intro pricing expires 2026-08-31;
  provider models beyond Claude are unpriced. `costUsd = null` whenever unsure — never show a wrong
  number. This is acceptable for a "watch it burn" glance.
- **Cline handle availability.** Whether a live `ClineCore` is reachable on a read path decides whether
  Cline lands in card 3 or later; either way usage stays derived, never tracked.
- **Out of scope:** live-streaming token counter (we derive-on-read by design); historical/aggregate
  cost analytics across cards; the fleet-CLI column; per-turn usage breakdown UI beyond a tooltip.
