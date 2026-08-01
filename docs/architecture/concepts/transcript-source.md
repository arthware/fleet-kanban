# Transcript source

**Importance:** high  ·  **Lives in:** `src/agents/shared/observe.ts`

The single owner of agent-transcript file access, and the home of the board's cost invariant: no
observation may do work proportional to a session's accumulated history.

## Domain model
Transcripts are append-only JSONL that grow for the life of a session and routinely reach tens of
megabytes. **Per-observation work must be proportional to the bytes appended since the last
observation, and to nothing else** — a whole-file re-read on a polled path saturates the event loop,
and the board stops serving HTTP while still holding its listening socket.

The *shape of the derivation* picks the access path, not the call site:

| Derivation | Path | Cost |
| --- | --- | --- |
| "latest value wins" (gemini/codex usage) | `selectFromTranscriptTail` — bounded backwards scan | O(1) in file size, even cold |
| cumulative sum (claude usage) | `foldTranscript` — byte-offset cursor + accumulator | history once per file, then O(appended) |
| the full conversation (opening a card) | `deriveFromTranscript` — full read, cached on file identity | on demand only, never on a poll |

A transcript is assumed to be appended to, never rewritten; rotation and truncation are detected via
inode, shrinking size, or an mtime change with no size change, and force a re-read rather than
resuming a stale cursor. A tail scan that finds no match within its budget returns `null`, and
callers keep their last known value rather than showing a wrong one.

`getTranscriptReadCost()` accounts every stat, read, byte, and parsed record. It exists so tests can
assert what an observation **cost**, not only what it returned — the driver TCK's
`givenAGrowingTranscriptWhenPolledForLivenessThenCostDoesNotGrowWithHistory` is the gate.

## Reuse / do-not-duplicate
- Relates to [Agent driver](agent-driver.md), [Task session](task-session.md),
  [Session ledger](session-ledger.md), [Runtime summary](runtime-summary.md).
- **Do not duplicate:** a driver MUST NOT read or parse a transcript path itself. Every driver once
  carried its own copy of the same whole-file `readFile` + `parseJsonlRecords` pattern, which is why
  the same freeze was fixed five times and returned with the next driver. Add a derivation here and
  express it as a tail query, a fold, or a full derivation — never a new file read.
