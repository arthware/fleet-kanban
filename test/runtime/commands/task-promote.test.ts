import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeWorkspaceStateResponse } from "../../../src/core/api-contract";

const trpcMocks = vi.hoisted(() => {
	const mockGetState = vi.fn();
	const mockEnsureWorktree = vi.fn();
	const mockStartTaskSession = vi.fn();
	const mockProjectsAdd = vi.fn();
	const mockNotifyStateUpdated = vi.fn();

	return {
		mockGetState,
		mockEnsureWorktree,
		mockStartTaskSession,
		mockProjectsAdd,
		mockNotifyStateUpdated,
		client: {
			projects: {
				add: {
					mutate: mockProjectsAdd,
				},
			},
			workspace: {
				getState: {
					query: mockGetState,
				},
				ensureWorktree: {
					mutate: mockEnsureWorktree,
				},
				notifyStateUpdated: {
					mutate: mockNotifyStateUpdated,
				},
			},
			runtime: {
				startTaskSession: {
					mutate: mockStartTaskSession,
				},
			},
		},
		createTRPCProxyClient: vi.fn(),
		httpBatchLink: vi.fn(),
	};
});

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

import { promoteTaskCommand } from "../../../src/commands/task";

describe("task promote command", () => {
	beforeEach(() => {
		trpcMocks.createTRPCProxyClient.mockReturnValue(trpcMocks.client);
		trpcMocks.httpBatchLink.mockReturnValue({});
		trpcMocks.mockGetState.mockReset();
		trpcMocks.mockEnsureWorktree.mockReset();
		trpcMocks.mockStartTaskSession.mockReset();
		trpcMocks.mockProjectsAdd.mockReset();
		trpcMocks.mockNotifyStateUpdated.mockReset();
		workspaceStateMocks.loadWorkspaceContext.mockReset();
		workspaceStateMocks.mutateWorkspaceState.mockReset();

		workspaceStateMocks.loadWorkspaceContext.mockResolvedValue({
			repoPath: "/tmp/repo",
			workspaceId: "workspace-1",
			statePath: "/tmp/state",
			git: {
				currentBranch: "main",
				defaultBranch: "main",
				branches: ["main"],
			},
		});

		trpcMocks.mockProjectsAdd.mockResolvedValue({
			ok: true,
			project: {
				id: "workspace-1",
			},
		});
		trpcMocks.mockNotifyStateUpdated.mockResolvedValue({ ok: true });
	});

	it("promotes a plan card in review to a build card and moves it to in_progress", async () => {
		const taskId = "card-123";
		const mockState: RuntimeWorkspaceStateResponse = {
			repoPath: "/tmp/repo",
			statePath: "/tmp/state",
			taskWorktreesRoot: "/tmp/worktrees",
			revision: 1,
			git: {
				currentBranch: "main",
				defaultBranch: "main",
				branches: ["main"],
			},
			board: {
				columns: [
					{ id: "backlog", title: "Backlog", cards: [] },
					{ id: "in_progress", title: "In Progress", cards: [] },
					{
						id: "review",
						title: "Review",
						cards: [
							{
								id: taskId,
								title: "Design the login form",
								prompt: "Create login UI",
								baseRef: "main",
								cardType: "plan",
								autoReviewEnabled: false,
								createdAt: Date.now(),
								updatedAt: Date.now(),
							},
						],
					},
					{ id: "done", title: "Done", cards: [] },
					{ id: "trash", title: "Trash", cards: [] },
				],
				dependencies: [],
			},
			sessions: {},
		};

		// Mock the initial updateRuntimeWorkspaceState during promoteTaskCommand
		workspaceStateMocks.mutateWorkspaceState.mockImplementation((_cwd, mutate) => {
			const res = mutate(mockState);
			return Promise.resolve({
				value: res.value,
				state: {
					...mockState,
					board: res.board,
				},
				saved: true,
			});
		});

		// Mock the startTask behavior
		const stateAfterPromotion: RuntimeWorkspaceStateResponse = {
			...mockState,
			board: {
				...mockState.board,
				columns: [
					{ id: "backlog", title: "Backlog", cards: [] },
					{
						id: "in_progress",
						title: "In Progress",
						cards: [
							{
								id: taskId,
								title: "Design the login form",
								prompt: "Create login UI",
								baseRef: "main",
								cardType: "build", // should be promoted to build!
								autoReviewEnabled: false,
								createdAt: Date.now(),
								updatedAt: Date.now(),
							},
						],
					},
					{ id: "review", title: "Review", cards: [] },
					{ id: "done", title: "Done", cards: [] },
					{ id: "trash", title: "Trash", cards: [] },
				],
				dependencies: [],
			},
		};

		trpcMocks.mockGetState.mockResolvedValue(stateAfterPromotion);
		trpcMocks.mockEnsureWorktree.mockResolvedValue({ ok: true });
		trpcMocks.mockStartTaskSession.mockResolvedValue({
			ok: true,
			summary: {
				taskId,
				state: "running",
			},
		});

		const result = (await promoteTaskCommand({
			cwd: "/tmp/repo",
			taskId,
		})) as any;

		expect(result.ok).toBe(true);
		expect(result.task).toBeDefined();
		expect(result.task.cardType).toBe("build");
		expect(result.task.column).toBe("in_progress");

		// Verify the mutateWorkspaceState was called to do the type-flip and movement
		expect(workspaceStateMocks.mutateWorkspaceState).toHaveBeenCalled();
	});

	it("throws an error and does not mutate if the card cannot be transitioned to in_progress", async () => {
		const taskId = "card-123";
		// A board that does not have in_progress column
		const mockStateWithNoInProgress: RuntimeWorkspaceStateResponse = {
			repoPath: "/tmp/repo",
			statePath: "/tmp/state",
			taskWorktreesRoot: "/tmp/worktrees",
			revision: 1,
			git: {
				currentBranch: "main",
				defaultBranch: "main",
				branches: ["main"],
			},
			board: {
				columns: [
					{ id: "backlog", title: "Backlog", cards: [] },
					{
						id: "review",
						title: "Review",
						cards: [
							{
								id: taskId,
								title: "Design the login form",
								prompt: "Create login UI",
								baseRef: "main",
								cardType: "plan",
								autoReviewEnabled: false,
								createdAt: Date.now(),
								updatedAt: Date.now(),
							},
						],
					},
					{ id: "done", title: "Done", cards: [] },
					{ id: "trash", title: "Trash", cards: [] },
				] as any, // missing in_progress
				dependencies: [],
			},
			sessions: {},
		};

		workspaceStateMocks.mutateWorkspaceState.mockImplementation((_cwd, mutate) => {
			try {
				mutate(mockStateWithNoInProgress);
				return Promise.resolve({
					value: null,
					state: mockStateWithNoInProgress,
					saved: false,
				});
			} catch (err: any) {
				return Promise.reject(err);
			}
		});

		await expect(
			promoteTaskCommand({
				cwd: "/tmp/repo",
				taskId,
			}),
		).rejects.toThrow(/could not be transitioned to "in_progress"/);
	});
});
