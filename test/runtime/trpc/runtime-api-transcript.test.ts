import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskChatMessage, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const readAgentTranscriptMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-transcript-reader.js", () => ({
	readAgentTranscript: readAgentTranscriptMock,
}));

import type { RuntimeTrpcContext } from "../../../src/trpc/app-router";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";

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

function createRuntimeApiForSummary(summary: RuntimeTaskSessionSummary | null): RuntimeTrpcContext["runtimeApi"] {
	const terminalManager = {
		getSummary: vi.fn(() => summary),
	};
	return createRuntimeApi({
		getActiveWorkspaceId: vi.fn(() => "workspace-1"),
		loadScopedRuntimeConfig: vi.fn(),
		setActiveRuntimeConfig: vi.fn(),
		getScopedTerminalManager: vi.fn(async () => terminalManager as never),
		getScopedClineTaskSessionService: vi.fn(),
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
			message: "unsupported",
		})),
	} as unknown as CreateRuntimeApiDependencies);
}

const scope = { workspaceId: "workspace-1", workspacePath: "/tmp/repo" };

describe("runtime-api getTaskTranscript", () => {
	beforeEach(() => {
		readAgentTranscriptMock.mockReset();
	});

	it("reads the persisted transcript for a session with a captured id and returns its messages", async () => {
		const messages: RuntimeTaskChatMessage[] = [
			{ id: "claude-0", role: "user", content: "hello", createdAt: 1 },
			{ id: "claude-1", role: "assistant", content: "hi there", createdAt: 2 },
		];
		readAgentTranscriptMock.mockResolvedValue({ present: true, messages });
		const api = createRuntimeApiForSummary(createSummary({ agentId: "claude", agentSessionId: "session-abc" }));

		const response = await api.getTaskTranscript(scope, { taskId: "task-1" });

		expect(readAgentTranscriptMock).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "claude", sessionId: "session-abc" }),
		);
		expect(response.ok).toBe(true);
		expect(response.present).toBe(true);
		expect(response.messages).toEqual(messages);
	});

	it("reports absent (never a fresh session) when no CLI session id was captured", async () => {
		const api = createRuntimeApiForSummary(createSummary({ agentId: "claude", agentSessionId: null }));

		const response = await api.getTaskTranscript(scope, { taskId: "task-1" });

		expect(readAgentTranscriptMock).not.toHaveBeenCalled();
		expect(response).toEqual({ ok: true, present: false, messages: [] });
	});

	it("surfaces a present:false transcript (gone on disk) without inventing messages", async () => {
		readAgentTranscriptMock.mockResolvedValue({ present: false, messages: [] });
		const api = createRuntimeApiForSummary(createSummary({ agentId: "claude", agentSessionId: "wiped-session" }));

		const response = await api.getTaskTranscript(scope, { taskId: "task-1" });

		expect(response).toEqual({ ok: true, present: false, messages: [] });
	});
});
