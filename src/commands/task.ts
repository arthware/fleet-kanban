import { readFile } from "node:fs/promises";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { Command } from "commander";

import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardDependency,
	RuntimeClineReasoningEffort,
	RuntimeExternalIssue,
	RuntimeTaskClineSettings,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { runtimeAgentIdSchema, runtimeClineReasoningEffortSchema } from "../core/api-contract";
import { parseExternalIssueRef } from "../core/external-issue";
import { buildKanbanRuntimeUrl, getKanbanRuntimeOrigin, getRuntimeFetch } from "../core/runtime-endpoint";
import {
	addTaskDependency,
	addTaskToColumn,
	completeTaskAndGetReadyLinkedTaskIds,
	deleteTasksFromBoard,
	getTaskColumnId,
	moveTaskToColumn,
	type RuntimeAddTaskDependencyResult,
	removeTaskDependency,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../core/task-board-mutations";
import { resolveTaskTitle } from "../core/task-title";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeAppRouter } from "../trpc/app-router";
import { resolveRepoNameWithOwner } from "../workspace/repo-name";
import {
	type ParsedTaskCard,
	parseTaskCardDocument,
	resolveCardSourceRequest,
	resolveTaskCardCreate,
} from "./task-card-frontmatter";
import { renderTranscriptTailLines, selectTranscriptTail } from "./task-transcript-tail";

const LIST_TASK_COLUMNS = ["backlog", "in_progress", "review", "done", "trash"] as const;
const NOTIFY_WORKSPACE_STATE_TIMEOUT_MS = 2_000;
type ListTaskColumn = (typeof LIST_TASK_COLUMNS)[number];
type TaskCommandTarget = { taskId?: string; column?: ListTaskColumn };

type ResolvedTaskCommandTarget =
	| {
			kind: "task";
			taskId: string;
	  }
	| {
			kind: "column";
			column: ListTaskColumn;
	  };

interface RuntimeWorkspaceMutationResult<T> {
	board: RuntimeWorkspaceStateResponse["board"];
	value: T;
}

type JsonRecord = Record<string, unknown>;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseListColumn(value: string | undefined): ListTaskColumn | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "backlog" || value === "in_progress" || value === "review" || value === "done" || value === "trash") {
		return value;
	}
	throw new Error(`Invalid column "${value}". Expected one of: ${LIST_TASK_COLUMNS.join(", ")}.`);
}

function parseAutoReviewMode(value: string | undefined): "commit" | "pr" | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "commit" || value === "pr") {
		return value;
	}
	throw new Error(`Invalid auto review mode "${value}". Expected: commit, pr.`);
}

const VALID_AGENT_IDS = runtimeAgentIdSchema.options;

function parseAgentId(value: string | undefined): RuntimeAgentId | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "default") {
		return null;
	}
	const result = runtimeAgentIdSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error(`Invalid agent ID "${value}". Expected one of: ${VALID_AGENT_IDS.join(", ")}, default.`);
}

function parseOptionalStringOrDefault(value: string | undefined): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "default") {
		return null;
	}
	return value;
}

type ParsedTaskClineReasoningEffort = RuntimeClineReasoningEffort | "default" | null | undefined;

function parseTaskClineReasoningEffort(value: string | undefined): ParsedTaskClineReasoningEffort {
	if (value === undefined) {
		return undefined;
	}
	if (value === "inherit") {
		return null;
	}
	if (value === "default") {
		return "default";
	}
	const result = runtimeClineReasoningEffortSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error("Invalid Cline reasoning effort. Expected one of: default, low, medium, high, xhigh, inherit.");
}

function cloneTaskClineSettings(settings?: RuntimeTaskClineSettings): RuntimeTaskClineSettings | undefined {
	if (settings === undefined) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

function formatTaskClineSettings(settings?: RuntimeTaskClineSettings): JsonRecord {
	if (settings === undefined) {
		return {};
	}
	return {
		clineSettings: cloneTaskClineSettings(settings) ?? {},
	};
}

export async function resolveExternalIssueForTaskCommand(input: {
	ref: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
}): Promise<RuntimeExternalIssue> {
	const parsed = parseExternalIssueRef(input.ref);
	if (!parsed) {
		throw new Error(
			`Invalid external issue reference "${input.ref}". Expected a Linear issue (ENG-123 or Linear URL) or GitHub issue (#123, owner/repo#123, or issue URL).`,
		);
	}
	if (parsed.url) {
		return parsed;
	}
	if (parsed.provider === "linear") {
		const workspaceSlug = input.env?.KANBAN_LINEAR_WORKSPACE?.trim();
		return {
			...parsed,
			...(workspaceSlug ? { url: `https://linear.app/${workspaceSlug}/issue/${parsed.key}` } : {}),
		};
	}
	if (parsed.provider === "github" && parsed.key.startsWith("#")) {
		const issueNumber = parsed.key.slice(1);
		const nameWithOwner = await resolveRepoNameWithOwner(input.cwd);
		return {
			...parsed,
			...(nameWithOwner ? { url: `https://github.com/${nameWithOwner}/issues/${issueNumber}` } : {}),
		};
	}
	return parsed;
}

function buildTaskClineSettingsForCreate(input: {
	providerId?: string;
	modelId?: string;
	reasoningEffort?: ParsedTaskClineReasoningEffort;
}): RuntimeTaskClineSettings | undefined {
	const providerId = input.providerId?.trim();
	const modelId = input.modelId?.trim();
	const reasoningEffort = input.reasoningEffort === null ? undefined : input.reasoningEffort;
	if (!providerId && !modelId && reasoningEffort === undefined) {
		return undefined;
	}
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(reasoningEffort && reasoningEffort !== "default" ? { reasoningEffort } : {}),
	};
}

function buildTaskClineSettingsForUpdate(
	currentSettings: RuntimeTaskClineSettings | undefined,
	input: {
		providerId?: string | null;
		modelId?: string | null;
		reasoningEffort?: ParsedTaskClineReasoningEffort;
	},
): RuntimeTaskClineSettings | null | undefined {
	if (input.providerId === undefined && input.modelId === undefined && input.reasoningEffort === undefined) {
		return undefined;
	}
	const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
	let preserveEmptyOverride = currentSettings !== undefined && Object.keys(currentSettings).length === 0;

	if (input.providerId !== undefined) {
		const providerId = input.providerId?.trim();
		if (providerId) {
			nextSettings.providerId = providerId;
		} else {
			delete nextSettings.providerId;
		}
	}

	if (input.modelId !== undefined) {
		const modelId = input.modelId?.trim();
		if (modelId) {
			nextSettings.modelId = modelId;
		} else {
			delete nextSettings.modelId;
		}
	}

	if (input.reasoningEffort !== undefined) {
		if (input.reasoningEffort === "default") {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = true;
		} else if (input.reasoningEffort === null) {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = false;
		} else {
			nextSettings.reasoningEffort = input.reasoningEffort;
		}
	}

	if (
		nextSettings.providerId === undefined &&
		nextSettings.modelId === undefined &&
		nextSettings.reasoningEffort === undefined &&
		!preserveEmptyOverride
	) {
		return null;
	}

	return nextSettings;
}

