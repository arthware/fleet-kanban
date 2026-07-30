# Agent catalog

**Importance:** high  ·  **Lives in:** `src/core/agent-catalog.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/agent-registry.ts`

The registry of supported coding agents and their launch configuration.

## Domain model
`RUNTIME_AGENT_CATALOG` lists entries (`id`, `binary`, `baseArgs`, `autonomousArgs`,
`supportsAgentModelOverride`) for the three supported active harnesses: `claude`, `codex`, and `gemini`. All other harnesses (such as `cursor`, `opencode`, `droid`, `kiro`, and `cline`) are retired and parsed only for backward compatibility, defaulting to `claude`. All supported harnesses run as PTY processes managed via their respective drivers.

## Reuse / do-not-duplicate
- Relates to [Task session](task-session.md), [Runtime modes](runtime-modes.md), [Agent driver](agent-driver.md).
- **Do not duplicate:** one catalog; add or change agent behavior via the driver port registry `DRIVERS`, not through scattered harness-specific branches.
