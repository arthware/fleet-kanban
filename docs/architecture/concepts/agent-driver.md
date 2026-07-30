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

### Cross-Driver Code Layout and Shared Logic Placement

To avoid duplicating common logic while ensuring drivers remain robust, clear, and easy to maintain, cross-driver logic is strictly organized by the specific sub-port member it serves.

```
src/agents/
  driver.ts            the port + DRIVERS registry        (contract — stays at top level)
  session-signal.ts    the AgentFact vocabulary           (contract — stays at top level)
  shared/
    launch.ts          logic every driver's `launch` needs
    identity.ts        …identity
    observe.ts         …observe
    signals.ts         …signals
    control.ts         …control
  claude/  codex/  gemini/   one harness's implementation
```

#### Shared Logic Placement Rules:
1. **Cross-driver implementation lives in `src/agents/shared/<port-member>.ts`**, named for the port member it serves.
2. **The port definitions and vocabulary stay at the `src/agents/` top level.**
3. **One harness's code stays in `src/agents/<harness>/`.**
4. **Drivers delegate to shared helpers; they never inherit them.**

#### Key Architectural Reasons:
- **The home is derivable, not chosen.** The port has exactly five members and that is already the organizing axis of the tree — `AgentDriver` is `launch|identity|observe|signals|control`, and the tests are per-member too (`test/agents/launch.test.ts`, `identity.test.ts`). "Which file?" is computed from "which member does this serve?", so there is no judgment call to get wrong.
- **Delegation, never inheritance.** A base driver or `createDefaultDriver()` that harnesses spread and override was considered and **rejected on principle**: it makes the port non-total by construction, so a driver can silently inherit a default that is wrong for its harness. That is precisely the bug class this epic removed — a rule written for one harness/kind, silently wrong for the other. Duplicating a *call-site* invocation of a shared function is fine; duplicating or inheriting *logic* is not.
