import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardCard, RuntimeWorkspaceStateResponse } from "../../../src/core/api-contract";

const trpcMocks = vi.hoisted(() => ({
	client: {
		projects: {
			add: {
				mutate: vi.fn(),
			},
		},
		runtime: {
			stopTaskSession: {
				mutate: vi.fn(),
			},
		},
		workspace: {
			getState: {
				query: vi.fn(),
			},
			notifyStateUpdated: {
				mutate: vi.fn(),
			},
		},
	},
	createTRPCProxyClient: vi.fn(),
	httpBatchLink: vi.fn(),
}));

const workspaceStateMocks = vi.hoisted(() => ({
	loadWorkspaceContext: vi.fn(),
	mutateWorkspaceState: vi.fn(),
}));

const taskWorktreeContextMocks = vi.hoisted(() => ({
	resolveTaskWorktreeContext: vi.fn(),
}));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: trpcMocks.createTRPCProxyClient,
	httpBatchLink: trpcMocks.httpBatchLink,
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	loadWorkspaceContext: workspaceStateMocks.loadWorkspaceContext,
	mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState,
}));

vi.mock("../../../src/workspace/task-worktree-context.js", () => ({
	resolveTaskWorktreeContext: taskWorktreeContextMocks.resolveTaskWorktreeContext,
}));

import { registerTaskCommand } from "../../../src/commands/task";

const MAIN_REPO_PATH = "/main/repo";
const WORKTREE_CWD = "/main/.cline/worktrees/card-42/repo";
const WORKTREE_TASK_ID = "card-42";

function createCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: WORKTREE_TASK_ID,
		title: "Task in worktree",
		prompt: "Prompt",
		startInPlanMode: false,
		autoReviewEnabled: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createState(
	cardsByColumn: Partial<
		Record<RuntimeWorkspaceStateResponse["board"]["columns"][number]["id"], RuntimeBoardCard[]>
	> = {},
): RuntimeWorkspaceStateResponse {
	return {
		repoPath: MAIN_REPO_PATH,
		statePath: `${MAIN_REPO_PATH}/.cline/kanban/board.json`,
		taskWorktreesRoot: `${MAIN_REPO_PATH}/.cline/worktrees`,
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board: {
			columns: [
				{ id: "backlog", title: "Backlog", cards: cardsByColumn.backlog ?? [] },
				{ id: "in_progress", title: "In Progress", cards: cardsByColumn.in_progress ?? [] },
				{ id: "review", title: "Review", cards: cardsByColumn.review ?? [] },
				{ id: "done", title: "Done", cards: cardsByColumn.done ?? [] },
				{ id: "trash", title: "Trash", cards: cardsByColumn.trash ?? [] },
			],
			dependencies: [],
		},
		sessions: {},
		revision: 1,
	};
}

function createTaskProgram(): Command {
	const program = new Command();
	program.exitOverride();
	program.name("kanban");
	registerTaskCommand(program);
	return program;
}

function parseStdoutJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

