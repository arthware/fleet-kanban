# tRPC contract & runtime-api chokepoint

**Importance:** high  ·  **Lives in:** `src/core/api-contract.ts`, `src/trpc/app-router.ts`, `src/trpc/runtime-api.ts`

The single typed contract plus the coordinator that routes every browser↔runtime request.

## Domain model
`api-contract.ts` is the Zod spine — every request/response and streamed message; the router validates
against it and web-ui imports its inferred types. `app-router.ts` exposes
`runtime`/`workspace`/`projects`/`hooks`; `runtime-api.ts` is the front door that routes/validates
then delegates (never a god file). Schema changes ripple everywhere and into on-disk state →
additive/optional only.

## Reuse / do-not-duplicate
- Relates to [Runtime state fanout](runtime-state-fanout.md), [Task card](task-card.md).
- **Do not duplicate:** don't accumulate deep session logic in `runtime-api.ts`; hand off downward.
