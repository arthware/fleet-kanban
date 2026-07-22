import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanBoard, type RequestProgrammaticCardMove } from "@/components/kanban-board";
import type { BoardData } from "@/types";

const dndMock = vi.hoisted(() => ({
	sensorApi: null as {
		tryGetLock: ReturnType<typeof vi.fn>;
	} | null,
}));

vi.mock("@hello-pangea/dnd", async () => {
	const React = await vi.importActual<typeof import("react")>("react");

	return {
		DragDropContext: ({
			children,
			sensors,
		}: {
			children: ReactNode;
			sensors?: Array<(api: NonNullable<typeof dndMock.sensorApi>) => void>;
		}): React.ReactElement => {
			React.useEffect(() => {
				if (!dndMock.sensorApi) {
					return;
				}
				for (const sensor of sensors ?? []) {
					sensor(dndMock.sensorApi);
				}
			}, [sensors]);

			return <>{children}</>;
		},
	};
});

vi.mock("@/components/board-column", () => ({
	BoardColumn: ({
		column,
		onClearTrash,
	}: {
		column: BoardData["columns"][number];
		onClearTrash?: () => void;
	}): React.ReactElement => (
		<section data-column-id={column.id}>
			{onClearTrash ? (
				<button type="button" aria-label="Clear archived tasks" onClick={onClearTrash}>
					Clear
				</button>
			) : null}
			<div className="kb-column-cards">
				{column.cards.map((card) => (
					<div key={card.id} data-task-id={card.id} />
				))}
			</div>
		</section>
	),
}));

vi.mock("@/components/dependencies/dependency-overlay", () => ({
	DependencyOverlay: (): null => null,
}));

vi.mock("@/components/dependencies/use-dependency-linking", () => ({
	useDependencyLinking: () => ({
		draft: null,
		onDependencyPointerDown: vi.fn(),
		onDependencyPointerEnter: vi.fn(),
	}),
}));

function createRect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	} as DOMRect;
}

