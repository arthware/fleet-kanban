import { join } from "node:path";

import type {
	RuntimeAgentId,
	RuntimeHookEvent,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { quoteShellArg } from "../core/shell";
import { lockedFileSystem } from "../fs/locked-file-system";
import { resolveHomeAgentAppendSystemPrompt } from "../prompts/append-system-prompt";
import { getRuntimeHomePath } from "../state/workspace-state";
import { runGit } from "../workspace/git-utils";
import { parseGithubRemoteNameWithOwner } from "../workspace/repo-name";
import { isClaudeCloudProviderBackend, resolveClaudePermissionStrategy } from "./claude-permission-strategy";
import { configureCodexHooks, hasCodexConfigOverride } from "./codex-hook-config";
import { createHookRuntimeEnv } from "./hook-runtime-context";
import { stripAnsi } from "./output-utils";
import type { SessionTransitionEvent } from "./session-state-machine";
import { prepareTaskPromptWithImages } from "./task-image-prompt";

export interface AgentAdapterLaunchInput {
	taskId: string;
	agentId: RuntimeAgentId;
	binary?: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	// Per-card model override for the CLI-agent launch path. When set (and the
	// user hasn't passed their own --model), the adapter launches the agent CLI
	// with `--model <agentModel>` so mechanical cards can run a cheaper model.
	agentModel?: string;
	images?: RuntimeTaskImage[];
	resumeFromTrash?: boolean;
	// The agent CLI's own session id. On a fresh start Claude launches under it
	// (`--session-id`); on a resume it identifies which session to reopen.
	agentSessionId?: string | null;
	// True when this launch resumes an existing agent session by id rather than
	// starting a fresh one.
	resumeSession?: boolean;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	/** Architect awareness appended to the home-agent system prompt; empty/omitted for non-architect workspaces. */
	architectContextPreamble?: string;
}

export type AgentOutputTransitionDetector = (
	data: string,
	summary: RuntimeTaskSessionSummary,
) => SessionTransitionEvent | null;

export type AgentOutputTransitionInspectionPredicate = (summary: RuntimeTaskSessionSummary) => boolean;

export interface PreparedAgentLaunch {
	binary?: string;
	args: string[];
	env: Record<string, string | undefined>;
	cleanup?: () => Promise<void>;
	deferredStartupInput?: string;
	detectOutputTransition?: AgentOutputTransitionDetector;
	shouldInspectOutputForTransition?: AgentOutputTransitionInspectionPredicate;
}

interface HookContext {
	taskId: string;
	workspaceId: string;
}

interface HookCommandMetadata {
	source?: string;
	activityText?: string;
	hookEventName?: string;
	notificationType?: string;
}

interface AgentSessionAdapter {
	prepare(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch>;
	submitEnterDelayMs?: number;
}

function resolveHookContext(input: AgentAdapterLaunchInput): HookContext | null {
	const workspaceId = input.workspaceId?.trim();
	if (!workspaceId) {
		return null;
	}
	return {
		taskId: input.taskId,
		workspaceId,
	};
}

function buildHookCommand(event: RuntimeHookEvent, metadata?: HookCommandMetadata): string {
	const parts = buildHooksCommandParts(["ingest", "--event", event]);
	if (metadata?.source) {
		parts.push("--source", metadata.source);
	}
	if (metadata?.activityText) {
		parts.push("--activity-text", metadata.activityText);
	}
	if (metadata?.hookEventName) {
		parts.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata?.notificationType) {
		parts.push("--notification-type", metadata.notificationType);
	}
	return parts.map(quoteShellArg).join(" ");
}

function buildHooksCommandParts(args: string[]): string[] {
	return buildKanbanCommandParts(["hooks", ...args]);
}

function buildHooksCommand(args: string[]): string {
	return buildHooksCommandParts(args).map(quoteShellArg).join(" ");
}

function hasCliOption(args: string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

/**
 * Push the card's per-card model as `--model <id>` — but only when the user
 * hasn't already passed their own `--model`/`-m`, so an explicit arg always wins.
 * Used by the claude and codex adapters (both take a `--model` flag).
 */
function applyAgentModel(args: string[], agentModel: string | undefined): void {
	const model = agentModel?.trim();
	if (model && !hasCliOption(args, "--model") && !hasCliOption(args, "-m")) {
		args.push("--model", model);
	}
}

function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
}

async function ensureTextFile(filePath: string, content: string, executable = false): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(filePath, content, {
		executable,
	});
}

function withPrompt(args: string[], prompt: string, mode: "append" | "flag", flag?: string): PreparedAgentLaunch {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return {
			args,
			env: {},
		};
	}
	if (mode === "flag" && flag) {
		args.push(flag, trimmed);
	} else {
		args.push(trimmed);
	}
	return {
		args,
		env: {},
	};
}

