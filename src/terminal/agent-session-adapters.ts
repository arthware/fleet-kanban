import { join } from "node:path";
import { DRIVERS } from "../agents/driver";
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
import { getRuntimeHomePath } from "../state/workspace-state";
import { runGit } from "../workspace/git-utils";
import { parseGithubRemoteNameWithOwner } from "../workspace/repo-name";
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

export interface HookCommandMetadata {
	source?: string;
	activityText?: string;
	hookEventName?: string;
	notificationType?: string;
}

export function buildHookCommand(event: RuntimeHookEvent, metadata?: HookCommandMetadata): string {
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

export function buildHooksCommand(args: string[]): string {
	return buildHooksCommandParts(args).map(quoteShellArg).join(" ");
}

export function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
}

async function ensureTextFile(filePath: string, content: string, executable = false): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(filePath, content, {
		executable,
	});
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
	const driver = DRIVERS[input.agentId];
	if (!driver) {
		throw new Error(`Unsupported agent driver: ${input.agentId}`);
	}

	// 1. Preflight
	const preflightResult = await driver.launch.preflight();
	if (!preflightResult.supported) {
		throw new Error(`Launch preflight failed for agent ${input.agentId}: ${preflightResult.reason}`);
	}

	// 2. Prepare task prompt with images
	const preparedPrompt = await prepareTaskPromptWithImages({
		prompt: input.prompt,
		images: input.images,
	});

	// 3. Prepare the plan
	const prepareResult = await driver.launch.prepare({
		taskId: input.taskId,
		prompt: preparedPrompt,
		cwd: input.cwd,
		env: input.env ?? {},
		args: input.args,
		autonomousModeEnabled: input.autonomousModeEnabled ?? false,
		agentSessionId: input.agentSessionId ?? null,
		resumeSession: input.resumeSession ?? false,
		resumeFromTrash: input.resumeFromTrash ?? false,
		agentModel: input.agentModel ?? null,
		workspaceId: input.workspaceId ?? null,
		architectContextPreamble: input.architectContextPreamble ?? null,
		binary: input.binary,
	});

	if (!prepareResult.supported) {
		throw new Error(`Failed to prepare launch plan for agent ${input.agentId}: ${prepareResult.reason}`);
	}

	const plan = prepareResult.value;

	// 4. Resolve gh environment
	let cardGhEnv: Record<string, string> = {};
	if (!isHomeAgentSessionId(input.taskId)) {
		cardGhEnv = await resolveCardGhEnv(input.cwd);
	}

	const env = {
		...plan.env,
		...cardGhEnv,
	};

	// 5. Side-effect write any settings/config files
	const filesToWrite = plan.filesToWrite ?? [];
	for (const file of filesToWrite) {
		await ensureTextFile(file.path, file.content);
	}

	const cleanup = async () => {
		for (const file of filesToWrite) {
			try {
				await lockedFileSystem.removePath(file.path, {
					lock: { path: file.path, type: "file" },
					force: true,
				});
			} catch {
				// Ignore
			}
		}
	};

	let detectOutputTransition: AgentOutputTransitionDetector | undefined;
	let shouldInspectOutputForTransition: AgentOutputTransitionInspectionPredicate | undefined;

	if (input.agentId === "codex") {
		detectOutputTransition = (data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null => {
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
		};

		shouldInspectOutputForTransition = (summary: RuntimeTaskSessionSummary): boolean => {
			return (
				summary.state === "awaiting_review" &&
				(summary.reviewReason === "attention" ||
					summary.reviewReason === "hook" ||
					summary.reviewReason === "error")
			);
		};
	}

	return {
		binary: plan.binary,
		args: [...plan.args],
		env,
		cleanup,
		deferredStartupInput: plan.deferredStartupInput,
		detectOutputTransition,
		shouldInspectOutputForTransition,
	};
}
