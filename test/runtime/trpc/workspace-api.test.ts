import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";

const workspaceTaskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
	ensureTaskWorktreeIfDoesntExist: vi.fn(),
}));

const workspaceChangesMocks = vi.hoisted(() => ({
	createEmptyWorkspaceChangesResponse: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	getWorkspaceChangesBetweenRefs: vi.fn(),
	getWorkspaceChangesFromRef: vi.fn(),
	resolveTaskForkPoint: vi.fn(),
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	deleteTaskWorktree: vi.fn(),
	ensureTaskWorktreeIfDoesntExist: workspaceTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist,
	getTaskWorkspaceInfo: vi.fn(),
	resolveTaskCwd: workspaceTaskWorktreeMocks.resolveTaskCwd,
}));

vi.mock("../../../src/workspace/get-workspace-changes.js", () => ({
	createEmptyWorkspaceChangesResponse: workspaceChangesMocks.createEmptyWorkspaceChangesResponse,
	getWorkspaceChanges: workspaceChangesMocks.getWorkspaceChanges,
	getWorkspaceChangesBetweenRefs: workspaceChangesMocks.getWorkspaceChangesBetweenRefs,
	getWorkspaceChangesFromRef: workspaceChangesMocks.getWorkspaceChangesFromRef,
	resolveTaskForkPoint: workspaceChangesMocks.resolveTaskForkPoint,
}));

import { createGitProcessEnv } from "../../../src/core/git-process-env";
import { loadWorkspaceContext } from "../../../src/state/workspace-state";
import { createWorkspaceApi } from "../../../src/trpc/workspace-api";

let tempDirs: string[] = [];

async function createTempProjectRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "fleet-kanban-workspace-api-"));
	tempDirs.push(dir);
	return dir;
}

function createWorkspaceApiForTests(): ReturnType<typeof createWorkspaceApi> {
	return createWorkspaceApi({
		ensureTerminalManagerForWorkspace: vi.fn(),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastRuntimeProjectsUpdated: vi.fn(),
		buildWorkspaceStateSnapshot: vi.fn(),
	});
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
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

function createChangesResponse(): RuntimeWorkspaceChangesResponse {
	return {
		repoRoot: "/tmp/worktree",
		generatedAt: Date.now(),
		files: [],
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.map(async (dir) => await rm(dir, { recursive: true, force: true })));
	tempDirs = [];
});

describe("createWorkspaceApi loadChanges", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockReset();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockReset();
		workspaceChangesMocks.getWorkspaceChanges.mockReset();
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockReset();
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockReset();
		workspaceChangesMocks.resolveTaskForkPoint.mockReset();

		workspaceTaskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/worktree");
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChanges.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesBetweenRefs.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.getWorkspaceChangesFromRef.mockResolvedValue(createChangesResponse());
		workspaceChangesMocks.resolveTaskForkPoint.mockResolvedValue("base-sha");
	});

	it("loads working-copy changes from the task fork point", async () => {
		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(workspaceChangesMocks.resolveTaskForkPoint).toHaveBeenCalledWith("/tmp/worktree", "main");
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "base-sha",
		});
		expect(workspaceChangesMocks.getWorkspaceChanges).not.toHaveBeenCalled();
	});

	it("falls back to the current working-tree diff when the task fork point cannot be resolved", async () => {
		workspaceChangesMocks.resolveTaskForkPoint.mockResolvedValue(null);

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChanges).toHaveBeenCalledWith("/tmp/worktree");
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).not.toHaveBeenCalled();
	});

	it("shows the completed turn diff while awaiting review", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "awaiting_review",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "1111111",
			toRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).not.toHaveBeenCalled();
	});

	it("tracks the current turn from the latest checkpoint while running", async () => {
		const terminalManager = {
			getSummary: vi.fn(() =>
				createSummary({
					state: "running",
					latestTurnCheckpoint: {
						turn: 2,
						ref: "refs/kanban/checkpoints/task-1/turn/2",
						commit: "2222222",
						createdAt: 2,
					},
					previousTurnCheckpoint: {
						turn: 1,
						ref: "refs/kanban/checkpoints/task-1/turn/1",
						commit: "1111111",
						createdAt: 1,
					},
				}),
			),
		};

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => terminalManager as never),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "last_turn",
			},
		);

		expect(workspaceChangesMocks.getWorkspaceChangesFromRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			fromRef: "2222222",
		});
		expect(workspaceChangesMocks.getWorkspaceChangesBetweenRefs).not.toHaveBeenCalled();
	});

	it("returns an empty diff when the task worktree does not exist yet", async () => {
		workspaceTaskWorktreeMocks.resolveTaskCwd.mockRejectedValue(
			new Error('Task worktree not found for task "task-1".'),
		);

		const emptyResponse = createChangesResponse();
		workspaceChangesMocks.createEmptyWorkspaceChangesResponse.mockResolvedValue(emptyResponse);

		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		const response = await api.loadChanges(
			{
				workspaceId: "workspace-1",
				workspacePath: "/tmp/repo",
			},
			{
				taskId: "task-1",
				baseRef: "main",
				mode: "working_copy",
			},
		);

		expect(response).toBe(emptyResponse);
		expect(workspaceChangesMocks.createEmptyWorkspaceChangesResponse).toHaveBeenCalledWith("/tmp/repo");
		expect(workspaceChangesMocks.getWorkspaceChanges).not.toHaveBeenCalled();
	});
});