function resolveTaskCommandTarget(input: TaskCommandTarget, commandName: string): ResolvedTaskCommandTarget {
	const taskId = input.taskId?.trim();
	const column = input.column;
	if (taskId && column) {
		throw new Error(`${commandName} accepts exactly one of --task-id or --column.`);
	}
	if (taskId) {
		return {
			kind: "task",
			taskId,
		};
	}
	if (column) {
		return {
			kind: "column",
			column,
		};
	}
	throw new Error(`${commandName} requires either --task-id or --column.`);
}

function createRuntimeTrpcClient(workspaceId: string | null) {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				headers: () => (workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
				fetch: async (url, options) => {
					const runtimeFetch = await getRuntimeFetch();
					return runtimeFetch(url, options);
				},
			}),
		],
	});
}

async function resolveRuntimeWorkspace(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
) {
	const normalizedProjectPath = (projectPath ?? "").trim();
	const resolvedPath = normalizedProjectPath ? resolveProjectInputPath(normalizedProjectPath, cwd) : cwd;
	return await loadWorkspaceContext(resolvedPath, {
		autoCreateIfMissing: options.autoCreateIfMissing ?? true,
	});
}

async function resolveWorkspaceRepoPath(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
): Promise<string> {
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, options);
	return workspace.repoPath;
}

async function ensureRuntimeWorkspace(workspaceRepoPath: string): Promise<string> {
	const runtimeClient = createRuntimeTrpcClient(null);
	const added = await runtimeClient.projects.add.mutate({
		path: workspaceRepoPath,
	});
	if (!added.ok || !added.project) {
		throw new Error(added.error ?? `Could not register project ${workspaceRepoPath} in Kanban runtime.`);
	}
	return added.project.id;
}

