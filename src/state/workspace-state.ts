import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { clineHomeDir } from "../config/cline-home";

import {
	type RuntimeAgentSessionLifecycle,
	type RuntimeBoardCard,
	type RuntimeBoardColumnId,
	type RuntimeBoardData,
	type RuntimeGitRepositoryInfo,
	type RuntimeTaskSessionSummary,
	type RuntimeWorkspaceStateResponse,
	type RuntimeWorkspaceStateSaveRequest,
	runtimeBoardCardSchema,
	runtimeBoardDataSchema,
	runtimeTaskSessionSummarySchema,
	runtimeWorkspaceStateSaveRequestSchema,
} from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { parseHomeAgentSessionId } from "../core/home-agent-session";
import { reconcileTaskSessionSummaryLiveness } from "../core/session-liveness";
import { updateTaskDependencies } from "../core/task-board-mutations";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";

const RUNTIME_HOME_DIR = "kanban";
const RUNTIME_WORKTREES_DIR = "worktrees";
const WORKSPACES_DIR = "workspaces";
const INDEX_FILENAME = "index.json";
const BOARD_FILENAME = "board.json";
export const ARCHIVED_CARDS_FILENAME = "archived-cards.json";
const SESSIONS_FILENAME = "sessions.json";
const META_FILENAME = "meta.json";
const INDEX_VERSION = 1;
const WORKSPACE_ID_COLLISION_SUFFIX_LENGTH = 4;

const BOARD_COLUMNS: Array<{ id: RuntimeBoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "done", title: "Done" },
	{ id: "trash", title: "Trash" },
];

interface WorkspaceIndexEntry {
	workspaceId: string;
	repoPath: string;
}

export interface RuntimeWorkspaceIndexEntry {
	workspaceId: string;
	repoPath: string;
}

interface WorkspaceIndexFile {
	version: number;
	entries: Record<string, WorkspaceIndexEntry>;
	repoPathToId: Record<string, string>;
}

interface WorkspaceStateMeta {
	revision: number;
	updatedAt: number;
}

interface WorkspaceBoardCacheEntry {
	board: RuntimeBoardData;
	fileToken: string | null;
}

const workspaceStateMetaSchema = z.object({
	revision: z.number().int().nonnegative(),
	updatedAt: z.number(),
});

const workspaceBoardCacheByPath = new Map<string, WorkspaceBoardCacheEntry>();
let workspaceBoardParseCountForTests = 0;

const workspaceIndexEntrySchema = z.object({
	workspaceId: z.string().min(1, "Workspace ID cannot be empty."),
	repoPath: z.string().min(1, "Workspace repository path cannot be empty."),
});

const workspaceIndexFileSchema = z
	.object({
		version: z.literal(INDEX_VERSION),
		entries: z.record(z.string(), workspaceIndexEntrySchema),
		repoPathToId: z.record(z.string(), z.string().min(1, "Workspace ID cannot be empty.")),
	})
	.superRefine((index, context) => {
		for (const [workspaceId, entry] of Object.entries(index.entries)) {
			if (entry.workspaceId !== workspaceId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["entries", workspaceId, "workspaceId"],
					message: `Workspace ID must match entry key "${workspaceId}".`,
				});
			}
			const mappedWorkspaceId = index.repoPathToId[entry.repoPath];
			if (mappedWorkspaceId !== workspaceId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["entries", workspaceId, "repoPath"],
					message: `Missing repoPathToId mapping for "${entry.repoPath}" to "${workspaceId}".`,
				});
			}
		}

		for (const [repoPath, workspaceId] of Object.entries(index.repoPathToId)) {
			const entry = index.entries[workspaceId];
			if (!entry) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped workspace "${workspaceId}" does not exist in entries.`,
				});
				continue;
			}
			if (entry.repoPath !== repoPath) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped repoPath does not match workspace entry path "${entry.repoPath}".`,
				});
			}
		}
	});

const workspaceSessionsSchema = z
	.record(z.string(), runtimeTaskSessionSummarySchema)
	.superRefine((sessions, context) => {
		for (const [taskId, session] of Object.entries(sessions)) {
			if (session.taskId !== taskId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [taskId, "taskId"],
					message: `Session taskId must match record key "${taskId}".`,
				});
			}
		}
	});

export interface RuntimeWorkspaceContext {
	repoPath: string;
	workspaceId: string;
	statePath: string;
	git: RuntimeGitRepositoryInfo;
}

export interface LoadWorkspaceContextOptions {
	autoCreateIfMissing?: boolean;
}

function createEmptyBoard(): RuntimeBoardData {
	return {
		columns: BOARD_COLUMNS.map((column) => ({
			id: column.id,
			title: column.title,
			cards: [],
		})),
		dependencies: [],
	};
}