describe("createWorkspaceApi loadDesignDoc", () => {
	it("returns exists false when the design directory is missing or no file matches", async () => {
		const projectRoot = await createTempProjectRoot();
		const api = createWorkspaceApiForTests();

		await expect(
			api.loadDesignDoc(
				{
					workspaceId: "workspace-1",
					workspacePath: projectRoot,
				},
				{
					taskId: "05506",
				},
			),
		).resolves.toEqual({ exists: false });

		await mkdir(join(projectRoot, "docs", "design"), { recursive: true });

		await expect(
			api.loadDesignDoc(
				{
					workspaceId: "workspace-1",
					workspacePath: projectRoot,
				},
				{
					taskId: "05506",
				},
			),
		).resolves.toEqual({ exists: false });
	});

	it("returns the first sorted matching markdown file content", async () => {
		const projectRoot = await createTempProjectRoot();
		const designDir = join(projectRoot, "docs", "design");
		await mkdir(designDir, { recursive: true });
		await writeFile(join(designDir, "eng-123-z-later.md"), "later");
		await writeFile(join(designDir, "eng-123-a-first.md"), "# First");
		const api = createWorkspaceApiForTests();

		const result = await api.loadDesignDoc(
			{
				workspaceId: "workspace-1",
				workspacePath: projectRoot,
			},
			{
				taskId: "05506",
				externalIssueKey: "ENG-123",
			},
		);

		expect(result).toEqual({
			exists: true,
			path: join(designDir, "eng-123-a-first.md"),
			content: "# First",
		});
	});
});

describe("createWorkspaceApi notifyStateUpdated", () => {
	it("awaits workspace and projects broadcasts for the scoped workspace", async () => {
		const broadcastWorkspace = vi.fn(async () => {});
		const broadcastProjects = vi.fn(async () => {});
		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: broadcastWorkspace,
			broadcastRuntimeProjectsUpdated: broadcastProjects,
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await expect(
			api.notifyStateUpdated({
				workspaceId: "workspace-live",
				workspacePath: "/tmp/live",
			}),
		).resolves.toEqual({ ok: true });

		expect(broadcastWorkspace).toHaveBeenCalledWith("workspace-live", "/tmp/live");
		expect(broadcastProjects).toHaveBeenCalledWith("workspace-live");
	});

	it("surfaces a failed workspace-state broadcast instead of reporting success", async () => {
		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(async () => {
				throw new Error("workspace push failed");
			}),
			broadcastRuntimeProjectsUpdated: vi.fn(async () => {}),
			buildWorkspaceStateSnapshot: vi.fn(),
		});

		await expect(
			api.notifyStateUpdated({
				workspaceId: "workspace-live",
				workspacePath: "/tmp/live",
			}),
		).rejects.toThrow("workspace push failed");
	});
});

describe("createWorkspaceApi ensureWorktree", () => {
	beforeEach(() => {
		workspaceTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockReset();
	});

	it("persists ensure warning into workspace sessions.json and broadcasts updates", async () => {
		const repoPath = await createTempProjectRoot();
		const { execSync } = await import("node:child_process");
		execSync("git init", {
			cwd: repoPath,
			env: createGitProcessEnv(),
			stdio: "ignore",
		});
		const boardPath = join(repoPath, ".cline", "kanban", "board.json");
		await mkdir(join(repoPath, ".cline", "kanban"), { recursive: true });
		const boardData = {
			revision: 1,
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "task-123",
							prompt: "do something",
							baseRef: "main",
							createdAt: Date.now(),
							updatedAt: Date.now(),
						},
					],
				},
			],
		};
		await writeFile(boardPath, JSON.stringify(boardData));

		const context = await loadWorkspaceContext(repoPath);
		await mkdir(context.statePath, { recursive: true });
		await writeFile(join(context.statePath, "board.json"), JSON.stringify(boardData), "utf8");

		workspaceTaskWorktreeMocks.ensureTaskWorktreeIfDoesntExist.mockResolvedValue({
			ok: true,
			path: join(repoPath, "task-123"),
			baseRef: "main",
			baseCommit: "base-commit",
			warning: "Git submodule initialization failed: clone failed",
		});

		const broadcastWorkspace = vi.fn();
		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(),
			broadcastRuntimeWorkspaceStateUpdated: broadcastWorkspace,
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(async () => {
				return {
					repoPath,
					statePath: join(repoPath, ".cline", "kanban"),
					taskWorktreesRoot: "/tmp/worktrees",
					git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
					board: {
						columns: [
							{
								id: "backlog",
								cards: [
									{
										id: "task-123",
										prompt: "do something",
										baseRef: "main",
										createdAt: Date.now(),
										updatedAt: Date.now(),
									},
								],
							},
						],
					},
					sessions: {},
				} as unknown as RuntimeWorkspaceStateResponse;
			}),
		});

		const result = await api.ensureWorktree(
			{
				workspaceId: "workspace-123",
				workspacePath: repoPath,
			},
			{
				taskId: "task-123",
				baseRef: "main",
			},
		);

		expect(result).toEqual({
			ok: true,
			path: join(repoPath, "task-123"),
			baseRef: "main",
			baseCommit: "base-commit",
			warning: "Git submodule initialization failed: clone failed",
		});

		expect(broadcastWorkspace).toHaveBeenCalledWith("workspace-123", repoPath);

		// Read sessions.json and check that warningMessage is written!
		const sessionsPath = join(context.statePath, "sessions.json");
		const sessionsContent = await import("node:fs/promises").then((fs) => fs.readFile(sessionsPath, "utf8"));
		const sessions = JSON.parse(sessionsContent);
		expect(sessions["task-123"]).toMatchObject({
			taskId: "task-123",
			warningMessage: "Git submodule initialization failed: clone failed",
		});
	});
});
