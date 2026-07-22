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

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: trpcMocks.createTRPCProxyClient,
	httpBatchLink: trpcMocks.httpBatchLink,
}));

vi.mock("../../../src/state/workspace-state.js", () => ({
	loadWorkspaceContext: workspaceStateMocks.loadWorkspaceContext,
	mutateWorkspaceState: workspaceStateMocks.mutateWorkspaceState,
}));

import { registerTaskCommand } from "../../../src/commands/task";

const WORKSPACE_PATH = "/tmp/repo";

function createCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: "task-1",
		title: "Task one",
		prompt: "Task one prompt",
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
		repoPath: WORKSPACE_PATH,
		statePath: `${WORKSPACE_PATH}/.cline/kanban/board.json`,
		taskWorktreesRoot: `${WORKSPACE_PATH}/.cline/worktrees`,
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

describe("task mutation output when realtime notify fails", () => {
	let state: RuntimeWorkspaceStateResponse;
	let stdout = "";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		stdout = "";
		state = createState();
		process.exitCode = undefined;
		trpcMocks.createTRPCProxyClient.mockReturnValue(trpcMocks.client);
		trpcMocks.httpBatchLink.mockReturnValue({});
		trpcMocks.client.projects.add.mutate.mockResolvedValue({
			ok: true,
			project: { id: "workspace-1" },
		});
		trpcMocks.client.runtime.stopTaskSession.mutate.mockResolvedValue({ ok: true });
		trpcMocks.client.workspace.getState.query.mockImplementation(async () => state);
		trpcMocks.client.workspace.notifyStateUpdated.mutate.mockRejectedValue(new Error("notify timed out"));
		workspaceStateMocks.loadWorkspaceContext.mockResolvedValue({
			repoPath: WORKSPACE_PATH,
			workspaceId: "workspace-1",
			statePath: `${WORKSPACE_PATH}/.cline/kanban/board.json`,
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
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
	});

	it("prints created-card JSON including agentModel after the board write commits", async () => {
		await createTaskProgram().parseAsync([
			"node",
			"kanban",
			"task",
			"create",
			"--prompt",
			"Create a design card",
			"--agent-id",
			"codex",
			"--agent-model",
			"claude-opus-4-8",
		]);

		const payload = parseStdoutJson(stdout);

		expect(process.exitCode).toBeUndefined();
		expect(payload.ok).toBe(true);
		expect(payload.task).toMatchObject({
			id: expect.any(String),
			prompt: "Create a design card",
			agentId: "codex",
			agentModel: "claude-opus-4-8",
		});
		expect(state.board.columns.find((column) => column.id === "backlog")?.cards[0]?.agentModel).toBe(
			"claude-opus-4-8",
		);
	});

	it("prints done-task JSON after the board write commits", async () => {
		state = createState({ backlog: [createCard()] });

		await createTaskProgram().parseAsync(["node", "kanban", "task", "done", "--task-id", "task-1"]);

		const payload = parseStdoutJson(stdout);

		expect(process.exitCode).toBeUndefined();
		expect(payload.ok).toBe(true);
		expect(payload.task).toMatchObject({
			id: "task-1",
			column: "done",
		});
		expect(state.board.columns.find((column) => column.id === "done")?.cards[0]?.id).toBe("task-1");
	});
});