function createEmptyWorkspaceIndex(): WorkspaceIndexFile {
	return {
		version: INDEX_VERSION,
		entries: {},
		repoPathToId: {},
	};
}

export function getRuntimeHomePath(): string {
	return join(clineHomeDir(), RUNTIME_HOME_DIR);
}

export function getTaskWorktreesHomePath(): string {
	return join(clineHomeDir(), RUNTIME_WORKTREES_DIR);
}

export function getWorkspacesRootPath(): string {
	return join(getRuntimeHomePath(), WORKSPACES_DIR);
}

function getWorkspaceIndexPath(): string {
	return join(getWorkspacesRootPath(), INDEX_FILENAME);
}

export function getWorkspaceDirectoryPath(workspaceId: string): string {
	return join(getWorkspacesRootPath(), workspaceId);
}

function getWorkspaceBoardPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), BOARD_FILENAME);
}

export function getWorkspaceArchivedCardsPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), ARCHIVED_CARDS_FILENAME);
}

function getWorkspaceSessionsPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), SESSIONS_FILENAME);
}

function getWorkspaceMetaPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), META_FILENAME);
}

function getWorkspaceIndexLockRequest(): LockRequest {
	return {
		path: getWorkspaceIndexPath(),
		type: "file",
	};
}

function getWorkspaceDirectoryLockRequest(workspaceId: string): LockRequest {
	return {
		path: getWorkspaceDirectoryPath(workspaceId),
		type: "directory",
		lockfilePath: join(getWorkspacesRootPath(), `${workspaceId}.lock`),
	};
}

function getWorkspacesRootLockRequest(): LockRequest {
	return {
		path: getWorkspacesRootPath(),
		type: "directory",
		lockfileName: ".workspaces.lock",
	};
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function readJsonFile(path: string): Promise<unknown | null> {
	try {
		const raw = await readFile(path, "utf8");
		try {
			return JSON.parse(raw) as unknown;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Malformed JSON in ${path}. ${message}`);
		}
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return null;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read JSON file at ${path}. ${message}`);
	}
}

async function getFileToken(path: string): Promise<string | null> {
	try {
		const stats = await stat(path, { bigint: true });
		return `${stats.mtimeNs.toString()}:${stats.size.toString()}`;
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return null;
		}
		throw error;
	}
}

function formatSchemaIssuePath(pathSegments: PropertyKey[]): string {
	if (pathSegments.length === 0) {
		return "root";
	}
	return pathSegments
		.map((segment) => {
			if (typeof segment === "number") {
				return `[${segment}]`;
			}
			return String(segment);
		})
		.join(".");
}

function formatSchemaIssues(error: z.ZodError): string {
	return error.issues.map((issue) => `${formatSchemaIssuePath(issue.path)}: ${issue.message}`).join("; ");
}

function parsePersistedStateFile<T>(
	filePath: string,
	fileLabel: string,
	raw: unknown | null,
	schema: z.ZodType<T>,
	defaultValue: T,
): T {
	if (raw === null) {
		return defaultValue;
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`Invalid ${fileLabel} file at ${filePath}. ` +
				`Fix or remove the file. Validation errors: ${formatSchemaIssues(parsed.error)}`,
		);
	}
	return parsed.data;
}

function parseWorkspaceIndex(rawIndex: unknown | null): WorkspaceIndexFile {
	const indexPath = getWorkspaceIndexPath();
	return parsePersistedStateFile(
		indexPath,
		INDEX_FILENAME,
		rawIndex,
		workspaceIndexFileSchema,
		createEmptyWorkspaceIndex(),
	);
}

function parseWorkspaceStateSavePayload(payload: RuntimeWorkspaceStateSaveRequest): RuntimeWorkspaceStateSaveRequest {
	const parsed = runtimeWorkspaceStateSaveRequestSchema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(`Invalid workspace state save payload. ${formatSchemaIssues(parsed.error)}`);
	}
	return parsed.data;
}

async function readWorkspaceBoard(workspaceId: string): Promise<RuntimeBoardData> {
	const boardPath = getWorkspaceBoardPath(workspaceId);
	const rawBoard = await readJsonFile(boardPath);
	workspaceBoardParseCountForTests += 1;
	return updateTaskDependencies(
		parsePersistedStateFile(boardPath, BOARD_FILENAME, rawBoard, runtimeBoardDataSchema, createEmptyBoard()),
	);
}

export function getWorkspaceBoardParseCountForTests(): number {
	return workspaceBoardParseCountForTests;
}

export function resetWorkspaceBoardCacheForTests(): void {
	workspaceBoardCacheByPath.clear();
	workspaceBoardParseCountForTests = 0;
}

