import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { resetWorkspaceMetadataStore, setTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { BoardColumnId, BoardData, ReviewTaskWorkspaceSnapshot } from "@/types";

function createBoard(autoReviewEnabled: boolean): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Test task",
						prompt: "Test task",
						startInPlanMode: false,
						autoReviewEnabled,
						autoReviewMode: "commit",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

const changedWorkspaceSnapshot: ReviewTaskWorkspaceSnapshot = {
	taskId: "task-1",
	path: "/tmp/task-1",
	branch: "task-1",
	isDetached: false,
	headCommit: "abc123",
	changedFiles: 3,
	additions: 10,
	deletions: 2,
};

const cleanWorkspaceSnapshot: ReviewTaskWorkspaceSnapshot = {
	...changedWorkspaceSnapshot,
	changedFiles: 0,
	additions: 0,
	deletions: 0,
};

function createSessionSummary(overrides?: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "awaiting_review",
		agentId: "cline",
		workspacePath: "/tmp/task-1",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		agentSessionId: null,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function HookHarness({
	board,
	sessionsByTaskId,
	workspaceSnapshot = changedWorkspaceSnapshot,
	runAutoReviewGitAction,
	requestMoveTaskToTrash,
}: {
	board: BoardData;
	sessionsByTaskId: Record<string, RuntimeTaskSessionSummary>;
	workspaceSnapshot?: ReviewTaskWorkspaceSnapshot | null;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: { skipWorkingChangeWarning?: boolean },
	) => Promise<void>;
}): null {
	setTaskWorkspaceSnapshot(workspaceSnapshot ?? null);
	useReviewAutoActions({
		board,
		sessionsByTaskId,
		taskGitActionLoadingByTaskId: {},
		runAutoReviewGitAction,
		requestMoveTaskToTrash,
	});
	return null;
}

describe("useReviewAutoActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		resetWorkspaceMetadataStore();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	it("cancels a scheduled auto review action when autoReviewEnabled is turned off", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					sessionsByTaskId={{}}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(false)}
					sessionsByTaskId={{}}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	// Durability guard: a card whose session is blocked on the user (needs_input,
	// e.g. stalled at a `git commit` permission prompt) still holds uncommitted,
	// not-durably-saved work. Auto-review must never advance it toward Done — doing
	// so is the exact incident that discarded real work. It stays put for a human.
	it("does NOT auto-advance a card whose session needs input, even with pending changes", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					sessionsByTaskId={{ "task-1": createSessionSummary({ reviewReason: "needs_input" }) }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(5000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	// An errored session is likewise not durably saved — never march it to Done.
	it("given an error session with changed files, when auto-review is enabled, then no git action fires and the card is NOT auto-moved to done", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		// given
		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					sessionsByTaskId={{ "task-1": createSessionSummary({ reviewReason: "error" }) }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		// when
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});

		// then
		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("given a failed session with changed files, when auto-review is enabled, then no git action fires and the card is NOT auto-moved to done", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		// given
		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					sessionsByTaskId={{ "task-1": createSessionSummary({ state: "failed" }) }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		// when
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});

		// then
		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("given a clean exit review with changed files, when auto-review is enabled, then it still auto-commits and auto-dones", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});
		const board = createBoard(true);
		const cleanExitSessions = { "task-1": createSessionSummary({ reviewReason: "exit" }) };

		// given
		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					sessionsByTaskId={cleanExitSessions}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		// when
		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
		});
		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					sessionsByTaskId={cleanExitSessions}
					workspaceSnapshot={cleanWorkspaceSnapshot}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
		});

		// then
		expect(runAutoReviewGitAction).toHaveBeenCalledWith("task-1", "commit");
		expect(requestMoveTaskToTrash).toHaveBeenCalledWith("task-1", "review", { skipWorkingChangeWarning: true });
	});

	it("given an action was scheduled, when the session flips to error before the timer fires, then nothing fires", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});
		const board = createBoard(true);

		// given
		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					sessionsByTaskId={{ "task-1": createSessionSummary({ reviewReason: "exit" }) }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		// when
		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					sessionsByTaskId={{ "task-1": createSessionSummary({ reviewReason: "error" }) }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});

		// then
		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});
});
