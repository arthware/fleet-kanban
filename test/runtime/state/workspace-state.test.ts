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
	loadWorkspaceArchivedBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
	migrateWorkspaceTrashToArchive,
	mutateWorkspaceState,
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
	if (previousClineHome === undefined) {
		delete process.env.CLINE_HOME;
	} else {
		process.env.CLINE_HOME = previousClineHome;
	}
	await rm(tempRoot, { recursive: true, force: true });
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