async function loadWorkspaceBoardCache(workspaceId: string): Promise<WorkspaceBoardCacheEntry> {
	const boardPath = getWorkspaceBoardPath(workspaceId);
	const fileToken = await getFileToken(boardPath);
	const cached = workspaceBoardCacheByPath.get(boardPath);
	if (cached && cached.fileToken === fileToken) {
		return cached;
	}
	const board = await readWorkspaceBoard(workspaceId);
	const nextFileToken = await getFileToken(boardPath);
	const entry: WorkspaceBoardCacheEntry = {
		board,
		fileToken: nextFileToken,
	};
	workspaceBoardCacheByPath.set(boardPath, entry);
	return entry;
}

async function getCachedWorkspaceBoard(workspaceId: string): Promise<RuntimeBoardData> {
	return (await loadWorkspaceBoardCache(workspaceId)).board;
}

async function writeWorkspaceBoardAndUpdateCache(workspaceId: string, board: RuntimeBoardData): Promise<void> {
	const boardPath = getWorkspaceBoardPath(workspaceId);
	await lockedFileSystem.writeJsonFileAtomic(boardPath, board, {
		lock: null,
	});
	workspaceBoardCacheByPath.set(boardPath, {
		board,
		fileToken: await getFileToken(boardPath),
	});
}

export async function loadWorkspaceBoardById(workspaceId: string): Promise<RuntimeBoardData> {
	return await getCachedWorkspaceBoard(workspaceId);
}

function createEmptyArchivedBoard(): RuntimeBoardData {
	return {
		columns: [{ id: "trash", title: "Trash", cards: [] }],
		dependencies: [],
	};
}

const archivedCardsBoardSchema = z.object({
	columns: z.array(
		z.object({
			id: z.literal("trash"),
			// Defaulted, not required: `archived-cards.json` files written before the trash
			// column carried a title (pre-#73) have no `title`, and the reader must not throw
			// on them — that would crash-loop the whole board on the first post-upgrade start
			// (a live-migration landmine). The column id is a literal, so the title is fixed;
			// the next write persists it canonically, so an old file self-heals.
			title: z.string().default("Trash"),
			cards: z.array(runtimeBoardCardSchema),
		}),
	),
	dependencies: z.array(z.never()).default([]),
});

function getColumnCards(board: RuntimeBoardData, columnId: RuntimeBoardColumnId): RuntimeBoardCard[] {
	return board.columns.find((column) => column.id === columnId)?.cards ?? [];
}

function getTrashCards(board: RuntimeBoardData): RuntimeBoardCard[] {
	return getColumnCards(board, "trash");
}

function getActiveBoardCardIds(board: RuntimeBoardData): Set<string> {
	const ids = new Set<string>();
	for (const column of board.columns) {
		if (column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			ids.add(card.id);
		}
	}
	return ids;
}

function withoutTrashCards(board: RuntimeBoardData): RuntimeBoardData {
	return updateTaskDependencies({
		...board,
		columns: board.columns.map((column) => (column.id === "trash" ? { ...column, cards: [] } : column)),
	});
}

function mergeArchivedTrashCards(
	archivedBoard: RuntimeBoardData,
	cardsToArchive: RuntimeBoardCard[],
): RuntimeBoardData {
	if (cardsToArchive.length === 0) {
		return archivedBoard;
	}
	const existingIds = new Set(getTrashCards(archivedBoard).map((card) => card.id));
	const nextCards = [...getTrashCards(archivedBoard)];
	for (const card of cardsToArchive) {
		if (existingIds.has(card.id)) {
			continue;
		}
		existingIds.add(card.id);
		nextCards.push(card);
	}
	return {
		columns: [{ id: "trash", title: "Trash", cards: nextCards }],
		dependencies: [],
	};
}

async function readWorkspaceArchivedBoard(workspaceId: string): Promise<RuntimeBoardData> {
	const archivePath = getWorkspaceArchivedCardsPath(workspaceId);
	const rawArchive = await readJsonFile(archivePath);
	return parsePersistedStateFile(
		archivePath,
		ARCHIVED_CARDS_FILENAME,
		rawArchive,
		archivedCardsBoardSchema,
		createEmptyArchivedBoard(),
	);
}

async function writeWorkspaceArchivedBoard(workspaceId: string, archivedBoard: RuntimeBoardData): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getWorkspaceArchivedCardsPath(workspaceId), archivedBoard, {
		lock: null,
	});
}

function assertArchivedCardsCaptured(archivedBoard: RuntimeBoardData, expectedCards: RuntimeBoardCard[]): void {
	const archivedIds = new Set(getTrashCards(archivedBoard).map((card) => card.id));
	const missingIds = expectedCards.map((card) => card.id).filter((id) => !archivedIds.has(id));
	if (missingIds.length > 0) {
		throw new Error(`Archive write did not capture trash card(s): ${missingIds.join(", ")}.`);
	}
}

