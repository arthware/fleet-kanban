import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { RuntimeTrpcContext } from "../../../src/trpc/app-router";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 4242,
		startedAt: 1_000,
		updatedAt: 2_000,
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

function createRuntimeApiForTerminalManager(
	terminalManager: Record<string, unknown>,
): RuntimeTrpcContext["runtimeApi"] {
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
		getFleetUpdateInProgressCount: vi.fn(async () => 0),
	} as unknown as CreateRuntimeApiDependencies);
}

const scope = { workspaceId: "workspace-1", workspacePath: "/tmp/repo" };

describe("runtime-api sendTaskSessionInput", () => {
	it("given a review card paused by a hook, when steering input is sent, then it resumes before writing", async () => {
		const reviewSummary = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		const runningSummary = createSummary({ state: "running", reviewReason: null });
		const writes: string[] = [];
		const terminalManager = {
			getSummary: vi.fn(() => reviewSummary),
			resumeFromHumanInput: vi.fn(() => runningSummary),
			writeInput: vi.fn((_taskId: string, data: Buffer) => {
				writes.push(data.toString("utf8"));
				return runningSummary;
			}),
		};
		const api = createRuntimeApiForTerminalManager(terminalManager);

		const response = await api.sendTaskSessionInput(scope, {
			taskId: "task-1",
			text: "please fix the review comments",
			appendNewline: true,
		});

		expect(response).toEqual({ ok: true, summary: runningSummary });
		expect(terminalManager.resumeFromHumanInput).toHaveBeenCalledWith("task-1");
		expect(terminalManager.writeInput).toHaveBeenCalledWith("task-1", expect.any(Buffer));
		expect(terminalManager.resumeFromHumanInput.mock.invocationCallOrder[0]).toBeLessThan(
			terminalManager.writeInput.mock.invocationCallOrder[0],
		);
		expect(writes).toEqual(["please fix the review comments\n"]);
	});
});
