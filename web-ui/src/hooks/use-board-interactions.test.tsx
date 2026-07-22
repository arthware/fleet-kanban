import { act, type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBoardInteractions } from "@/hooks/use-board-interactions";
import type { UseTaskSessionsResult } from "@/hooks/use-task-sessions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardData } from "@/types";

const notifyErrorMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());
const useLinkedBacklogTaskActionsMock = vi.hoisted(() => vi.fn());
const useProgrammaticCardMovesMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
	showAppToast: showAppToastMock,
}));

vi.mock("@/hooks/use-linked-backlog-task-actions", () => ({
	useLinkedBacklogTaskActions: useLinkedBacklogTaskActionsMock,
}));

vi.mock("@/hooks/use-programmatic-card-moves", () => ({
	useProgrammaticCardMoves: useProgrammaticCardMovesMock,
}));

function createTask(taskId: string, prompt: string, createdAt: number): BoardCard {
	return {
		id: taskId,
		title: prompt,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

function createBoard(): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [createTask("task-1", "Backlog task", 1)],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "done", title: "Done", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

const NOOP_STOP_SESSION = async (): Promise<void> => {};
const NOOP_CLEANUP_WORKSPACE = async (): Promise<null> => null;
const NOOP_FETCH_WORKSPACE_INFO = async (): Promise<null> => null;
const NOOP_SEND_TASK_INPUT = async (): Promise<{ ok: boolean }> => ({ ok: true });
const NOOP_RUN_IMPLEMENT_HERE = async (): Promise<boolean> => false;

function createSessionSummary(
	taskId: string,
	agentSessionLifecycle: RuntimeTaskSessionSummary["agentSessionLifecycle"],
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "awaiting_review",
		agentId: "cline",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		agentSessionId: agentSessionLifecycle === "gone" ? null : "session-1",
		agentSessionLifecycle,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

function stubProgrammaticAndLinkedActionMocks(): void {
	useProgrammaticCardMovesMock.mockReturnValue({
		handleProgrammaticCardMoveReady: () => {},
		setRequestMoveTaskToTrashHandler: () => {},
		tryProgrammaticCardMove: () => "unavailable",
		consumeProgrammaticCardMove: () => ({}),
		resolvePendingProgrammaticTrashMove: () => {},
		waitForProgrammaticCardMoveAvailability: async () => {},
		resetProgrammaticCardMoves: () => {},
		requestMoveTaskToTrashWithAnimation: async () => {},
		programmaticCardMoveCycle: 0,
	});
	useLinkedBacklogTaskActionsMock.mockReturnValue({
		handleCreateDependency: () => {},
		handleDeleteDependency: () => {},
		confirmMoveTaskToTrash: async () => {},
		requestMoveTaskToTrash: async () => {},
	});
}

interface HookSnapshot {
	handleRestoreTaskFromTrash: (taskId: string) => void;
	handleStartTask: (taskId: string) => void;
	handleCardSelect: (taskId: string) => void;
	handleDragEnd: ReturnType<typeof useBoardInteractions>["handleDragEnd"];
	handleMoveDoneCardToTrash: (taskId: string) => void;
	handleMoveReviewCardToTrash: (taskId: string) => void;
	handleImplementHere: (taskId: string) => void;
}

function createRect(width: number, height: number): DOMRect {
	return {
		x: 0,
		y: 0,
		left: 0,
		top: 0,
		width,
		height,
		right: width,
		bottom: height,
		toJSON: () => ({}),
	} as DOMRect;
}

function HookHarness({
	board,
	setBoard,
	ensureTaskWorkspace,
	startTaskSession,
	selectedCard = null,
	setSelectedTaskIdOverride,
	initialSessions,
	runImplementHereAction = NOOP_RUN_IMPLEMENT_HERE,
	onSnapshot,
}: {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	ensureTaskWorkspace: UseTaskSessionsResult["ensureTaskWorkspace"];
	startTaskSession: UseTaskSessionsResult["startTaskSession"];
	selectedCard?: { card: BoardCard; column: { id: "backlog" | "in_progress" | "review" | "done" | "trash" } } | null;
	setSelectedTaskIdOverride?: Dispatch<SetStateAction<string | null>>;
	initialSessions?: Record<string, RuntimeTaskSessionSummary>;
	runImplementHereAction?: (taskId: string) => Promise<boolean>;
	onSnapshot?: (snapshot: HookSnapshot) => void;
}): null {
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>(initialSessions ?? {});
	const [, setSelectedTaskId] = useState<string | null>(null);
	const [, setIsClearTrashDialogOpen] = useState(false);
	const [, setIsGitHistoryOpen] = useState(false);

	const actions = useBoardInteractions({
		board,
		setBoard,
		sessions,
		setSessions,
		selectedCard,
		selectedTaskId: null,
		currentProjectId: "project-1",
		setSelectedTaskId: setSelectedTaskIdOverride ?? setSelectedTaskId,
		setIsClearTrashDialogOpen,
		setIsGitHistoryOpen,
		stopTaskSession: NOOP_STOP_SESSION,
		cleanupTaskWorkspace: NOOP_CLEANUP_WORKSPACE,
		ensureTaskWorkspace,
		startTaskSession,
		fetchTaskWorkspaceInfo: NOOP_FETCH_WORKSPACE_INFO,
		sendTaskSessionInput: NOOP_SEND_TASK_INPUT,
		readyForReviewNotificationsEnabled: false,
		runImplementHereAction,
	});

	useEffect(() => {
		onSnapshot?.({
			handleRestoreTaskFromTrash: actions.handleRestoreTaskFromTrash,
			handleStartTask: actions.handleStartTask,
			handleCardSelect: actions.handleCardSelect,
			handleDragEnd: actions.handleDragEnd,
			handleMoveDoneCardToTrash: actions.handleMoveDoneCardToTrash,
			handleMoveReviewCardToTrash: actions.handleMoveReviewCardToTrash,
			handleImplementHere: actions.handleImplementHere,
		});
	}, [
		actions.handleCardSelect,
		actions.handleDragEnd,
		actions.handleImplementHere,
		actions.handleMoveDoneCardToTrash,
		actions.handleMoveReviewCardToTrash,
		actions.handleRestoreTaskFromTrash,
		actions.handleStartTask,
		onSnapshot,
	]);

	return null;
}

describe("useBoardInteractions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			return window.setTimeout(() => {
				callback(performance.now());
			}, 16);
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle: number) => {
			window.clearTimeout(handle);
		});
		notifyErrorMock.mockReset();
		showAppToastMock.mockReset();
		useLinkedBacklogTaskActionsMock.mockReset();
		useProgrammaticCardMovesMock.mockReset();
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
		vi.restoreAllMocks();
		vi.useRealTimers();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("starts dependency-unblocked tasks even when setBoard updater is deferred", async () => {
		let startBacklogTaskWithAnimation: ((task: BoardCard) => Promise<boolean>) | null = null;

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		useLinkedBacklogTaskActionsMock.mockImplementation(
			(input: { startBacklogTaskWithAnimation?: (task: BoardCard) => Promise<boolean> }) => {
				startBacklogTaskWithAnimation = input.startBacklogTaskWithAnimation ?? null;
				return {
					handleCreateDependency: () => {},
					handleDeleteDependency: () => {},
					confirmMoveTaskToTrash: async () => {},
					requestMoveTaskToTrash: async () => {},
				};
			},
		);

		const board = createBoard();
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((_nextBoard) => {
			// Simulate React deferring state updater execution.
		});
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: {
				ok: true as const,
				path: "/tmp/task-1",
				baseRef: "main",
				baseCommit: "abc123",
			},
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
				/>,
			);
		});

		if (!startBacklogTaskWithAnimation) {
			throw new Error("Expected startBacklogTaskWithAnimation to be provided.");
		}

		const backlogTask = board.columns[0]?.cards[0];
		if (!backlogTask) {
			throw new Error("Expected a backlog task.");
		}

		let started = false;
		await act(async () => {
			started = await startBacklogTaskWithAnimation!(backlogTask);
		});

		expect(started).toBe(true);
		expect(ensureTaskWorkspace).toHaveBeenCalledWith(backlogTask);
		expect(startTaskSession).toHaveBeenCalledWith(backlogTask);
	});

	it("waits for a new backlog card height to settle before starting animation", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const tryProgrammaticCardMove = vi.fn(() => "unavailable" as const);
		let measurementCount = 0;
		const boardElement = document.createElement("section");
		boardElement.className = "kb-board";
		const taskElement = document.createElement("div");
		taskElement.dataset.taskId = "task-1";
		vi.spyOn(taskElement, "getBoundingClientRect").mockImplementation(() => {
			measurementCount += 1;
			if (measurementCount === 1) {
				return createRect(160, 44);
			}
			return createRect(160, 96);
		});
		boardElement.appendChild(taskElement);
		document.body.appendChild(boardElement);

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove,
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const board = createBoard();
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>(() => {});
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: {
				ok: true as const,
				path: "/tmp/task-1",
				baseRef: "main",
				baseCommit: "abc123",
			},
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot!.handleStartTask("task-1");
		});

		expect(tryProgrammaticCardMove).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(32);
			await Promise.resolve();
		});

		expect(tryProgrammaticCardMove).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(16);
			await Promise.resolve();
		});

		expect(tryProgrammaticCardMove).toHaveBeenCalledWith("task-1", "backlog", "in_progress");
		boardElement.remove();
	});

	it("starts backlog tasks immediately from detail view without waiting for card height to settle", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const tryProgrammaticCardMove = vi.fn(() => "unavailable" as const);
		let measurementCount = 0;
		const boardElement = document.createElement("section");
		boardElement.className = "kb-board";
		const taskElement = document.createElement("div");
		taskElement.dataset.taskId = "task-1";
		vi.spyOn(taskElement, "getBoundingClientRect").mockImplementation(() => {
			measurementCount += 1;
			if (measurementCount === 1) {
				return createRect(160, 44);
			}
			return createRect(160, 96);
		});
		boardElement.appendChild(taskElement);
		document.body.appendChild(boardElement);

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove,
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const board = createBoard();
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>(() => {});
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: {
				ok: true as const,
				path: "/tmp/task-1",
				baseRef: "main",
				baseCommit: "abc123",
			},
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
					selectedCard={{ card: board.columns[0]!.cards[0]!, column: { id: "backlog" } }}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot!.handleStartTask("task-1");
		});

		expect(tryProgrammaticCardMove).not.toHaveBeenCalled();
		expect(measurementCount).toBe(0);
		expect(setBoard).toHaveBeenCalled();
		expect(startTaskSession).toHaveBeenCalledWith(board.columns[0]!.cards[0]!);
		boardElement.remove();
	});

	it("shows a warning toast when restoring a trashed task with a saved patch warning", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const trashTask = createTask("task-trash", "Trash task", 2);
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "done", title: "Done", cards: [] },
				{ id: "trash", title: "Trash", cards: [trashTask] },
			],
			dependencies: [],
		};
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((_nextBoard) => {
			// The optimistic move is not part of this assertion.
		});
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: {
				ok: true as const,
				path: "/tmp/task-trash",
				baseRef: "main",
				baseCommit: "abc123",
				warning: "Saved task changes could not be reapplied automatically.",
			},
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={setBoard}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot!.handleRestoreTaskFromTrash("task-trash");
			// resumeTaskFromTrash is fire-and-forget (void), so flush enough
			// microtasks for ensureTaskWorkspace and startTaskSession to resolve.
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
		});

		// moveTaskToColumn updates updatedAt with Date.now(), so match fields except updatedAt.
		const expectedTask = expect.objectContaining({
			id: trashTask.id,
			prompt: trashTask.prompt,
			baseRef: trashTask.baseRef,
			createdAt: trashTask.createdAt,
		});
		expect(ensureTaskWorkspace).toHaveBeenCalledWith(expectedTask);
		expect(startTaskSession).toHaveBeenCalledWith(expectedTask, {
			resumeFromTrash: true,
			resumeMode: "resume",
		});
		expect(showAppToastMock).toHaveBeenCalledWith({
			intent: "warning",
			icon: "warning-sign",
			message: "Saved task changes could not be reapplied automatically.",
			timeout: 7000,
		});
	});

	it("preserves model fields when restoring a trashed task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const trashTask: BoardCard = {
			id: "task-trash-model",
			title: "Trash task with model title",
			prompt: "Trash task with model",
			startInPlanMode: false,
			autoReviewEnabled: false,
			agentId: "codex",
			clineSettings: {
				providerId: "my-provider",
				modelId: "my-model",
			},
			baseRef: "main",
			createdAt: 2,
			updatedAt: 2,
		};
		let currentBoard: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "done", title: "Done", cards: [] },
				{ id: "trash", title: "Trash", cards: [trashTask] },
			],
			dependencies: [],
		};
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			if (typeof nextBoard === "function") {
				currentBoard = nextBoard(currentBoard);
			} else {
				currentBoard = nextBoard;
			}
		});
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: {
				ok: true as const,
				path: "/tmp/task-trash-model",
				baseRef: "main",
				baseCommit: "abc123",
			},
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));

		await act(async () => {
			root.render(
				<HookHarness
					board={currentBoard}
					setBoard={setBoard}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot!.handleRestoreTaskFromTrash("task-trash-model");
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
		});

		// After restore, disableTaskAutoReview is called via setBoard updater.
		// Verify model fields survived the restore flow.
		const reviewCards = currentBoard.columns.find((col) => col.id === "review")?.cards ?? [];
		const restoredTask = reviewCards.find((card) => card.id === "task-trash-model");
		expect(restoredTask).toBeDefined();
		expect(restoredTask?.clineSettings).toEqual({
			providerId: "my-provider",
			modelId: "my-model",
		});
		expect(restoredTask?.agentId).toBe("codex");
	});

	it("ignores card selection requests for trashed tasks", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});

		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash: async () => {},
		});

		const trashTask = createTask("task-trash", "Trash task", 2);
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "done", title: "Done", cards: [] },
				{ id: "trash", title: "Trash", cards: [trashTask] },
			],
			dependencies: [],
		};
		const setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>();

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={() => board}
					ensureTaskWorkspace={async () => ({ ok: true as const })}
					startTaskSession={async () => ({ ok: true as const })}
					setSelectedTaskIdOverride={setSelectedTaskId}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot!.handleCardSelect("task-trash");
		});

		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("given a review card, when it is abandoned, then it is moved to trash without completing to done", async () => {
		// given a review card and a stubbed trash-animation mutation
		let latestSnapshot: HookSnapshot | null = null;
		const requestMoveTaskToTrashWithAnimation = vi.fn(async () => {});

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation,
			programmaticCardMoveCycle: 0,
		});
		const requestMoveTaskToTrash = vi.fn(async () => {});
		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash,
		});

		const reviewTask = createTask("task-review", "Review task", 2);
		let currentBoard: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [reviewTask] },
				{ id: "done", title: "Done", cards: [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		};
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			if (typeof nextBoard === "function") {
				currentBoard = nextBoard(currentBoard);
				return;
			}
			currentBoard = nextBoard;
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={currentBoard}
					setBoard={setBoard}
					ensureTaskWorkspace={async () => ({ ok: true as const })}
					startTaskSession={async () => ({ ok: true as const })}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		// when the review card is abandoned
		await act(async () => {
			latestSnapshot!.handleMoveReviewCardToTrash("task-review");
			await Promise.resolve();
		});

		// then it goes to trash via the animated mutation and never lands in done
		expect(requestMoveTaskToTrashWithAnimation).toHaveBeenCalledWith("task-review", "review");
		expect(currentBoard.columns.find((column) => column.id === "done")?.cards).toEqual([]);
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("archives a done card through the trash cleanup workflow", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const requestMoveTaskToTrashWithAnimation = vi.fn(async () => {});

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation,
			programmaticCardMoveCycle: 0,
		});
		const requestMoveTaskToTrash = vi.fn(async () => {});
		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash,
		});

		const doneTask = createTask("task-done", "Done task", 2);
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "done", title: "Done", cards: [doneTask] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		};

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					setBoard={() => board}
					ensureTaskWorkspace={async () => ({ ok: true as const })}
					startTaskSession={async () => ({ ok: true as const })}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot!.handleMoveDoneCardToTrash("task-done");
			await Promise.resolve();
		});

		expect(requestMoveTaskToTrashWithAnimation).toHaveBeenCalledWith("task-done", "done");
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("runs the trash cleanup handler when a done card is dropped into trash", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		useProgrammaticCardMovesMock.mockReturnValue({
			handleProgrammaticCardMoveReady: () => {},
			setRequestMoveTaskToTrashHandler: () => {},
			tryProgrammaticCardMove: () => "unavailable",
			consumeProgrammaticCardMove: () => ({}),
			resolvePendingProgrammaticTrashMove: () => {},
			waitForProgrammaticCardMoveAvailability: async () => {},
			resetProgrammaticCardMoves: () => {},
			requestMoveTaskToTrashWithAnimation: async () => {},
			programmaticCardMoveCycle: 0,
		});
		const requestMoveTaskToTrash = vi.fn(async () => {});
		useLinkedBacklogTaskActionsMock.mockReturnValue({
			handleCreateDependency: () => {},
			handleDeleteDependency: () => {},
			confirmMoveTaskToTrash: async () => {},
			requestMoveTaskToTrash,
		});

		const doneTask = createTask("task-done-drop", "Done task drop", 2);
		let currentBoard: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "done", title: "Done", cards: [doneTask] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		};
		const setBoard = vi.fn<Dispatch<SetStateAction<BoardData>>>((nextBoard) => {
			if (typeof nextBoard === "function") {
				currentBoard = nextBoard(currentBoard);
				return;
			}
			currentBoard = nextBoard;
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={currentBoard}
					setBoard={setBoard}
					ensureTaskWorkspace={async () => ({ ok: true as const })}
					startTaskSession={async () => ({ ok: true as const })}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot!.handleDragEnd({
				draggableId: "task-done-drop",
				type: "CARD",
				source: { droppableId: "done", index: 0 },
				destination: { droppableId: "trash", index: 0 },
				reason: "DROP",
				mode: "FLUID",
				combine: null,
			});
			await Promise.resolve();
		});

		expect(currentBoard.columns.find((column) => column.id === "done")?.cards).toEqual([]);
		expect(currentBoard.columns.find((column) => column.id === "trash")?.cards.map((card) => card.id)).toEqual([
			"task-done-drop",
		]);
		expect(requestMoveTaskToTrash).toHaveBeenCalledWith("task-done-drop", "done", {
			optimisticMoveApplied: true,
			skipWorkingChangeWarning: undefined,
		});
	});

	it("given a review card whose session is still attached, when Implement here is clicked, then it runs the implement-here action with no warning toast", async () => {
		// given a review card whose agent session is still live (attached)
		stubProgrammaticAndLinkedActionMocks();
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: { ok: true as const, path: "/tmp/review-1", baseRef: "main", baseCommit: "abc123" },
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));
		const runImplementHereAction = vi.fn(async () => true);
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard()}
					setBoard={() => {}}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
					initialSessions={{ "review-1": createSessionSummary("review-1", "attached") }}
					runImplementHereAction={runImplementHereAction}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		// when Implement here is clicked for that card
		await act(async () => {
			latestSnapshot!.handleImplementHere("review-1");
			await Promise.resolve();
		});

		// then the injection action runs and no "restart the card" toast is shown
		expect(runImplementHereAction).toHaveBeenCalledWith("review-1");
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("given a review card whose session is gone, when Implement here is clicked, then it declines with a toast and injects nothing", async () => {
		// given a review card whose agent session has ended (gone — no longer attached)
		stubProgrammaticAndLinkedActionMocks();
		const ensureTaskWorkspace = vi.fn(async () => ({
			ok: true as const,
			response: { ok: true as const, path: "/tmp/review-1", baseRef: "main", baseCommit: "abc123" },
		}));
		const startTaskSession = vi.fn(async () => ({ ok: true as const }));
		const runImplementHereAction = vi.fn(async () => true);
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard()}
					setBoard={() => {}}
					ensureTaskWorkspace={ensureTaskWorkspace}
					startTaskSession={startTaskSession}
					initialSessions={{ "review-1": createSessionSummary("review-1", "gone") }}
					runImplementHereAction={runImplementHereAction}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
		});

		if (!latestSnapshot) {
			throw new Error("Expected a hook snapshot.");
		}

		// when Implement here is clicked for that card
		await act(async () => {
			latestSnapshot!.handleImplementHere("review-1");
			await Promise.resolve();
		});

		// then nothing is injected and the operator is told to restart the card first
		expect(runImplementHereAction).not.toHaveBeenCalled();
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({
				intent: "warning",
				message: expect.stringContaining("Restart the card"),
			}),
		);
	});
});
