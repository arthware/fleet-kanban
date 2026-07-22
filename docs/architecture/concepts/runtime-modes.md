# Runtime modes

**Importance:** medium  ·  **Lives in:** `src/terminal/`, `src/cline-sdk/`, `docs/architecture.md` (§Runtime Modes)

The three execution modes the runtime supports: native Cline chat, CLI-backed task terminal, and
workspace shell terminal.

## Domain model
(1) Native Cline chat — task-scoped + a project-scoped sidebar surface, backed by the SDK session
host. (2) CLI-backed task terminal — task-scoped PTY process for claude/codex/gemini/etc. (3)
Workspace shell terminal — workspace-scoped PTY for manual repo commands, not task execution. Cline is
a native runtime path, not "just another agent command".

## Reuse / do-not-duplicate
- Relates to [Task session](task-session.md), [Agent catalog](agent-catalog.md),
  [Home / architect agent session](home-agent-session.md).
- **Do not duplicate:** don't collapse the workspace shell terminal into the task-session path.
