import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";

const trpcMocks = vi.hoisted(() => ({
	client: {
		projects: {
			add: {
				mutate: vi.fn(),
			},
		},
		runtime: {
			startTaskSession: {
				mutate: vi.fn(),
			},
		},
		workspace: {
			getState: {
				query: vi.fn(),
			},
			ensureWorktree: {
				mutate: vi.fn(),
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
	resolveTaskWorktreeContext: vi.fn().mockResolvedValue(null),
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

const WORKSPACE_PATH = "/tmp/repo";
const TASK_ID = "task-1";
const COLUMN_IDS: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "done", "trash"];

function createCard(): RuntimeBoardCard {
	return {
		id: TASK_ID,
		title: "Reviewed build card",
		prompt: "Address the review feedback",
		autoReviewEnabled: false,
		baseRef: "production-line",
		cardType: "build",
		createdAt: 1,
		updatedAt: 3,
		transitions: [
			{ column: "backlog", at: 1 },
			{ column: "in_progress", at: 2 },
			{ column: "review", at: 3 },
		],
	};
}

function createState(columnId: RuntimeBoardColumnId): RuntimeWorkspaceStateResponse {
	return {
		repoPath: WORKSPACE_PATH,
		statePath: `${WORKSPACE_PATH}/.cline/kanban/board.json`,
		taskWorktreesRoot: `${WORKSPACE_PATH}/.cline/worktrees`,
		git: {
			currentBranch: "production-line",
			defaultBranch: "production-line",
			branches: ["production-line"],
		},
		board: {
			columns: COLUMN_IDS.map((id) => ({
				id,
				title: id,
				cards: id === columnId ? [createCard()] : [],
			})),
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

describe("task start column guard", () => {
	let persistedState: RuntimeWorkspaceStateResponse;
	let stdout = "";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		vi.clearAllMocks();
		stdout = "";
		persistedState = createState("review");
		process.exitCode = undefined;

		trpcMocks.createTRPCProxyClient.mockReturnValue(trpcMocks.client);
		trpcMocks.httpBatchLink.mockReturnValue({});
		trpcMocks.client.projects.add.mutate.mockResolvedValue({
			ok: true,
			project: { id: "workspace-1" },
		});
		trpcMocks.client.workspace.getState.query.mockImplementation(async () => persistedState);
		trpcMocks.client.workspace.ensureWorktree.mutate.mockResolvedValue({ ok: true });
		trpcMocks.client.workspace.notifyStateUpdated.mutate.mockResolvedValue(undefined);
		trpcMocks.client.runtime.startTaskSession.mutate.mockResolvedValue({
			ok: true,
			summary: {
				taskId: TASK_ID,
				state: "running",
			},
		});
		workspaceStateMocks.loadWorkspaceContext.mockResolvedValue({
			repoPath: WORKSPACE_PATH,
			workspaceId: "workspace-1",
			statePath: `${WORKSPACE_PATH}/.cline/kanban/board.json`,
			git: persistedState.git,
		});
		workspaceStateMocks.mutateWorkspaceState.mockImplementation(async (_workspacePath, mutate) => {
			const result = mutate(persistedState);
			persistedState = {
				...persistedState,
				board: result.board,
				revision: persistedState.revision + 1,
			};
			return {
				saved: result.save !== false,
				value: result.value,
			};
		});
		vi.spyOn(process, "cwd").mockReturnValue(WORKSPACE_PATH);
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout += String(chunk);
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	it("given a card in review, when started, then it moves to in_progress and appends that transition", async () => {
		await createTaskProgram().parseAsync(["node", "kanban", "task", "start", "--task-id", TASK_ID]);

		const payload = parseStdoutJson(stdout);
		const reviewCards = persistedState.board.columns.find((column) => column.id === "review")?.cards ?? [];
		const startedCard = persistedState.board.columns.find((column) => column.id === "in_progress")?.cards[0];

		expect(process.exitCode).toBeUndefined();
		expect(payload).toMatchObject({ ok: true, task: { id: TASK_ID, column: "in_progress" } });
		expect(reviewCards).toEqual([]);
		expect(startedCard?.transitions?.map((transition) => transition.column)).toEqual([
			"backlog",
			"in_progress",
			"review",
			"in_progress",
		]);
	});

	it.each(["done", "trash"] as const)(
		"given a card in %s, when started, then it is refused because the column is terminal",
		async (columnId) => {
			persistedState = createState(columnId);

			await createTaskProgram().parseAsync(["node", "kanban", "task", "start", "--task-id", TASK_ID]);

			const payload = parseStdoutJson(stdout);

			expect(process.exitCode).toBe(1);
			expect(payload).toMatchObject({
				ok: false,
				error: expect.stringContaining(`Task "${TASK_ID}" is in "${columnId}" and cannot be started`),
			});
			expect(trpcMocks.client.runtime.startTaskSession.mutate).not.toHaveBeenCalled();
			expect(workspaceStateMocks.mutateWorkspaceState).not.toHaveBeenCalled();
		},
	);
});
