# Runtime modes

**Importance:** medium  ·  **Lives in:** `src/terminal/`, `docs/architecture.md` (§Runtime Modes)

The two execution modes the runtime supports: CLI-backed task terminal and workspace shell terminal.

## Domain model
(1) CLI-backed task terminal — task-scoped PTY process for supported active harnesses (`claude`, `codex`, `gemini`), managed via their respective drivers. (2) Workspace shell terminal — workspace-scoped PTY for manual repository commands, not task execution.

## Reuse / do-not-duplicate
- Relates to [Task session](task-session.md), [Agent catalog](agent-catalog.md),
  [Home / architect agent session](home-agent-session.md).
- **Do not duplicate:** don't collapse the workspace shell terminal into the task-session path.
