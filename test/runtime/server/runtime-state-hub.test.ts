import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeStateStreamMessage,
	RuntimeStateStreamWorkspaceStateMessage,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import { runtimeBoardCardSchema } from "../../../src/core/api-contract";
import { addTaskToColumn } from "../../../src/core/task-board-mutations";
import {
	applyPersistedCardPrToBoard,
	createRuntimeStateHub,
	SnapshotAssemblyTimeoutError,
	withSnapshotTimeout,
} from "../../../src/server/runtime-state-hub";
import { createWorkspaceApi } from "../../../src/trpc/workspace-api";
import type { CardPrRef } from "../../../src/workspace/card-pr-url";

const MERGED_PR: CardPrRef = {
	url: "https://github.com/cline/kanban/pull/42",
	state: "merged",
	number: 42,
};

const CLOSED_PR: CardPrRef = {
	...MERGED_PR,
	state: "closed",
};

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
								startInPlanMode: false,
								baseRef: "main",
								prUrl: MERGED_PR.url,
								prState: "open",
								prNumber: MERGED_PR.number,
								createdAt: 1,
								updatedAt: 1,
							}),
						]
					: [],
		})),
		dependencies: [],
	};
}

function cardColumnId(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	return board.columns.find((column) => column.cards.some((card) => card.id === taskId))?.id ?? null;
}

function emptyBoard(): RuntimeBoardData {
	return {
		columns: COLUMN_IDS.map((id) => ({ id, title: id, cards: [] })),
		dependencies: [],
	};
}

function createWorkspaceState(workspacePath: string, board: RuntimeBoardData): RuntimeWorkspaceStateResponse {
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
		sessions: {},
		revision: 1,
	};
}

async function setupWorkspaceStateStream(input: {
	workspaceId: string;
	workspacePath: string;
	board: RuntimeBoardData;
}) {
	let board = input.board;
	const hub = createRuntimeStateHub({
		workspaceRegistry: {
			resolveWorkspaceForStream: async () => ({
				workspaceId: input.workspaceId,
				workspacePath: input.workspacePath,
			}),
			buildProjectsPayload: async () => ({
				currentProjectId: input.workspaceId,
				projects: [
					{
						id: input.workspaceId,
						path: input.workspacePath,
						name: "repo",
						taskCounts: {
							backlog: board.columns.find((column) => column.id === "backlog")?.cards.length ?? 0,
							in_progress: 0,
							review: 0,
							done: 0,
							trash: 0,
						},
					},
				],
				architectWorkspaceId: null,
			}),
			buildWorkspaceStateSnapshot: async () => createWorkspaceState(input.workspacePath, board),
		},
	});

	const server: Server = createServer();
	server.on("upgrade", (request, socket, head) => {
		hub.handleUpgrade(request, socket, head, { requestedWorkspaceId: input.workspaceId });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const messages: RuntimeStateStreamMessage[] = [];
	const client = new WebSocket(`ws://127.0.0.1:${port}/api/runtime/ws`);
	client.on("message", (raw) => {
		messages.push(JSON.parse(String(raw)) as RuntimeStateStreamMessage);
	});
	await new Promise<void>((resolve, reject) => {
		client.once("open", resolve);
		client.once("error", reject);
	});
	await waitForMessage(messages, (message) => message.type === "snapshot");

	return {
		hub,
		server,
		client,
		messages,
		setBoard: (nextBoard: RuntimeBoardData) => {
			board = nextBoard;
		},
		async cleanup() {
			client.close();
			await hub.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function waitForMessage<T extends RuntimeStateStreamMessage>(
	messages: RuntimeStateStreamMessage[],
	predicate: (message: RuntimeStateStreamMessage) => message is T,
): Promise<T> {
	const existing = messages.find(predicate);
	if (existing) {
		return existing;
	}
	return await new Promise<T>((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error("Timed out waiting for runtime stream message.")), 1_000);
		const poll = setInterval(() => {
			const message = messages.find(predicate);
			if (!message) {
				return;
			}
			clearInterval(poll);
			clearTimeout(deadline);
			resolve(message);
		}, 10);
	});
}

function createCliStyleCard(prompt: string): RuntimeBoardCard {
	const created = addTaskToColumn(
		emptyBoard(),
		"backlog",
		{
			prompt,
			title: prompt.split(/\r?\n/u)[0],
			startInPlanMode: false,
			autoReviewEnabled: true,
			autoReviewMode: "commit",
			baseRef: "main",
		},
		() =>
			`task-${prompt
				.toLowerCase()
				.replace(/[^a-z0-9]+/gu, "-")
				.replace(/^-|-$/gu, "")}`,
	);
	const card = created.task;
	if (!card) {
		throw new Error("Failed to create test card.");
	}
	return card;
}

describe("applyPersistedCardPrToBoard", () => {
	it("given a review card whose PR transitioned to merged, when the monitor persists it, then the card is moved to done", () => {
		const result = applyPersistedCardPrToBoard(boardWithCard("review"), "task-1", MERGED_PR);

		expect(result.updated).toBe(true);
		expect(cardColumnId(result.board, "task-1")).toBe("done");
		expect(result.board.columns.find((column) => column.id === "done")?.cards[0]?.prState).toBe("merged");
	});

	it("given a review card whose PR transitioned to closed, when the monitor persists it, then the card is moved to trash", () => {
		const result = applyPersistedCardPrToBoard(boardWithCard("review"), "task-1", CLOSED_PR);

		expect(result.updated).toBe(true);
		expect(cardColumnId(result.board, "task-1")).toBe("trash");
		expect(result.board.columns.find((column) => column.id === "trash")?.cards[0]?.prState).toBe("closed");
	});

	it("given an in-progress card whose PR transitioned to merged, when the monitor persists it, then the card is moved to done", () => {
		const result = applyPersistedCardPrToBoard(boardWithCard("in_progress"), "task-1", MERGED_PR);

		expect(result.updated).toBe(true);
		expect(cardColumnId(result.board, "task-1")).toBe("done");
	});

	it("given a card already in done, when the monitor persists a terminal PR state, then the card stays in done", () => {
		const result = applyPersistedCardPrToBoard(boardWithCard("done"), "task-1", MERGED_PR);

		expect(result.updated).toBe(true);
		expect(cardColumnId(result.board, "task-1")).toBe("done");
	});

	it("given a backlog card, when the monitor persists a terminal PR state, then the card is not pulled forward", () => {
		const result = applyPersistedCardPrToBoard(boardWithCard("backlog"), "task-1", MERGED_PR);

		expect(result.updated).toBe(true);
		expect(cardColumnId(result.board, "task-1")).toBe("backlog");
	});
});

describe("withSnapshotTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("given a promise that settles before the deadline, when awaited, then it passes the value through", async () => {
		await expect(withSnapshotTimeout(Promise.resolve("ok"), "projects payload", 1_000)).resolves.toBe("ok");
	});

	it("given a promise that never settles, when the deadline passes, then it rejects naming the stage", async () => {
		const guarded = withSnapshotTimeout(new Promise<never>(() => {}), "workspace state", 1_000);
		const isTimeout = expect(guarded).rejects.toBeInstanceOf(SnapshotAssemblyTimeoutError);
		await vi.advanceTimersByTimeAsync(1_000);
		await isTimeout;
		// `guarded` is now a settled rejection; asserting its message needs no further ticks.
		await expect(guarded).rejects.toThrow(/workspace state/);
	});

	it("given a promise that resolves, when the deadline later elapses, then the timer was cleared and does not reject", async () => {
		await expect(withSnapshotTimeout(Promise.resolve(42), "workspace metadata", 1_000)).resolves.toBe(42);
		await vi.advanceTimersByTimeAsync(5_000);
	});
});

