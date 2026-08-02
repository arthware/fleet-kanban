import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import { runtimeBoardCardSchema } from "../../../src/core/api-contract";
import { addTaskToColumn, moveTaskToColumn } from "../../../src/core/task-board-mutations";
import {
	createSessionColumnProjector,
	getTargetColumnForSession,
	projectSessionSummaryColumn,
} from "../../../src/server/session-column-projection";

const mockMutateWorkspaceState = vi.fn();
vi.mock("../../../src/state/workspace-state", () => ({
	mutateWorkspaceState: (...args: unknown[]) => mockMutateWorkspaceState(...args),
	mutateWorkspaceStateById: (...args: unknown[]) => mockMutateWorkspaceState(...args),
}));

const COLUMN_IDS: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "done", "trash"];

function boardWithCard(columnId: RuntimeBoardColumnId): RuntimeBoardData {
	return {
		columns: COLUMN_IDS.map((id) => ({
			id,
			title: id,
			cards:
				id === columnId
					? [
							runtimeBoardCardSchema.parse({
								id: "task-1",
								prompt: "Ship a feature",
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							}),
						]
					: [],
		})),
		dependencies: [],
	};
}

function emptyBoard(): RuntimeBoardData {
	return {
		columns: COLUMN_IDS.map((id) => ({ id, title: id, cards: [] })),
		dependencies: [],
	};
}

function cardColumnId(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	return board.columns.find((column) => column.cards.some((card) => card.id === taskId))?.id ?? null;
}

