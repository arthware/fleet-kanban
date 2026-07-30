import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeHookIngestResponse,
	RuntimeProjectsResponse,
	RuntimeShellSessionStartResponse,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeTaskSessionInputResponse,
	RuntimeTaskSessionStartResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core/api-contract";
import {
	completeTaskAndGetReadyLinkedTaskIds,
	getTaskColumnId,
	moveTaskToColumn,
} from "../../src/core/task-board-mutations";
import { startIsolatedKanbanInstance } from "../utilities/kanban-test-instance";
import { createPetRepoFixtureCopy, type PetRepoFixture } from "../utilities/pet-repo-fixture";
import { requestJson } from "../utilities/trpc-request";
import { connectRuntimeStream, type RuntimeStreamClient } from "./runtime-stream";

export interface SelfcheckContext {
	instance: any; // Using any or IsolatedKanbanInstance to keep things simple
	baseUrl: string;
	workspaceId: string;
	fixture: PetRepoFixture;
	stop(): Promise<void>;
}

export interface ScenarioDriver {
	createCard(input: { card: RuntimeBoardCard; column: RuntimeBoardColumnId }): Promise<void>;
	startCard(taskId: string): Promise<void>;
	steerCard(taskId: string, text: string): Promise<void>;
	expectColumn(taskId: string, column: RuntimeBoardColumnId): Promise<void>;
	expectOverseerNotified(taskId: string): Promise<void>;
	killAgentProcess(taskId: string): Promise<void>;
	expectSessionGone(taskId: string): Promise<void>;
	expectAgentRunning(taskId: string): Promise<number>;
	readLaunchedArgv(taskId: string): Promise<readonly string[]>;
	ingestNativeHook(taskId: string, input: { event: string; metadata?: any }): Promise<void>;
	expectReviewReason(taskId: string, reason: string | null): Promise<void>;
}

export class ScenarioAssertionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScenarioAssertionError";
	}
}

export function createSelfcheckCard(input: {
	id: string;
	title: string;
	prompt?: string;
	baseRef?: string;
	agentId?: RuntimeBoardCard["agentId"];
	agentModel?: string;
}): RuntimeBoardCard {
	const now = Date.now();
	return {
		id: input.id,
		title: input.title,
		prompt: input.prompt ?? input.title,
		startInPlanMode: false,
		autoReviewEnabled: false,
		agentId: input.agentId ?? "claude",
		baseRef: input.baseRef ?? "main",
		createdAt: now,
		updatedAt: now,
		transitions: [{ column: "backlog", at: now }],
		...(input.agentModel ? { agentModel: input.agentModel } : {}),
	};
}

export async function createSelfcheckContext(): Promise<SelfcheckContext> {
	const fixture = createPetRepoFixtureCopy("kanban-selfcheck-pet-repo-");
	const stubAgentPath = resolve(process.cwd(), "test/fixtures/stub-agent/stub-agent.mjs");
	if (!existsSync(stubAgentPath)) {
		fixture.cleanup();
		throw new ScenarioAssertionError(`Missing stub agent fixture: ${stubAgentPath}`);
	}
	let instance: any;
	try {
		instance = await startIsolatedKanbanInstance({
			cwd: fixture.path,
			env: {
				KANBAN_TEST_AGENT_BINARY: stubAgentPath,
			},
		});
	} catch (error) {
		fixture.cleanup();
		throw error;
	}
	const baseUrl = new URL(instance.baseUrl).origin;
	const workspaceId = await resolveCurrentWorkspaceId(baseUrl);

	return {
		instance,
		baseUrl,
		workspaceId,
		fixture,
		stop: async () => {
			try {
				await instance.stop();
			} finally {
				fixture.cleanup();
			}
		},
	};
}

