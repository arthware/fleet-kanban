import { beforeEach, describe, expect, it, vi } from "vitest";

const trpcMocks = vi.hoisted(() => ({
	client: {
		runtime: {
			notifyTaskReadyForReview: {
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

import { reviewTask } from "../../../src/commands/task";

describe("task review command", () => {
	beforeEach(() => {
		trpcMocks.createTRPCProxyClient.mockReturnValue(trpcMocks.client);
		trpcMocks.httpBatchLink.mockReturnValue({});
		trpcMocks.client.runtime.notifyTaskReadyForReview.mutate.mockReset();
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
	});

	it("delegates the card review notification to the runtime and returns machine-readable output", async () => {
		trpcMocks.client.runtime.notifyTaskReadyForReview.mutate.mockResolvedValue({
			ok: true,
			taskId: "card-1",
			homeAgentTaskId: "__home_agent__:workspace-1:claude",
			notified: true,
			message: 'Card card-1 ("Fix review flow") was moved to review and is awaiting your review.',
		});

		await expect(reviewTask({ cwd: "/tmp/repo", taskId: "card-1" })).resolves.toEqual({
			ok: true,
			taskId: "card-1",
			homeAgentTaskId: "__home_agent__:workspace-1:claude",
			notified: true,
			message: 'Card card-1 ("Fix review flow") was moved to review and is awaiting your review.',
			workspacePath: "/tmp/repo",
		});
		expect(trpcMocks.client.runtime.notifyTaskReadyForReview.mutate).toHaveBeenCalledWith({ taskId: "card-1" });
	});

	it("throws a clean error for an unknown card so the CLI exits non-zero", async () => {
		trpcMocks.client.runtime.notifyTaskReadyForReview.mutate.mockResolvedValue({
			ok: false,
			taskId: "missing-card",
			homeAgentTaskId: null,
			notified: false,
			message: null,
			error: 'Task "missing-card" was not found in workspace /tmp/repo.',
		});

		await expect(reviewTask({ cwd: "/tmp/repo", taskId: "missing-card" })).rejects.toThrow(
			'Task "missing-card" was not found in workspace /tmp/repo.',
		);
	});

	it("does not mutate the board", async () => {
		trpcMocks.client.runtime.notifyTaskReadyForReview.mutate.mockResolvedValue({
			ok: true,
			taskId: "card-1",
			homeAgentTaskId: null,
			notified: false,
			message: null,
		});

		await reviewTask({ cwd: "/tmp/repo", taskId: "card-1" });

		expect(workspaceStateMocks.mutateWorkspaceState).not.toHaveBeenCalled();
	});
});
