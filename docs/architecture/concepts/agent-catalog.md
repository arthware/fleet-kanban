# Agent catalog

**Importance:** high  ·  **Lives in:** `src/core/agent-catalog.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/agent-registry.ts`

The registry of supported coding agents and their launch config, split between native Cline and
command-driven CLIs.

## Domain model
`RUNTIME_AGENT_CATALOG` lists entries (`id`, `binary`, `baseArgs`, `autonomousArgs`,
`supportsAgentModelOverride`) for claude, codex, cursor, cline, opencode, droid, kiro, gemini; a
launch-supported subset gates what actually runs. Cline is the one native-SDK entry; all others are
PTY CLIs with per-agent `prepare()` adapters. Prefer capability-oriented reasoning over
`agentId === "cline"` branching.

## Reuse / do-not-duplicate
- Relates to [Task session](task-session.md), [Runtime modes](runtime-modes.md),
  [Cline SDK boundary](cline-sdk-boundary.md).
- **Do not duplicate:** one catalog; add agents via `ADAPTERS`, not scattered special-cases.
