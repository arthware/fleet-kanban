# Task session

**Importance:** high  ·  **Lives in:** `src/terminal/session-manager.ts`, `src/terminal/agent-session-launch.ts`

The live runtime attached to a task card.

## Domain model
A task session represents a live process-oriented execution path. It runs as a PTY-backed process, managed and normalized via its corresponding [Agent driver](agent-driver.md). 
Keyed by task ID, a session is classified by lifecycles: `attached`, `resumable`, or `gone`. The browser is never the source of truth for session lifecycle.

Session identity, launching, and observation are driver-owned capabilities. Historical conversation transcripts and token metrics are captured durably off the hot path inside the [Session ledger](session-ledger.md), allowing past conversation history and execution stats to survive session teardown.

## Reuse / do-not-duplicate
- Relates to [Runtime summary](runtime-summary.md), [Worktree](worktree.md), [Agent catalog](agent-catalog.md), [Agent driver](agent-driver.md), [Session ledger](session-ledger.md).
- **Do not duplicate:** Do not scatter process launch, lifecycle management, or transcript location logic outside of `TerminalSessionManager` and the registered agent drivers.