/**
 * Wrap text in bracketed-paste markers so an interactive agent CLI buffers it as
 * a single paste instead of interleaving it into whatever it is generating. When
 * `submit` is true (the default) a trailing carriage return submits the pasted
 * text; `submit: false` stages it in the prompt without sending — used by
 * `fleet task say --no-submit` to compose multi-line steering before submitting.
 */
export function toBracketedPaste(command: string): string {
	return `\u001b[200~${command}\u001b[201~`;
}

/**
 * Delay between writing a bracketed paste and writing the submit Enter. It lets the
 * paste flush and be processed by the agent TUI (paste mode closed) so the Enter
 * arrives in a distinct PTY read and registers as a submit keystroke rather than
 * being coalesced into the paste. Applies to every PTY agent (claude, codex, ...).
 */
export const SUBMIT_ENTER_DELAY_MS = 50;

/**
 * Gets the submit Enter delay for a given agent ID.
 */
export function getAgentSubmitEnterDelayMs(agentId: string | null | undefined): number {
	if (!agentId) {
		return SUBMIT_ENTER_DELAY_MS;
	}
	const adapter = ADAPTERS[agentId as RuntimeAgentId];
	return adapter?.submitEnterDelayMs ?? SUBMIT_ENTER_DELAY_MS;
}

const claudeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {
			FORCE_HYPERLINK: "1",
		};
		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId, {
			architectContextPreamble: input.architectContextPreamble,
		});
		if (input.autonomousModeEnabled) {
			// Auto mode is gated behind this env var on Bedrock/Vertex/Foundry; the Anthropic API ignores it.
			env.CLAUDE_CODE_ENABLE_AUTO_MODE = "1";
		}
		if (
			input.autonomousModeEnabled &&
			!hasCliOption(args, "--permission-mode") &&
			!hasCliOption(args, "--dangerously-skip-permissions")
		) {
			// Capability-tiered strategy: capable models (Opus/Sonnet) and cloud-provider
			// backends keep auto mode (auto mode is a reliable unattended bypass there);
			// weaker/unknown models on the Anthropic API get a real bypass so they don't
			// stall on bash/git prompts — always behind the destructive-command guard hook.
			const strategy = resolveClaudePermissionStrategy({
				agentModel: input.agentModel,
				cloudProviderBackend: isClaudeCloudProviderBackend(),
			});
			if (strategy === "bypass-guarded") {
				args.push("--dangerously-skip-permissions");
			} else {
				args.push("--permission-mode", "auto");
			}
		}
		const claudeSessionId = input.agentSessionId?.trim();
		const claudeHasResumeFlag = hasCliOption(args, "--resume") || hasCliOption(args, "--continue");
		if (input.resumeSession && claudeSessionId && !claudeHasResumeFlag) {
			// Resume the exact prior session by id instead of Claude's cwd/recency guess.
			args.push("--resume", claudeSessionId);
		} else if (
			!input.resumeSession &&
			claudeSessionId &&
			!claudeHasResumeFlag &&
			!hasCliOption(args, "--session-id")
		) {
			// Fresh start under a known id so the session can be resumed later.
			args.push("--session-id", claudeSessionId);
		} else if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}
		applyAgentModel(args, input.agentModel);

		// The Bash-guard runs whenever this launch bypasses native permission checks
		// (skip-permissions). It's a PreToolUse hook because hooks still run — and can
		// still block — under `--dangerously-skip-permissions`, unlike settings.json
		// permissions.deny prompts.
		const bashGuardEnabled =
			input.autonomousModeEnabled === true && hasCliOption(args, "--dangerously-skip-permissions");

		const hooks = resolveHookContext(input);
		if (hooks) {
			const settingsPath = join(getHookAgentDirectory("claude"), "settings.json");
			const preToolUseHooks = [
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
				},
				...(bashGuardEnabled
					? [
							{
								matcher: "Bash",
								hooks: [{ type: "command", command: buildHooksCommand(["guard", "--source", "claude"]) }],
							},
						]
					: []),
			];
			const hooksSettings = {
				hooks: {
					Stop: [{ hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }] }],
					SubagentStop: [
						{ hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }] },
					],
					PreToolUse: preToolUseHooks,
					PermissionRequest: [
						{
							matcher: "*",
							hooks: [
								{
									type: "command",
									command: buildHookCommand("to_review", {
										source: "claude",
										notificationType: "permission_prompt",
									}),
								},
							],
						},
					],
					PostToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					PostToolUseFailure: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					Notification: [
						{
							matcher: "permission_prompt",
							hooks: [
								{
									type: "command",
									command: buildHookCommand("to_review", {
										source: "claude",
										notificationType: "permission_prompt",
									}),
								},
							],
						},
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					UserPromptSubmit: [
						{
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
				},
			};
			await ensureTextFile(settingsPath, JSON.stringify(hooksSettings, null, 2));
			args.push("--settings", settingsPath);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

function codexPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	if (summary.state !== "awaiting_review") {
		return null;
	}
	if (summary.reviewReason !== "attention" && summary.reviewReason !== "hook") {
		return null;
	}
	const stripped = stripAnsi(data);
	if (/(?:^|\n)\s*›/.test(stripped)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectCodexOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

const codexAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const codexArgs = [...input.args];
		const env: Record<string, string | undefined> = {};
		const binary = input.binary;
		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId, {
			architectContextPreamble: input.architectContextPreamble,
		});

		if (!hasCodexConfigOverride(codexArgs, "check_for_update_on_startup")) {
			codexArgs.push("-c", "check_for_update_on_startup=false");
		}

		if (input.autonomousModeEnabled && !hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")) {
			codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
		}

		const codexSessionId = input.agentSessionId?.trim();
		if (input.resumeSession && codexSessionId) {
			// Resume the exact prior conversation by id instead of `resume --last`.
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			if (!codexArgs.includes(codexSessionId)) {
				codexArgs.push(codexSessionId);
			}
		} else if (input.resumeFromTrash) {
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			if (!hasCliOption(codexArgs, "--last")) {
				codexArgs.push("--last");
			}
		}

		if (appendedSystemPrompt && !hasCodexConfigOverride(codexArgs, "developer_instructions")) {
			codexArgs.push("-c", `developer_instructions=${JSON.stringify(appendedSystemPrompt)}`);
		}

		applyAgentModel(codexArgs, input.agentModel);

		const hooks = resolveHookContext(input);
		if (hooks) {
			configureCodexHooks(codexArgs);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const prompt = input.prompt;
		const trimmed = prompt.trim();
		if (trimmed) {
			codexArgs.push(trimmed);
		}

		if (hooks) {
			return {
				binary,
				args: codexArgs,
				env,
				detectOutputTransition: codexPromptDetector,
				shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
			};
		}

		return {
			binary,
			args: codexArgs,
			env,
			detectOutputTransition: codexPromptDetector,
			shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
		};
	},
};