describe("KanbanBoard", () => {
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
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(
			this: HTMLElement,
		) {
			if (this.dataset.taskId === "source-task") {
				return createRect(20, 20, 160, 96);
			}
			if (this.dataset.taskId === "target-task-1") {
				return createRect(300, 20, 160, 96);
			}
			if (this.classList.contains("kb-column-cards")) {
				const columnId = this.closest<HTMLElement>("[data-column-id]")?.dataset.columnId;
				if (columnId === "backlog") {
					return createRect(12, 12, 176, 420);
				}
				if (columnId === "in_progress") {
					return createRect(292, 12, 176, 420);
				}
			}
			return createRect(0, 0, 0, 0);
		});
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
		dndMock.sensorApi = null;
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

	it("marks the board while a programmatic move is active", async () => {
		const dragActions = {
			isActive: vi.fn(() => true),
			move: vi.fn(),
			drop: vi.fn(),
			cancel: vi.fn(),
		};
		const preDrag = {
			fluidLift: vi.fn(() => dragActions),
			isActive: vi.fn(() => true),
			abort: vi.fn(),
		};
		dndMock.sensorApi = {
			tryGetLock: vi.fn(() => preDrag),
		};

		const board: BoardData = {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "source-task",
							title: "Source task",
							prompt: "Source task",
							startInPlanMode: false,
							autoReviewEnabled: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "target-task-1",
							title: "Target task 1",
							prompt: "Target task 1",
							startInPlanMode: false,
							autoReviewEnabled: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "done", title: "Done", cards: [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		};

		let requestMove: RequestProgrammaticCardMove | null = null;

		await act(async () => {
			root.render(
				<KanbanBoard
					data={board}
					taskSessions={{}}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					dependencies={[]}
					onDragEnd={() => {}}
					onRequestProgrammaticCardMoveReady={(nextRequestMove) => {
						requestMove = nextRequestMove;
					}}
				/>,
			);
		});

		const boardElement = container.querySelector<HTMLElement>(".kb-board");
		expect(boardElement?.dataset.programmaticCardMove).toBeUndefined();

		await act(async () => {
			requestMove?.({
				taskId: "source-task",
				fromColumnId: "backlog",
				toColumnId: "in_progress",
				insertAtTop: true,
			});
		});

		expect(boardElement?.dataset.programmaticCardMove).toBe("true");
	});

	it("renders visible columns in board order while keeping trash hidden", async () => {
		const board: BoardData = {
			columns: [
				{ id: "trash", title: "Trash", cards: [] },
				{ id: "done", title: "Done", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "backlog", title: "Backlog", cards: [] },
			],
			dependencies: [],
		};

		await act(async () => {
			root.render(
				<KanbanBoard
					data={board}
					taskSessions={{}}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					dependencies={[]}
					onDragEnd={() => {}}
				/>,
			);
		});

		const columnIds = Array.from(container.querySelectorAll<HTMLElement>("section[data-column-id]")).map(
			(column) => column.dataset.columnId,
		);
		expect(columnIds).toEqual(["backlog", "in_progress", "review", "done"]);
		expect(columnIds).not.toContain("trash");
	});

	it("reveals archived cards with a count and scopes Clear to the archived view", async () => {
		const onClearTrash = vi.fn();
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "done", title: "Done", cards: [] },
				{
					id: "trash",
					title: "Archived",
					cards: [
						{
							id: "archived-task-1",
							title: "Archived task 1",
							prompt: "Archived task 1",
							startInPlanMode: false,
							autoReviewEnabled: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
						{
							id: "archived-task-2",
							title: "Archived task 2",
							prompt: "Archived task 2",
							startInPlanMode: false,
							autoReviewEnabled: false,
							baseRef: "main",
							createdAt: 2,
							updatedAt: 2,
						},
					],
				},
			],
			dependencies: [],
		};

		await act(async () => {
			root.render(
				<KanbanBoard
					data={board}
					taskSessions={{}}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					onClearTrash={onClearTrash}
					dependencies={[]}
					onDragEnd={() => {}}
				/>,
			);
		});

		expect(container.querySelector('section[data-column-id="trash"]')).toBeNull();
		expect(container.querySelector('[data-task-id="archived-task-1"]')).toBeNull();

		const toggle = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Archived (2)",
		);
		expect(toggle).toBeDefined();

		await act(async () => {
			toggle?.click();
		});

		expect(container.querySelector('section[data-column-id="trash"]')).not.toBeNull();
		expect(container.querySelector('[data-task-id="archived-task-1"]')).not.toBeNull();
		const clearButton = container.querySelector<HTMLButtonElement>('button[aria-label="Clear archived tasks"]');
		expect(clearButton).not.toBeNull();

		await act(async () => {
			clearButton?.click();
		});

		expect(onClearTrash).toHaveBeenCalledTimes(1);
	});

	it("loads archived cards on demand and renders archivedData when opened", async () => {
		const onLoadArchivedCards = vi.fn();
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "done", title: "Done", cards: [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		};
		const archivedData: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "done", title: "Done", cards: [] },
				{
					id: "trash",
					title: "Archived",
					cards: [
						{
							id: "archived-task-1",
							title: "Archived task 1",
							prompt: "Archived task 1",
							startInPlanMode: false,
							autoReviewEnabled: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
			],
			dependencies: [],
		};

		await act(async () => {
			root.render(
				<KanbanBoard
					data={board}
					archivedData={archivedData}
					taskSessions={{}}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					onLoadArchivedCards={onLoadArchivedCards}
					dependencies={[]}
					onDragEnd={() => {}}
				/>,
			);
		});

		const toggle = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Archived (0)",
		);
		expect(toggle).toBeDefined();
		expect(container.querySelector('[data-task-id="archived-task-1"]')).toBeNull();

		await act(async () => {
			toggle?.click();
		});

		expect(onLoadArchivedCards).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[data-task-id="archived-task-1"]')).not.toBeNull();
	});
});
