import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary, RuntimeTaskTokenUsage } from "../../../src/core/api-contract";

const readAgentUsageMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-usage-reader.js", () => ({
	readAgentUsage: readAgentUsageMock,
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

/** Resolve each task id to its own summary (or null when the id is unknown). */
function createRuntimeApiForSummaries(
	summaries: Record<string, RuntimeTaskSessionSummary | null>,
): RuntimeTrpcContext["runtimeApi"] {
	const terminalManager = {
		getSummary: vi.fn((taskId: string) => summaries[taskId] ?? null),
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

const SAMPLE_USAGE: RuntimeTaskTokenUsage = {
	inputTokens: 100,
	outputTokens: 20,
	cacheReadTokens: 300,
	cacheCreationTokens: 40,
	costUsd: null,
};

describe("runtime-api getTaskTokenUsage", () => {
	beforeEach(() => {
		readAgentUsageMock.mockReset();
	});

	it("returns null usage for a card that never captured a CLI session id", async () => {
		const api = createRuntimeApiForSummaries({
			"task-1": createSummary({ agentId: "claude", agentSessionId: null }),
		});

		const response = await api.getTaskTokenUsage(scope, { taskIds: ["task-1"] });

		expect(readAgentUsageMock).not.toHaveBeenCalled();
		expect(response).toEqual({ ok: true, usage: { "task-1": null } });
	});

	it("returns the normalized usage for a resolvable session", async () => {
		readAgentUsageMock.mockResolvedValue({ present: true, usage: SAMPLE_USAGE });
		const api = createRuntimeApiForSummaries({
			"task-1": createSummary({ agentId: "claude", agentSessionId: "session-abc" }),
		});

		const response = await api.getTaskTokenUsage(scope, { taskIds: ["task-1"] });

		expect(readAgentUsageMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-abc" }));
		expect(response).toEqual({ ok: true, usage: { "task-1": SAMPLE_USAGE } });
	});

	it("returns one entry per requested id, mixing resolvable, session-less, and unknown cards", async () => {
		readAgentUsageMock.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
			sessionId === "session-live" ? { present: true, usage: SAMPLE_USAGE } : { present: false, usage: null },
		);
		const api = createRuntimeApiForSummaries({
			"task-live": createSummary({ taskId: "task-live", agentSessionId: "session-live" }),
			"task-idle": createSummary({ taskId: "task-idle", agentSessionId: null }),
			"task-gone": createSummary({ taskId: "task-gone", agentSessionId: "wiped-session" }),
		});

		const response = await api.getTaskTokenUsage(scope, {
			taskIds: ["task-live", "task-idle", "task-gone", "task-unknown"],
		});

		expect(response).toEqual({
			ok: true,
			usage: {
				"task-live": SAMPLE_USAGE,
				"task-idle": null,
				"task-gone": null,
				"task-unknown": null,
			},
		});
	});
});
