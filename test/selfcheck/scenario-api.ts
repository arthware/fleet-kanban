import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeConfigResponse,
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
import {
	LINKED_CHILD_TASK_ID,
	LINKED_PARENT_TASK_ID,
	STUB_LIFECYCLE_TASK_ID,
	seedIsolatedBoardState,
} from "../utilities/board-seed";
import { createGitTestEnv } from "../utilities/git-env";
import { type IsolatedKanbanInstance, startIsolatedKanbanInstance } from "../utilities/kanban-test-instance";
import { createPetRepoFixtureCopy, type PetRepoFixture } from "../utilities/pet-repo-fixture";
import { createTempDir } from "../utilities/temp-dir";
import { requestJson } from "../utilities/trpc-request";
import { connectRuntimeStream, type RuntimeStreamClient } from "./runtime-stream";

export interface SelfcheckContext {
	instance: IsolatedKanbanInstance;
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
}

export class ScenarioAssertionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScenarioAssertionError";
	}
}

const DEFAULT_COLUMNS: Array<{ id: RuntimeBoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "done", title: "Done" },
	{ id: "trash", title: "Trash" },
];

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
	let instance: IsolatedKanbanInstance;
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
				procedure: "runtime.sendTaskInput",
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
			} catch (err: any) {
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
	};
}

export async function givenReviewCardWhenSteeredThenMovesToInProgress(driver: ScenarioDriver): Promise<void> {
	const taskId = "selfcheck-steer-review";
	await driver.createCard({
		column: "review",
		card: createSelfcheckCard({
			id: taskId,
			title: "Selfcheck steer review",
			prompt: "Wait for steering input.",
		}),
	});
	await driver.startCard(taskId);
	await driver.expectColumn(taskId, "review");
	await driver.steerCard(taskId, "Continue after review.");
	await driver.expectColumn(taskId, "in_progress");
}

export async function givenLifecycleCardWhenCompletedThenLinkedCardStarts(driver: ScenarioDriver): Promise<void> {
	const context = driverContext(driver);
	seedIsolatedBoardState({ homeDir: context.instance.homeDir, workspaceId: context.workspaceId });
	const config = await requestJson<RuntimeConfigResponse>({
		baseUrl: context.baseUrl,
		procedure: "runtime.getConfig",
		type: "query",
		workspaceId: context.workspaceId,
	});
	assertOk(config.status === 200, "Could not load runtime config.");
	assertOk(config.payload.effectiveCommand?.includes("stub-agent.mjs"), "Runtime is not using the stub agent.");

	await driver.expectColumn(STUB_LIFECYCLE_TASK_ID, "backlog");
	await driver.startCard(STUB_LIFECYCLE_TASK_ID);
	await waitFor(async () => {
		const state = await loadState(context);
		const summary = state.sessions[STUB_LIFECYCLE_TASK_ID];
		return summary?.state === "awaiting_review" && summary.exitCode === 0 ? true : null;
	}, "stub card to reach review");
	await mutateBoard(context, (board) => moveCard(board, STUB_LIFECYCLE_TASK_ID, "review"));
	await driver.expectColumn(STUB_LIFECYCLE_TASK_ID, "review");
	await mutateBoard(context, (board) => completeTask(board, STUB_LIFECYCLE_TASK_ID).board);
	await driver.expectColumn(STUB_LIFECYCLE_TASK_ID, "done");
	await mutateBoard(context, (board) =>
		moveCard(moveCard(board, LINKED_PARENT_TASK_ID, "in_progress"), LINKED_PARENT_TASK_ID, "review"),
	);
	const completed = completeTask((await loadState(context)).board, LINKED_PARENT_TASK_ID);
	assertOk(
		completed.readyTaskIds.includes(LINKED_CHILD_TASK_ID),
		"Completing the linked parent did not unblock child.",
	);
	await mutateBoard(context, () => completed.board);
	await driver.startCard(LINKED_CHILD_TASK_ID);
	await driver.expectColumn(LINKED_CHILD_TASK_ID, "in_progress");
}