function createTimeoutError(message: string, timeoutMs: number): Promise<never> {
	return new Promise((_, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${message} after ${timeoutMs}ms.`));
		}, timeoutMs);
		timer.unref();
	});
}

export async function notifyRuntimeWorkspaceStateUpdated(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	options: { timeoutMs?: number; warn?: (message: string) => void } = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? NOTIFY_WORKSPACE_STATE_TIMEOUT_MS;
	const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
	try {
		await Promise.race([
			runtimeClient.workspace.notifyStateUpdated.mutate(),
			createTimeoutError("Timed out notifying the running Kanban board about the workspace update", timeoutMs),
		]);
	} catch (error) {
		const message = toErrorMessage(error);
		warn(`Kanban board realtime update failed: ${message}`);
		throw error;
	}
}

async function updateRuntimeWorkspaceState<T>(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	workspaceRepoPath: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceMutationResult<T>,
): Promise<T> {
	const mutationResponse = await mutateWorkspaceState(workspaceRepoPath, (state) => {
		const mutation = mutate(state);
		return {
			board: mutation.board,
			value: mutation.value,
		};
	});

	if (mutationResponse.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	return mutationResponse.value;
}

function resolveTaskBaseRef(state: RuntimeWorkspaceStateResponse): string {
	return state.git.currentBranch ?? state.git.defaultBranch ?? state.git.branches[0] ?? "";
}

function findTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	taskId: string,
): { task: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null {
	for (const column of state.board.columns) {
		const task = column.cards.find((candidate) => candidate.id === taskId);
		if (task) {
			return {
				task,
				columnId: column.id,
			};
		}
	}
	return null;
}

export function resolveCardIdFromRefOrIssue(state: RuntimeWorkspaceStateResponse, ref: string): string {
	if (findTaskRecord(state, ref)) {
		return ref;
	}

	const matches = state.board.columns.flatMap((column) =>
		column.cards.filter((task) => task.externalIssue?.key === ref).map((task) => task.id),
	);
	if (matches.length > 1) {
		throw new Error(`Multiple cards reference issue "${ref}": ${matches.join(", ")}. Pass the card id instead.`);
	}
	return matches[0] ?? ref;
}

export function formatTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	task: RuntimeBoardCard,
	columnId: RuntimeBoardColumnId,
): JsonRecord {
	const session = state.sessions[task.id] ?? null;
	return {
		id: task.id,
		title: resolveTaskTitle(task.title, task.prompt),
		prompt: task.prompt,
		column: columnId,
		baseRef: task.baseRef,
		startInPlanMode: task.startInPlanMode,
		autoReviewEnabled: task.autoReviewEnabled === true,
		autoReviewMode: task.autoReviewMode ?? "commit",
		...(task.agentId ? { agentId: task.agentId } : {}),
		...(task.agentModel ? { agentModel: task.agentModel } : {}),
		...(task.skill ? { skill: task.skill } : {}),
		...(task.externalIssue ? { externalIssue: task.externalIssue } : {}),
		...formatTaskClineSettings(task.clineSettings),
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		session: session
			? {
					state: session.state,
					agentId: session.agentId,
					pid: session.pid,
					startedAt: session.startedAt,
					updatedAt: session.updatedAt,
					lastOutputAt: session.lastOutputAt,
					reviewReason: session.reviewReason,
					exitCode: session.exitCode,
				}
			: null,
	};
}

export function formatCreatedTaskRecord(created: RuntimeBoardCard, workspaceRepoPath: string): JsonRecord {
	return {
		id: created.id,
		column: "backlog",
		workspacePath: workspaceRepoPath,
		title: resolveTaskTitle(created.title, created.prompt),
		prompt: created.prompt,
		baseRef: created.baseRef,
		startInPlanMode: created.startInPlanMode,
		autoReviewEnabled: created.autoReviewEnabled === true,
		autoReviewMode: created.autoReviewMode ?? "commit",
		...(created.agentId ? { agentId: created.agentId } : {}),
		...(created.agentModel ? { agentModel: created.agentModel } : {}),
		...(created.skill ? { skill: created.skill } : {}),
		...(created.externalIssue ? { externalIssue: created.externalIssue } : {}),
		...formatTaskClineSettings(created.clineSettings),
	};
}

function formatDependencyRecord(
	state: RuntimeWorkspaceStateResponse,
	dependency: RuntimeBoardDependency,
): Record<string, unknown> {
	return {
		id: dependency.id,
		backlogTaskId: dependency.fromTaskId,
		backlogTaskColumn: getTaskColumnId(state.board, dependency.fromTaskId),
		linkedTaskId: dependency.toTaskId,
		linkedTaskColumn: getTaskColumnId(state.board, dependency.toTaskId),
		createdAt: dependency.createdAt,
	};
}

function getLinkFailureMessage(reason: RuntimeAddTaskDependencyResult["reason"]): string {
	if (reason === "same_task") {
		return "A task cannot be linked to itself.";
	}
	if (reason === "duplicate") {
		return "These tasks are already linked.";
	}
	if (reason === "terminal_task" || reason === "trash_task") {
		return "Links cannot include done or trashed tasks.";
	}
	if (reason === "non_backlog") {
		return "Links require at least one backlog task.";
	}
	return "One or both tasks could not be found.";
}

function findTasksInColumn(
	state: RuntimeWorkspaceStateResponse,
	columnId: ListTaskColumn,
): Array<{ task: RuntimeBoardCard; columnId: RuntimeBoardColumnId }> {
	const column = state.board.columns.find((candidate) => candidate.id === columnId);
	if (!column) {
		return [];
	}
	return column.cards.map((task) => ({
		task,
		columnId: column.id,
	}));
}

async function listTasks(input: { cwd: string; projectPath?: string; column?: ListTaskColumn }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();

	const tasks = state.board.columns.flatMap((boardColumn) => {
		if (!input.column && boardColumn.id === "trash") {
			return [];
		}
		if (input.column && boardColumn.id !== input.column) {
			return [];
		}
		return boardColumn.cards.map((task) => formatTaskRecord(state, task, boardColumn.id));
	});

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		column: input.column ?? null,
		tasks,
		dependencies: state.board.dependencies.map((dependency) => formatDependencyRecord(state, dependency)),
		count: tasks.length,
	};
}

async function stopTaskRuntimeSession(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	taskId: string,
): Promise<void> {
	await runtimeClient.runtime.stopTaskSession
		.mutate({
			taskId,
		})
		.catch(() => null);
}

async function deleteTaskWorkspace(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	taskId: string,
): Promise<{ removed: boolean; error?: string }> {
	try {
		const deleted = await runtimeClient.workspace.deleteWorktree.mutate({
			taskId,
		});
		return {
			removed: deleted.removed,
			error: deleted.ok ? undefined : deleted.error,
		};
	} catch (error) {
		return {
			removed: false,
			error: toErrorMessage(error),
		};
	}
}

async function readCardStdinText(): Promise<string> {
	if (process.stdin.isTTY) {
		throw new Error("--file - expects card Markdown on stdin, but stdin is a TTY.");
	}
	const chunks: string[] = [];
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	return chunks.join("");
}

/** Reads and parses a card document from `--file`/`--markdown` (or stdin), if either was given. */
async function loadTaskCardFromFlags(options: {
	file?: string;
	markdown?: string;
}): Promise<ParsedTaskCard | undefined> {
	const request = resolveCardSourceRequest({ file: options.file, markdown: options.markdown });
	if (request.kind === "none") {
		return undefined;
	}
	const source =
		request.kind === "inline"
			? request.text
			: request.kind === "stdin"
				? await readCardStdinText()
				: await readFile(request.path, "utf8");
	return parseTaskCardDocument(source);
}

/**
 * Links the freshly created card to each dependency named in the card's
 * `links:` frontmatter, so the new card waits on them. Runs after creation and
 * surfaces the resulting dependencies in the command output.
 */
async function applyTaskCardLinks(
	created: JsonRecord,
	links: string[],
	projectPath: string | undefined,
): Promise<JsonRecord> {
	if (links.length === 0) {
		return created;
	}
	const createdId = (created.task as { id?: unknown } | undefined)?.id;
	if (typeof createdId !== "string" || createdId.trim().length === 0) {
		throw new Error("Cannot apply card links: the created task id is missing.");
	}
	const dependencies: JsonRecord[] = [];
	for (const linkedTaskId of links) {
		const linked = await linkTasks({
			cwd: process.cwd(),
			taskId: createdId,
			linkedTaskId,
			projectPath,
		});
		dependencies.push(linked);
	}
	return { ...created, links: dependencies };
}

async function createTask(input: {
	cwd: string;
	title?: string;
	prompt: string;
	projectPath?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr";
	agentId?: RuntimeAgentId;
	agentModel?: string;
	skill?: string;
	externalIssueRef?: string;
	clineSettings?: RuntimeTaskClineSettings;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const externalIssue =
		input.externalIssueRef !== undefined
			? await resolveExternalIssueForTaskCommand({
					ref: input.externalIssueRef,
					cwd: workspaceRepoPath,
					env: process.env,
				})
			: undefined;
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const created = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state) => {
		const resolvedBaseRef = (input.baseRef ?? "").trim() || resolveTaskBaseRef(state);
		if (!resolvedBaseRef) {
			throw new Error("Could not determine task base branch for this workspace.");
		}
		const result = addTaskToColumn(
			state.board,
			"backlog",
			{
				title: input.title,
				prompt: input.prompt,
				startInPlanMode: input.startInPlanMode,
				autoReviewEnabled: input.autoReviewEnabled,
				autoReviewMode: input.autoReviewMode,
				agentId: input.agentId,
				agentModel: input.agentModel,
				skill: input.skill,
				externalIssue,
				clineSettings: input.clineSettings,
				baseRef: resolvedBaseRef,
			},
			() => globalThis.crypto.randomUUID(),
		);
		return {
			board: result.board,
			value: result.task,
		};
	});

	return {
		ok: true,
		task: formatCreatedTaskRecord(created, workspaceRepoPath),
	};
}

async function updateTaskCommand(input: {
	cwd: string;
	taskId: string;
	title?: string;
	projectPath?: string;
	prompt?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr";
	agentId?: RuntimeAgentId | null;
	agentModel?: string | null;
	skill?: string | null;
	externalIssueRef?: string | null;
	clineProviderId?: string | null;
	clineModelId?: string | null;
	clineReasoningEffort?: ParsedTaskClineReasoningEffort;
}): Promise<JsonRecord> {
	if (
		input.title === undefined &&
		input.prompt === undefined &&
		input.baseRef === undefined &&
		input.startInPlanMode === undefined &&
		input.autoReviewEnabled === undefined &&
		input.autoReviewMode === undefined &&
		input.agentId === undefined &&
		input.agentModel === undefined &&
		input.skill === undefined &&
		input.externalIssueRef === undefined &&
		input.clineProviderId === undefined &&
		input.clineModelId === undefined &&
		input.clineReasoningEffort === undefined
	) {
		throw new Error("task update requires at least one field to change.");
	}

	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const externalIssue =
		input.externalIssueRef === undefined
			? undefined
			: input.externalIssueRef === null
				? null
				: await resolveExternalIssueForTaskCommand({
						ref: input.externalIssueRef,
						cwd: workspaceRepoPath,
						env: process.env,
					});
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const updated = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const taskId = resolveCardIdFromRefOrIssue(runtimeState, input.taskId);
		const taskRecord = findTaskRecord(runtimeState, taskId);
		if (!taskRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
		}
		// baseRef/agentModel/skill drive worktree creation and launch-time agent
		// guidance, all fixed once a task leaves backlog. Changing them afterward
		// would not take effect and would be misleading, so reject rather than
		// silently ignore.
		if (
			(input.baseRef !== undefined || input.agentModel !== undefined || input.skill !== undefined) &&
			taskRecord.columnId !== "backlog"
		) {
			throw new Error(
				`Task "${taskId}" is in "${taskRecord.columnId}" — base-ref, agent-model, and skill can only be changed while a task is in backlog.`,
			);
		}
		const nextTaskClineSettings = buildTaskClineSettingsForUpdate(taskRecord.task.clineSettings, {
			providerId: input.clineProviderId,
			modelId: input.clineModelId,
			reasoningEffort: input.clineReasoningEffort,
		});

		const updatedTask = updateTask(runtimeState.board, taskId, {
			title: input.title ?? taskRecord.task.title,
			prompt: input.prompt ?? taskRecord.task.prompt,
			baseRef: input.baseRef ?? taskRecord.task.baseRef,
			startInPlanMode: input.startInPlanMode ?? taskRecord.task.startInPlanMode,
			autoReviewEnabled: input.autoReviewEnabled ?? taskRecord.task.autoReviewEnabled === true,
			autoReviewMode: input.autoReviewMode ?? taskRecord.task.autoReviewMode ?? "commit",
			agentId: input.agentId,
			agentModel: input.agentModel,
			skill: input.skill,
			externalIssue,
			clineSettings: nextTaskClineSettings,
		});
		if (!updatedTask.updated || !updatedTask.task) {
			throw new Error(`Task "${taskId}" could not be updated.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: updatedTask.board,
		};

		return {
			board: updatedTask.board,
			value: formatTaskRecord(nextState, updatedTask.task, taskRecord.columnId),
		};
	});

	return {
		ok: true,
		task: updated,
		workspacePath: workspaceRepoPath,
	};
}

