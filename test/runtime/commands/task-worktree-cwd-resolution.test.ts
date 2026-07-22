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
			notifyTaskReadyForReview: {
				mutate: vi.fn(),
			},
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

describe("task commands resolve cwd inside a task worktree without --project-path", () => {
	let state: RuntimeWorkspaceStateResponse;
	let stdout = "";
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		stdout = "";
		state = createState({ backlog: [createCard(), createCard({ id: "other-task" })] });
		process.exitCode = undefined;

		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(WORKTREE_CWD);
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
		trpcMocks.client.runtime.notifyTaskReadyForReview.mutate.mockResolvedValue({
			ok: true,
			taskId: WORKTREE_TASK_ID,
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
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	it("resolves the registered workspace from the worktree's main repo path, not the raw worktree cwd, for task review", async () => {
		await createTaskProgram().parseAsync(["node", "kanban", "task", "review"]);

		expect(cwdSpy).toHaveBeenCalled();
		expect(taskWorktreeContextMocks.resolveTaskWorktreeContext).toHaveBeenCalledWith(WORKTREE_CWD);
		expect(workspaceStateMocks.loadWorkspaceContext).toHaveBeenCalledWith(
			MAIN_REPO_PATH,
			expect.objectContaining({ autoCreateIfMissing: false }),
		);
		expect(trpcMocks.client.runtime.notifyTaskReadyForReview.mutate).toHaveBeenCalledWith({
			taskId: WORKTREE_TASK_ID,
		});
		expect(process.exitCode).toBeUndefined();
	});

	it("defaults the task id to the current worktree's card for task review when no id is given", async () => {
		await createTaskProgram().parseAsync(["node", "kanban", "task", "review"]);

		const payload = parseStdoutJson(stdout);
		expect(payload.ok).toBe(true);
		expect(trpcMocks.client.runtime.notifyTaskReadyForReview.mutate).toHaveBeenCalledWith({
			taskId: WORKTREE_TASK_ID,
		});
	});

	it("defaults the task id to the current worktree's card for task done when no --task-id or --column is given", async () => {
		await createTaskProgram().parseAsync(["node", "kanban", "task", "done"]);

		const payload = parseStdoutJson(stdout);
		expect(process.exitCode).toBeUndefined();
		expect(payload.ok).toBe(true);
		expect(payload.task).toMatchObject({ id: WORKTREE_TASK_ID, column: "done" });
	});

	it("defaults the task id to the current worktree's card for task update when no --task-id is given", async () => {
		await createTaskProgram().parseAsync(["node", "kanban", "task", "update", "--title", "New title"]);

		const payload = parseStdoutJson(stdout);
		expect(process.exitCode).toBeUndefined();
		expect(payload.ok).toBe(true);
		expect(payload.task).toMatchObject({ id: WORKTREE_TASK_ID, title: "New title" });
	});

	it("defaults the primary task id to the current worktree's card for task link when no --task-id is given", async () => {
		await createTaskProgram().parseAsync(["node", "kanban", "task", "link", "--linked-task-id", "other-task"]);

		const payload = parseStdoutJson(stdout);
		expect(process.exitCode).toBeUndefined();
		expect(payload.ok).toBe(true);
		expect(state.board.dependencies).toHaveLength(1);
	});

	it("still fails clearly when cwd is neither a worktree nor given --project-path/--task-id", async () => {
		taskWorktreeContextMocks.resolveTaskWorktreeContext.mockResolvedValue(null);

		await createTaskProgram().parseAsync(["node", "kanban", "task", "done"]);

		const payload = parseStdoutJson(stdout);
		expect(process.exitCode).toBe(1);
		expect(payload.ok).toBe(false);
		expect(payload.error).toContain("task done requires either --task-id or --column.");
	});
});
