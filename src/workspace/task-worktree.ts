import { access, lstat, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKanbanClineLogger } from "../cline-sdk/cline-runtime-logger";
import { loadRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeAgentId,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { listResolvedSkillsSync } from "../prompts/skill-discovery";
import { getRuntimeHomePath, getTaskWorktreesHomePath, loadWorkspaceContext } from "../state/workspace-state";
import {
	assessTaskWorkDurability,
	type TaskWorkDurabilityAssessment,
	type TaskWorkDurabilityMode,
} from "./durable-save";
import { getGitCommandErrorMessage, getGitStdout, readGitHeadInfo, runGit } from "./git-utils";
import { getWorkspaceFolderLabelForWorktreePath, normalizeTaskIdForWorktreePath } from "./task-worktree-path";
import { DEFAULT_WORKTREE_UNSHARED_PATHS, shouldKeepPathUnsharedInWorktree } from "./task-worktree-unshared-paths";
import { runWorktreePostCreateHook } from "./worktree-post-create-hook";

const KANBAN_MANAGED_EXCLUDE_BLOCK_START = "# kanban-managed-symlinked-ignored-paths:start";
const KANBAN_MANAGED_EXCLUDE_BLOCK_END = "# kanban-managed-symlinked-ignored-paths:end";
const KANBAN_TRASHED_TASK_PATCHES_DIR_NAME = "trashed-task-patches";
const KANBAN_TASK_WORKTREE_SETUP_LOCKFILE_NAME = "kanban-task-worktree-setup.lock";
const TASK_PATCH_FILE_SUFFIX = ".patch";
const WORKTREE_SKILLS_RELATIVE_PATH = ".agents/skills";
const WORKTREE_CLAUDE_SKILLS_RELATIVE_PATH = ".claude/skills";
const LOGGER = createKanbanClineLogger({ component: "worktree-post-create" });

/**
 * Where a card's agent harness discovers its skills inside the worktree.
 *
 * Claude Code resolves its `Skill` tool against project skills under
 * `.claude/skills`; codex and the other CLI harnesses follow the `.agents/skills`
 * (AGENTS.md) convention. An unknown or unset agent falls back to `.agents/skills`
 * so worktree setup never regresses when a new agent id appears.
 */
export function resolveWorktreeSkillsRelativePath(agentId?: RuntimeAgentId | null): string {
	return agentId === "claude" ? WORKTREE_CLAUDE_SKILLS_RELATIVE_PATH : WORKTREE_SKILLS_RELATIVE_PATH;
}

const SYMLINK_PATH_SEGMENT_BLACKLIST = new Set([
	".git",
	".DS_Store",
	"Thumbs.db",
	"Desktop.ini",
	"Icon\r",
	".Spotlight-V100",
	".Trashes",
]);

type CreateSymlink = (target: string, path: string, type: "dir" | "file") => Promise<void>;
type WorktreeSkillsPlacementStatus = "linked" | "existing" | "missing_canonical" | "fallback_created" | "skipped";

export interface ArchivedTaskWorktreeCleanupResult {
	taskId: string;
	removed: boolean;
	staleRegistrationPruned?: boolean;
	discardedStatus?: TaskWorkDurabilityAssessment["status"];
	discardedDetail?: string;
	error?: string;
}

export interface ArchivedTaskWorktreeCleanupSummary {
	cleaned: ArchivedTaskWorktreeCleanupResult[];
}

interface WorktreeSkillsFs {
	lstat: typeof lstat;
	mkdir: typeof mkdir;
	symlink: typeof symlink;
}

const DEFAULT_WORKTREE_SKILLS_FS: WorktreeSkillsFs = {
	lstat,
	mkdir,
	symlink,
};

export async function mirrorIgnoredPath(options: {
	sourcePath: string;
	targetPath: string;
	isDirectory: boolean;
	createSymlink?: CreateSymlink;
}): Promise<"mirrored" | "skipped"> {
	const createSymlink = options.createSymlink ?? symlink;
	try {
		await createSymlink(options.sourcePath, options.targetPath, options.isDirectory ? "dir" : "file");
		return "mirrored";
	} catch {
		return "skipped";
	}
}

function toPlatformRelativePath(path: string): string {
	return path
		.trim()
		.replaceAll("\\", "/")
		.replace(/\/+$/g, "")
		.split("/")
		.filter((segment) => segment.length > 0)
		.join("/");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function lstatExists(
	path: string,
	fs: Pick<WorktreeSkillsFs, "lstat"> = DEFAULT_WORKTREE_SKILLS_FS,
): Promise<boolean> {
	try {
		await fs.lstat(path);
		return true;
	} catch {
		return false;
	}
}

export async function resolveCanonicalSkillsDir(options?: {
	moduleDir?: string;
	pathExists?: (path: string) => Promise<boolean>;
}): Promise<string | null> {
	const here = options?.moduleDir ?? dirname(fileURLToPath(import.meta.url));
	const exists = options?.pathExists ?? pathExists;
	const candidates = [
		resolve(here, ".agents/skills"),
		resolve(here, "../.agents/skills"),
		resolve(here, "../../.agents/skills"),
	];
	for (const candidate of candidates) {
		if (await exists(candidate)) {
			return candidate;
		}
	}
	return null;
}

export async function ensureWorktreeSkillsDirectory(options: {
	worktreePath: string;
	workspacePath?: string;
	skillsRelativePath?: string;
	canonicalSkillsDir?: string | null;
	resolveCanonicalSkillsDir?: () => Promise<string | null>;
	fs?: WorktreeSkillsFs;
}): Promise<WorktreeSkillsPlacementStatus> {
	const fs = options.fs ?? DEFAULT_WORKTREE_SKILLS_FS;
	const targetPath = join(options.worktreePath, options.skillsRelativePath ?? WORKTREE_SKILLS_RELATIVE_PATH);
	const canonicalSkillsDir =
		options.canonicalSkillsDir === undefined
			? await (options.resolveCanonicalSkillsDir ?? resolveCanonicalSkillsDir)()
			: options.canonicalSkillsDir;
	const resolvedSkills = listResolvedSkillsSync({
		workspacePath: options.workspacePath,
		canonicalSkillsDir,
	});
	if (resolvedSkills.length === 0) {
		if (await lstatExists(targetPath, fs)) {
			return "existing";
		}
		return "missing_canonical";
	}

	try {
		const targetStat = await fs.lstat(targetPath).catch(() => null);
		if (targetStat && !targetStat.isDirectory()) {
			return "existing";
		}
		if (!targetStat) {
			await fs.mkdir(targetPath, { recursive: true });
		}

		let linkedAny = false;
		for (const skill of resolvedSkills) {
			const targetSkillPath = join(targetPath, skill.name);
			if (await lstatExists(targetSkillPath, fs)) {
				continue;
			}
			await fs.symlink(skill.skillDir, targetSkillPath, "dir");
			linkedAny = true;
		}
		return linkedAny ? "linked" : "existing";
	} catch {
		try {
			if (await lstatExists(targetPath, fs)) {
				return "existing";
			}
			await fs.mkdir(targetPath, { recursive: true });
			return "fallback_created";
		} catch {
			return "skipped";
		}
	}
}

function isMissingInitialCommitError(message: string): boolean {
	const normalizedMessage = message.trim().toLowerCase();
	if (!normalizedMessage) {
		return false;
	}

	return (
		normalizedMessage.includes("needed a single revision") ||
		normalizedMessage.includes("ambiguous argument") ||
		normalizedMessage.includes("unknown revision or path not in the working tree") ||
		normalizedMessage.includes("bad revision")
	);
}

function getWorktreeBaseRefResolutionErrorMessage(baseRef: string, errorMessage: string): string {
	if (!isMissingInitialCommitError(errorMessage)) {
		return errorMessage;
	}

	return `This repository does not have an initial commit yet, so Kanban cannot create a task worktree from base ref "${baseRef}". Create an initial commit, then try moving the task to in progress again.`;
}

async function tryRunGit(cwd: string, args: string[]): Promise<string | null> {
	const result = await runGit(cwd, args);
	return result.ok ? result.stdout : null;
}

async function getGitCommonDir(repoPath: string): Promise<string> {
	const gitCommonDir = await getGitStdout(["rev-parse", "--git-common-dir"], repoPath);
	return isAbsolute(gitCommonDir) ? gitCommonDir : join(repoPath, gitCommonDir);
}

async function getTaskWorktreeSetupLock(repoPath: string): Promise<LockRequest> {
	return {
		path: await getGitCommonDir(repoPath),
		type: "directory",
		lockfileName: KANBAN_TASK_WORKTREE_SETUP_LOCKFILE_NAME,
	};
}

export async function removeTaskWorktreeSetupLock(repoPath: string): Promise<boolean> {
	const lockPath = join(repoPath, ".git", KANBAN_TASK_WORKTREE_SETUP_LOCKFILE_NAME);
	const existed = await pathExists(lockPath);
	await rm(lockPath, { force: true, recursive: true });
	return existed;
}

async function withTaskWorktreeSetupLock<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
	return await lockedFileSystem.withLock(await getTaskWorktreeSetupLock(repoPath), operation);
}

function getWorktreesRootPath(taskId: string): string {
	const normalizedTaskId = normalizeTaskIdForWorktreePath(taskId);
	return join(getTaskWorktreesHomePath(), normalizedTaskId);
}

function getWorktreesBaseRootPath(): string {
	return getTaskWorktreesHomePath();
}

function getTrashedTaskPatchesRootPath(): string {
	return join(getRuntimeHomePath(), KANBAN_TRASHED_TASK_PATCHES_DIR_NAME);
}

function getTaskWorktreePath(repoPath: string, taskId: string): string {
	const workspaceLabel = getWorkspaceFolderLabelForWorktreePath(repoPath);
	return join(getWorktreesRootPath(taskId), workspaceLabel);
}

function getTaskPatchFilePrefix(taskId: string): string {
	return `${normalizeTaskIdForWorktreePath(taskId)}.`;
}

function parseTaskPatchCommit(taskId: string, filename: string): string | null {
	const prefix = getTaskPatchFilePrefix(taskId);
	if (!filename.startsWith(prefix) || !filename.endsWith(TASK_PATCH_FILE_SUFFIX)) {
		return null;
	}
	const commit = filename.slice(prefix.length, -TASK_PATCH_FILE_SUFFIX.length).trim();
	return commit.length > 0 ? commit : null;
}

async function listTaskPatchFiles(taskId: string): Promise<string[]> {
	const patchesRootPath = getTrashedTaskPatchesRootPath();
	try {
		const entries = await readdir(patchesRootPath);
		return entries.filter((entry) => parseTaskPatchCommit(taskId, entry) !== null);
	} catch {
		return [];
	}
}

async function deleteTaskPatchFiles(taskId: string): Promise<void> {
	const patchesRootPath = getTrashedTaskPatchesRootPath();
	const filenames = await listTaskPatchFiles(taskId);
	await Promise.all(filenames.map((filename) => rm(join(patchesRootPath, filename), { force: true })));
}

async function findTaskPatch(taskId: string): Promise<{ path: string; commit: string } | null> {
	const patchesRootPath = getTrashedTaskPatchesRootPath();
	const filenames = await listTaskPatchFiles(taskId);
	const filename = filenames.sort().at(-1);
	if (!filename) {
		return null;
	}
	const commit = parseTaskPatchCommit(taskId, filename);
	if (!commit) {
		return null;
	}
	return {
		path: join(patchesRootPath, filename),
		commit,
	};
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

async function listUntrackedPaths(worktreePath: string): Promise<string[]> {
	// Original used runGitRaw (throws on failure).
	const output = await getGitStdout(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath, {
		trimStdout: false,
	});
	return output
		.split("\0")
		.map((path) => path.trim())
		.filter((path) => path.length > 0);
}

async function captureTaskPatch(options: { repoPath: string; taskId: string; worktreePath: string }): Promise<void> {
	const headCommit = await getGitStdout(["rev-parse", "--verify", "HEAD"], options.worktreePath);

	const trackedResult = await runGit(options.worktreePath, ["diff", "--binary", "HEAD", "--"], { trimStdout: false });
	if (!trackedResult.ok && trackedResult.exitCode !== 1) {
		throw new Error(trackedResult.error ?? "Failed to capture tracked diff.");
	}
	const trackedPatch = trackedResult.stdout;
	const patchChunks = trackedPatch.trim().length > 0 ? [ensureTrailingNewline(trackedPatch)] : [];

	for (const relativePath of await listUntrackedPaths(options.worktreePath)) {
		const untrackedResult = await runGit(
			options.worktreePath,
			["diff", "--binary", "--no-index", "--", "/dev/null", relativePath],
			{ trimStdout: false },
		);
		if (!untrackedResult.ok && untrackedResult.exitCode !== 1) {
			throw new Error(untrackedResult.error ?? "Failed to capture untracked diff.");
		}
		const untrackedPatch = untrackedResult.stdout;
		if (untrackedPatch.trim().length > 0) {
			patchChunks.push(ensureTrailingNewline(untrackedPatch));
		}
	}

	await deleteTaskPatchFiles(options.taskId);
	if (patchChunks.length === 0) {
		return;
	}

	const patchesRootPath = getTrashedTaskPatchesRootPath();
	await mkdir(patchesRootPath, { recursive: true });
	const patchPath = join(
		patchesRootPath,
		`${normalizeTaskIdForWorktreePath(options.taskId)}.${headCommit}${TASK_PATCH_FILE_SUFFIX}`,
	);
	await lockedFileSystem.writeTextFileAtomic(patchPath, patchChunks.join(""));
}

async function applyTaskPatch(patchPath: string, worktreePath: string): Promise<void> {
	await getGitStdout(["apply", "--binary", "--whitespace=nowarn", patchPath], worktreePath);
}

function shouldSkipSymlink(relativePath: string): boolean {
	const segments = relativePath.split("/").filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		return true;
	}
	return segments.some((segment) => SYMLINK_PATH_SEGMENT_BLACKLIST.has(segment));
}

function isPathWithinRoot(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

function getUniquePaths(relativePaths: string[]): string[] {
	const uniquePaths = Array.from(new Set(relativePaths.map((path) => toPlatformRelativePath(path)).filter(Boolean)));
	uniquePaths.sort((left, right) => {
		const leftDepth = left.split("/").length;
		const rightDepth = right.split("/").length;
		if (leftDepth !== rightDepth) {
			return leftDepth - rightDepth;
		}
		return left.localeCompare(right);
	});

	const roots: string[] = [];
	for (const path of uniquePaths) {
		if (roots.some((root) => isPathWithinRoot(path, root))) {
			continue;
		}
		roots.push(path);
	}

	return roots;
}

async function listIgnoredPaths(repoPath: string): Promise<string[]> {
	const output = await getGitStdout(
		["ls-files", "--others", "--ignored", "--exclude-per-directory=.gitignore", "--directory"],
		repoPath,
	);
	return output
		.split("\n")
		.map((line) => toPlatformRelativePath(line))
		.filter((line) => line.length > 0);
}

async function worktreeHasConfiguredSubmodules(worktreePath: string): Promise<boolean> {
	const gitmodulesPath = join(worktreePath, ".gitmodules");
	if (!(await pathExists(gitmodulesPath))) {
		return false;
	}

	const result = await runGit(worktreePath, [
		"config",
		"--file",
		gitmodulesPath,
		"--get-regexp",
		"^submodule\\..*\\.path$",
	]);
	return result.ok && result.stdout.length > 0;
}

function escapeGitIgnoreLiteral(path: string): string {
	const normalized = toPlatformRelativePath(path);
	return normalized
		.replace(/\\/g, "\\\\")
		.replace(/^([#!])/u, "\\$1")
		.replace(/([*?[])/g, "\\$1");
}

function stripManagedExcludeBlock(content: string): string {
	const lines = content.split("\n");
	const nextLines: string[] = [];
	let insideManagedBlock = false;
	for (const line of lines) {
		if (line === KANBAN_MANAGED_EXCLUDE_BLOCK_START) {
			insideManagedBlock = true;
			continue;
		}
		if (line === KANBAN_MANAGED_EXCLUDE_BLOCK_END) {
			insideManagedBlock = false;
			continue;
		}
		if (!insideManagedBlock) {
			nextLines.push(line);
		}
	}
	return nextLines.join("\n").replace(/\n+$/g, "");
}

async function syncManagedIgnoredPathExcludes(repoPath: string, relativePaths: string[]): Promise<void> {
	const excludePathOutput = await getGitStdout(["rev-parse", "--git-path", "info/exclude"], repoPath);
	if (!excludePathOutput) {
		return;
	}
	const excludePath = isAbsolute(excludePathOutput) ? excludePathOutput : join(repoPath, excludePathOutput);

	const existingContent = await readFile(excludePath, "utf8").catch(() => "");
	const preservedContent = stripManagedExcludeBlock(existingContent);
	const managedPaths = getUniquePaths(relativePaths);
	const managedBlock =
		managedPaths.length === 0
			? ""
			: [
					KANBAN_MANAGED_EXCLUDE_BLOCK_START,
					"# Keep symlinked ignored paths ignored inside Kanban task worktrees.",
					...managedPaths.map((relativePath) => `/${escapeGitIgnoreLiteral(relativePath)}`),
					KANBAN_MANAGED_EXCLUDE_BLOCK_END,
				].join("\n");

	const nextContent = [preservedContent, managedBlock].filter(Boolean).join("\n\n").replace(/\n+$/g, "");
	const normalizedNextContent = nextContent ? `${nextContent}\n` : "";
	if (normalizedNextContent === existingContent) {
		return;
	}

	await lockedFileSystem.writeTextFileAtomic(excludePath, normalizedNextContent);
}

async function syncIgnoredPathsIntoWorktree(
	repoPath: string,
	worktreePath: string,
	skillsRelativePath: string = WORKTREE_SKILLS_RELATIVE_PATH,
): Promise<void> {
	const runtimeConfig = await loadRuntimeConfig(repoPath);
	const unsharedPaths = runtimeConfig.worktree.unsharedPaths ?? DEFAULT_WORKTREE_UNSHARED_PATHS;
	const ignoredPaths = getUniquePaths(await listIgnoredPaths(repoPath)).filter(
		(relativePath) => !shouldSkipSymlink(relativePath),
	);
	const mirroredIgnoredPaths = ignoredPaths.filter(
		(relativePath) => !shouldKeepPathUnsharedInWorktree(relativePath, unsharedPaths),
	);
	const managedExcludePaths = getUniquePaths([...mirroredIgnoredPaths, skillsRelativePath]);

	await syncManagedIgnoredPathExcludes(repoPath, managedExcludePaths);
	for (const relativePath of mirroredIgnoredPaths) {
		if (shouldSkipSymlink(relativePath)) {
			continue;
		}

		const sourcePath = join(repoPath, relativePath);
		if (!(await pathExists(sourcePath))) {
			continue;
		}

		const targetPath = join(worktreePath, relativePath);
		if (await pathExists(targetPath)) {
			continue;
		}

		const sourceStat = await lstat(sourcePath);
		await mkdir(dirname(targetPath), { recursive: true });
		await mirrorIgnoredPath({
			sourcePath,
			targetPath,
			isDirectory: sourceStat.isDirectory(),
		});
	}
}

async function initializeSubmodulesIfNeeded(worktreePath: string): Promise<void> {
	if (!(await worktreeHasConfiguredSubmodules(worktreePath))) {
		return;
	}

	await getGitStdout(["submodule", "update", "--init", "--recursive"], worktreePath);
}

function formatWorktreePostCreateFailure(result: {
	exitCode: number | null;
	timedOut: boolean;
	outputTail: string;
}): string {
	const reason = result.timedOut
		? "timed out"
		: `failed${result.exitCode === null ? "" : ` (exit ${result.exitCode})`}`;
	const tail = result.outputTail.trim();
	return `Worktree post-create command ${reason}.${tail ? ` Output tail:\n${tail}` : ""}`;
}

function appendWorktreeWarning(current: string | undefined, next: string): string {
	return current ? `${current}\n\n${next}` : next;
}

async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
	const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`]);
	return result.ok;
}

async function isValidGitBranchName(repoPath: string, branchName: string): Promise<boolean> {
	const result = await runGit(repoPath, ["check-ref-format", "--branch", branchName]);
	return result.ok;
}

function isBranchCheckedOutCollision(result: { stderr: string; output: string }): boolean {
	const output = `${result.stderr}\n${result.output}`.toLowerCase();
	return output.includes("already checked out") || output.includes("already used by worktree");
}

function createCollisionBranchName(branchName: string, taskId: string): string {
	const suffix = `-${taskId.slice(0, 8)}`;
	if (branchName.endsWith(suffix)) {
		return branchName;
	}
	const maxLength = 60;
	const prefix = branchName.slice(0, maxLength - suffix.length).replace(/-+$/u, "");
	return `${prefix || branchName}${suffix}`;
}

async function addTaskWorktree(options: {
	repoPath: string;
	worktreePath: string;
	baseCommit: string;
	taskId: string;
	branchName?: string;
	resetExistingBranch: boolean;
}): Promise<Awaited<ReturnType<typeof runGit>>> {
	const branchName = options.branchName?.trim();
	if (!branchName || !(await isValidGitBranchName(options.repoPath, branchName))) {
		return await runGit(options.repoPath, ["worktree", "add", "--detach", options.worktreePath, options.baseCommit]);
	}

	const exists = await branchExists(options.repoPath, branchName);
	const args = exists
		? options.resetExistingBranch
			? ["worktree", "add", "-B", branchName, options.worktreePath, options.baseCommit]
			: ["worktree", "add", options.worktreePath, branchName]
		: ["worktree", "add", "-b", branchName, options.worktreePath, options.baseCommit];
	const result = await runGit(options.repoPath, args);
	if (result.ok || !isBranchCheckedOutCollision(result)) {
		return result;
	}

	const collisionBranchName = createCollisionBranchName(branchName, options.taskId);
	if (collisionBranchName === branchName || !(await isValidGitBranchName(options.repoPath, collisionBranchName))) {
		return result;
	}
	LOGGER.log("Task branch is already checked out elsewhere; retrying with a disambiguated name.", {
		severity: "warn",
		taskId: options.taskId,
		branchName,
		collisionBranchName,
	});
	const collisionExists = await branchExists(options.repoPath, collisionBranchName);
	return await runGit(
		options.repoPath,
		collisionExists
			? ["worktree", "add", "-B", collisionBranchName, options.worktreePath, options.baseCommit]
			: ["worktree", "add", "-b", collisionBranchName, options.worktreePath, options.baseCommit],
	);
}

async function runWorktreePreparation(options: {
	repoPath: string;
	worktreePath: string;
	taskId: string;
	workspaceId: string;
	baseRef: string;
	skillsRelativePath: string;
}): Promise<{ warning?: string }> {
	let warning: string | undefined;

	// 1. Initialize submodules if needed (Isolated / Non-fatal)
	try {
		await initializeSubmodulesIfNeeded(options.worktreePath);
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		const subWarning = `Git submodule initialization failed: ${errMsg}`;
		LOGGER.log("Git submodule initialization failed.", {
			severity: "warn",
			taskId: options.taskId,
			warning: subWarning,
		});
		warning = appendWorktreeWarning(warning, subWarning);
	}

	// 2. Sync ignored paths (Fatal)
	await syncIgnoredPathsIntoWorktree(options.repoPath, options.worktreePath, options.skillsRelativePath);

	// 3. Ensure worktree skills directory (Isolated / Non-fatal)
	try {
		await ensureWorktreeSkillsDirectory({
			worktreePath: options.worktreePath,
			workspacePath: options.repoPath,
			skillsRelativePath: options.skillsRelativePath,
		});
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		const skillsWarning = `Failed to ensure worktree skills directory: ${errMsg}`;
		LOGGER.log("Failed to ensure worktree skills directory.", {
			severity: "warn",
			taskId: options.taskId,
			warning: skillsWarning,
		});
		warning = appendWorktreeWarning(warning, skillsWarning);
	}

	// 4. Load runtime config and run post-create hook (Non-fatal unless postCreateFailureMode === "block")
	const runtimeConfig = await loadRuntimeConfig(options.repoPath);
	const hook = runtimeConfig.worktree;
	if (hook.postCreateCommand === undefined) {
		return { warning };
	}
	const result = await runWorktreePostCreateHook(hook, {
		taskId: options.taskId,
		workspaceId: options.workspaceId,
		worktreePath: options.worktreePath,
		repoPath: options.repoPath,
		baseRef: options.baseRef,
	});
	if (result.ok) {
		if (result.outputTail.trim()) {
			LOGGER.log("Worktree post-create command completed.", {
				taskId: options.taskId,
				outputTail: result.outputTail.trim(),
			});
		}
		return { warning };
	}
	const hookWarning = formatWorktreePostCreateFailure(result);
	LOGGER.log("Worktree post-create command failed.", {
		severity: "warn",
		taskId: options.taskId,
		warning: hookWarning,
	});
	if (hook.postCreateFailureMode === "block") {
		throw new Error(hookWarning);
	}
	warning = appendWorktreeWarning(warning, hookWarning);
	return { warning };
}

export async function prepareExistingWorktree(options: {
	repoPath: string;
	worktreePath: string;
	taskId: string;
	workspaceId: string;
	baseRef: string;
	agentId?: RuntimeAgentId | null;
}): Promise<{ warning?: string }> {
	return await runWorktreePreparation({
		...options,
		skillsRelativePath: resolveWorktreeSkillsRelativePath(options.agentId),
	});
}

async function prepareNewTaskWorktree(options: {
	repoPath: string;
	worktreePath: string;
	taskId: string;
	workspaceId: string;
	baseRef: string;
	skillsRelativePath: string;
}): Promise<{ warning?: string }> {
	try {
		return await runWorktreePreparation(options);
	} catch (error) {
		await removeTaskWorktreeInternal(options.repoPath, options.worktreePath).catch(() => {});
		throw error;
	}
}

async function removeTaskWorktreeInternal(repoPath: string, worktreePath: string): Promise<boolean> {
	const existed = await pathExists(worktreePath);
	const removeResult = await runGit(repoPath, ["worktree", "remove", "--force", worktreePath]);
	if (!removeResult.ok) {
		// If remove failed (e.g. worktree in bad state), prune stale registrations
		// so git doesn't think the path is still registered after we rm it.
		await runGit(repoPath, ["worktree", "prune"]);
	}
	await rm(worktreePath, { recursive: true, force: true });
	return existed;
}

function parseGitWorktreeListPaths(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim())
		.filter((path) => path.length > 0);
}

async function listRegisteredGitWorktreePaths(repoPath: string): Promise<Set<string>> {
	const result = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
	return new Set(result.ok ? parseGitWorktreeListPaths(result.stdout) : []);
}

async function pruneStaleTaskWorktreeRegistration(repoPath: string, worktreePath: string): Promise<boolean> {
	const registeredBefore = await listRegisteredGitWorktreePaths(repoPath);
	if (!registeredBefore.has(worktreePath)) {
		return false;
	}
	await runGit(repoPath, ["worktree", "prune"]);
	const registeredAfter = await listRegisteredGitWorktreePaths(repoPath);
	return !registeredAfter.has(worktreePath);
}

async function pruneEmptyParents(rootPath: string, fromPath: string): Promise<void> {
	let current = fromPath;
	while (current.startsWith(rootPath) && current !== rootPath) {
		try {
			const entries = await readdir(current);
			if (entries.length > 0) {
				return;
			}
			await rm(current, { recursive: true, force: true });
			current = dirname(current);
		} catch {
			return;
		}
	}
}

export async function ensureTaskWorktreeIfDoesntExist(options: {
	cwd: string;
	taskId: string;
	workspaceId?: string;
	baseRef: string;
	branchName?: string;
	/**
	 * The card's resolved agent id — the same one used to launch the session.
	 * Drives which skills location is mounted and git-excluded (claude →
	 * `.claude/skills`, others → `.agents/skills`). Callers resolve it
	 * (card override else workspace default); omitting it defaults to
	 * `.agents/skills` so no config read lands on the worktree hot path.
	 */
	agentId?: RuntimeAgentId | null;
}): Promise<RuntimeWorktreeEnsureResponse> {
	try {
		const context = await loadWorkspaceContext(options.cwd);
		const taskId = normalizeTaskIdForWorktreePath(options.taskId);
		const worktreePath = getTaskWorktreePath(context.repoPath, taskId);
		// Skill placement follows the card's resolved agent; callers pass it in.
		// Resolving it here would make skills placement depend on the mutable
		// workspace default instead of the card's resolved agent.
		const skillsRelativePath = resolveWorktreeSkillsRelativePath(options.agentId);
		// Investigation note: ensure is called on every task start. The previous implementation
		// compared the worktree HEAD to the latest baseRef commit and recreated the worktree
		// when the base branch advanced, which could destroy valid task progress. Existing
		// worktrees are now treated as authoritative and only missing worktrees are created.
		const existingResult = await runGit(worktreePath, ["rev-parse", "HEAD"]);
		if (existingResult.ok && existingResult.stdout) {
			await syncIgnoredPathsIntoWorktree(context.repoPath, worktreePath, skillsRelativePath);
			return {
				ok: true,
				path: worktreePath,
				baseRef: options.baseRef.trim(),
				baseCommit: existingResult.stdout,
			};
		}

		return await withTaskWorktreeSetupLock(context.repoPath, async () => {
			const lockedExistingCommit = await tryRunGit(worktreePath, ["rev-parse", "HEAD"]);
			if (lockedExistingCommit) {
				await syncIgnoredPathsIntoWorktree(context.repoPath, worktreePath, skillsRelativePath);
				return {
					ok: true,
					path: worktreePath,
					baseRef: options.baseRef.trim(),
					baseCommit: lockedExistingCommit,
				};
			}

			const requestedBaseRef = options.baseRef.trim();
			if (!requestedBaseRef) {
				return {
					ok: false,
					path: null,
					baseRef: requestedBaseRef,
					baseCommit: null,
					error: "Task base branch is required for worktree creation.",
				};
			}

			const baseRefResult = await runGit(context.repoPath, [
				"rev-parse",
				"--verify",
				`${requestedBaseRef}^{commit}`,
			]);
			if (!baseRefResult.ok) {
				return {
					ok: false,
					path: null,
					baseRef: requestedBaseRef,
					baseCommit: null,
					error: getWorktreeBaseRefResolutionErrorMessage(
						requestedBaseRef,
						baseRefResult.stderr || baseRefResult.output,
					),
				};
			}
			const requestedBaseCommit = baseRefResult.stdout;

			const storedPatch = await findTaskPatch(taskId);
			let baseCommit = storedPatch?.commit ?? requestedBaseCommit;
			let warning: string | undefined;

			if (await pathExists(worktreePath)) {
				await removeTaskWorktreeInternal(context.repoPath, worktreePath);
			}

			// Clean up stale worktree registrations that can linger when git
			// worktree remove fails or the process is interrupted. Without this,
			// git worktree add refuses with "missing but already registered".
			await runGit(context.repoPath, ["worktree", "prune"]);

			await mkdir(dirname(worktreePath), { recursive: true });
			const addResult = await addTaskWorktree({
				repoPath: context.repoPath,
				worktreePath,
				baseCommit,
				taskId,
				branchName: options.branchName,
				resetExistingBranch: storedPatch !== null,
			});
			if (!addResult.ok) {
				if (!storedPatch) {
					return {
						ok: false,
						path: null,
						baseRef: requestedBaseRef,
						baseCommit: null,
						error: addResult.stderr || addResult.output,
					};
				}

				baseCommit = requestedBaseCommit;
				warning =
					"Could not restore the saved task patch onto its original commit. Started from the task base ref instead.";
				const fallbackAddResult = await addTaskWorktree({
					repoPath: context.repoPath,
					worktreePath,
					baseCommit,
					taskId,
					branchName: options.branchName,
					resetExistingBranch: false,
				});
				if (!fallbackAddResult.ok) {
					throw new Error(fallbackAddResult.stderr || fallbackAddResult.output);
				}
			}
			const prepareResult = await prepareNewTaskWorktree({
				repoPath: context.repoPath,
				worktreePath,
				taskId,
				workspaceId: options.workspaceId ?? "",
				baseRef: requestedBaseRef,
				skillsRelativePath,
			});
			if (prepareResult.warning) {
				warning = appendWorktreeWarning(warning, prepareResult.warning);
			}

			if (storedPatch && baseCommit === storedPatch.commit) {
				try {
					await applyTaskPatch(storedPatch.path, worktreePath);
					await rm(storedPatch.path, { force: true });
				} catch (error) {
					warning = `Saved task changes could not be reapplied automatically. ${getGitCommandErrorMessage(error)}`;
				}
			}

			return {
				ok: true,
				path: worktreePath,
				baseRef: requestedBaseRef,
				baseCommit,
				warning,
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			path: null,
			baseRef: options.baseRef.trim(),
			baseCommit: null,
			error: message,
		};
	}
}

/**
 * Assess whether a task's worktree holds durably-saved work, resolving the
 * worktree path/existence for the caller. This is the read-only counterpart to
 * the delete gate below: the web-ui uses it to explain to an operator why a
 * card cannot silently reach Done.
 */
export async function assessTaskWorktreeDurability(options: {
	repoPath: string;
	taskId: string;
	baseRef: string;
	mode: TaskWorkDurabilityMode;
}): Promise<TaskWorkDurabilityAssessment> {
	const taskId = normalizeTaskIdForWorktreePath(options.taskId);
	const worktreePath = getTaskWorktreePath(options.repoPath, taskId);
	const worktreeExists = await pathExists(worktreePath);
	return assessTaskWorkDurability({
		worktreePath,
		worktreeExists,
		baseRef: options.baseRef,
		mode: options.mode,
	});
}

export async function deleteTaskWorktree(options: {
	repoPath: string;
	taskId: string;
	/**
	 * The card's base branch. When provided, the durability gate is enforced:
	 * the worktree is not removed unless its work is durably saved (or `discard`
	 * is set). Legacy callers that omit it get the pre-gate behavior.
	 */
	baseRef?: string;
	mode?: TaskWorkDurabilityMode;
	/** Explicit Discard — remove even when the work is not durably saved. */
	discard?: boolean;
}): Promise<RuntimeWorktreeDeleteResponse> {
	try {
		const taskId = normalizeTaskIdForWorktreePath(options.taskId);
		const rootPath = getWorktreesBaseRootPath();
		const worktreePath = getTaskWorktreePath(options.repoPath, taskId);
		if (!(await pathExists(worktreePath))) {
			const staleRegistrationPruned = await pruneStaleTaskWorktreeRegistration(options.repoPath, worktreePath);
			await deleteTaskPatchFiles(taskId);
			await pruneEmptyParents(rootPath, dirname(worktreePath));
			return {
				ok: true,
				removed: false,
				...(staleRegistrationPruned ? { staleRegistrationPruned } : {}),
			};
		}

		let durability: TaskWorkDurabilityAssessment | undefined;
		if (options.baseRef !== undefined) {
			durability = await assessTaskWorkDurability({
				worktreePath,
				worktreeExists: true,
				baseRef: options.baseRef,
				mode: options.mode ?? "commit",
			});
		}

		// Durability gate: this is the single choke point both the CLI (`task
		// done`) and the web-ui delete through. Refuse to remove a worktree whose
		// work is not durably saved unless the caller explicitly Discards it — a
		// card only reaches Done when its work is committed and landed/merged. See
		// the incident in durable-save.ts: a card stalled at a `git commit` prompt
		// was advanced to Done and its worktree deleted, throwing away real work.
		if (durability && options.discard !== true) {
			if (!durability.durable) {
				return {
					ok: false,
					removed: false,
					blocked: true,
					durability,
					error: durability.detail,
				};
			}
		}

		try {
			await captureTaskPatch({
				repoPath: options.repoPath,
				taskId,
				worktreePath,
			});
		} catch {
			// Patch capture is best-effort. A corrupted or partially-created
			// worktree (e.g. plain directory, no git init) should still be removed.
		}
		const removed = await removeTaskWorktreeInternal(options.repoPath, worktreePath);
		await pruneEmptyParents(rootPath, dirname(worktreePath));
		const discardedDurability = durability && !durability.durable ? durability : null;

		return {
			ok: true,
			removed,
			...(discardedDurability
				? {
						durability: discardedDurability,
						discardedStatus: discardedDurability.status,
						discardedDetail: discardedDurability.detail,
					}
				: {}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			removed: false,
			error: message,
		};
	}
}

export async function deleteArchivedTaskWorktrees(options: {
	repoPath: string;
	taskIds: string[];
	baseRefByTaskId?: Record<string, string | undefined>;
}): Promise<ArchivedTaskWorktreeCleanupSummary> {
	const cleaned: ArchivedTaskWorktreeCleanupResult[] = [];
	const seenTaskIds = new Set<string>();
	for (const rawTaskId of options.taskIds) {
		const taskId = rawTaskId.trim();
		if (!taskId || seenTaskIds.has(taskId)) {
			continue;
		}
		seenTaskIds.add(taskId);
		const deleted = await deleteTaskWorktree({
			repoPath: options.repoPath,
			taskId,
			baseRef: options.baseRefByTaskId?.[taskId],
			mode: "pr",
			discard: true,
		});
		cleaned.push({
			taskId,
			removed: deleted.removed,
			...(deleted.staleRegistrationPruned ? { staleRegistrationPruned: true } : {}),
			...(deleted.discardedStatus ? { discardedStatus: deleted.discardedStatus } : {}),
			...(deleted.discardedDetail ? { discardedDetail: deleted.discardedDetail } : {}),
			...(deleted.ok ? {} : { error: deleted.error ?? "Could not delete archived task worktree." }),
		});
	}
	return { cleaned };
}

export async function resolveTaskCwd(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
	ensure?: boolean;
}): Promise<string> {
	const context = await loadWorkspaceContext(options.cwd);

	const normalizedBaseRef = options.baseRef.trim();
	if (!normalizedBaseRef) {
		throw new Error("Task base branch is required for task workspace resolution.");
	}

	if (options.ensure) {
		const ensured = await ensureTaskWorktreeIfDoesntExist({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: normalizedBaseRef,
		});
		if (!ensured.ok) {
			throw new Error(ensured.error ?? "Worktree setup failed.");
		}
		return ensured.path;
	}

	const worktreePath = getTaskWorktreePath(context.repoPath, options.taskId);
	if (await pathExists(worktreePath)) {
		return worktreePath;
	}
	throw new Error(`Task worktree not found for task "${options.taskId}".`);
}

export async function getTaskWorkspacePathInfo(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<Pick<RuntimeTaskWorkspaceInfoResponse, "taskId" | "path" | "exists" | "baseRef">> {
	const taskId = normalizeTaskIdForWorktreePath(options.taskId);
	const normalizedBaseRef = options.baseRef.trim();
	const repoPath = options.cwd.trim();

	if (!repoPath) {
		throw new Error("Task workspace root is required for task workspace info.");
	}

	if (!normalizedBaseRef) {
		throw new Error("Task base branch is required for task workspace info.");
	}

	const worktreePath = getTaskWorktreePath(repoPath, taskId);
	return {
		taskId,
		path: worktreePath,
		exists: await pathExists(worktreePath),
		baseRef: normalizedBaseRef,
	};
}

export async function getTaskWorkspaceInfo(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<RuntimeTaskWorkspaceInfoResponse> {
	const workspacePathInfo = await getTaskWorkspacePathInfo(options);
	if (!workspacePathInfo.exists) {
		return {
			taskId: workspacePathInfo.taskId,
			path: workspacePathInfo.path,
			exists: false,
			baseRef: workspacePathInfo.baseRef,
			branch: null,
			isDetached: false,
			headCommit: null,
		};
	}

	const headInfo = await readGitHeadInfo(workspacePathInfo.path);
	return {
		taskId: workspacePathInfo.taskId,
		path: workspacePathInfo.path,
		exists: true,
		baseRef: workspacePathInfo.baseRef,
		branch: headInfo.branch,
		isDetached: headInfo.isDetached,
		headCommit: headInfo.headCommit,
	};
}