async function linkTasks(input: {
	cwd: string;
	taskId: string;
	linkedTaskId: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const dependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const taskId = resolveCardIdFromRefOrIssue(runtimeState, input.taskId);
		const linkedTaskId = resolveCardIdFromRefOrIssue(runtimeState, input.linkedTaskId);
		const linked = addTaskDependency(runtimeState.board, taskId, linkedTaskId);
		if (!linked.added || !linked.dependency) {
			throw new Error(getLinkFailureMessage(linked.reason));
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: linked.board,
		};
		return {
			board: linked.board,
			value: formatDependencyRecord(nextState, linked.dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		dependency,
	};
}

async function unlinkTasks(input: { cwd: string; dependencyId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const removedDependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const dependency =
			runtimeState.board.dependencies.find((candidate) => candidate.id === input.dependencyId) ?? null;
		if (!dependency) {
			throw new Error(`Dependency "${input.dependencyId}" was not found in workspace ${workspaceRepoPath}.`);
		}

		const unlinked = removeTaskDependency(runtimeState.board, input.dependencyId);
		if (!unlinked.removed) {
			throw new Error(`Dependency "${input.dependencyId}" could not be removed.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: unlinked.board,
		};
		return {
			board: unlinked.board,
			value: formatDependencyRecord(nextState, dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		removedDependency,
	};
}

async function startTask(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const taskId = resolveCardIdFromRefOrIssue(runtimeState, input.taskId);
	const fromColumnId = getTaskColumnId(runtimeState.board, taskId);
	if (!fromColumnId) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
	}

	if (fromColumnId !== "backlog" && fromColumnId !== "in_progress") {
		throw new Error(`Task "${taskId}" is in "${fromColumnId}" and can only be started from backlog or in_progress.`);
	}

	const currentRecord = findTaskRecord(runtimeState, taskId);
	const task = currentRecord?.task;
	if (!task) {
		throw new Error(`Task "${taskId}" could not be resolved.`);
	}

	const existingSession = runtimeState.sessions[task.id] ?? null;
	const shouldStartSession = !existingSession || existingSession.state !== "running";

	if (shouldStartSession) {
		const ensured = await runtimeClient.workspace.ensureWorktree.mutate({
			taskId: task.id,
			baseRef: task.baseRef,
		});
		if (!ensured.ok) {
			throw new Error(ensured.error ?? "Could not ensure task worktree.");
		}

		const started = await runtimeClient.runtime.startTaskSession.mutate({
			taskId: task.id,
			prompt: task.prompt,
			taskTitle: task.title,
			startInPlanMode: task.startInPlanMode,
			baseRef: task.baseRef,
			agentId: task.agentId,
			agentModel: task.agentModel,
			skill: task.skill,
			clineSettings: task.clineSettings,
		});
		if (!started.ok || !started.summary) {
			throw new Error(started.error ?? "Could not start task session.");
		}
	}

	const moved = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (latestState) => {
		const movement = moveTaskToColumn(latestState.board, taskId, "in_progress");
		if (!movement.task) {
			throw new Error(`Task "${taskId}" could not be resolved.`);
		}
		if (!movement.moved) {
			return {
				board: latestState.board,
				value: movement,
			};
		}
		return {
			board: movement.board,
			value: movement,
		};
	});

	if (!moved.moved) {
		return {
			ok: true,
			message: `Task "${taskId}" is already in progress.`,
			task: {
				id: task.id,
				prompt: task.prompt,
				column: "in_progress",
				workspacePath: workspaceRepoPath,
			},
		};
	}

	return {
		ok: true,
		task: {
			id: task.id,
			prompt: task.prompt,
			column: "in_progress",
			workspacePath: workspaceRepoPath,
		},
	};
}

async function sendTaskInput(input: {
	cwd: string;
	taskId: string;
	text: string;
	projectPath?: string;
	submit: boolean;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);

	// Bracketed paste so a mid-turn PTY agent buffers the steering text cleanly; the
	// Cline path ignores the framing and takes it as a message. `submit` decides
	// whether the text is sent or just staged in the prompt.
	const result = await runtimeClient.runtime.sendTaskSessionInput.mutate({
		taskId: input.taskId,
		text: input.text,
		bracketedPaste: true,
		submit: input.submit,
	});

	if (!result.ok) {
		return {
			ok: false,
			taskId: input.taskId,
			error: result.error ?? "Task session is not running.",
			// Liveness guard: an ended/awaiting-review-and-exited card has no live
			// session to steer. Resuming it starts one, then `say` reaches it.
			hint: `Session is not live — resume it first: task start --task-id ${input.taskId}`,
		};
	}

	return {
		ok: true,
		taskId: input.taskId,
		submitted: input.submit,
		state: result.summary?.state ?? null,
	};
}

async function tailTask(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	lines?: number;
	sinceMinutes?: number;
}): Promise<JsonRecord> {
	// Read-only: resolve the workspace without registering it (mirrors `list`),
	// then derive the tail from the agent CLI's own transcript via the existing
	// reader/locator — the board never re-streams or re-persists the session.
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd);
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);

	const transcript = await runtimeClient.runtime.getTaskTranscript.query({ taskId: input.taskId });
	if (!transcript.ok) {
		return {
			ok: false,
			taskId: input.taskId,
			error: transcript.error ?? "Could not read the task transcript.",
		};
	}

	const tail = selectTranscriptTail(renderTranscriptTailLines(transcript.messages), {
		lines: input.lines,
		sinceMinutes: input.sinceMinutes,
	});

	return {
		ok: true,
		taskId: input.taskId,
		// `present: false` = no transcript on disk for a captured session — the
		// card isn't live, or its agent hasn't written a turn yet.
		present: transcript.present,
		count: tail.length,
		tail,
		...(tail.length === 0
			? {
					hint: transcript.present
						? "The agent hasn't written any conversation yet."
						: `No live transcript for "${input.taskId}" — resume it first: task start --task-id ${input.taskId}`,
				}
			: {}),
	};
}

interface TrashTaskExecutionResult {
	task: JsonRecord;
	taskId: string;
	previousColumnId: ListTaskColumn;
	readyTaskIds: string[];
	autoStartedTasks: JsonRecord[];
	worktreeDeleted: boolean;
	worktreeDeleteError?: string;
	alreadyInTrash: boolean;
}

interface CompleteTaskExecutionResult {
	task: JsonRecord;
	taskId: string;
	previousColumnId: ListTaskColumn;
	readyTaskIds: string[];
	autoStartedTasks: JsonRecord[];
	alreadyDone: boolean;
}

interface TrashTaskMutationValue {
	task: JsonRecord;
	taskId: string;
	previousColumnId: ListTaskColumn;
	readyTaskIds: string[];
	alreadyInTrash: boolean;
}

interface CompleteTaskMutationValue {
	task: JsonRecord;
	taskId: string;
	previousColumnId: ListTaskColumn;
	readyTaskIds: string[];
	alreadyDone: boolean;
}

function columnCanHaveLiveTaskSession(columnId: ListTaskColumn): boolean {
	return columnId === "in_progress" || columnId === "review";
}

async function completeTaskById(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	workspaceRepoPath: string;
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>;
}): Promise<CompleteTaskExecutionResult> {
	const mutation = await mutateWorkspaceState<CompleteTaskMutationValue>(input.workspaceRepoPath, (latestState) => {
		const taskId = resolveCardIdFromRefOrIssue(latestState, input.taskId);
		const latestRecord = findTaskRecord(latestState, taskId);
		if (!latestRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${input.workspaceRepoPath}.`);
		}
		if (latestRecord.columnId === "done") {
			return {
				board: latestState.board,
				value: {
					task: formatTaskRecord(latestState, latestRecord.task, latestRecord.columnId),
					taskId,
					previousColumnId: latestRecord.columnId,
					readyTaskIds: [] as string[],
					alreadyDone: true,
				},
				save: false,
			};
		}

		const completed = completeTaskAndGetReadyLinkedTaskIds(latestState.board, taskId);
		if (!completed.moved || !completed.task) {
			throw new Error(`Task "${taskId}" could not be moved to done.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...latestState,
			board: completed.board,
		};
		return {
			board: completed.board,
			value: {
				task: formatTaskRecord(nextState, completed.task, "done"),
				taskId,
				previousColumnId: latestRecord.columnId,
				readyTaskIds: completed.readyTaskIds,
				alreadyDone: false,
			},
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(input.runtimeClient);
	}

	if (mutation.value.alreadyDone) {
		return {
			task: mutation.value.task,
			taskId: mutation.value.taskId,
			previousColumnId: mutation.value.previousColumnId,
			readyTaskIds: [],
			autoStartedTasks: [],
			alreadyDone: true,
		};
	}

	if (columnCanHaveLiveTaskSession(mutation.value.previousColumnId)) {
		await stopTaskRuntimeSession(input.runtimeClient, mutation.value.taskId);
	}

	const autoStartedTasks: JsonRecord[] = [];
	for (const readyTaskId of mutation.value.readyTaskIds) {
		const started = await startTask({
			cwd: input.cwd,
			taskId: readyTaskId,
			projectPath: input.projectPath,
		});
		autoStartedTasks.push(started);
	}

	return {
		task: mutation.value.task,
		taskId: mutation.value.taskId,
		previousColumnId: mutation.value.previousColumnId,
		readyTaskIds: mutation.value.readyTaskIds,
		autoStartedTasks,
		alreadyDone: false,
	};
}

async function trashTaskById(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	workspaceRepoPath: string;
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>;
}): Promise<TrashTaskExecutionResult> {
	const mutation = await mutateWorkspaceState<TrashTaskMutationValue>(input.workspaceRepoPath, (latestState) => {
		const taskId = resolveCardIdFromRefOrIssue(latestState, input.taskId);
		const latestRecord = findTaskRecord(latestState, taskId);
		if (!latestRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${input.workspaceRepoPath}.`);
		}
		if (latestRecord.columnId === "trash") {
			return {
				board: latestState.board,
				value: {
					task: formatTaskRecord(latestState, latestRecord.task, latestRecord.columnId),
					taskId,
					previousColumnId: latestRecord.columnId,
					readyTaskIds: [] as string[],
					alreadyInTrash: true,
				},
				save: false,
			};
		}

		const trashed = trashTaskAndGetReadyLinkedTaskIds(latestState.board, taskId);
		if (!trashed.moved || !trashed.task) {
			throw new Error(`Task "${taskId}" could not be moved to trash.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...latestState,
			board: trashed.board,
		};
		return {
			board: trashed.board,
			value: {
				task: formatTaskRecord(nextState, trashed.task, "trash"),
				taskId,
				previousColumnId: latestRecord.columnId,
				readyTaskIds: trashed.readyTaskIds,
				alreadyInTrash: false,
			},
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(input.runtimeClient);
	}

	if (mutation.value.alreadyInTrash) {
		return {
			task: mutation.value.task,
			taskId: mutation.value.taskId,
			previousColumnId: mutation.value.previousColumnId,
			readyTaskIds: [],
			autoStartedTasks: [],
			worktreeDeleted: false,
			alreadyInTrash: true,
		};
	}

	if (columnCanHaveLiveTaskSession(mutation.value.previousColumnId)) {
		await stopTaskRuntimeSession(input.runtimeClient, mutation.value.taskId);
	}

	const deletedWorkspace = await deleteTaskWorkspace(input.runtimeClient, mutation.value.taskId);

	return {
		task: mutation.value.task,
		taskId: mutation.value.taskId,
		previousColumnId: mutation.value.previousColumnId,
		readyTaskIds: [],
		autoStartedTasks: [],
		worktreeDeleted: deletedWorkspace.removed,
		worktreeDeleteError: deletedWorkspace.error,
		alreadyInTrash: false,
	};
}

async function completeTask(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task done");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);

	if (target.kind === "task") {
		const completed = await completeTaskById({
			cwd: input.cwd,
			taskId: target.taskId,
			projectPath: input.projectPath,
			workspaceRepoPath,
			runtimeClient,
		});
		if (completed.alreadyDone) {
			return {
				ok: true,
				message: `Task "${target.taskId}" is already done.`,
				task: completed.task,
				workspacePath: workspaceRepoPath,
				readyTaskIds: [],
				autoStartedTasks: [],
			};
		}
		return {
			ok: true,
			task: completed.task,
			workspacePath: workspaceRepoPath,
			readyTaskIds: completed.readyTaskIds,
			autoStartedTasks: completed.autoStartedTasks,
		};
	}

	const initialState = await runtimeClient.workspace.getState.query();
	const targetTasks = findTasksInColumn(initialState, target.column);
	if (targetTasks.length === 0) {
		return {
			ok: true,
			column: target.column,
			workspacePath: workspaceRepoPath,
			completedTasks: [],
			alreadyDoneTasks: [],
			readyTaskIds: [],
			autoStartedTasks: [],
			count: 0,
		};
	}

	const results: CompleteTaskExecutionResult[] = [];
	for (const { task } of targetTasks) {
		results.push(
			await completeTaskById({
				cwd: input.cwd,
				taskId: task.id,
				projectPath: input.projectPath,
				workspaceRepoPath,
				runtimeClient,
			}),
		);
	}

	const completedTasks = results.filter((result) => !result.alreadyDone);
	const alreadyDoneTasks = results.filter((result) => result.alreadyDone);

	return {
		ok: true,
		column: target.column,
		workspacePath: workspaceRepoPath,
		completedTasks: completedTasks.map((result) => result.task),
		alreadyDoneTasks: alreadyDoneTasks.map((result) => result.task),
		readyTaskIds: [...new Set(completedTasks.flatMap((result) => result.readyTaskIds))],
		autoStartedTasks: completedTasks.flatMap((result) => result.autoStartedTasks),
		count: completedTasks.length,
	};
}

async function trashTask(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task trash");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);

	if (target.kind === "task") {
		const trashed = await trashTaskById({
			cwd: input.cwd,
			taskId: target.taskId,
			projectPath: input.projectPath,
			workspaceRepoPath,
			runtimeClient,
		});
		if (trashed.alreadyInTrash) {
			return {
				ok: true,
				message: `Task "${target.taskId}" is already trashed.`,
				task: trashed.task,
				workspacePath: workspaceRepoPath,
				readyTaskIds: [],
				autoStartedTasks: [],
			};
		}
		return {
			ok: true,
			task: trashed.task,
			workspacePath: workspaceRepoPath,
			readyTaskIds: trashed.readyTaskIds,
			autoStartedTasks: trashed.autoStartedTasks,
			worktreeDeleted: trashed.worktreeDeleted,
			worktreeDeleteError: trashed.worktreeDeleteError,
		};
	}

	const initialState = await runtimeClient.workspace.getState.query();
	const targetTasks = findTasksInColumn(initialState, target.column);
	if (targetTasks.length === 0) {
		return {
			ok: true,
			column: target.column,
			workspacePath: workspaceRepoPath,
			trashedTasks: [],
			alreadyTrashedTasks: [],
			readyTaskIds: [],
			autoStartedTasks: [],
			worktreeCleanup: [],
			count: 0,
		};
	}

	const results: TrashTaskExecutionResult[] = [];
	for (const { task } of targetTasks) {
		results.push(
			await trashTaskById({
				cwd: input.cwd,
				taskId: task.id,
				projectPath: input.projectPath,
				workspaceRepoPath,
				runtimeClient,
			}),
		);
	}

	const trashedTasks = results.filter((result) => !result.alreadyInTrash);
	const alreadyTrashedTasks = results.filter((result) => result.alreadyInTrash);

	return {
		ok: true,
		column: target.column,
		workspacePath: workspaceRepoPath,
		trashedTasks: trashedTasks.map((result) => result.task),
		alreadyTrashedTasks: alreadyTrashedTasks.map((result) => result.task),
		readyTaskIds: [...new Set(trashedTasks.flatMap((result) => result.readyTaskIds))],
		autoStartedTasks: trashedTasks.flatMap((result) => result.autoStartedTasks),
		worktreeCleanup: trashedTasks.map((result) => ({
			taskId: result.taskId,
			removed: result.worktreeDeleted,
			error: result.worktreeDeleteError,
		})),
		count: trashedTasks.length,
	};
}

async function deleteTaskCommand(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task delete");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const mutation = await mutateWorkspaceState(workspaceRepoPath, (latestState) => {
		const latestTargetRecords =
			target.kind === "task"
				? (() => {
						const taskId = resolveCardIdFromRefOrIssue(latestState, target.taskId);
						const record = findTaskRecord(latestState, taskId);
						if (!record) {
							throw new Error(`Task "${target.taskId}" was not found in workspace ${workspaceRepoPath}.`);
						}
						return [record];
					})()
				: findTasksInColumn(latestState, target.column);

		if (latestTargetRecords.length === 0) {
			return {
				board: latestState.board,
				value: {
					deletedTaskIds: [] as string[],
					taskIdsRequiringStop: [] as string[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deleted = deleteTasksFromBoard(
			latestState.board,
			latestTargetRecords.map(({ task }) => task.id),
		);
		if (!deleted.deleted) {
			return {
				board: latestState.board,
				value: {
					deletedTaskIds: [] as string[],
					taskIdsRequiringStop: [] as string[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deletedTasks = latestTargetRecords.map(({ task, columnId }) =>
			formatTaskRecord(latestState, task, columnId),
		);
		const taskIdsRequiringStop = latestTargetRecords
			.filter(({ columnId }) => columnCanHaveLiveTaskSession(columnId))
			.map(({ task }) => task.id);
		return {
			board: deleted.board,
			value: {
				deletedTaskIds: deleted.deletedTaskIds,
				taskIdsRequiringStop,
				deletedTasks,
			},
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	if (mutation.value.deletedTaskIds.length === 0) {
		return {
			ok: true,
			workspacePath: workspaceRepoPath,
			column: target.kind === "column" ? target.column : null,
			deletedTasks: [],
			count: 0,
		};
	}

	await Promise.all(
		mutation.value.taskIdsRequiringStop.map(async (taskId) => await stopTaskRuntimeSession(runtimeClient, taskId)),
	);

	const workspaceCleanupResults = await Promise.all(
		mutation.value.deletedTaskIds.map(async (taskId) => ({
			taskId,
			...(await deleteTaskWorkspace(runtimeClient, taskId)),
		})),
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		column: target.kind === "column" ? target.column : null,
		deletedTasks: mutation.value.deletedTasks,
		count: mutation.value.deletedTaskIds.length,
		worktreeCleanup: workspaceCleanupResults,
	};
}

function parseOptionalBooleanOption(value: unknown, flagName: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === true || value === false) {
		return value;
	}
	if (typeof value !== "string") {
		throw new Error(`Invalid boolean value for ${flagName}. Use true or false.`);
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	throw new Error(`Invalid boolean value for ${flagName}: "${value}". Use true or false.`);
}

function parsePositiveIntOption(value: string | undefined, flagName: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Invalid value for ${flagName}: "${value}". Use a positive whole number.`);
	}
	return parsed;
}

interface TaskCommandOutputOptions {
	quietTaskIdOnly?: boolean;
}

export function renderTaskCommandSuccess(payload: JsonRecord, options?: TaskCommandOutputOptions): string {
	if (options?.quietTaskIdOnly === true) {
		const taskId = (payload.task as { id?: unknown } | undefined)?.id;
		if (typeof taskId !== "string" || taskId.trim().length === 0) {
			throw new Error("Task command did not return a task id.");
		}
		return `${taskId}\n`;
	}
	return `${JSON.stringify(payload, null, 2)}\n`;
}

async function runTaskCommand(handler: () => Promise<JsonRecord>, options?: TaskCommandOutputOptions): Promise<void> {
	try {
		const payload = await handler();
		process.stdout.write(renderTaskCommandSuccess(payload, options));
	} catch (error) {
		printJson({
			ok: false,
			error: `Task command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

export function registerTaskCommand(program: Command): void {
	const task = program.command("task").alias("tasks").description("Manage Kanban board tasks from the CLI.");

	task
		.command("list")
		.description("List Kanban tasks for a workspace.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option(
			"--column <column>",
			"Filter column: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.action(async (options: { projectPath?: string; column?: ListTaskColumn }) => {
			await runTaskCommand(
				async () =>
					await listTasks({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						column: options.column,
					}),
			);
		});

	task
		.command("create")
		.description("Create a task in backlog.")
		.option("--title <text>", "Task title.")
		.option("--prompt <text>", "Task prompt text. Optional when --file/--markdown supplies the body.")
		.option(
			"--file <path>",
			"Read the card from a Markdown file with optional YAML frontmatter (- reads stdin). See docs/card-authoring.md.",
		)
		.option("--markdown <text>", "Card Markdown (frontmatter + body) supplied inline instead of via --file.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Task base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option("--auto-review-enabled [value]", "Enable auto-review behavior (true|false). Flag-only implies true.")
		.option("--auto-review-mode <mode>", "Auto-review mode: commit | pr.", parseAutoReviewMode)
		.option("--agent-id <id>", "Agent override: cline | claude | codex | droid | gemini | opencode | default.")
		.option(
			"--agent-model <id>",
			"Per-card model for the CLI agent (claude/codex/…), e.g. claude-haiku-4-5. Passed as the agent's native --model.",
		)
		.option("--skill <name>", "Per-card Agent Skills / SKILL.md pointer.")
		.option("--quiet", "Print only the created task id.")
		.option("--id-only", "Alias for --quiet.")
		.option(
			"--external-issue <ref>",
			"External issue ref: Linear ENG-123 or URL; GitHub #123, 123, owner/repo#123, or issue URL. Bare Linear keys use KANBAN_LINEAR_WORKSPACE.",
		)
		.option("--issue <ref>", "Alias for --external-issue.")
		.option(
			"--cline-provider <id>",
			'Cline provider override (e.g. anthropic, openai, cline). Use "default" for workspace default.',
		)
		.option(
			"--cline-model <id>",
			'Cline model override (e.g. claude-sonnet-4-20250514). Use "default" for workspace default.',
		)
		.option(
			"--cline-reasoning-effort <level>",
			"Cline reasoning effort override: default | low | medium | high | xhigh.",
		)
		.action(
			async (options: {
				title?: string;
				prompt?: string;
				file?: string;
				markdown?: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				autoReviewEnabled?: unknown;
				autoReviewMode?: "commit" | "pr";
				agentId?: string;
				agentModel?: string;
				skill?: string;
				quiet?: boolean;
				idOnly?: boolean;
				externalIssue?: string;
				issue?: string;
				clineProvider?: string;
				clineModel?: string;
				clineReasoningEffort?: string;
			}) => {
				await runTaskCommand(
					async () => {
						const card = await loadTaskCardFromFlags(options);
						// Explicit CLI flags override frontmatter, so one card file can be
						// reused with a single field tweaked from the command line.
						const resolved = resolveTaskCardCreate(card, {
							title: options.title,
							prompt: options.prompt,
							baseRef: options.baseRef,
							startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
							autoReviewEnabled: parseOptionalBooleanOption(options.autoReviewEnabled, "--auto-review-enabled"),
							autoReviewMode: options.autoReviewMode,
							agentId: parseAgentId(options.agentId),
							agentModel: parseOptionalStringOrDefault(options.agentModel),
							skill: parseOptionalStringOrDefault(options.skill),
							externalIssueRef: options.externalIssue ?? options.issue,
						});
						const created = await createTask({
							cwd: process.cwd(),
							title: resolved.title,
							prompt: resolved.prompt,
							projectPath: options.projectPath,
							baseRef: resolved.baseRef,
							startInPlanMode: resolved.startInPlanMode,
							autoReviewEnabled: resolved.autoReviewEnabled,
							autoReviewMode: resolved.autoReviewMode,
							agentId: resolved.agentId,
							agentModel: resolved.agentModel,
							skill: resolved.skill,
							externalIssueRef: resolved.externalIssueRef,
							clineSettings: buildTaskClineSettingsForCreate({
								providerId: parseOptionalStringOrDefault(options.clineProvider) ?? undefined,
								modelId: parseOptionalStringOrDefault(options.clineModel) ?? undefined,
								reasoningEffort: parseTaskClineReasoningEffort(options.clineReasoningEffort),
							}),
						});
						return await applyTaskCardLinks(created, resolved.links, options.projectPath);
					},
					{
						quietTaskIdOnly: options.quiet === true || options.idOnly === true,
					},
				);
			},
		);

	task
		.command("update")
		.description("Update an existing task.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--title <text>", "Replacement task title.")
		.option("--prompt <text>", "Replacement task prompt.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Replacement base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option("--auto-review-enabled [value]", "Enable auto-review behavior (true|false). Flag-only implies true.")
		.option("--auto-review-mode <mode>", "Auto-review mode: commit | pr.", parseAutoReviewMode)
		.option(
			"--agent-id <id>",
			'Agent override: cline | claude | codex | droid | gemini | opencode. Use "default" to clear.',
		)
		.option(
			"--agent-model <id>",
			'Per-card model for the CLI agent (claude/codex/…), e.g. claude-haiku-4-5. Use "default" to clear. Only valid while the task is in backlog.',
		)
		.option("--skill <name>", 'Per-card Agent Skills / SKILL.md pointer. Use "default" to clear.')
		.option(
			"--external-issue <ref>",
			'External issue ref: Linear ENG-123 or URL; GitHub #123, 123, owner/repo#123, or issue URL. Use "default" to clear. Bare Linear keys use KANBAN_LINEAR_WORKSPACE.',
		)
		.option("--issue <ref>", "Alias for --external-issue.")
		.option(
			"--cline-provider <id>",
			'Cline provider override (e.g. anthropic, openai, cline). Use "default" to clear.',
		)
		.option("--cline-model <id>", 'Cline model override (e.g. claude-sonnet-4-20250514). Use "default" to clear.')
		.option(
			"--cline-reasoning-effort <level>",
			'Cline reasoning effort override: default | low | medium | high | xhigh. Use "inherit" to clear.',
		)
		.action(
			async (options: {
				taskId: string;
				title?: string;
				prompt?: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				autoReviewEnabled?: unknown;
				autoReviewMode?: "commit" | "pr";
				agentId?: string;
				agentModel?: string;
				skill?: string;
				externalIssue?: string;
				issue?: string;
				clineProvider?: string;
				clineModel?: string;
				clineReasoningEffort?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await updateTaskCommand({
							cwd: process.cwd(),
							taskId: options.taskId,
							title: options.title,
							projectPath: options.projectPath,
							prompt: options.prompt,
							baseRef: options.baseRef,
							startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
							autoReviewEnabled: parseOptionalBooleanOption(options.autoReviewEnabled, "--auto-review-enabled"),
							autoReviewMode: options.autoReviewMode,
							agentId: parseAgentId(options.agentId),
							agentModel: parseOptionalStringOrDefault(options.agentModel),
							skill: parseOptionalStringOrDefault(options.skill),
							externalIssueRef: parseOptionalStringOrDefault(options.externalIssue ?? options.issue),
							clineProviderId: parseOptionalStringOrDefault(options.clineProvider),
							clineModelId: parseOptionalStringOrDefault(options.clineModel),
							clineReasoningEffort: parseTaskClineReasoningEffort(options.clineReasoningEffort),
						}),
				);
			},
		);

	task
		.command("done")
		.description("Complete a task or an entire column by moving it to done, keeping task worktrees.")
		.option("--task-id <id>", "Task ID.")
		.option(
			"--column <column>",
			"Column to move to done: backlog | in_progress | review | done | trash.",
			parseListColumn,
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; column?: ListTaskColumn; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await completeTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("trash")
		.description("Archive a task or an entire column by moving it to trash and cleaning up task workspaces.")
		.option("--task-id <id>", "Task ID.")
		.option(
			"--column <column>",
			"Column to move to trash: backlog | in_progress | review | done | trash.",
			parseListColumn,
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; column?: ListTaskColumn; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await trashTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("delete")
		.description("Permanently delete a task or every task in a column.")
		.option("--task-id <id>", "Task ID to permanently delete.")
		.option(
			"--column <column>",
			"Column to bulk-delete: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; column?: ListTaskColumn; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await deleteTaskCommand({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("link")
		.description("Link two tasks so one task waits on another.")
		.requiredOption("--task-id <id>", "One of the two task IDs to link.")
		.requiredOption("--linked-task-id <id>", "The other task ID to link.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.addHelpText(
			"after",
			[
				"",
				"Dependency direction:",
				"  If both linked tasks are in backlog, Kanban preserves the order you pass:",
				"  --task-id waits on --linked-task-id, and on the board the arrow points into",
				"  --linked-task-id.",
				"  Once only one linked task remains in backlog, Kanban reorients the saved link",
				"  so the backlog task is the waiting dependent task and the other task is the",
				"  prerequisite.",
				"  When the prerequisite finishes review and moves to done, the waiting backlog",
				"  task becomes ready to start.",
				"",
			].join("\n"),
		)
		.action(async (options: { taskId: string; linkedTaskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await linkTasks({
						cwd: process.cwd(),
						taskId: options.taskId,
						linkedTaskId: options.linkedTaskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("unlink")
		.description("Remove an existing dependency link.")
		.requiredOption("--dependency-id <id>", "Dependency ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { dependencyId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await unlinkTasks({
						cwd: process.cwd(),
						dependencyId: options.dependencyId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("start")
		.description("Start a task session and move task to in_progress.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await startTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("send-input")
		.description("Send steering input into a running task session (architect → agent).")
		.requiredOption("--task-id <id>", "Task ID.")
		.requiredOption("--text <text>", "Text to inject into the session.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--no-submit", "Stage the text in the prompt without submitting it (default: submit).")
		.action(async (options: { taskId: string; text: string; projectPath?: string; submit?: boolean }) => {
			await runTaskCommand(
				async () =>
					await sendTaskInput({
						cwd: process.cwd(),
						taskId: options.taskId,
						text: options.text,
						projectPath: options.projectPath,
						submit: options.submit !== false,
					}),
			);
		});

	task
		.command("tail")
		.description("Read-only tail of a running task's agent conversation (architect observe).")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--lines <n>", "Show only the last N rendered lines.", (value) =>
			parsePositiveIntOption(value, "--lines"),
		)
		.option("--since <mins>", "Show only turns from the last M minutes.", (value) =>
			parsePositiveIntOption(value, "--since"),
		)
		.action(async (options: { taskId: string; projectPath?: string; lines?: number; since?: number }) => {
			await runTaskCommand(
				async () =>
					await tailTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
						lines: options.lines,
						sinceMinutes: options.since,
					}),
			);
		});
}
