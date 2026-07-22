# Architect workspace classification & context preamble

**Importance:** medium  ·  **Lives in:** `src/server/architect-workspace.ts`, `src/server/fleet-cli.ts`, `src/prompts/append-system-prompt.ts`

The rule that picks which opened repo acts as the architect/home workspace and the context it injects
into that agent's prompt.

## Domain model
`classifyArchitectWorkspace` resolves containment (outermost container wins) so nested repos map to
one architect. `buildArchitectContextPreamble` + `renderAppendSystemPrompt` assemble the home agent's
system prompt, including `fleet help --agent` output shelled via `runFleetAgentHelp`.

## Reuse / do-not-duplicate
- Relates to [Home / architect agent session](home-agent-session.md), [Workspace](workspace.md),
  [Skill injection & directives](skill-injection.md).
- **Do not duplicate:** architect detection/containment lives in `classifyArchitectWorkspace` only.
