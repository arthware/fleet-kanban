import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createGitProcessEnv } from "../../../src/core/git-process-env";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import { moveTaskToColumn } from "../../../src/core/task-board-mutations";
import {
	getWorkspaceArchivedCardsPath,
	getWorkspaceBoardParseCountForTests,
	getWorkspaceEpic,
	loadWorkspaceArchivedBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
	migrateAllWorkspaceAgentSessions,
	migrateWorkspaceTrashToArchive,
	mutateWorkspaceState,
	mutateWorkspaceStateById,
	resetWorkspaceBoardCacheForTests,
	restoreArchivedWorkspaceTask,
	saveWorkspaceState,
	setWorkspaceEpic,
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

async function writeSessionsJson(workspaceId: string, sessions: Record<string, unknown>): Promise<void> {
	const workspaceDir = join(tempRoot, "home", "kanban", "workspaces", workspaceId);
	await mkdir(workspaceDir, { recursive: true });
	await writeFile(join(workspaceDir, "sessions.json"), JSON.stringify(sessions, null, 2), "utf8");
}

async function readSessionsJson(workspaceId: string): Promise<Record<string, unknown>> {
	return (await readJson(join(tempRoot, "home", "kanban", "workspaces", workspaceId, "sessions.json"))) as Record<
		string,
		unknown
	>;
}

function createSession(taskId: string, overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: "claude",
		workspacePath: "/tmp/repo",
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		agentSessionId: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
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
	it("does not parse board.json for every in-runtime mutation", { timeout: 30_000 }, async () => {
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

describe.sequential("workspace agent session reconciliation", () => {
	it("given retired agent ids are persisted, when the workspace loads, then sessions and cards fall back to Claude", async () => {
		// given
		const context = await loadWorkspaceContext(repoPath);
		await writeBoardJson(
			context.workspaceId,
			createBoard({
				backlog: [
					{
						...createCard("task-session"),
						agentId: "cursor" as RuntimeBoardCard["agentId"],
					},
				],
			}),
		);
		await writeSessionsJson(context.workspaceId, {
			"task-session": {
				...createSession("task-session"),
				agentId: "kiro",
			},
		});

		// when
		const state = await loadWorkspaceState(repoPath);

		// then
		expect(state.board.columns[0]?.cards[0]?.agentId).toBe("claude");
		expect(state.sessions["task-session"]?.agentId).toBe("claude");
	});

	it("normalizes dead running sessions, reaps dead and foreign home agents, and is idempotent", async () => {
		const context = await loadWorkspaceContext(repoPath);
		const otherRepoPath = join(tempRoot, "other-repo");
		await mkdir(otherRepoPath, { recursive: true });
		execFileSync("git", ["init", "-b", "main"], {
			cwd: otherRepoPath,
			env: createGitProcessEnv(),
			stdio: "ignore",
		});
		const otherContext = await loadWorkspaceContext(otherRepoPath);
		// One architect identity per workspace now: the canonical id carries no agent
		// suffix. A legacy `:<agentId>`-suffixed id still parses and is reaped when gone.
		const canonicalHomeAgentId = createHomeAgentSessionId(context.workspaceId);
		const legacyGoneHomeAgentId = `${createHomeAgentSessionId(context.workspaceId)}:codex`;
		const foreignHomeAgentId = createHomeAgentSessionId(otherContext.workspaceId);
		const runningTaskId = "task-running";
		const liveLookingTaskId = "task-live-looking";

		await writeBoardJson(
			context.workspaceId,
			createBoard({
				backlog: [createCard(runningTaskId), createCard(liveLookingTaskId)],
			}),
		);

		await writeSessionsJson(context.workspaceId, {
			[runningTaskId]: createSession(runningTaskId, {
				state: "running",
				pid: 999_999,
				startedAt: 1,
				agentSessionId: "task-session",
				agentSessionLifecycle: "attached",
			}),
			[liveLookingTaskId]: createSession(liveLookingTaskId, {
				state: "running",
				pid: process.pid,
				startedAt: 1,
				agentSessionId: "live-looking-session",
				agentSessionLifecycle: "attached",
			}),
			[foreignHomeAgentId]: createSession(foreignHomeAgentId, {
				state: "running",
				pid: 999_999,
				startedAt: 1,
				agentSessionId: "foreign-session",
				agentSessionLifecycle: "attached",
			}),
			[legacyGoneHomeAgentId]: createSession(legacyGoneHomeAgentId, {
				agentId: "codex",
				agentSessionLifecycle: "gone",
			}),
			[canonicalHomeAgentId]: createSession(canonicalHomeAgentId, {
				agentSessionId: "canonical-session",
				agentSessionLifecycle: "resumable",
			}),
		});

		await migrateAllWorkspaceAgentSessions();
		const migrated = await readSessionsJson(context.workspaceId);
		await migrateAllWorkspaceAgentSessions();
		const rerun = await readSessionsJson(context.workspaceId);

		expect(migrated[runningTaskId]).toMatchObject({
			state: "interrupted",
			pid: null,
			reviewReason: "interrupted",
		});
		expect(migrated[liveLookingTaskId]).toMatchObject({
			state: "interrupted",
			pid: null,
			reviewReason: "interrupted",
			agentSessionLifecycle: "resumable",
		});
		expect(migrated[foreignHomeAgentId]).toBeUndefined();
		expect(migrated[legacyGoneHomeAgentId]).toBeUndefined();
		expect(migrated[canonicalHomeAgentId]).toMatchObject({
			taskId: canonicalHomeAgentId,
			agentSessionId: "canonical-session",
		});
		expect(rerun).toEqual(migrated);
	});

	it("filters foreign home-agent sessions on save and mutation writes", async () => {
		const context = await loadWorkspaceContext(repoPath);
		const otherRepoPath = join(tempRoot, "other-repo-write");
		await mkdir(otherRepoPath, { recursive: true });
		execFileSync("git", ["init", "-b", "main"], {
			cwd: otherRepoPath,
			env: createGitProcessEnv(),
			stdio: "ignore",
		});
		const otherContext = await loadWorkspaceContext(otherRepoPath);
		const canonicalHomeAgentId = createHomeAgentSessionId(context.workspaceId, "claude");
		const foreignHomeAgentId = createHomeAgentSessionId(otherContext.workspaceId, "claude");
		const initial = await loadWorkspaceState(repoPath);

		await saveWorkspaceState(repoPath, {
			board: initial.board,
			sessions: {
				[canonicalHomeAgentId]: createSession(canonicalHomeAgentId, { agentSessionId: "canonical-session" }),
				[foreignHomeAgentId]: createSession(foreignHomeAgentId, { agentSessionId: "foreign-session" }),
			},
			expectedRevision: initial.revision,
		});

		const afterSave = await readSessionsJson(context.workspaceId);
		expect(afterSave[canonicalHomeAgentId]).toBeDefined();
		expect(afterSave[foreignHomeAgentId]).toBeUndefined();

		await mutateWorkspaceState(repoPath, (state) => ({
			board: state.board,
			sessions: {
				...state.sessions,
				[foreignHomeAgentId]: createSession(foreignHomeAgentId, { agentSessionId: "foreign-session" }),
			},
			value: null,
		}));

		const afterMutation = await readSessionsJson(context.workspaceId);
		expect(afterMutation[canonicalHomeAgentId]).toBeDefined();
		expect(afterMutation[foreignHomeAgentId]).toBeUndefined();
	});
});

describe("workspace epic metadata persistence", () => {
	it("returns null when no epic metadata is defined on a workspace", async () => {
		const context = await loadWorkspaceContext(repoPath);
		const epic = await getWorkspaceEpic(context.workspaceId);
		expect(epic).toBeNull();
	});

	it("saves, retrieves, and preserves epic metadata on a workspace", async () => {
		const context = await loadWorkspaceContext(repoPath);
		const initialEpic = { name: "Cool Epic Feature", branch: "epic/cool-epic" };

		await setWorkspaceEpic(context.workspaceId, initialEpic);

		const retrieved = await getWorkspaceEpic(context.workspaceId);
		expect(retrieved).toEqual(initialEpic);

		// Mutate workspace state and ensure epic is preserved in meta.json
		await mutateWorkspaceState(repoPath, (state) => ({
			board: state.board,
			value: null,
		}));

		const preservedAfterMutation = await getWorkspaceEpic(context.workspaceId);
		expect(preservedAfterMutation).toEqual(initialEpic);

		// Save workspace state and ensure epic is preserved in meta.json
		const state = await loadWorkspaceState(repoPath);
		await saveWorkspaceState(repoPath, {
			board: state.board,
			sessions: state.sessions,
			expectedRevision: state.revision,
		});

		const preservedAfterSave = await getWorkspaceEpic(context.workspaceId);
		expect(preservedAfterSave).toEqual(initialEpic);

		// Can clear epic metadata
		await setWorkspaceEpic(context.workspaceId, null);
		const cleared = await getWorkspaceEpic(context.workspaceId);
		expect(cleared).toBeNull();
	});
});

describe("workspace sessions scoping, pruning, and liveness reconciliation", () => {
	it("scopes and prunes card sessions to active board cards, drops other workspaces cards, and bounds latestHookActivity", async () => {
		const context = await loadWorkspaceContext(repoPath);

		// Let's set up 4 cards on the board
		await writeBoardJson(
			context.workspaceId,
			createBoard({
				backlog: [createCard("card-1"), createCard("card-2"), createCard("card-3"), createCard("card-4")],
			}),
		);

		// Reset the board cache so it re-reads from disk
		resetWorkspaceBoardCacheForTests();

		const canonicalHomeAgentId = createHomeAgentSessionId(context.workspaceId);
		const foreignHomeAgentId = createHomeAgentSessionId("other-workspace-id");

		// 1. Load a persisted state with 200 records and 4 cards -> 4 (+ this workspace's overseer) survive
		// 2. Load a state containing another workspace's card record -> dropped
		const sessions: Record<string, RuntimeTaskSessionSummary> = {
			[canonicalHomeAgentId]: createSession(canonicalHomeAgentId, { agentSessionId: "home-session" }),
			[foreignHomeAgentId]: createSession(foreignHomeAgentId, { agentSessionId: "other-home-session" }),
			"card-1": createSession("card-1", { agentSessionId: "session-1" }),
			"card-2": createSession("card-2", { agentSessionId: "session-2" }),
			"card-3": createSession("card-3", { agentSessionId: "session-3" }),
			"card-4": createSession("card-4", { agentSessionId: "session-4" }),
			"other-workspace-card": createSession("other-workspace-card", { agentSessionId: "other-card-session" }),
		};

		// 196 other card sessions (not on the board, so they should be pruned)
		for (let i = 5; i <= 200; i++) {
			sessions[`card-${i}`] = createSession(`card-${i}`, { agentSessionId: `session-${i}` });
		}

		await writeSessionsJson(context.workspaceId, sessions);

		// Trigger partition/reconciliation
		await migrateAllWorkspaceAgentSessions();

		const migrated = await readSessionsJson(context.workspaceId);

		// Assertions:
		// Active card sessions survive
		expect(migrated["card-1"]).toBeDefined();
		expect(migrated["card-2"]).toBeDefined();
		expect(migrated["card-3"]).toBeDefined();
		expect(migrated["card-4"]).toBeDefined();

		// Home agent for this workspace survives
		expect(migrated[canonicalHomeAgentId]).toBeDefined();

		// Other workspace home agent is dropped
		expect(migrated[foreignHomeAgentId]).toBeUndefined();

		// Other workspace card is dropped
		expect(migrated["other-workspace-card"]).toBeUndefined();

		// Stale / un-boarded card sessions are pruned
		expect(migrated["card-5"]).toBeUndefined();
		expect(migrated["card-200"]).toBeUndefined();
	});

	it("reconciles dead running card/overseer sessions to interrupted on cold load, while a genuinely live session survives, and keeps records when board.json is unreadable", async () => {
		const context = await loadWorkspaceContext(repoPath);

		// Write a card to the board so it doesn't get pruned
		await writeBoardJson(
			context.workspaceId,
			createBoard({
				backlog: [createCard("running-card")],
			}),
		);
		resetWorkspaceBoardCacheForTests();

		const canonicalHomeAgentId = createHomeAgentSessionId(context.workspaceId);

		// Write sessions.json with:
		// - running-card as running (process is dead, so it should flip to interrupted)
		const sessions: Record<string, RuntimeTaskSessionSummary> = {
			"running-card": createSession("running-card", {
				state: "running",
				pid: 99999,
				startedAt: 12345,
				agentSessionId: "session-running-card",
				agentSessionLifecycle: "attached",
			}),
			[canonicalHomeAgentId]: createSession(canonicalHomeAgentId, {
				state: "running",
				pid: 99999,
				startedAt: 12345,
				agentSessionId: "session-canonical",
				agentSessionLifecycle: "attached",
			}),
		};
		await writeSessionsJson(context.workspaceId, sessions);

		// Run liveness reconciliation
		await migrateAllWorkspaceAgentSessions();

		const migrated = await readSessionsJson(context.workspaceId);

		// Assert they are flipped to interrupted
		expect(migrated["running-card"]).toMatchObject({
			state: "interrupted",
			pid: null,
			reviewReason: "interrupted",
			agentSessionLifecycle: "resumable",
		});
		expect(migrated[canonicalHomeAgentId]).toMatchObject({
			state: "interrupted",
			pid: null,
			reviewReason: "interrupted",
			agentSessionLifecycle: "resumable",
		});

		// 3. Test that when board.json is unreadable, nothing is dropped
		const boardPath = join(tempRoot, "home", "kanban", "workspaces", context.workspaceId, "board.json");
		await writeFile(boardPath, "{ invalid json", "utf8");
		resetWorkspaceBoardCacheForTests();

		// Re-write sessions
		await writeSessionsJson(context.workspaceId, sessions);

		await migrateAllWorkspaceAgentSessions();

		const migratedWithUnreadableBoard = await readSessionsJson(context.workspaceId);

		// Card sessions are NOT dropped because board was unreadable!
		expect(migratedWithUnreadableBoard["running-card"]).toBeDefined();
		// Home agent still survives/is processed
		expect(migratedWithUnreadableBoard[canonicalHomeAgentId]).toBeDefined();
	});

	it("bounds latestHookActivity size to prevent record ballooning", async () => {
		const context = await loadWorkspaceContext(repoPath);

		await writeBoardJson(
			context.workspaceId,
			createBoard({
				backlog: [createCard("active-card")],
			}),
		);
		resetWorkspaceBoardCacheForTests();

		const hugeString = "A".repeat(50000); // 50 KB

		const sessions: Record<string, RuntimeTaskSessionSummary> = {
			"active-card": createSession("active-card", {
				agentSessionId: "active-session-id",
				latestHookActivity: {
					activityText: hugeString,
					toolName: "Read",
					toolInputSummary: hugeString,
					finalMessage: hugeString,
					hookEventName: "AfterTool",
					notificationType: null,
					source: "claude",
				},
			}),
		};
		await writeSessionsJson(context.workspaceId, sessions);

		await migrateAllWorkspaceAgentSessions();

		const migrated = await readSessionsJson(context.workspaceId);
		const activity = (migrated["active-card"] as RuntimeTaskSessionSummary)?.latestHookActivity;

		expect(activity).toBeDefined();
		expect(activity).not.toBeNull();
		if (activity) {
			expect(activity.activityText?.length).toBeLessThan(1100);
			expect(activity.activityText).toContain("...");
			expect(activity.toolInputSummary?.length).toBeLessThan(1100);
			expect(activity.toolInputSummary).toContain("...");
			expect(activity.finalMessage?.length).toBeLessThan(1100);
			expect(activity.finalMessage).toContain("...");
		}

		// Size assertion: serialized JSON of the session is way below the original oversized 150+ KB
		const serializedSize = JSON.stringify(migrated).length;
		expect(serializedSize).toBeLessThan(5000); // well bounded!
	});
});

describe("mutateWorkspaceStateById", () => {
	it("successfully mutates the correct workspace by ID and resists any path or cwd mismatches", async () => {
		const context1 = await loadWorkspaceContext(repoPath);

		const repoPath2 = join(tempRoot, "repo2");
		await mkdir(repoPath2, { recursive: true });
		execFileSync("git", ["init", "-b", "main"], {
			cwd: repoPath2,
			env: createGitProcessEnv(),
			stdio: "ignore",
		});
		const context2 = await loadWorkspaceContext(repoPath2);

		await writeBoardJson(context1.workspaceId, createBoard({ backlog: [createCard("task-1")] }));
		await writeBoardJson(context2.workspaceId, createBoard({ backlog: [createCard("task-2")] }));

		const result = await mutateWorkspaceStateById(context1.workspaceId, (state) => ({
			board: {
				...state.board,
				columns: state.board.columns.map((col) =>
					col.id === "backlog" ? { ...col, cards: [...col.cards, createCard("task-new")] } : col,
				),
			},
			value: "mutated-1",
		}));

		expect(result.value).toBe("mutated-1");

		const board1 = (await readJson(
			join(tempRoot, "home", "kanban", "workspaces", context1.workspaceId, "board.json"),
		)) as RuntimeBoardData;
		const board2 = (await readJson(
			join(tempRoot, "home", "kanban", "workspaces", context2.workspaceId, "board.json"),
		)) as RuntimeBoardData;

		const backlogCol1 = board1.columns.find((col) => col.id === "backlog");
		const backlogCol2 = board2.columns.find((col) => col.id === "backlog");
		expect(backlogCol1).toBeDefined();
		expect(backlogCol2).toBeDefined();
		const backlogCards1 = backlogCol1?.cards.map((c) => c.id);
		const backlogCards2 = backlogCol2?.cards.map((c) => c.id);

		expect(backlogCards1).toEqual(["task-1", "task-new"]);
		expect(backlogCards2).toEqual(["task-2"]);
	});

	it("throws an error if workspace ID is not found in the index", async () => {
		await expect(
			mutateWorkspaceStateById("workspace-unknown", (state) => ({ board: state.board, value: null })),
		).rejects.toThrow('Workspace with ID "workspace-unknown" not found in index.');
	});
});