export async function givenCardWithGoneAgentWhenStartedThenNewAgentRuns(driver: ScenarioDriver): Promise<void> {
	const context = driverContext(driver);
	const taskId = "selfcheck-restart-after-gone";
	const card = createSelfcheckCard({
		id: taskId,
		title: "Selfcheck restart after gone",
		agentId: "claude",
		baseRef: "main",
	});
	await driver.createCard({
		column: "backlog",
		card,
	});

	await driver.expectColumn(taskId, "backlog");
	await driver.startCard(taskId);
	await driver.expectColumn(taskId, "in_progress");

	// Capture initial PID
	const pid1 = await driver.expectAgentRunning(taskId);
	assertOk(pid1 > 0, "Agent PID must be greater than 0");

	// Write a sentinel file with known content into the card's worktree, and leave it UNCOMMITTED.
	const ensured = await requestJson<RuntimeWorktreeEnsureResponse>({
		baseUrl: context.baseUrl,
		procedure: "workspace.ensureWorktree",
		type: "mutation",
		workspaceId: context.workspaceId,
		payload: { taskId, baseRef: "main" },
	});
	assertOk(ensured.status === 200 && ensured.payload.ok, "Could not ensure worktree to write sentinel.");
	const worktreePath = ensured.payload.path;
	const sentinelPath = join(worktreePath, "restart-sentinel.txt");
	writeFileSync(sentinelPath, "survivor\n", "utf8");

	// Kill the agent process, then expect session gone.
	await driver.killAgentProcess(taskId);
	await driver.expectSessionGone(taskId);

	// Start card a second time
	await driver.startCard(taskId);

	// Assert pid2 = expectAgentRunning(taskId) is a live pid and pid2 !== pid1
	const pid2 = await driver.expectAgentRunning(taskId);
	assertOk(pid2 > 0, "Second agent PID must be greater than 0");
	assertOk(pid2 !== pid1, "New agent process must have a different PID than the killed one");

	// Assert the sentinel file still exists with identical content
	assertOk(existsSync(sentinelPath), "Sentinel file must survive restart");
	const sentinelContent = readFileSync(sentinelPath, "utf8");
	assertOk(sentinelContent === "survivor\n", "Sentinel file content must be untouched");
}

export async function givenReviewHookWhenIngestedThenOverseerIsNotified(driver: ScenarioDriver): Promise<void> {
	const taskId = "selfcheck-review-ping";
	await driver.createCard({
		column: "review",
		card: createSelfcheckCard({
			id: taskId,
			title: "Selfcheck review ping",
		}),
	});
	await driver.startCard(taskId);
	await driver.expectOverseerNotified(taskId);
}