async function archiveTrashCardsAndTrimBoard(
	workspaceId: string,
	board: RuntimeBoardData,
): Promise<{ board: RuntimeBoardData; archived: boolean }> {
	const trashCards = getTrashCards(board);
	if (trashCards.length === 0) {
		return { board, archived: false };
	}
	const currentArchive = await readWorkspaceArchivedBoard(workspaceId);
	const nextArchive = mergeArchivedTrashCards(currentArchive, trashCards);
	await writeWorkspaceArchivedBoard(workspaceId, nextArchive);
	const verifiedArchive = await readWorkspaceArchivedBoard(workspaceId);
	assertArchivedCardsCaptured(verifiedArchive, trashCards);
	return {
		board: withoutTrashCards(board),
		archived: true,
	};
}

async function reconcileArchivedCardsAlreadyOnBoard(
	workspaceId: string,
	board: RuntimeBoardData,
): Promise<RuntimeBoardData> {
	const activeBoardCardIds = getActiveBoardCardIds(board);
	if (activeBoardCardIds.size === 0) {
		return board;
	}
	const archive = await readWorkspaceArchivedBoard(workspaceId);
	const archiveTrashColumn = archive.columns.find((column) => column.id === "trash");
	if (!archiveTrashColumn) {
		return board;
	}
	const nextArchiveCards = archiveTrashColumn.cards.filter((card) => !activeBoardCardIds.has(card.id));
	if (nextArchiveCards.length === archiveTrashColumn.cards.length) {
		return board;
	}
	await writeWorkspaceArchivedBoard(workspaceId, {
		columns: [{ ...archiveTrashColumn, cards: nextArchiveCards }],
		dependencies: [],
	});
	return board;
}

async function migrateWorkspaceTrashToArchiveLocked(
	workspaceId: string,
	options: { reconcileArchiveDuplicates?: boolean } = {},
): Promise<RuntimeBoardData> {
	const board = await getCachedWorkspaceBoard(workspaceId);
	const migration = await archiveTrashCardsAndTrimBoard(workspaceId, board);
	const migratedBoard = migration.board;
	if (migration.archived) {
		await writeWorkspaceBoardAndUpdateCache(workspaceId, migratedBoard);
	}
	if (options.reconcileArchiveDuplicates) {
		return await reconcileArchivedCardsAlreadyOnBoard(workspaceId, migratedBoard);
	}
	return migratedBoard;
}

export async function migrateWorkspaceTrashToArchive(workspaceId: string): Promise<RuntimeBoardData> {
	return await lockedFileSystem.withLock(
		getWorkspaceDirectoryLockRequest(workspaceId),
		async () => await migrateWorkspaceTrashToArchiveLocked(workspaceId),
	);
}

export async function migrateAllWorkspaceTrashToArchive(): Promise<void> {
	const index = await readWorkspaceIndex();
	await Promise.all(
		Object.keys(index.entries).map(async (workspaceId) => {
			await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(workspaceId), async () => {
				await migrateWorkspaceTrashToArchiveLocked(workspaceId, { reconcileArchiveDuplicates: true });
			});
		}),
	);
}

export async function loadWorkspaceArchivedBoardById(workspaceId: string): Promise<RuntimeBoardData> {
	return await lockedFileSystem.withLock(
		getWorkspaceDirectoryLockRequest(workspaceId),
		async () => await readWorkspaceArchivedBoard(workspaceId),
	);
}

async function readWorkspaceSessions(workspaceId: string): Promise<Record<string, RuntimeTaskSessionSummary>> {
	const sessionsPath = getWorkspaceSessionsPath(workspaceId);
	const rawSessions = await readJsonFile(sessionsPath);
	return parsePersistedStateFile(sessionsPath, SESSIONS_FILENAME, rawSessions, workspaceSessionsSchema, {});
}

function classifyPersistedSessionLifecycle(summary: RuntimeTaskSessionSummary): RuntimeAgentSessionLifecycle {
	return summary.agentSessionLifecycle === "resumable" || summary.agentSessionId ? "resumable" : "gone";
}

function normalizePersistedSessionLiveness(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return reconcileTaskSessionSummaryLiveness({
		summary,
		lifecycle: classifyPersistedSessionLifecycle(summary),
	});
}

function partitionWorkspaceSessions(
	workspaceId: string,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): Record<string, RuntimeTaskSessionSummary> {
	const nextSessions: Record<string, RuntimeTaskSessionSummary> = {};
	for (const [taskId, summary] of Object.entries(sessions)) {
		const parsedHomeAgentId = parseHomeAgentSessionId(taskId);
		if (parsedHomeAgentId && parsedHomeAgentId.workspaceId !== workspaceId) {
			continue;
		}

		const normalized = normalizePersistedSessionLiveness(summary);
		if (parsedHomeAgentId && normalized.agentSessionLifecycle === "gone") {
			continue;
		}
		nextSessions[taskId] = normalized;
	}
	return nextSessions;
}

