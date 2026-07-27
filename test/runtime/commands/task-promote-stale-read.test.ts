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

function createCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: TASK_ID,
		title: "Reviewed plan",
		prompt: "Implement the reviewed plan",
		autoReviewEnabled: false,
		baseRef: "production-line",
		cardType: "plan",
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
		repoPath: WORKSPACE_PATH,
		statePath: `${WORKSPACE_PATH}/.cline/kanban/board.json`,
		taskWorktreesRoot: `${WORKSPACE_PATH}/.cline/worktrees`,
		git: {
			currentBranch: "production-line",
			defaultBranch: "production-line",
			branches: ["production-line"],
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

describe("task promote stale read", () => {
	let persistedState: RuntimeWorkspaceStateResponse;
	let staleRuntimeState: RuntimeWorkspaceStateResponse;
	let stdout = "";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		stdout = "";
		persistedState = createState({ review: [createCard()] });
		staleRuntimeState = createState({ review: [createCard()] });
		process.exitCode = undefined;

		trpcMocks.createTRPCProxyClient.mockReturnValue(trpcMocks.client);
		trpcMocks.httpBatchLink.mockReturnValue({});
		trpcMocks.client.projects.add.mutate.mockResolvedValue({
			ok: true,
			project: { id: "workspace-1" },
		});
		trpcMocks.client.workspace.getState.query.mockImplementation(async () => staleRuntimeState);
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

	it("given a reviewed plan card and stale runtime reads, when promoted, then it starts from the promoted in_progress card", async () => {
		await createTaskProgram().parseAsync(["node", "kanban", "task", "promote", TASK_ID]);

		const payload = parseStdoutJson(stdout);
		const reviewCard = persistedState.board.columns.find((column) => column.id === "review")?.cards[0] ?? null;
		const inProgressCard =
			persistedState.board.columns.find((column) => column.id === "in_progress")?.cards[0] ?? null;

		expect(process.exitCode).toBeUndefined();
		expect(payload).toMatchObject({
			ok: true,
			task: {
				id: TASK_ID,
				column: "in_progress",
				cardType: "build",
			},
		});
		expect(reviewCard).toBeNull();
		expect(inProgressCard).toMatchObject({
			id: TASK_ID,
			cardType: "build",
		});
		expect(trpcMocks.client.runtime.startTaskSession.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: TASK_ID,
				prompt: "Implement the reviewed plan",
				taskTitle: "Reviewed plan",
				baseRef: "production-line",
				cardType: "build",
			}),
		);
	});
});
