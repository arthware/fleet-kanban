import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeBoardCard, RuntimeBoardData } from "../../../src/core/api-contract";
import { createGitProcessEnv } from "../../../src/core/git-process-env";
import { moveTaskToColumn } from "../../../src/core/task-board-mutations";
import {
	getWorkspaceArchivedCardsPath,
	getWorkspaceBoardParseCountForTests,
	loadWorkspaceArchivedBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
	migrateWorkspaceTrashToArchive,
	mutateWorkspaceState,
	resetWorkspaceBoardCacheForTests,
	restoreArchivedWorkspaceTask,
	saveWorkspaceState,
} from "../../../src/state/workspace-state";

let previousClineHome: string | undefined;
let tempRoot: string;
let repoPath: string;

function createCard(id: string, prompt = `Prompt for ${id}`): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		transitions: [{ column: "backlog", at: 1 }],
	};
}

function createBoard(input: {
	backlog?: RuntimeBoardCard[];
	done?: RuntimeBoardCard[];
	trash?: RuntimeBoardCard[];
}): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: input.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "done", title: "Done", cards: input.done ?? [] },
			{ id: "trash", title: "Trash", cards: input.trash ?? [] },
		],
		dependencies: [],
	};
}

function createArchiveBoard(cards: RuntimeBoardCard[]): RuntimeBoardData {
	return {
		columns: [{ id: "trash", title: "Trash", cards }],
		dependencies: [],
	};
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeBoardJson(workspaceId: string, board: RuntimeBoardData): Promise<void> {
	const boardPath = join(tempRoot, "home", "kanban", "workspaces", workspaceId, "board.json");
	await mkdir(join(tempRoot, "home", "kanban", "workspaces", workspaceId), { recursive: true });
	await writeFile(boardPath, JSON.stringify(board, null, 2), "utf8");
}

async function writeArchiveJson(workspaceId: string, board: RuntimeBoardData): Promise<void> {
	const archivePath = getWorkspaceArchivedCardsPath(workspaceId);
	await mkdir(join(tempRoot, "home", "kanban", "workspaces", workspaceId), { recursive: true });
	await writeFile(archivePath, JSON.stringify(board, null, 2), "utf8");
}

beforeEach(async () => {
	resetWorkspaceBoardCacheForTests();
	previousClineHome = process.env.CLINE_HOME;
	tempRoot = await mkdtemp(join(tmpdir(), "kanban-workspace-state-"));
	process.env.CLINE_HOME = join(tempRoot, "home");
	repoPath = join(tempRoot, "repo");
	await mkdir(repoPath, { recursive: true });
	execFileSync("git", ["init", "-b", "main"], {
		cwd: repoPath,
		env: createGitProcessEnv(),
		stdio: "ignore",
	});
});

afterEach(async () => {
	resetWorkspaceBoardCacheForTests();
	if (previousClineHome === undefined) {
		delete process.env.CLINE_HOME;
	} else {
		process.env.CLINE_HOME = previousClineHome;
	}
	await rm(tempRoot, { recursive: true, force: true });
});

describe.sequential("workspace board cache", () => {
	it("does not parse board.json for every in-runtime mutation", async () => {
		const context = await loadWorkspaceContext(repoPath);
		await writeBoardJson(context.workspaceId, createBoard({ backlog: [createCard("task-1")] }));
		resetWorkspaceBoardCacheForTests();

		for (let index = 0; index < 5; index += 1) {
			await mutateWorkspaceState(repoPath, (state) => ({
				board: {
					...state.board,
					columns: state.board.columns.map((column) =>
						column.id === "backlog"
							? {
									...column,
									cards: column.cards.map((card) =>
										card.id === "task-1" ? { ...card, title: `Renamed ${index}` } : card,
									),
								}
							: column,
					),
				},
				value: null,
			}));
		}

		expect(getWorkspaceBoardParseCountForTests()).toBe(1);
	});

	it("serves repeated workspace snapshots from memory", async () => {
		const context = await loadWorkspaceContext(repoPath);
		await writeBoardJson(context.workspaceId, createBoard({ backlog: [createCard("task-1")] }));
		resetWorkspaceBoardCacheForTests();

		await expect(loadWorkspaceState(repoPath)).resolves.toMatchObject({
			board: expect.objectContaining({ columns: expect.any(Array) }),
		});
		await loadWorkspaceState(repoPath);
		await loadWorkspaceState(repoPath);

		expect(getWorkspaceBoardParseCountForTests()).toBe(1);
	});

	it("reloads once after an external board write and preserves it during the next mutation", async () => {
		const context = await loadWorkspaceContext(repoPath);
		await writeBoardJson(context.workspaceId, createBoard({ backlog: [createCard("task-1")] }));
		await loadWorkspaceState(repoPath);
		expect(getWorkspaceBoardParseCountForTests()).toBe(1);

		await writeBoardJson(
			context.workspaceId,
			createBoard({ backlog: [createCard("task-1"), createCard("cli-task")] }),
		);

		const mutation = await mutateWorkspaceState(repoPath, (state) => ({
			board: {
				...state.board,
				columns: state.board.columns.map((column) =>
					column.id === "backlog"
						? {
								...column,
								cards: [...column.cards, createCard("runtime-task")],
							}
						: column,
				),
			},
			value: null,
		}));
		const backlogIds = mutation.state.board.columns
			.find((column) => column.id === "backlog")
			?.cards.map((card) => card.id);

		expect(getWorkspaceBoardParseCountForTests()).toBe(2);
		expect(backlogIds).toEqual(["task-1", "cli-task", "runtime-task"]);

		await loadWorkspaceState(repoPath);
		expect(getWorkspaceBoardParseCountForTests()).toBe(2);
	});
});

describe.sequential("workspace trash archive", () => {
	it("migrates board trash into archived-cards.json idempotently without touching done", async () => {
		const context = await loadWorkspaceContext(repoPath);
		const trashOne = createCard("trash-1", "Archived prompt one");
		const trashTwo = createCard("trash-2", "Archived prompt two");
		const done = createCard("done-1", "Done stays live");
		await writeBoardJson(context.workspaceId, createBoard({ done: [done], trash: [trashOne, trashTwo] }));
		await writeArchiveJson(context.workspaceId, createArchiveBoard([trashOne]));

		const migrated = await migrateWorkspaceTrashToArchive(context.workspaceId);
		const rerun = await migrateWorkspaceTrashToArchive(context.workspaceId);
		const archive = await loadWorkspaceArchivedBoardById(context.workspaceId);

		expect(migrated.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(rerun.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(migrated.columns.find((column) => column.id === "done")?.cards).toEqual([done]);
		expect(archive.columns.find((column) => column.id === "trash")?.cards.map((card) => card.id)).toEqual([
			"trash-1",
			"trash-2",
		]);
	});

	it("tolerates a pre-#73 archived-cards.json with no column title and self-heals it", async () => {
		const context = await loadWorkspaceContext(repoPath);
		const existingArchived = createCard("archived-old", "Archived before the column had a title");
		const newlyTrashed = createCard("trash-new", "Freshly trashed");
		await writeBoardJson(context.workspaceId, createBoard({ trash: [newlyTrashed] }));
		// Pre-#73 file: the trash column has no `title`. A strict reader throws here and
		// crash-loops the board on the first post-upgrade start; the schema default must
		// absorb it (this is the live-migration landmine the default guards against). The
		// board write above already created the workspace dir, so writeFile is enough.
		await writeFile(
			getWorkspaceArchivedCardsPath(context.workspaceId),
			JSON.stringify({ columns: [{ id: "trash", cards: [existingArchived] }], dependencies: [] }, null, 2),
			"utf8",
		);

		// Must not throw (the crash-loop this guards), and must preserve the archived card.
		const migrated = await migrateWorkspaceTrashToArchive(context.workspaceId);
		const archive = await loadWorkspaceArchivedBoardById(context.workspaceId);
		const healed = (await readJson(getWorkspaceArchivedCardsPath(context.workspaceId))) as {
			columns: Array<{ id: string; title?: string }>;
		};

		expect(migrated.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(archive.columns.find((column) => column.id === "trash")?.cards.map((card) => card.id)).toEqual([
			"archived-old",
			"trash-new",
		]);
		// The rewrite persists the canonical title, so the file stays valid on the next read.
		expect(healed.columns[0]?.title).toBe("Trash");
	});

	it("archives trash written by a mutation while keeping board.json trash empty", async () => {
		const context = await loadWorkspaceContext(repoPath);
		const initial = await loadWorkspaceState(repoPath);
		const card = createCard("task-1");
		await saveWorkspaceState(repoPath, {
			board: createBoard({ backlog: [card] }),
			sessions: {},
			expectedRevision: initial.revision,
		});

		await mutateWorkspaceState(repoPath, (state) => {
			const moved = moveTaskToColumn(state.board, "task-1", "trash");
			return { board: moved.board, value: null };
		});

		const liveState = await loadWorkspaceState(repoPath);
		const archive = await loadWorkspaceArchivedBoardById(context.workspaceId);

		expect(liveState.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(archive.columns.find((column) => column.id === "trash")?.cards.map((candidate) => candidate.id)).toEqual([
			"task-1",
		]);
	});

	it("does not parse archived-cards.json during a normal mutation or snapshot", async () => {
		const context = await loadWorkspaceContext(repoPath);
		const initial = await loadWorkspaceState(repoPath);
		const card = createCard("task-1");
		await saveWorkspaceState(repoPath, {
			board: createBoard({ backlog: [card] }),
			sessions: {},
			expectedRevision: initial.revision,
		});
		await writeFile(getWorkspaceArchivedCardsPath(context.workspaceId), "{not json", "utf8");

		await expect(
			mutateWorkspaceState(repoPath, (state) => ({
				board: {
					...state.board,
					columns: state.board.columns.map((column) =>
						column.id === "backlog"
							? {
									...column,
									cards: column.cards.map((candidate) =>
										candidate.id === "task-1" ? { ...candidate, title: "Renamed" } : candidate,
									),
								}
							: column,
					),
				},
				value: null,
			})),
		).resolves.toMatchObject({ saved: true });
		await expect(loadWorkspaceState(repoPath)).resolves.toMatchObject({
			board: expect.objectContaining({ columns: expect.any(Array) }),
		});
	});

	it("restores a card from archived-cards.json into the live board and removes it from the archive", async () => {
		const context = await loadWorkspaceContext(repoPath);
		const archivedCard = createCard("task-archived");
		await writeArchiveJson(context.workspaceId, createArchiveBoard([archivedCard]));

		const restored = await restoreArchivedWorkspaceTask(repoPath, archivedCard.id);
		const archive = await readJson(getWorkspaceArchivedCardsPath(context.workspaceId));

		expect(restored.board.columns.find((column) => column.id === "review")?.cards[0]?.id).toBe(archivedCard.id);
		expect(restored.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(
			(archive as RuntimeBoardData).columns.find((column) => column.id === "trash")?.cards.map((card) => card.id),
		).toEqual([]);
	});
});