function sessionsAreEqual(
	left: Record<string, RuntimeTaskSessionSummary>,
	right: Record<string, RuntimeTaskSessionSummary>,
): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) {
		return false;
	}
	for (const key of leftKeys) {
		const leftSummary = left[key];
		const rightSummary = right[key];
		if (!rightSummary || JSON.stringify(leftSummary) !== JSON.stringify(rightSummary)) {
			return false;
		}
	}
	return true;
}

async function writeWorkspaceSessions(
	workspaceId: string,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getWorkspaceSessionsPath(workspaceId), sessions, {
		lock: null,
	});
}

async function reconcileWorkspaceAgentSessionsLocked(
	workspaceId: string,
): Promise<Record<string, RuntimeTaskSessionSummary>> {
	const currentSessions = await readWorkspaceSessions(workspaceId);
	const nextSessions = partitionWorkspaceSessions(workspaceId, currentSessions);
	if (!sessionsAreEqual(currentSessions, nextSessions)) {
		await writeWorkspaceSessions(workspaceId, nextSessions);
	}
	return nextSessions;
}

export async function migrateAllWorkspaceAgentSessions(): Promise<void> {
	const index = await readWorkspaceIndex();
	await Promise.all(
		Object.keys(index.entries).map(async (workspaceId) => {
			await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(workspaceId), async () => {
				await reconcileWorkspaceAgentSessionsLocked(workspaceId);
			});
		}),
	);
}

async function readWorkspaceMeta(workspaceId: string): Promise<WorkspaceStateMeta> {
	const metaPath = getWorkspaceMetaPath(workspaceId);
	const rawMeta = await readJsonFile(metaPath);
	return parsePersistedStateFile(metaPath, META_FILENAME, rawMeta, workspaceStateMetaSchema, {
		revision: 0,
		updatedAt: 0,
	});
}

async function readWorkspaceIndex(): Promise<WorkspaceIndexFile> {
	const raw = await readJsonFile(getWorkspaceIndexPath());
	return parseWorkspaceIndex(raw);
}

async function writeWorkspaceIndex(index: WorkspaceIndexFile): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getWorkspaceIndexPath(), index, {
		lock: null,
	});
}

function toWorkspaceIdBase(repoPath: string): string {
	const trimmed = repoPath.trim().replace(/[\\/]+$/g, "");
	const folderName = basename(trimmed) || "project";
	const normalized = folderName
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "project";
}

function createWorkspaceIdCollisionSuffix(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let suffix = "";
	while (suffix.length < length) {
		const bytes = randomBytes(length);
		for (const byte of bytes) {
			suffix += alphabet[byte % alphabet.length] ?? "";
			if (suffix.length === length) {
				break;
			}
		}
	}
	return suffix;
}

function createWorkspaceId(index: WorkspaceIndexFile, repoPath: string): string {
	const baseId = toWorkspaceIdBase(repoPath);
	if (!index.entries[baseId] || index.entries[baseId]?.repoPath === repoPath) {
		return baseId;
	}

	for (let attempt = 0; attempt < 256; attempt += 1) {
		const candidate = `${baseId}-${createWorkspaceIdCollisionSuffix(WORKSPACE_ID_COLLISION_SUFFIX_LENGTH)}`;
		if (!index.entries[candidate] || index.entries[candidate]?.repoPath === repoPath) {
			return candidate;
		}
	}

	throw new Error(`Could not generate a unique workspace ID for ${repoPath}.`);
}

function ensureWorkspaceEntry(
	index: WorkspaceIndexFile,
	repoPath: string,
): { index: WorkspaceIndexFile; entry: WorkspaceIndexEntry; changed: boolean } {
	const existingWorkspaceId = index.repoPathToId[repoPath];
	if (existingWorkspaceId) {
		const existingEntry = index.entries[existingWorkspaceId];
		if (existingEntry && existingEntry.repoPath === repoPath) {
			return {
				index,
				entry: existingEntry,
				changed: false,
			};
		}
	}

	const workspaceId = createWorkspaceId(index, repoPath);

	const entry: WorkspaceIndexEntry = {
		workspaceId,
		repoPath,
	};

	return {
		index: {
			version: INDEX_VERSION,
			entries: {
				...index.entries,
				[workspaceId]: entry,
			},
			repoPathToId: {
				...index.repoPathToId,
				[repoPath]: workspaceId,
			},
		},
		entry,
		changed: true,
	};
}

