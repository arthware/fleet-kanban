import { describe, expect, it, vi } from "vitest";
import { SIGNAL_SEQUENCE_TRACKER } from "../../../src/agents/shared/signals";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createHooksApi as createRealHooksApi } from "../../../src/trpc/hooks-api";

function createHooksApi(deps: any) {
	const origEnsure = deps.ensureTerminalManagerForWorkspace;
	deps.ensureTerminalManagerForWorkspace = async (...args: any[]) => {
		const manager = await origEnsure(...args);
		if (manager) {
			if (!manager.getLastProcessedSeq) {
				manager.getLastProcessedSeq = vi.fn(() => 0);
			}
			if (!manager.setLastProcessedSeq) {
				manager.setLastProcessedSeq = vi.fn();
			}
		}
		return manager;
	};
	return createRealHooksApi(deps);
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		agentSessionId: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function _createMockManager(overrides: Record<string, any> = {}): TerminalSessionManager {
	return {
		getSummary: vi.fn(() => createSummary({ state: "running" })),
		transitionToReview: vi.fn(),
		transitionToRunning: vi.fn(),
		applyHookActivity: vi.fn(),
		applyTurnCheckpoint: vi.fn(),
		getLastProcessedSeq: vi.fn(() => 0),
		setLastProcessedSeq: vi.fn(),
		...overrides,
	} as unknown as TerminalSessionManager;
}

describe("createHooksApi", () => {
	it("treats ineligible hook transitions as successful no-ops", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
	});

	it("stores activity metadata without changing session state", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: {
				source: "claude",
				activityText: "Using Read",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(manager.applyHookActivity).toHaveBeenCalledWith("task-1", {
			source: "claude",
			activityText: "Using Read",
		});
	});

	it("routes a permission-prompt hook to the 'needs_input' review reason", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "needs_input" })),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", notificationType: "permission_prompt" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "needs_input");
	});

	describe("given Codex is waiting on request_user_input", () => {
		it("when the hook is ingested, then the task is marked needs-input and remains steerable", async () => {
			// given
			const manager = {
				getSummary: vi.fn(() => createSummary({ agentId: "codex", state: "running", pid: 4242 })),
				transitionToReview: vi.fn(() =>
					createSummary({ agentId: "codex", state: "awaiting_review", reviewReason: "needs_input", pid: 4242 }),
				),
				transitionToRunning: vi.fn(),
				applyHookActivity: vi.fn(),
				applyTurnCheckpoint: vi.fn(),
			} as unknown as TerminalSessionManager;

			const api = createHooksApi({
				getWorkspacePathById: vi.fn(() => "/tmp/repo"),
				ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastTaskReadyForReview: vi.fn(),
			});

			// when
			const response = await api.ingest({
				taskId: "task-1",
				workspaceId: "workspace-1",
				event: "to_review",
				metadata: {
					source: "codex",
					hookEventName: "raw_response_item",
					notificationType: "request_user_input",
					toolName: "request_user_input",
					activityText: "Waiting for input",
				},
			});

			// then
			expect(response).toEqual({ ok: true });
			expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "needs_input");
			expect(manager.transitionToReview).toHaveReturnedWith(
				expect.objectContaining({
					state: "awaiting_review",
					reviewReason: "needs_input",
					pid: 4242,
				}),
			);
		});
	});

	it("keeps an end-of-turn stop hook on the ordinary 'hook' review reason", async () => {
		const notifyTaskReadyForReview = vi.fn(async () => undefined);
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			notifyTaskReadyForReview,
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "Stop" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "hook");
		expect(notifyTaskReadyForReview).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
			taskId: "task-1",
		});
	});

	it("lets a needs_input card transition back to running on to_in_progress", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "needs_input" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(() => createSummary({ state: "running", reviewReason: null })),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).toHaveBeenCalledTimes(1);
	});

	it("drops stale/duplicate signals with lower or equal sequence numbers", async () => {
		const taskId = "task-stale";
		SIGNAL_SEQUENCE_TRACKER.evictSession(taskId);

		const manager = {
			getSummary: vi.fn(() => createSummary({ taskId, state: "running" })),
			transitionToReview: vi.fn(() => createSummary({ taskId, state: "awaiting_review", reviewReason: "hook" })),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
			getLastProcessedSeq: vi.fn(() => 5),
			setLastProcessedSeq: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId,
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "Stop" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(manager.setLastProcessedSeq).not.toHaveBeenCalled();
	});

	it("parks a gemini card when it receives a native gemini Notification hook", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ agentId: "gemini", state: "running" })),
			transitionToReview: vi.fn(() =>
				createSummary({ agentId: "gemini", state: "awaiting_review", reviewReason: "needs_input" }),
			),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: {
				source: "gemini",
				hookEventName: "Notification",
				notificationType: "permission_prompt",
				activityText: "Waiting for approval",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "needs_input");
	});

	it("given a completed Review card, when an explicit to_in_progress hook arrives, then it resumes running", async () => {
		// given
		const notifyTaskReadyForReview = vi.fn(async () => undefined);
		const ensureAutoReviewPrForTask = vi.fn(async () => undefined);
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(() => createSummary({ state: "running", reviewReason: null })),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			notifyTaskReadyForReview,
			ensureAutoReviewPrForTask,
		});

		// when
		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
		});

		// then
		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).toHaveBeenCalledWith("task-1");
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(notifyTaskReadyForReview).not.toHaveBeenCalled();
		expect(ensureAutoReviewPrForTask).not.toHaveBeenCalled();
	});

	it("given a home-agent session resting at hook review, when an explicit to_in_progress hook arrives, then it resumes running", async () => {
		// given
		const taskId = createHomeAgentSessionId("workspace-1");
		const manager = {
			getSummary: vi.fn(() => createSummary({ taskId, state: "awaiting_review", reviewReason: "hook" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(() => createSummary({ taskId, state: "running", reviewReason: null })),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		// when
		const response = await api.ingest({
			taskId,
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
		});

		// then
		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).toHaveBeenCalledWith(taskId);
		expect(manager.transitionToReview).not.toHaveBeenCalled();
	});

	it("given a Review card with no turn-start hook, when activity arrives, then it stays in review", async () => {
		// given
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		// when
		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: { source: "gemini", hookEventName: "AfterTool" },
		});

		// then
		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(manager.applyHookActivity).toHaveBeenCalledWith("task-1", {
			source: "gemini",
			hookEventName: "AfterTool",
		});
	});

	it("captures a turn checkpoint when transitioning to review", async () => {
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			latestTurnCheckpoint: {
				turn: 2,
				ref: "refs/kanban/checkpoints/task-1/turn/2",
				commit: "2222222",
				createdAt: 1,
			},
			previousTurnCheckpoint: {
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			},
		});

		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const captureTaskTurnCheckpoint = vi.fn(async () => ({
			turn: 3,
			ref: "refs/kanban/checkpoints/task-1/turn/3",
			commit: "3333333",
			createdAt: Date.now(),
		}));
		const deleteTaskTurnCheckpointRef = vi.fn(async () => undefined);

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			captureTaskTurnCheckpoint,
			deleteTaskTurnCheckpointRef,
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
		});

		expect(response).toEqual({ ok: true });
		expect(captureTaskTurnCheckpoint).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			taskId: "task-1",
			turn: 3,
		});
		await vi.waitFor(() => {
			expect(manager.applyTurnCheckpoint).toHaveBeenCalledTimes(1);
		});
		expect(deleteTaskTurnCheckpointRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			ref: "refs/kanban/checkpoints/task-1/turn/1",
		});
	});

	describe("given an auto-PR card reaches review", () => {
		it("when the hook is ingested, then it fires the PR-ensure step and the ACK returns ok even if that step rejects", async () => {
			// given
			const transitionedSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const manager = {
				getSummary: vi.fn(() => createSummary({ state: "running" })),
				transitionToReview: vi.fn(() => transitionedSummary),
				transitionToRunning: vi.fn(),
				applyHookActivity: vi.fn(),
				applyTurnCheckpoint: vi.fn(),
			} as unknown as TerminalSessionManager;

			const ensureAutoReviewPrForTask = vi.fn(async () => {
				throw new Error("push/PR failed");
			});

			const api = createHooksApi({
				getWorkspacePathById: vi.fn(() => "/tmp/repo"),
				ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastTaskReadyForReview: vi.fn(),
				ensureAutoReviewPrForTask,
			});

			// when
			const response = await api.ingest({
				taskId: "task-1",
				workspaceId: "workspace-1",
				event: "to_review",
			});

			// then
			expect(response).toEqual({ ok: true });
			await vi.waitFor(() => {
				expect(ensureAutoReviewPrForTask).toHaveBeenCalledWith({
					workspaceId: "workspace-1",
					taskId: "task-1",
					cwd: "/tmp/worktree",
				});
			});
		});

		it("when the PR-ensure step hangs, then the response resolves without waiting for it", async () => {
			// given
			const transitionedSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const manager = {
				getSummary: vi.fn(() => createSummary({ state: "running" })),
				transitionToReview: vi.fn(() => transitionedSummary),
				transitionToRunning: vi.fn(),
				applyHookActivity: vi.fn(),
				applyTurnCheckpoint: vi.fn(),
			} as unknown as TerminalSessionManager;

			const ensureAutoReviewPrForTask = vi.fn(() => new Promise<void>(() => {}));

			const api = createHooksApi({
				getWorkspacePathById: vi.fn(() => "/tmp/repo"),
				ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastTaskReadyForReview: vi.fn(),
				ensureAutoReviewPrForTask,
			});

			// when
			const response = await api.ingest({
				taskId: "task-1",
				workspaceId: "workspace-1",
				event: "to_review",
			});

			// then
			expect(response).toEqual({ ok: true });
			expect(ensureAutoReviewPrForTask).toHaveBeenCalledTimes(1);
		});
	});

	describe("given the turn checkpoint capture is slow", () => {
		it("when a to_review hook is ingested, then the response resolves without waiting for the checkpoint", async () => {
			// given
			const transitionedSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
			const manager = {
				getSummary: vi.fn(() => createSummary({ state: "running" })),
				transitionToReview: vi.fn(() => transitionedSummary),
				transitionToRunning: vi.fn(),
				applyHookActivity: vi.fn(),
				applyTurnCheckpoint: vi.fn(),
			} as unknown as TerminalSessionManager;

			const captureTaskTurnCheckpoint = vi.fn(() => new Promise<never>(() => {}));
			const api = createHooksApi({
				getWorkspacePathById: vi.fn(() => "/tmp/repo"),
				ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastTaskReadyForReview: vi.fn(),
				captureTaskTurnCheckpoint,
			});

			// when
			const response = await api.ingest({
				taskId: "task-1",
				workspaceId: "workspace-1",
				event: "to_review",
			});

			// then
			expect(response).toEqual({ ok: true });
			expect(captureTaskTurnCheckpoint).toHaveBeenCalledTimes(1);
			expect(manager.applyTurnCheckpoint).not.toHaveBeenCalled();
		});
	});
});