export async function givenWorktreeShapesWhenEnsuredThenTheyKeepTheExpectedArtifacts(): Promise<void> {
	const sandbox = createTempDir("kanban-selfcheck-worktree-shapes-");
	let instance: IsolatedKanbanInstance | null = null;
	try {
		const { repoPath, depPath } = createWorktreeShapeRepos(sandbox.path);
		instance = await startIsolatedKanbanInstance({
			cwd: repoPath,
			env: { GIT_ALLOW_PROTOCOL: "file" },
		});
		const baseUrl = new URL(instance.baseUrl).origin;
		const workspaceId = await resolveCurrentWorkspaceId(baseUrl);
		const shape1Path = await ensureWorktree(baseUrl, workspaceId, instance.homeDir, "task-card", "main");
		assertShape(shape1Path);

		const fleetDir = join(sandbox.path, "fleet_project", ".fleet");
		mkdirSync(fleetDir, { recursive: true });
		writeFileSync(
			join(fleetDir, "config.json"),
			JSON.stringify({ kanban_port: instance.port, repos: ["main-repo"] }),
		);
		const epic = runFleetCli(["epic", "create", "cool-epic", "--repo", "main-repo", "--base", "main"], {
			FLEET_DIR: fleetDir,
			CLINE_HOME: instance.homeDir,
			HOME: instance.homeDir,
			USERPROFILE: instance.homeDir,
			GIT_ALLOW_PROTOCOL: "file",
		});
		assertOk(epic.status === 0, `fleet epic create failed: ${epic.stderr || epic.stdout}`);
		assertShape(join(instance.homeDir, "epics", "main-repo@cool-epic"));

		const projects = await requestJson<RuntimeProjectsResponse>({
			baseUrl,
			procedure: "projects.list",
			type: "query",
		});
		const epicWorkspaceId =
			projects.payload.projects.find((project) => project.epic?.name === "cool-epic")?.id ?? null;
		if (!epicWorkspaceId) {
			throw new ScenarioAssertionError("Epic workspace was not registered.");
		}
		const shape3Path = await ensureWorktree(
			baseUrl,
			epicWorkspaceId,
			instance.homeDir,
			"epic-task-card",
			"epic/cool-epic",
		);
		assertShape(shape3Path);
		void depPath;
	} finally {
		await instance?.stop();
		sandbox.cleanup();
	}
}

export async function givenCliContractWhenExercisedThenHelpAndUsageExitCorrectly(): Promise<void> {
	const help = spawnSync(
		process.execPath,
		["--import", resolveTsxLoader(), resolve(process.cwd(), "src/cli.ts"), "--help"],
		{
			encoding: "utf8",
			env: createGitTestEnv(),
		},
	);
	assertOk(help.status === 0, `kanban --help exited ${String(help.status)}: ${help.stderr}`);
	assertOk(help.stdout.includes("Usage:"), "kanban --help did not print usage.");
	const usage = spawnSync(
		process.execPath,
		["--import", resolveTsxLoader(), resolve(process.cwd(), "src/cli.ts"), "task", "start"],
		{
			encoding: "utf8",
			env: createGitTestEnv(),
		},
	);
	assertOk(usage.status !== 0, "kanban task start without --task-id exited zero.");
}