function findWorkspaceEntry(index: WorkspaceIndexFile, repoPath: string): WorkspaceIndexEntry | null {
	const workspaceId = index.repoPathToId[repoPath];
	if (!workspaceId) {
		return null;
	}
	const entry = index.entries[workspaceId];
	if (!entry || entry.repoPath !== repoPath) {
		return null;
	}
	return entry;
}

function runGitCapture(cwd: string, args: string[]): string | null {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: createGitProcessEnv(),
	});
	if (result.status !== 0 || typeof result.stdout !== "string") {
		return null;
	}
	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

function detectGitRoot(cwd: string): string | null {
	return runGitCapture(cwd, ["rev-parse", "--show-toplevel"]);
}

function detectGitCurrentBranch(repoPath: string): string | null {
	return runGitCapture(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

function detectGitBranches(repoPath: string): string[] {
	// TODO: support showing remote branches again once worktree creation can safely fetch/pull
	// and resolve missing local tracking branches automatically.
	const output = runGitCapture(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
	if (!output) {
		return [];
	}

	const unique = new Set<string>();
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "HEAD") {
			continue;
		}
		unique.add(trimmed);
	}
	return Array.from(unique).sort((left, right) => left.localeCompare(right));
}

function detectGitDefaultBranch(repoPath: string, branches: string[]): string | null {
	const remoteHead = runGitCapture(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (remoteHead) {
		const normalized = remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
		if (normalized) {
			return normalized;
		}
	}
	if (branches.includes("main")) {
		return "main";
	}
	if (branches.includes("master")) {
		return "master";
	}
	return branches[0] ?? null;
}

function detectGitRepositoryInfo(repoPath: string): RuntimeGitRepositoryInfo {
	const gitRoot = detectGitRoot(repoPath);
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${repoPath}`);
	}

	const currentBranch = detectGitCurrentBranch(repoPath);
	const branches = detectGitBranches(repoPath);
	const orderedBranches = currentBranch && !branches.includes(currentBranch) ? [currentBranch, ...branches] : branches;
	const defaultBranch = detectGitDefaultBranch(repoPath, orderedBranches);

	return {
		currentBranch,
		defaultBranch,
		branches: orderedBranches,
	};
}

async function resolveWorkspacePath(cwd: string): Promise<string> {
	const resolvedCwd = resolve(cwd);
	let canonicalCwd = resolvedCwd;
	try {
		canonicalCwd = await realpath(resolvedCwd);
	} catch {
		canonicalCwd = resolvedCwd;
	}

	const gitRoot = detectGitRoot(canonicalCwd);
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${canonicalCwd}`);
	}

	const resolvedGitRoot = resolve(gitRoot);
	try {
		return await realpath(resolvedGitRoot);
	} catch {
		return resolvedGitRoot;
	}
}

function toWorkspaceStateResponse(
	context: RuntimeWorkspaceContext,
	board: RuntimeBoardData,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	revision: number,
): RuntimeWorkspaceStateResponse {
	return {
		repoPath: context.repoPath,
		statePath: context.statePath,
		taskWorktreesRoot: getTaskWorktreesHomePath(),
		git: context.git,
		board,
		sessions,
		revision,
	};
}

export class WorkspaceStateConflictError extends Error {
	readonly currentRevision: number;

	constructor(expectedRevision: number, currentRevision: number) {
		super(`Workspace state revision mismatch: expected ${expectedRevision}, current ${currentRevision}.`);
		this.name = "WorkspaceStateConflictError";
		this.currentRevision = currentRevision;
	}
}

export async function loadWorkspaceContext(
	cwd: string,
	options: LoadWorkspaceContextOptions = {},
): Promise<RuntimeWorkspaceContext> {
	const repoPath = await resolveWorkspacePath(cwd);
	const autoCreateIfMissing = options.autoCreateIfMissing ?? true;
	if (!autoCreateIfMissing) {
		const index = await readWorkspaceIndex();
		const existingEntry = findWorkspaceEntry(index, repoPath);
		if (!existingEntry) {
			throw new Error(`Project ${repoPath} is not added to Kanban yet.`);
		}
		return {
			repoPath,
			workspaceId: existingEntry.workspaceId,
			statePath: getWorkspaceDirectoryPath(existingEntry.workspaceId),
			git: detectGitRepositoryInfo(repoPath),
		};
	}

	return await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		let index = await readWorkspaceIndex();
		const existingEntry = findWorkspaceEntry(index, repoPath);
		const ensured = existingEntry
			? { index, entry: existingEntry, changed: false }
			: ensureWorkspaceEntry(index, repoPath);
		index = ensured.index;
		if (ensured.changed) {
			await writeWorkspaceIndex(index);
		}

		return {
			repoPath,
			workspaceId: ensured.entry.workspaceId,
			statePath: getWorkspaceDirectoryPath(ensured.entry.workspaceId),
			git: detectGitRepositoryInfo(repoPath),
		};
	});
}

