# PR 423 CLI Task Send Comparison

## Sources Read

- Local prior art:
  - `64bb716` — `task send-input` / `fleet task say` steering path.
  - `9a6f8aa` — `task tail` / `fleet task tail` observe path.
- Current local implementation:
  - `src/commands/task.ts`
  - `src/trpc/runtime-api.ts`
  - `src/core/api-contract.ts`
  - `src/terminal/agent-session-adapters.ts`
- Upstream comparison:
  - `gh pr view 423 --repo cline/kanban --json title,body,files`
  - `gh pr diff 423 --repo cline/kanban`

## Side-by-Side

| Area | Upstream PR #423 | Our fork |
| --- | --- | --- |
| Command surface | Adds `kanban task send --task-id <id> [--text <text>] [--project-path <path>] [--no-submit]`. | Has `kanban task send-input --task-id <id> --text <text> [--project-path <path>] [--no-submit]`; architect-facing wrapper is `fleet task say`. |
| Input source | `--text` is optional. If omitted, reads stdin when stdin is not a TTY. Rejects empty `--text`; trims one trailing newline from stdin. | `--text` is required at the Kanban command layer. Multi-line steering is supported via shell quoting or `--no-submit` staging, but not stdin fallback. |
| Submit semantics | First writes the text with `appendNewline:false`. For non-Cline sessions and default submit, sends a second `"\r"` write. For `--no-submit`, only writes text. For Cline, does not send the carriage return. | CLI sends one structured request with `bracketedPaste:true` and `submit`. Runtime sends Cline plain text. Runtime sends PTY text as bracketed paste with paste mode closed, then sends a separate `"\r"` write when `submit` is true. `--no-submit` stages without the separate submit. |
| How input reaches Cline | Calls existing `runtime.sendTaskSessionInput`; detects Cline from returned `summary.agentId === "cline"` and skips the second submit write. | `runtime.sendTaskSessionInput` first tries `ClineTaskSessionService.sendTaskSessionInput(taskId, plainText)`. If it returns a summary, the PTY path is skipped. |
| How input reaches PTY agents | Uses existing runtime input path as raw bytes: text first, optional carriage return second. No bracketed paste framing. | Uses existing runtime input path with explicit steering metadata: `bracketedPaste` and `submit`. PTY payload is bracketed paste, then optional separate carriage return. This prevents mid-generation interleaving and preserves clean staging. |
| Error behavior | Throws when runtime input fails; `runTaskCommand` prints JSON error and sets exit code. | Returns structured JSON with `ok:false`, `taskId`, error, and a resume hint: `task start --task-id <id>`. |
| Observe counterpart | PR #423 only adds send. | Send is paired with `task tail` / `fleet task tail`, which reads the running agent transcript before deciding whether to steer. |
| Tests | Adds CLI command tests around `task send`, stdin, Cline skip-submit, and empty text rejection. | Prior art includes runtime tests for bracketed paste, Cline plain-message routing, liveness guard, and transcript tail rendering. |

## Deltas

What upstream does that we do not:

- Allows stdin as the message source when `--text` is omitted.
- Rejects an explicitly empty `--text` with a targeted error.
- Uses the shorter command spelling `task send`.
- Has direct CLI-level tests for the command parser and stdout/error behavior.

What we do that upstream does not:

- Uses bracketed paste for PTY steering, so pasted steering text is buffered as one input instead of interleaving with an agent mid-turn.
- Carries submit intent through the API contract (`bracketedPaste`, `submit`) instead of inferring it in the CLI.
- Keeps Cline semantics inside the runtime boundary: Cline receives a discrete plain chat message and never sees terminal paste framing.
- Returns a resume hint when the target session is not live.
- Provides the observe half (`task tail` / `fleet task tail`) alongside the steering command.
- Uses the architect-facing verb `fleet task say`, which matches the intended product workflow better than a generic terminal-style `send`.

## Worth Adopting?

Recommendation: do not adopt upstream's runtime delivery semantics. Our current path is stronger: it already includes upstream's useful separate-submit behavior, but keeps bracketed paste framing for PTY agents and keeps Cline routing in the runtime where it belongs.

The only upstream pieces worth considering in a follow-up are CLI ergonomics:

- Add optional stdin fallback for `task send-input` / `fleet task say` so an architect can pipe a prepared multi-line message without shell-quoting it.
- Reject empty `--text` with a clearer error if we keep accepting only explicit text.
- Optionally add `task send` as a compatibility alias, but this is not important for the fleet workflow and may make the command surface less explicit.

No source change is required for parity with the core capability. Our fork already covers the send-input use case and has safer PTY behavior than PR #423.