function cardTransitions(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId[] {
	const card = board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
	return card?.transitions?.map((transition) => transition.column) ?? [];
}

function createWorkspaceState(
	workspacePath: string,
	board: RuntimeBoardData,
	sessions: Record<string, RuntimeTaskSessionSummary> = {},
): RuntimeWorkspaceStateResponse {
	return {
		repoPath: workspacePath,
		statePath: `${workspacePath}/.cline/kanban/board.json`,
		taskWorktreesRoot: `${workspacePath}/.cline/worktrees`,
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board,
		sessions,
		revision: 1,
	};
}

/**
 * Wire the mocked workspace mutation onto a mutable board, optionally holding a
 * mutation open so a later one can overtake it. `holdFor` is the trick that
 * reproduces the production race in-process: the file lock in the real runtime
 * makes one mutation wait while the next is dispatched.
 */
function mockBoardMutations(
	initialBoard: RuntimeBoardData,
	holdFor?: (callIndex: number) => Promise<void>,
): {
	board: () => RuntimeBoardData;
} {
	let board = initialBoard;
	let callIndex = -1;
	mockMutateWorkspaceState.mockImplementation(async (_id, mutate) => {
		callIndex += 1;
		await holdFor?.(callIndex);
		const res = mutate(createWorkspaceState("/path/to/workspace", board));
		if (res.board) {
			board = res.board;
		}
		return { value: res.value, state: createWorkspaceState("/path/to/workspace", board), saved: res.save };
	});
	return { board: () => board };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("getTargetColumnForSession", () => {
	it("should map card states to target columns", () => {
		expect(getTargetColumnForSession({ taskId: "task-1", state: "awaiting_review" })).toBe("review");
		expect(getTargetColumnForSession({ taskId: "task-1", state: "running" })).toBe("in_progress");
		expect(getTargetColumnForSession({ taskId: "task-1", state: "interrupted" })).toBeNull();
		expect(getTargetColumnForSession({ taskId: "task-1", state: "idle" })).toBeNull();
	});

	it("should always project overseer to null", () => {
		expect(getTargetColumnForSession({ taskId: "__home_agent__:workspace-1", state: "awaiting_review" })).toBeNull();
		expect(getTargetColumnForSession({ taskId: "__home_agent__:workspace-1", state: "running" })).toBeNull();
	});
});

describe("projectSessionSummaryColumn", () => {
	beforeEach(() => {
		mockMutateWorkspaceState.mockReset();
	});

	it("given a card in in_progress transitioning to awaiting_review, when projected, then it moves to review and broadcasts update", async () => {
		mockBoardMutations(boardWithCard("in_progress"));
		const mockBroadcast = vi.fn();

		const result = await projectSessionSummaryColumn(
			"workspace-1",
			{ taskId: "task-1", state: "awaiting_review" },
			mockBroadcast,
		);

		expect(result).toBe(true);
		expect(mockMutateWorkspaceState).toHaveBeenCalledWith("workspace-1", expect.any(Function));
		expect(mockBroadcast).toHaveBeenCalledWith("workspace-1", "/path/to/workspace");
	});

	it("given a card in review transitioning to running, when projected, then it moves to in_progress and broadcasts update", async () => {
		mockBoardMutations(boardWithCard("review"));
		const mockBroadcast = vi.fn();

		const result = await projectSessionSummaryColumn(
			"workspace-1",
			{ taskId: "task-1", state: "running" },
			mockBroadcast,
		);

		expect(result).toBe(true);
		expect(mockMutateWorkspaceState).toHaveBeenCalledWith("workspace-1", expect.any(Function));
		expect(mockBroadcast).toHaveBeenCalledWith("workspace-1", "/path/to/workspace");
	});

	it("given a card already in the target column, when projected, then it no-ops and returns false", async () => {
		mockBoardMutations(boardWithCard("review"));
		const mockBroadcast = vi.fn();

		const result = await projectSessionSummaryColumn(
			"workspace-1",
			{ taskId: "task-1", state: "awaiting_review" },
			mockBroadcast,
		);

		expect(result).toBe(false);
		expect(mockBroadcast).not.toHaveBeenCalled();
	});

	it.each([
		["done", "awaiting_review"],
		["done", "running"],
		["trash", "awaiting_review"],
		["trash", "running"],
	] as const)(
		"given a card already in %s, when a %s summary is projected, then it stays terminal",
		async (terminalColumnId, sessionState) => {
			const tracker = mockBoardMutations(boardWithCard(terminalColumnId));
			const mockBroadcast = vi.fn();

			const result = await projectSessionSummaryColumn(
				"workspace-1",
				{ taskId: "task-1", state: sessionState },
				mockBroadcast,
			);

			expect(result).toBe(false);
			expect(cardColumnId(tracker.board(), "task-1")).toBe(terminalColumnId);
			expect(mockBroadcast).not.toHaveBeenCalled();
		},
	);

	it("given a non-terminal card is missing, when projected, then it no-ops and returns false", async () => {
		mockBoardMutations(emptyBoard());
		const mockBroadcast = vi.fn();

		const result = await projectSessionSummaryColumn(
			"workspace-1",
			{ taskId: "task-1", state: "awaiting_review" },
			mockBroadcast,
		);

		expect(result).toBe(false);
		expect(mockBroadcast).not.toHaveBeenCalled();
	});

	it("given an overseer, when projected, then it no-ops and returns false", async () => {
		const mockBroadcast = vi.fn();

		const result = await projectSessionSummaryColumn(
			"workspace-1",
			{ taskId: "__home_agent__:workspace-1", state: "awaiting_review" },
			mockBroadcast,
		);

		expect(result).toBe(false);
		expect(mockMutateWorkspaceState).not.toHaveBeenCalled();
		expect(mockBroadcast).not.toHaveBeenCalled();
	});

	it("given a workspace ID not found in the registry, when projected, then it logs an error and returns false", async () => {
		const mockBroadcast = vi.fn();
		const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		mockMutateWorkspaceState.mockRejectedValueOnce(
			new Error('Workspace with ID "workspace-unknown" not found in index.'),
		);

		const result = await projectSessionSummaryColumn(
			"workspace-unknown",
			{ taskId: "task-1", state: "awaiting_review" },
			mockBroadcast,
		);

		expect(result).toBe(false);
		expect(mockMutateWorkspaceState).toHaveBeenCalledWith("workspace-unknown", expect.any(Function));
		expect(mockBroadcast).not.toHaveBeenCalled();
		expect(stderrWriteSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				'[kanban] Background projection mutation failed for task "task-1" in workspace "workspace-unknown": Error: Workspace with ID "workspace-unknown" not found in index.\n',
			),
		);
		stderrWriteSpy.mockRestore();
	});
});

describe("createSessionColumnProjector", () => {
	beforeEach(() => {
		mockMutateWorkspaceState.mockReset();
	});

	it("given a steered review card whose session emits running then awaiting_review, when the earlier board write is overtaken, then transitions still record the round-trip in order", async () => {
		// Given: a card that has already been through Review once, and a first board
		// write held open so the second one would win if projections ran concurrently
		// — the production workspace-file-lock race.
		const created = addTaskToColumn(
			emptyBoard(),
			"backlog",
			{ taskId: "task-1", prompt: "Ship a feature", baseRef: "main" },
			() => "task-1",
			1,
		);
		const firstWriteHeld = deferred();
		const tracker = mockBoardMutations(
			moveTaskToColumn(created.board, "task-1", "review", 2).board,
			async (callIndex) => {
				if (callIndex === 0) {
					await firstWriteHeld.promise;
				}
			},
		);
		const projector = createSessionColumnProjector(vi.fn());

		// When
		const running = projector.project("workspace-1", { taskId: "task-1", state: "running" });
		const awaitingReview = projector.project("workspace-1", { taskId: "task-1", state: "awaiting_review" });
		await new Promise((resolve) => setImmediate(resolve));
		firstWriteHeld.resolve();
		await Promise.all([running, awaitingReview]);

		// Then
		expect(cardColumnId(tracker.board(), "task-1")).toBe("review");
		expect(cardTransitions(tracker.board(), "task-1")).toEqual(["backlog", "review", "in_progress", "review"]);
	});

	it("given two tasks in one workspace, when one task's projection stalls, then the other task's projection is not blocked behind it", async () => {
		const firstMutationHeld = deferred();
		mockBoardMutations(boardWithCard("in_progress"), async (callIndex) => {
			if (callIndex === 0) {
				await firstMutationHeld.promise;
			}
		});
		const projector = createSessionColumnProjector(vi.fn());

		const firstCard = projector.project("workspace-1", { taskId: "task-1", state: "awaiting_review" });
		const secondCard = projector.project("workspace-1", { taskId: "task-2", state: "awaiting_review" });
		await new Promise((resolve) => setImmediate(resolve));

		expect(mockMutateWorkspaceState).toHaveBeenCalledTimes(2);
		firstMutationHeld.resolve();
		await Promise.all([firstCard, secondCard]);
	});

	it("given a projection that throws, when a later state for the same task is projected, then the later projection still runs", async () => {
		const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		mockMutateWorkspaceState.mockRejectedValueOnce(new Error("transient state write failure"));
		const tracker = mockBoardMutations(boardWithCard("in_progress"));
		const projector = createSessionColumnProjector(vi.fn());

		await Promise.all([
			projector.project("workspace-1", { taskId: "task-1", state: "running" }),
			projector.project("workspace-1", { taskId: "task-1", state: "awaiting_review" }),
		]);

		expect(cardColumnId(tracker.board(), "task-1")).toBe("review");
		stderrWriteSpy.mockRestore();
	});
});