describe("CLI-style workspace state notify", () => {
	it.each([
		["inline --prompt create", "Inline card prompt"],
		["--file create", "# File card\n\nCreated from Markdown."],
	])(
		"given a subscribed workspace stream, when a CLI-style %s mutates the board then notifies, then the client receives the updated workspace state",
		async (_label, prompt) => {
			const workspaceId = "workspace-live";
			const workspacePath = "/tmp/workspace-live";
			const stream = await setupWorkspaceStateStream({
				workspaceId,
				workspacePath,
				board: emptyBoard(),
			});
			try {
				const card = createCliStyleCard(prompt);
				stream.setBoard({
					...emptyBoard(),
					columns: emptyBoard().columns.map((column) =>
						column.id === "backlog" ? { ...column, cards: [card] } : column,
					),
				});
				const api = createWorkspaceApi({
					ensureTerminalManagerForWorkspace: vi.fn(),
					getScopedClineTaskSessionService: vi.fn(),
					broadcastRuntimeWorkspaceStateUpdated: stream.hub.broadcastRuntimeWorkspaceStateUpdated,
					broadcastRuntimeProjectsUpdated: stream.hub.broadcastRuntimeProjectsUpdated,
					buildWorkspaceStateSnapshot: vi.fn(),
				});

				await expect(api.notifyStateUpdated({ workspaceId, workspacePath })).resolves.toEqual({ ok: true });

				const update = await waitForMessage(
					stream.messages,
					(message): message is RuntimeStateStreamWorkspaceStateMessage =>
						message.type === "workspace_state_updated" &&
						message.workspaceState.board.columns.some((column) =>
							column.cards.some((candidate) => candidate.id === card.id),
						),
				);
				expect(update.workspaceId).toBe(workspaceId);
				expect(
					update.workspaceState.board.columns.find((column) => column.id === "backlog")?.cards[0]?.prompt,
				).toBe(prompt);
			} finally {
				await stream.cleanup();
			}
		},
	);
});
