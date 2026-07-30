# Agent driver

**Importance:** high  ·  **Lives in:** `src/agents/driver.ts`, `src/agents/session-signal.ts`

The capability port for harness-specific agent behavior. A driver owns facts about one harness:
launch shape, session identity, observation, inbound signal normalization, and control.

## Domain model
`AgentDriver` is split into `launch`, `identity`, `observe`, `signals`, and `control` sub-ports. Every
member is total: unsupported behavior is returned as `unsupported(reason)` rather than represented by
an omitted method. `DRIVERS` is an exhaustive `Record<RuntimeAgentId, AgentDriver>` registry.

The `launch`, `identity`, and `observe` sub-ports are fully bound and implemented for all three active harnesses (`claude`, `codex`, `gemini`) in `src/agents/{claude,codex,gemini}/driver.ts`. The `signals` and `control` sub-ports are currently in progress of being bound by active developer cards.

`SessionSignal` carries normalized `AgentFact` values from a harness into runtime policy. Drivers emit
facts like `turn.ended` and `attention.required`; they never emit board verbs such as review,
columns, or lifecycle states.

## Reuse / do-not-duplicate
- Relates to [Agent catalog](agent-catalog.md), [Task session](task-session.md), [Runtime summary](runtime-summary.md).
- **Do not duplicate:** add or change harness-specific behavior through the driver port and its TCK,
  not through scattered `agentId` branches in runtime orchestration.