export function createTrpcScenarioDriver(context: SelfcheckContext): ScenarioDriver {
	let stream: RuntimeStreamClient | null = null;
	return {
		createCard: async ({ card, column }) => {
			await mutateBoard(context, (board) => placeCard(board, card, column));
		},
		startCard: async (taskId) => {
			const state = await loadState(context);
			const card = findCard(state.board, taskId);
			const column = getTaskColumnId(state.board, taskId);
			if (column === "review") {
				stream = await connectRuntimeStream(
					`ws://127.0.0.1:${context.instance.port}/api/runtime/ws?workspaceId=${encodeURIComponent(
						context.workspaceId,
					)}`,
				);
				await stream.waitForMessage(
					(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
				);
				await startShellReviewSession(context, taskId);
				return;
			}
			if (column === "backlog") {
				await mutateBoard(context, (board) => moveCard(board, taskId, "in_progress"));
			}
			await startTaskSession(context, card);
		},
		steerCard: async (taskId, text) => {
			const response = await requestJson<RuntimeTaskSessionInputResponse>({
				baseUrl: context.baseUrl,
				procedure: "runtime.sendTaskSessionInput",
				type: "mutation",
				workspaceId: context.workspaceId,
				payload: { taskId, text, bracketedPaste: true, submit: true },
			});
			assertOk(
				response.status === 200 && response.payload.ok,
				`Could not steer ${taskId}: ${response.payload.error}`,
			);
		},
		expectColumn: async (taskId, column) => {
			await waitFor(async () => {
				const state = await loadState(context);
				return getTaskColumnId(state.board, taskId) === column ? true : null;
			}, `card ${taskId} to be in ${column}`);
		},
		expectOverseerNotified: async (taskId) => {
			if (!stream) {
				throw new ScenarioAssertionError("No runtime stream is connected for review notification assertion.");
			}
			const message = (await stream.waitForMessage(
				(candidate): candidate is RuntimeStateStreamTaskReadyForReviewMessage =>
					candidate.type === "task_ready_for_review" &&
					candidate.workspaceId === context.workspaceId &&
					candidate.taskId === taskId,
			)) as RuntimeStateStreamTaskReadyForReviewMessage;
			assertOk(message.triggeredAt > 0, `Review notification for ${taskId} had no trigger timestamp.`);
			await stream.close();
			stream = null;
		},
		killAgentProcess: async (taskId) => {
			const state = await loadState(context);
			const summary = state.sessions[taskId];
			if (!summary || !summary.pid) {
				throw new ScenarioAssertionError(`No running agent process found for task ${taskId} to kill.`);
			}
			try {
				process.kill(summary.pid, "SIGKILL");
			} catch (_err: any) {
				// Ignore errors (e.g. process already dead)
			}
		},
		expectSessionGone: async (taskId) => {
			await waitFor(async () => {
				const state = await loadState(context);
				const summary = state.sessions[taskId];
				const isGone = !summary || summary.pid === null;
				return isGone ? true : null;
			}, `session for ${taskId} to be gone (pid null)`);
		},
		expectAgentRunning: async (taskId) => {
			const pid = await waitFor(async () => {
				const state = await loadState(context);
				const summary = state.sessions[taskId];
				if (summary && summary.pid !== null) {
					return summary.pid;
				}
				return null;
			}, `agent process for ${taskId} to be running (non-null pid)`);
			return pid;
		},
		readLaunchedArgv: async (taskId) => {
			const runtimeHome = context.instance.homeDir;
			const argvPath = join(runtimeHome, ".kanban", `launched-argv-${taskId}.json`);
			let content = "";
			await waitFor(async () => {
				if (existsSync(argvPath)) {
					try {
						content = readFileSync(argvPath, "utf8");
						return true;
					} catch {
						return null;
					}
				}
				return null;
			}, `launched argv file to exist at ${argvPath}`);
			return JSON.parse(content) as readonly string[];
		},
		ingestNativeHook: async (taskId, input) => {
			const hook = await requestJson<RuntimeHookIngestResponse>({
				baseUrl: context.baseUrl,
				procedure: "hooks.ingest",
				type: "mutation",
				payload: {
					taskId,
					workspaceId: context.workspaceId,
					event: input.event as any,
					metadata: input.metadata,
				},
			});
			assertOk(
				hook.status === 200 && hook.payload.ok,
				`ingestNativeHook failed for ${taskId}: ${hook.payload.error}`,
			);
		},
		expectReviewReason: async (taskId, reason) => {
			await waitFor(async () => {
				const state = await loadState(context);
				const summary = state.sessions[taskId];
				return summary && summary.reviewReason === reason ? true : null;
			}, `card ${taskId} to have reviewReason ${reason}`);
		},
	};
}

export function driverContext(driver: ScenarioDriver): SelfcheckContext {
	const context = (driver as { __context?: SelfcheckContext }).__context;
	if (!context) {
		throw new ScenarioAssertionError("Scenario driver did not expose its selfcheck context.");
	}
	return context;
}

export function attachContext<T extends ScenarioDriver>(driver: T, context: SelfcheckContext): T {
	(driver as T & { __context: SelfcheckContext }).__context = context;
	return driver;
}

export async function resolveCurrentWorkspaceId(baseUrl: string): Promise<string> {
	const projects = await requestJson<RuntimeProjectsResponse>({
		baseUrl,
		procedure: "projects.list",
		type: "query",
	});
	assertOk(projects.status === 200, "Could not list projects.");
	if (!projects.payload.currentProjectId) {
		throw new ScenarioAssertionError("Expected isolated instance to have a current project.");
	}
	return projects.payload.currentProjectId;
}

export async function loadState(context: SelfcheckContext): Promise<RuntimeWorkspaceStateResponse> {
	const response = await requestJson<RuntimeWorkspaceStateResponse>({
		baseUrl: context.baseUrl,
		procedure: "workspace.getState",
		type: "query",
		workspaceId: context.workspaceId,
	});
	assertOk(response.status === 200, "Could not load workspace state.");
	return response.payload;
}

async function saveBoard(
	context: SelfcheckContext,
	state: RuntimeWorkspaceStateResponse,
	board: RuntimeBoardData,
): Promise<RuntimeWorkspaceStateResponse> {
	const response = await requestJson<RuntimeWorkspaceStateResponse>({
		baseUrl: context.baseUrl,
		procedure: "workspace.saveState",
		type: "mutation",
		workspaceId: context.workspaceId,
		payload: { board, sessions: state.sessions, expectedRevision: state.revision },
	});
	assertOk(response.status === 200, "Could not save workspace state.");
	return response.payload;
}

export async function mutateBoard(
	context: SelfcheckContext,
	mutate: (board: RuntimeBoardData) => RuntimeBoardData,
): Promise<RuntimeWorkspaceStateResponse> {
	const state = await loadState(context);
	return await saveBoard(context, state, mutate(state.board));
}

function placeCard(board: RuntimeBoardData, card: RuntimeBoardCard, columnId: RuntimeBoardColumnId): RuntimeBoardData {
	const withoutCard: RuntimeBoardData = {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.filter((candidate) => candidate.id !== card.id),
		})),
	};
	return {
		...withoutCard,
		columns: withoutCard.columns.map((column) =>
			column.id === columnId ? { ...column, cards: [card, ...column.cards] } : column,
		),
	};
}

function findCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return card;
		}
	}
	throw new ScenarioAssertionError(`Task ${taskId} not found.`);
}

export function moveCard(board: RuntimeBoardData, taskId: string, columnId: RuntimeBoardColumnId): RuntimeBoardData {
	const moved = moveTaskToColumn(board, taskId, columnId);
	if (!moved.moved) {
		throw new ScenarioAssertionError(`Task ${taskId} did not move to ${columnId}.`);
	}
	return moved.board;
}

export function completeTask(
	board: RuntimeBoardData,
	taskId: string,
): ReturnType<typeof completeTaskAndGetReadyLinkedTaskIds> {
	const completed = completeTaskAndGetReadyLinkedTaskIds(board, taskId);
	if (!completed.moved) {
		throw new ScenarioAssertionError(`Task ${taskId} did not move to done.`);
	}
	return completed;
}

async function startTaskSession(context: SelfcheckContext, card: RuntimeBoardCard): Promise<void> {
	const ensure = await requestJson<RuntimeWorktreeEnsureResponse>({
		baseUrl: context.baseUrl,
		procedure: "workspace.ensureWorktree",
		type: "mutation",
		workspaceId: context.workspaceId,
		payload: { taskId: card.id, baseRef: card.baseRef },
	});
	assertOk(ensure.status === 200 && ensure.payload.ok, `Could not ensure worktree for ${card.id}.`);
	assertOk(
		realpathSync(context.fixture.path) === (await loadState(context)).repoPath,
		"Selfcheck fixture path drifted.",
	);
	const start = await requestJson<RuntimeTaskSessionStartResponse>({
		baseUrl: context.baseUrl,
		procedure: "runtime.startTaskSession",
		type: "mutation",
		workspaceId: context.workspaceId,
		payload: {
			taskId: card.id,
			prompt: card.prompt,
			taskTitle: card.title,
			startInPlanMode: card.startInPlanMode,
			baseRef: card.baseRef,
			agentId: card.agentId,
			agentModel: card.agentModel,
			cols: 100,
			rows: 30,
		},
	});
	assertOk(start.status === 200 && start.payload.ok, `Could not start task ${card.id}: ${start.payload.error}`);
}

async function startShellReviewSession(context: SelfcheckContext, taskId: string): Promise<void> {
	const start = await requestJson<RuntimeShellSessionStartResponse>({
		baseUrl: context.baseUrl,
		procedure: "runtime.startShellSession",
		type: "mutation",
		workspaceId: context.workspaceId,
		payload: { taskId, baseRef: "HEAD" },
	});
	assertOk(start.status === 200 && start.payload.ok, `Could not start shell session for ${taskId}.`);
	const hook = await requestJson<RuntimeHookIngestResponse>({
		baseUrl: context.baseUrl,
		procedure: "hooks.ingest",
		type: "mutation",
		payload: { taskId, workspaceId: context.workspaceId, event: "to_review" },
	});
	assertOk(hook.status === 200 && hook.payload.ok, `Review hook failed for ${taskId}: ${hook.payload.error}`);
}

export async function waitFor<T>(resolveValue: () => Promise<T | null>, label: string, timeoutMs = 8_000): Promise<T> {
	const startedAt = Date.now();
	let lastValue: T | null = null;
	while (Date.now() - startedAt < timeoutMs) {
		lastValue = await resolveValue();
		if (lastValue !== null) {
			return lastValue;
		}
		await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
	}
	throw new ScenarioAssertionError(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

export function assertOk(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new ScenarioAssertionError(message);
	}
}