export async function loadWorkspaceContextById(workspaceId: string): Promise<RuntimeWorkspaceContext | null> {
	const index = await readWorkspaceIndex();
	const entry = index.entries[workspaceId];
	if (!entry) {
		return null;
	}
	// Resolve directly from the index entry. Do NOT round-trip through
	// loadWorkspaceContext(entry.repoPath): that re-resolves the path via git and
	// takes the index WRITE lock (and may rewrite the index), so a transient — a
	// contended/stale lock, a git hiccup, a momentarily unwritable store — would make
	// this throw and every workspace-SCOPED request fail with "Unknown workspace ID"
	// for a workspace that plainly exists in the index (while unscoped reads like
	// projects.list keep working). A known entry needs no lock, no write, no re-resolve.
	try {
		return {
			repoPath: entry.repoPath,
			workspaceId: entry.workspaceId,
			statePath: getWorkspaceDirectoryPath(entry.workspaceId),
			git: detectGitRepositoryInfo(entry.repoPath),
		};
	} catch {
		return null;
	}
}

export async function listWorkspaceIndexEntries(): Promise<RuntimeWorkspaceIndexEntry[]> {
	const index = await readWorkspaceIndex();
	return Object.values(index.entries)
		.map((entry) => ({
			workspaceId: entry.workspaceId,
			repoPath: entry.repoPath,
		}))
		.sort((left, right) => left.repoPath.localeCompare(right.repoPath));
}

export async function removeWorkspaceIndexEntry(workspaceId: string): Promise<boolean> {
	return await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		const index = await readWorkspaceIndex();
		const entry = index.entries[workspaceId];
		if (!entry) {
			return false;
		}
		delete index.entries[workspaceId];
		delete index.repoPathToId[entry.repoPath];
		await writeWorkspaceIndex(index);
		return true;
	});
}

export async function removeWorkspaceStateFiles(workspaceId: string): Promise<void> {
	await lockedFileSystem.withLocks(
		[getWorkspacesRootLockRequest(), getWorkspaceDirectoryLockRequest(workspaceId)],
		async () => {
			await rm(getWorkspaceDirectoryPath(workspaceId), {
				recursive: true,
				force: true,
			});
		},
	);
}

export async function loadWorkspaceState(cwd: string): Promise<RuntimeWorkspaceStateResponse> {
	const context = await loadWorkspaceContext(cwd);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(context.workspaceId), async () => {
		const board = await migrateWorkspaceTrashToArchiveLocked(context.workspaceId);
		const sessions = await reconcileWorkspaceAgentSessionsLocked(context.workspaceId);
		const meta = await readWorkspaceMeta(context.workspaceId);
		return toWorkspaceStateResponse(context, board, sessions, meta.revision);
	});
}

export async function saveWorkspaceState(
	cwd: string,
	payload: RuntimeWorkspaceStateSaveRequest,
): Promise<RuntimeWorkspaceStateResponse> {
	const parsedPayload = parseWorkspaceStateSavePayload(payload);
	const context = await loadWorkspaceContext(cwd);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(context.workspaceId), async () => {
		const metaPath = getWorkspaceMetaPath(context.workspaceId);
		const currentMeta = await readWorkspaceMeta(context.workspaceId);
		const expectedRevision = parsedPayload.expectedRevision;
		if (
			typeof expectedRevision === "number" &&
			Number.isInteger(expectedRevision) &&
			expectedRevision >= 0 &&
			expectedRevision !== currentMeta.revision
		) {
			throw new WorkspaceStateConflictError(expectedRevision, currentMeta.revision);
		}
		const board = parsedPayload.board;
		const archivedBoard = await archiveTrashCardsAndTrimBoard(context.workspaceId, board);
		const sessions = partitionWorkspaceSessions(context.workspaceId, parsedPayload.sessions);
		const nextRevision = currentMeta.revision + 1;
		const nextMeta: WorkspaceStateMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await writeWorkspaceBoardAndUpdateCache(context.workspaceId, archivedBoard.board);
		await writeWorkspaceSessions(context.workspaceId, sessions);
		await lockedFileSystem.writeJsonFileAtomic(metaPath, nextMeta, {
			lock: null,
		});

		return toWorkspaceStateResponse(context, archivedBoard.board, sessions, nextRevision);
	});
}

export interface RuntimeWorkspaceAtomicMutationResult<T> {
	board: RuntimeBoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	value: T;
	save?: boolean;
}

export interface RuntimeWorkspaceAtomicMutationResponse<T> {
	value: T;
	state: RuntimeWorkspaceStateResponse;
	saved: boolean;
}