const geminiAdapter: AgentSessionAdapter = {
	submitEnterDelayMs: 300,
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.autonomousModeEnabled && !hasCliOption(args, "--yolo")) {
			args.push("--yolo");
		}

		const geminiSessionId = input.agentSessionId?.trim();
		const hasResumeFlag = hasCliOption(args, "--resume") || hasCliOption(args, "-r");
		if (input.resumeSession && geminiSessionId && !hasResumeFlag) {
			args.push("--resume", geminiSessionId);
		} else if (input.resumeFromTrash && !hasResumeFlag) {
			args.push("--resume", "latest");
		}

		const configPath = join(getHookAgentDirectory("gemini"), "settings.json");
		const hooks = resolveHookContext(input);
		const config: { security: { folderTrust: { enabled: boolean } }; hooks?: Record<string, unknown> } = {
			// Board worktrees are already trusted by the harness; disabling this here
			// prevents the "Do you trust the files in this folder?" gate from hanging
			// every fresh Gemini session (--yolo only covers tool-call approval, not this).
			security: {
				folderTrust: {
					enabled: false,
				},
			},
		};

		if (hooks) {
			const geminiHookCommand = buildHooksCommand(["gemini-hook"]);
			config.hooks = {
				BeforeTool: [
					{
						hooks: [{ type: "command", command: geminiHookCommand }],
					},
				],
				AfterTool: [
					{
						hooks: [{ type: "command", command: geminiHookCommand }],
					},
				],
				AfterAgent: [
					{
						hooks: [{ type: "command", command: geminiHookCommand }],
					},
				],
				BeforeAgent: [
					{
						hooks: [{ type: "command", command: geminiHookCommand }],
					},
				],
				Notification: [
					{
						hooks: [{ type: "command", command: geminiHookCommand }],
					},
				],
			};
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		await ensureTextFile(configPath, JSON.stringify(config, null, 2));
		env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = configPath;

		const trimmed = input.prompt.trim();
		if (trimmed) {
			args.push("-i", trimmed);
			return {
				args,
				env,
			};
		}

		return {
			args,
			env,
		};
	},
};

const ADAPTERS: Record<RuntimeAgentId, AgentSessionAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
	gemini: geminiAdapter,
};

const CARD_GH_REMOTE_TIMEOUT_MS = 5_000;

// gh goes interactive ("Where should we push the '<branch>' branch?") whenever it can't tell which
// repo a card's multi-remote worktree (origin = fork, upstream = the repo we track) targets, hanging
// the session's PTY forever. GH_REPO removes the ambiguity so gh never needs to ask; GH_PROMPT_DISABLED
// is the backstop that turns any other missing-info prompt into a visible, retryable error instead of
// a hang. Home-agent sidebar sessions aren't card worktrees and don't run `gh pr create`, so they're
// left untouched.
export async function resolveCardGhEnv(cwd: string): Promise<Record<string, string>> {
	const env: Record<string, string> = { GH_PROMPT_DISABLED: "1" };
	const origin = await runGit(cwd, ["remote", "get-url", "origin"], { timeoutMs: CARD_GH_REMOTE_TIMEOUT_MS });
	const nameWithOwner = origin.ok ? parseGithubRemoteNameWithOwner(origin.stdout) : null;
	if (nameWithOwner) {
		env.GH_REPO = nameWithOwner;
	}
	return env;
}

export async function prepareAgentLaunch(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> {
	const preparedPrompt = await prepareTaskPromptWithImages({
		prompt: input.prompt,
		images: input.images,
	});
	const launch = await ADAPTERS[input.agentId].prepare({
		...input,
		prompt: preparedPrompt,
	});
	if (isHomeAgentSessionId(input.taskId)) {
		return launch;
	}
	return {
		...launch,
		env: {
			...launch.env,
			...(await resolveCardGhEnv(input.cwd)),
		},
	};
}