function driverContext(driver: ScenarioDriver): SelfcheckContext {
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

async function resolveCurrentWorkspaceId(baseUrl: string): Promise<string> {
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

async function loadState(context: SelfcheckContext): Promise<RuntimeWorkspaceStateResponse> {
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

async function mutateBoard(
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

function moveCard(board: RuntimeBoardData, taskId: string, columnId: RuntimeBoardColumnId): RuntimeBoardData {
	const moved = moveTaskToColumn(board, taskId, columnId);
	if (!moved.moved) {
		throw new ScenarioAssertionError(`Task ${taskId} did not move to ${columnId}.`);
	}
	return moved.board;
}

function completeTask(
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

async function waitFor<T>(resolveValue: () => Promise<T | null>, label: string, timeoutMs = 8_000): Promise<T> {
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

function createWorktreeShapeRepos(root: string): { repoPath: string; depPath: string } {
	const fleetProjectDir = join(root, "fleet_project");
	const depPath = join(root, "dependency-repo");
	const repoPath = join(fleetProjectDir, "main-repo");
	mkdirSync(depPath, { recursive: true });
	runGit(depPath, ["init", "-b", "main"]);
	writeFileSync(join(depPath, "dep-file.txt"), "submodule-content\n", "utf8");
	runGit(depPath, ["add", "dep-file.txt"]);
	runGit(depPath, ["commit", "-m", "init-dep"]);

	mkdirSync(repoPath, { recursive: true });
	runGit(repoPath, ["init", "-b", "main"]);
	runGit(repoPath, ["config", "protocol.file.allow", "always"]);
	writeFileSync(join(repoPath, "README.md"), "main-content\n", "utf8");
	writeFileSync(join(repoPath, ".gitignore"), ".env\n.env.local\n/node_modules/\n/dist/\n/.turbo/\n", "utf8");
	writeFileSync(join(repoPath, ".env"), "ENV_VAR=value\n", "utf8");
	writeFileSync(join(repoPath, ".env.local"), "ENV_LOCAL=local-value\n", "utf8");
	mkdirSync(join(repoPath, "node_modules"), { recursive: true });
	writeFileSync(join(repoPath, "node_modules", "ignore.txt"), "ignored-node-module\n", "utf8");
	mkdirSync(join(repoPath, "dist"), { recursive: true });
	writeFileSync(join(repoPath, "dist", "built.js"), "compiled-js\n", "utf8");
	mkdirSync(join(repoPath, ".turbo"), { recursive: true });
	writeFileSync(join(repoPath, ".turbo", "cache.json"), '{"cached":true}\n', "utf8");
	mkdirSync(join(repoPath, ".cline", "kanban"), { recursive: true });
	writeFileSync(
		join(repoPath, ".cline", "kanban", "config.json"),
		JSON.stringify(
			{
				worktree: {
					postCreateCommand: "echo 'hook-ran' > post-create-marker.txt",
					unsharedPaths: ["node_modules", "dist", ".turbo"],
				},
			},
			null,
			2,
		),
		"utf8",
	);
	runGit(repoPath, ["add", "README.md", ".gitignore", ".cline/kanban/config.json"]);
	runGit(repoPath, ["commit", "-m", "init-main"]);
	runGit(repoPath, ["-c", "protocol.file.allow=always", "submodule", "add", depPath, "vendor/submodule"]);
	runGit(repoPath, ["commit", "-m", "add-submodule"]);
	return { repoPath, depPath };
}

async function ensureWorktree(
	baseUrl: string,
	workspaceId: string,
	homeDir: string,
	taskId: string,
	baseRef: string,
): Promise<string> {
	seedIsolatedBoardState({
		homeDir,
		workspaceId,
		board: {
			columns: DEFAULT_COLUMNS.map((column) => ({
				...column,
				cards: column.id === "backlog" ? [createSelfcheckCard({ id: taskId, title: taskId, baseRef })] : [],
			})),
			dependencies: [],
		},
	});
	const ensured = await requestJson<RuntimeWorktreeEnsureResponse>({
		baseUrl,
		procedure: "workspace.ensureWorktree",
		type: "mutation",
		workspaceId,
		payload: { taskId, baseRef },
	});
	assertOk(ensured.status === 200 && ensured.payload.ok, `Could not ensure worktree ${taskId}.`);
	return ensured.payload.path;
}

function assertShape(worktreePath: string): void {
	assertOk(
		existsSync(join(worktreePath, ".env")) && lstatSync(join(worktreePath, ".env")).isSymbolicLink(),
		".env was not a symlink.",
	);
	assertOk(
		existsSync(join(worktreePath, ".env.local")) && lstatSync(join(worktreePath, ".env.local")).isSymbolicLink(),
		".env.local was not a symlink.",
	);
	assertOk(existsSync(join(worktreePath, "vendor", "submodule", "dep-file.txt")), "Submodule was not checked out.");
	for (const path of ["node_modules", "dist", ".turbo"]) {
		assertOk(!existsSync(join(worktreePath, path)), `${path} should not be present in worktree.`);
	}
	assertOk(
		readFileSync(join(worktreePath, "post-create-marker.txt"), "utf8").trim() === "hook-ran",
		"postCreateCommand did not run.",
	);
}

function runFleetCli(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("python3", [resolve(process.cwd(), "fleet-cli/fleet.py"), ...args], {
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
	return { status: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv({ GIT_ALLOW_PROTOCOL: "file" }),
	});
	if (result.status !== 0) {
		throw new ScenarioAssertionError(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

function resolveTsxLoader(): string {
	return new URL(import.meta.resolve("tsx")).href;
}

function assertOk(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new ScenarioAssertionError(message);
	}
}

export async function givenCardWithModelOverrideWhenStartedThenCliReceivesModel(driver: ScenarioDriver): Promise<void> {
	const _context = driverContext(driver);

	// Card A: created with a per-card model override, started.
	// Assert the recorded argv contains `--model` followed by exactly that override value.
	const taskIdA = "card-a-override";
	await driver.createCard({
		column: "backlog",
		card: createSelfcheckCard({
			id: taskIdA,
			title: "Card A override model",
			agentModel: "sonnet-3-5",
		}),
	});
	await driver.startCard(taskIdA);
	const argvA = await driver.readLaunchedArgv(taskIdA);
	assertOk(argvA.includes("--model"), `Card A argv should contain --model, got ${JSON.stringify(argvA)}`);
	const modelIndexA = argvA.indexOf("--model");
	assertOk(
		argvA[modelIndexA + 1] === "sonnet-3-5",
		`Card A model override should be sonnet-3-5, got ${argvA[modelIndexA + 1]}`,
	);

	// Card C: created with no override, started.
	// Assert the recorded argv contains no `--model` at all.
	const taskIdC = "card-c-no-override";
	await driver.createCard({
		column: "backlog",
		card: createSelfcheckCard({
			id: taskIdC,
			title: "Card C no override",
		}),
	});
	await driver.startCard(taskIdC);
	const argvC = await driver.readLaunchedArgv(taskIdC);
	assertOk(!argvC.includes("--model"), "Card C argv should not contain --model");

	// Card B: created with a per-card model override AND a user-supplied `--model` already present in the configured agent args, started.
	// Assert the recorded argv contains the user's value and does NOT contain the card override.
	const stubAgentPath = resolve(process.cwd(), "test/fixtures/stub-agent/stub-agent.mjs");
	const bFixture = createPetRepoFixtureCopy("kanban-selfcheck-pet-repo-b-");
	let bInstance: IsolatedKanbanInstance | null = null;
	try {
		bInstance = await startIsolatedKanbanInstance({
			cwd: bFixture.path,
			env: {
				KANBAN_TEST_AGENT_BINARY: stubAgentPath,
				KANBAN_TEST_AGENT_ARGS_JSON: JSON.stringify(["--model", "user-wins-model"]),
			},
		});
		const bBaseUrl = new URL(bInstance.baseUrl).origin;
		const bWorkspaceId = await resolveCurrentWorkspaceId(bBaseUrl);
		const bContext = {
			instance: bInstance,
			baseUrl: bBaseUrl,
			workspaceId: bWorkspaceId,
			fixture: bFixture,
			stop: async () => {},
		};
		const bDriver = attachContext(createTrpcScenarioDriver(bContext), bContext);

		const taskIdB = "card-b-user-supplied";
		await bDriver.createCard({
			column: "backlog",
			card: createSelfcheckCard({
				id: taskIdB,
				title: "Card B user supplied model",
				agentModel: "should-be-overridden",
			}),
		});
		await bDriver.startCard(taskIdB);
		const argvB = await bDriver.readLaunchedArgv(taskIdB);
		assertOk(argvB.includes("--model"), "Card B argv should contain --model");
		const modelIndexB = argvB.indexOf("--model");
		assertOk(
			argvB[modelIndexB + 1] === "user-wins-model",
			`Card B model should be user-wins-model, got ${argvB[modelIndexB + 1]}`,
		);
		const occurrences = argvB.filter((arg) => arg === "--model").length;
		assertOk(occurrences === 1, `Card B argv should contain --model exactly once, got ${occurrences}`);
		assertOk(
			!argvB.includes("should-be-overridden"),
			"Card B argv should not contain the card override value when user supplied it",
		);
	} finally {
		if (bInstance) {
			await bInstance.stop();
		}
		bFixture.cleanup();
	}
}
