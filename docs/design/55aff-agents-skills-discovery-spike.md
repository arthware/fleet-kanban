# Spike: `.agents/skills/` native discovery for board-launched agents

Date: 2026-07-14

## Verdict

Codex: PASS.

- L1 native Codex discovery from cwd passed with `codex-cli 0.142.5`.
- Test cwd: `/tmp/codex-skills-canary.NF3f87`.
- Test skill: `/tmp/codex-skills-canary.NF3f87/.agents/skills/canary/SKILL.md`.
- Prompt used for implicit activation: `Please use the canary sentinel now.`
- The prompt did not contain the hidden body token.
- Output contained `SKILL-CANARY-7Q2X`.
- Codex output also showed it loaded the skill body from `$CWD/.agents/skills/canary/SKILL.md`.
- Explicit `$canary` also emitted `SKILL-CANARY-7Q2X`.
- `/skills` listed `canary`.

Board-launched Codex: PASS by L1 plus L2 code inspection.

- Kanban resolves a normal task cwd to the per-card worktree root.
- Kanban passes that cwd unchanged into the Codex PTY launch.
- Therefore a committed `.agents/skills/` directory at the task worktree root is in Codex's native `$CWD/.agents/skills` scan path.
- L3 board e2e was not run because L1 and L2 answered the Codex question without ambiguity.

Cline-native: PARTIAL.

- I did not run a live native Cline canary turn.
- Code inspection confirms Kanban passes the same task worktree cwd into the native Cline SDK path.
- Code inspection also confirms Kanban creates the Cline SDK user-instruction service with `skills: { workspacePath }`.
- That is strong evidence that board-launched Cline is rooted at the task worktree for SDK skill discovery, but this spike does not prove semantic activation or the exact `.agents/skills/` search behavior for Cline at runtime.

## L1 Evidence: Codex native discovery

The canary skill body instructed the agent to output only `SKILL-CANARY-7Q2X`. The trigger prompt intentionally omitted that token.

Commands run:

```sh
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  --cd /tmp/codex-skills-canary.NF3f87 \
  'Please use the canary sentinel now.'

codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  --cd /tmp/codex-skills-canary.NF3f87 \
  '$canary'

codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  --cd /tmp/codex-skills-canary.NF3f87 \
  '/skills'
```

Observed:

- Implicit activation output contained `SKILL-CANARY-7Q2X`.
- Explicit `$canary` output contained `SKILL-CANARY-7Q2X`.
- `/skills` listed `canary`.

## L2 Evidence: launch cwd

For task sessions, `runtime-api.ts` resolves `taskCwd` from the workspace path and task id:

```ts
taskCwd = await resolveExistingTaskCwdOrEnsure({
	cwd: workspaceScope.workspacePath,
	taskId: body.taskId,
	baseRef: body.baseRef,
});
```

`resolveExistingTaskCwdOrEnsure` first calls `resolveTaskCwd(..., ensure: false)` and falls back to `ensure: true`. `resolveTaskCwd` returns the task worktree path:

```ts
const worktreePath = getTaskWorktreePath(context.repoPath, options.taskId);
if (await pathExists(worktreePath)) {
	return worktreePath;
}
```

When the worktree must be created, `ensureTaskWorktreeIfDoesntExist` creates it at that path:

```ts
const addResult = await runGit(context.repoPath, ["worktree", "add", "--detach", worktreePath, baseCommit]);
```

For CLI-backed agents, including Codex, `runtime-api.ts` passes that task cwd into the terminal manager:

```ts
const summary = await terminalManager.startTaskSession({
	...
	cwd: taskCwd,
	prompt: body.prompt,
	...
});
```

`session-manager.ts` passes the same cwd into the adapter and the PTY spawn:

```ts
const launch = await prepareAgentLaunch({
	...
	cwd: request.cwd,
	prompt: request.prompt,
	...
});
```

```ts
session = PtySession.spawn({
	binary: commandBinary,
	args: commandArgs,
	cwd: request.cwd,
	env,
	cols,
	rows,
	...
});
```

The Codex adapter appends prompt/config args, hooks, model, and resume flags, but does not rewrite cwd.

For Cline-native, `runtime-api.ts` passes the same `taskCwd` to the native service:

```ts
const summary = await clineTaskSessionService.startTaskSession({
	taskId: body.taskId,
	cwd: taskCwd,
	prompt: body.prompt,
	...
});
```

The SDK boundary creates the user-instruction service with the workspace path as the skills root:

```ts
return createUserInstructionConfigService({
	skills: { workspacePath },
	rules: { workspacePath },
	workflows: { workspacePath },
});
```

The Cline session runtime starts the SDK session with the same cwd:

```ts
startResult = await sessionHost.start({
	config: {
		...
		cwd: request.cwd,
		mode: resolvedMode,
		...
	},
	...
});
```

## Recommendation for the implementation card

Native Codex discovery is sufficient for availability when `.agents/skills/` is present in the task worktree root. Board-launched Codex should see those skills without Kanban injecting the skill body into the prompt.

Do not rely on semantic matching alone for deterministic per-card behavior. The canary passed, but native progressive-disclosure activation is intentionally semantic and can miss or choose not to load a relevant skill. The implementation card should add an explicit pointer when a card is intended to use a specific skill, such as `$skill_name` or a one-line instruction naming the skill, while still letting Codex load the body natively from disk.

The implementation should not paste or duplicate the `SKILL.md` body into the task prompt. It should only ensure the skill file exists in the worktree and, when deterministic activation matters, point the agent at the skill by name.

## Gotchas for implementation

- The `.agents/skills/` directory must exist in the task worktree root. A skill only present in the source repo but missing from the created worktree will not be found through `$CWD/.agents/skills`.
- Codex may show or auto-confirm workspace trust prompts on PTY startup; Kanban already has Codex workspace-trust handling in `session-manager.ts`.
- The Codex adapter passes the card prompt as a CLI argument for non-plan starts. If the implementation adds a deterministic pointer, it should be part of the prompt text and should not require changing cwd handling.
- Cline-native needs a live canary run before claiming full PASS. The code path is cwd-correct, but this spike did not prove Cline's runtime semantic activation from `.agents/skills/`.