describe("task update description guards", () => {
	let state: RuntimeWorkspaceStateResponse;
	let stdout = "";
	let _stderr = "";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		stdout = "";
		_stderr = "";
		state = createState();
		process.exitCode = undefined;

		taskWorktreeContextMocks.resolveTaskWorktreeContext.mockReset();
		taskWorktreeContextMocks.resolveTaskWorktreeContext.mockImplementation(async (cwd: string) =>
			cwd === WORKTREE_CWD ? { taskId: WORKTREE_TASK_ID, mainRepoPath: MAIN_REPO_PATH } : null,
		);

		trpcMocks.createTRPCProxyClient.mockReturnValue(trpcMocks.client);
		trpcMocks.httpBatchLink.mockReturnValue({});
		trpcMocks.client.projects.add.mutate.mockResolvedValue({
			ok: true,
			project: { id: "workspace-1" },
		});
		trpcMocks.client.runtime.stopTaskSession.mutate.mockResolvedValue({ ok: true });
		trpcMocks.client.workspace.getState.query.mockImplementation(async () => state);
		trpcMocks.client.workspace.notifyStateUpdated.mutate.mockResolvedValue(undefined);
		workspaceStateMocks.loadWorkspaceContext.mockResolvedValue({
			repoPath: MAIN_REPO_PATH,
			workspaceId: "workspace-1",
			statePath: `${MAIN_REPO_PATH}/.cline/kanban/board.json`,
			git: state.git,
		});
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(async (_workspacePath, mutate) => {
			const result = mutate(state);
			state = {
				...state,
				board: result.board,
				revision: state.revision + 1,
			};
			return {
				saved: result.save !== false,
				value: result.value,
			};
		});
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout += String(chunk);
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			_stderr += String(chunk);
			return true;
		});
	});

	it("given a backlog card, when task update is called with prompt or title, then it succeeds", async () => {
		state = createState({
			backlog: [createCard({ id: WORKTREE_TASK_ID, title: "Original Title", prompt: "Original Prompt" })],
		});

		await createTaskProgram().parseAsync([
			"node",
			"kanban",
			"task",
			"update",
			"--task-id",
			WORKTREE_TASK_ID,
			"--title",
			"Updated Title",
			"--prompt",
			"Updated Prompt",
		]);

		const payload = parseStdoutJson(stdout);
		expect(payload.ok).toBe(true);
		expect(payload.task).toMatchObject({
			id: WORKTREE_TASK_ID,
			title: "Updated Title",
			prompt: "Updated Prompt",
		});
		expect(process.exitCode).toBeUndefined();
	});

	it("given an in_progress card, when task update is called with prompt, then it rejects with clear error and non-zero exit", async () => {
		state = createState({
			in_progress: [createCard({ id: WORKTREE_TASK_ID, title: "Original Title", prompt: "Original Prompt" })],
		});

		await createTaskProgram().parseAsync([
			"node",
			"kanban",
			"task",
			"update",
			"--task-id",
			WORKTREE_TASK_ID,
			"--prompt",
			"Updated Prompt",
		]);

		const payload = parseStdoutJson(stdout);
		expect(payload.ok).toBe(false);
		expect(payload.error).toContain(
			"cannot edit the prompt of card card-42: it is in in_progress (started); prompt/title are editable only in backlog",
		);
		expect(process.exitCode).toBe(1);
	});

	it("given a review card, when task update is called with title, then it rejects with clear error and non-zero exit", async () => {
		state = createState({
			review: [createCard({ id: WORKTREE_TASK_ID, title: "Original Title", prompt: "Original Prompt" })],
		});

		await createTaskProgram().parseAsync([
			"node",
			"kanban",
			"task",
			"update",
			"--task-id",
			WORKTREE_TASK_ID,
			"--title",
			"Updated Title",
		]);

		const payload = parseStdoutJson(stdout);
		expect(payload.ok).toBe(false);
		expect(payload.error).toContain(
			"cannot edit the title of card card-42: it is in review (started); prompt/title are editable only in backlog",
		);
		expect(process.exitCode).toBe(1);
	});

	it("given a started card, when task update is called changing other fields like autoReviewEnabled, then it succeeds", async () => {
		state = createState({
			in_progress: [
				createCard({
					id: WORKTREE_TASK_ID,
					title: "Original Title",
					prompt: "Original Prompt",
					autoReviewEnabled: false,
				}),
			],
		});

		await createTaskProgram().parseAsync([
			"node",
			"kanban",
			"task",
			"update",
			"--task-id",
			WORKTREE_TASK_ID,
			"--auto-review-enabled",
		]);

		const payload = parseStdoutJson(stdout);
		expect(payload.ok).toBe(true);
		expect(payload.task).toMatchObject({
			id: WORKTREE_TASK_ID,
			autoReviewEnabled: true,
		});
		expect(process.exitCode).toBeUndefined();
	});
});