export async function mutateWorkspaceState<T>(
	cwd: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceAtomicMutationResult<T>,
): Promise<RuntimeWorkspaceAtomicMutationResponse<T>> {
	const context = await loadWorkspaceContext(cwd);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(context.workspaceId), async () => {
		const currentBoard = await getCachedWorkspaceBoard(context.workspaceId);
		const currentSessions = await reconcileWorkspaceAgentSessionsLocked(context.workspaceId);
		const currentMeta = await readWorkspaceMeta(context.workspaceId);
		const currentState = toWorkspaceStateResponse(context, currentBoard, currentSessions, currentMeta.revision);

		const mutation = mutate(currentState);
		if (mutation.save === false) {
			return {
				value: mutation.value,
				state: currentState,
				saved: false,
			};
		}

		const archivedBoard = await archiveTrashCardsAndTrimBoard(context.workspaceId, mutation.board);
		const nextBoard = archivedBoard.board;
		const nextSessions = partitionWorkspaceSessions(context.workspaceId, mutation.sessions ?? currentSessions);
		const nextRevision = currentMeta.revision + 1;
		const nextMeta: WorkspaceStateMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await writeWorkspaceBoardAndUpdateCache(context.workspaceId, nextBoard);
		await writeWorkspaceSessions(context.workspaceId, nextSessions);
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceMetaPath(context.workspaceId), nextMeta, {
			lock: null,
		});

		return {
			value: mutation.value,
			state: toWorkspaceStateResponse(context, nextBoard, nextSessions, nextRevision),
			saved: true,
		};
	});
}

export async function restoreArchivedWorkspaceTask(
	cwd: string,
	taskId: string,
	targetColumnId: RuntimeBoardColumnId = "review",
): Promise<RuntimeWorkspaceStateResponse> {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		throw new Error("Task ID is required.");
	}
	if (targetColumnId === "trash") {
		throw new Error("Archived tasks must be restored to a non-trash column.");
	}
	const context = await loadWorkspaceContext(cwd);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(context.workspaceId), async () => {
		const currentBoard = await migrateWorkspaceTrashToArchiveLocked(context.workspaceId);
		if (currentBoard.columns.some((column) => column.cards.some((card) => card.id === normalizedTaskId))) {
			throw new Error(`Task "${normalizedTaskId}" already exists on the active board.`);
		}
		const currentArchive = await readWorkspaceArchivedBoard(context.workspaceId);
		const archiveTrashColumn = currentArchive.columns.find((column) => column.id === "trash");
		const archivedTask = archiveTrashColumn?.cards.find((card) => card.id === normalizedTaskId) ?? null;
		if (!archiveTrashColumn || !archivedTask) {
			throw new Error(`Archived task "${normalizedTaskId}" was not found.`);
		}
		const targetColumn = currentBoard.columns.find((column) => column.id === targetColumnId);
		if (!targetColumn) {
			throw new Error(`Column ${targetColumnId} not found.`);
		}

		const now = Date.now();
		const restoredTask: RuntimeBoardCard = {
			...archivedTask,
			autoReviewEnabled: false,
			autoReviewMode: undefined,
			updatedAt: now,
			transitions: [...(archivedTask.transitions ?? []), { column: targetColumnId, at: now }],
		};
		const nextBoard = {
			...currentBoard,
			columns: currentBoard.columns.map((column) =>
				column.id === targetColumnId ? { ...column, cards: [restoredTask, ...column.cards] } : column,
			),
		};
		const nextArchive = {
			columns: [
				{
					...archiveTrashColumn,
					cards: archiveTrashColumn.cards.filter((card) => card.id !== normalizedTaskId),
				},
			],
			dependencies: [],
		};
		const currentSessions = await reconcileWorkspaceAgentSessionsLocked(context.workspaceId);
		const currentMeta = await readWorkspaceMeta(context.workspaceId);
		const nextRevision = currentMeta.revision + 1;
		const nextMeta: WorkspaceStateMeta = {
			revision: nextRevision,
			updatedAt: now,
		};

		await writeWorkspaceBoardAndUpdateCache(context.workspaceId, nextBoard);
		const verifiedBoard = await getCachedWorkspaceBoard(context.workspaceId);
		if (!getColumnCards(verifiedBoard, targetColumnId).some((card) => card.id === normalizedTaskId)) {
			throw new Error(`Board write did not restore task "${normalizedTaskId}".`);
		}
		await writeWorkspaceArchivedBoard(context.workspaceId, nextArchive);
		const verifiedArchive = await readWorkspaceArchivedBoard(context.workspaceId);
		if (getTrashCards(verifiedArchive).some((card) => card.id === normalizedTaskId)) {
			throw new Error(`Archive write did not remove restored task "${normalizedTaskId}".`);
		}
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceMetaPath(context.workspaceId), nextMeta, {
			lock: null,
		});

		return toWorkspaceStateResponse(context, nextBoard, currentSessions, nextRevision);
	});
}
