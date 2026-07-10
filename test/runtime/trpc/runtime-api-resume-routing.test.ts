import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const agentRegistryMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
	buildRuntimeConfigResponse: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
}));

const locateAgentTranscriptMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-registry.js", () => ({
	resolveAgentCommand: agentRegistryMocks.resolveAgentCommand,
	buildRuntimeConfigResponse: agentRegistryMocks.buildRuntimeConfigResponse,
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	resolveTaskCwd: taskWorktreeMocks.resolveTaskCwd,
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
}));

vi.mock("../../../src/terminal/agent-transcript-locator.js", () => ({
	locateAgentTranscript: locateAgentTranscriptMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

vi.mock("../../../src/cline-sdk/sdk-provider-boundary.js", () => ({
	SDK_DEFAULT_MODEL_ID: "anthropic/claude-sonnet-4.6",
	SDK_DEFAULT_PROVIDER_ID: "anthropic",
	addSdkCustomProvider: vi.fn(),
	completeClineDeviceAuth: vi.fn(),
	deleteSdkCustomProvider: vi.fn(),
	fetchSdkClineAccountBalance: vi.fn(),
	fetchSdkClineAccountProfile: vi.fn(),
	fetchSdkClineUserRemoteConfig: vi.fn(),
	fetchSdkFeaturebaseToken: vi.fn(),
	fetchSdkOrganizationBalance: vi.fn(),
	fetchSdkOrgData: vi.fn(),
	getLastUsedSdkProviderSettings: vi.fn(() => ({ provider: "anthropic", model: "claude-sonnet-4-6" })),
	getSdkProviderSettings: vi.fn(() => null),
	listSdkProviderCatalog: vi.fn(async () => []),
	listSdkProviderModels: vi.fn(async () => []),
	loginManagedOauthProvider: vi.fn(),
	refreshManagedOauthCredentials: vi.fn(),
	saveSdkProviderSettings: vi.fn(),
	startClineDeviceAuth: vi.fn(),
	switchSdkClineAccount: vi.fn(),
	updateSdkCustomProvider: vi.fn(),
}));

vi.mock("../../../src/server/browser.js", () => ({
	openInBrowser: vi.fn(),
}));

import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import type { RuntimeTrpcContext } from "../../../src/trpc/app-router";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";

interface MockSpawnRequest {
	readonly binary: string;
	readonly args: string[];
	readonly onData?: (chunk: Buffer) => void;
	readonly onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createRuntimeConfigState(): RuntimeConfigState {
	return {
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
	};
}

function createClineTaskSessionServiceMock() {
	return {
		startTaskSession: vi.fn(async () => createSummary({ agentId: "cline", pid: null })),
		onMessage: vi.fn(() => () => {}),
		stopTaskSession: vi.fn(async () => null),
		abortTaskSession: vi.fn(async () => null),
		cancelTaskTurn: vi.fn(async () => null),
		sendTaskSessionInput: vi.fn(async () => null),
		clearTaskSession: vi.fn(async () => null),
		reloadTaskSession: vi.fn(async () => null),
		rebindPersistedTaskSession: vi.fn(async () => null),
		getSummary: vi.fn(() => null),
		listSummaries: vi.fn(() => []),
		listMessages: vi.fn(() => []),
		loadTaskSessionMessages: vi.fn(async () => []),
		applyTurnCheckpoint: vi.fn(() => null),
		dispose: vi.fn(async () => {}),
	};
}

function createRuntimeApiForManager(terminalManager: TerminalSessionManager): RuntimeTrpcContext["runtimeApi"] {
	return createRuntimeApi({
		getActiveWorkspaceId: vi.fn(() => "workspace-1"),
		loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
		setActiveRuntimeConfig: vi.fn(),
		getScopedTerminalManager: vi.fn(async () => terminalManager),
		getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
		resolveInteractiveShellCommand: vi.fn(() => ({ binary: "zsh", args: [] })),
		runCommand: vi.fn(),
		getUpdateStatus: vi.fn(() => ({
			currentVersion: "0.1.0",
			latestVersion: null,
			updateAvailable: false,
			updateTiming: null,
			installCommand: null,
		})),
		runUpdateNow: vi.fn(async () => ({
			status: "unsupported_installation" as const,
			currentVersion: "0.1.0",
			latestVersion: null,
			message: "On-demand updates are not available in this test runtime.",
		})),
	} satisfies CreateRuntimeApiDependencies);
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: "claude",
		workspacePath: null,
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

function hydrateStoredClaudeSession(manager: TerminalSessionManager, agentSessionId: string): void {
	manager.hydrateFromRecord({
		"task-1": createSummary({
			taskId: "task-1",
			agentId: "claude",
			agentSessionId,
		}),
	});
}

async function startTaskSession(api: RuntimeTrpcContext["runtimeApi"]) {
	return await api.startTaskSession(
		{
			workspaceId: "workspace-1",
			workspacePath: "/tmp/repo",
		},
		{
			taskId: "task-1",
			baseRef: "main",
			prompt: "Resume task",
			resumeFromTrash: true,
		},
	);
}

describe("runtime-api terminal resume routing", () => {
	beforeEach(() => {
		agentRegistryMocks.resolveAgentCommand.mockReset();
		agentRegistryMocks.buildRuntimeConfigResponse.mockReset();
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
		locateAgentTranscriptMock.mockReset();
		ptySessionSpawnMock.mockReset();

		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "claude",
			label: "Claude Code",
			command: "claude",
			binary: "claude",
			args: [],
		});
		taskWorktreeMocks.resolveTaskCwd.mockResolvedValue("/tmp/existing-worktree");
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockResolvedValue({
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: Date.now(),
		});
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => ({
			pid: 1234,
			write: vi.fn(),
			resize: vi.fn(),
			pause: vi.fn(),
			resume: vi.fn(),
			stop: vi.fn(),
			wasInterrupted: vi.fn(() => false),
			triggerData: (chunk: string | Buffer) => {
				request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
			},
			triggerExit: (exitCode: number | null) => {
				request.onExit?.({ exitCode });
			},
		}));
	});

	it("resumes by stored id when active is cleared and the stored transcript is resumable", async () => {
		locateAgentTranscriptMock.mockResolvedValue({ present: true, path: "/tmp/session.jsonl" });
		const terminalManager = new TerminalSessionManager();
		hydrateStoredClaudeSession(terminalManager, "stored-session");
		const api = createRuntimeApiForManager(terminalManager);

		const response = await startTaskSession(api);

		expect(response.ok).toBe(true);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		const spawnRequest = ptySessionSpawnMock.mock.calls[0]?.[0] as MockSpawnRequest | undefined;
		expect(spawnRequest?.args).toEqual(expect.arrayContaining(["--resume", "stored-session"]));
		expect(spawnRequest?.args).not.toContain("--session-id");
	});

	it("starts fresh instead of emitting a dead stored id when the stored transcript is gone", async () => {
		locateAgentTranscriptMock.mockResolvedValue({ present: false });
		const terminalManager = new TerminalSessionManager();
		hydrateStoredClaudeSession(terminalManager, "dead-session");
		const api = createRuntimeApiForManager(terminalManager);

		const response = await startTaskSession(api);

		expect(response.ok).toBe(true);
		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		const spawnRequest = ptySessionSpawnMock.mock.calls[0]?.[0] as MockSpawnRequest | undefined;
		expect(spawnRequest?.args).toContain("--session-id");
		expect(spawnRequest?.args).not.toContain("--resume");
		expect(spawnRequest?.args).not.toContain("--continue");
		expect(spawnRequest?.args).not.toContain("dead-session");
		const freshSessionId = spawnRequest?.args[(spawnRequest?.args.indexOf("--session-id") ?? -2) + 1];
		expect(freshSessionId).toEqual(expect.any(String));
		expect(freshSessionId).not.toBe("dead-session");
	});
});
