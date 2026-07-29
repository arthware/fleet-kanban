import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
const locateAgentTranscriptMock = vi.hoisted(() => vi.fn());
const captureCodexSessionIdMock = vi.hoisted(() => vi.fn());
const captureGeminiSessionIdMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

vi.mock("../../../src/terminal/agent-transcript-locator.js", () => ({
	locateAgentTranscript: locateAgentTranscriptMock,
}));

vi.mock("../../../src/terminal/codex-session-capture.js", () => ({
	captureCodexSessionId: captureCodexSessionIdMock,
}));

vi.mock("../../../src/terminal/gemini-session-capture.js", () => ({
	captureGeminiSessionId: captureGeminiSessionIdMock,
}));

import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import { deriveHomeAgentClaudeSessionId } from "../../../src/terminal/home-agent-session-id";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	readonly onData?: (chunk: Buffer) => void;
	readonly onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

interface MockPtySession {
	readonly pid: number;
	readonly write: ReturnType<typeof vi.fn>;
	readonly resize: ReturnType<typeof vi.fn>;
	readonly pause: ReturnType<typeof vi.fn>;
	readonly resume: ReturnType<typeof vi.fn>;
	readonly stop: ReturnType<typeof vi.fn>;
	readonly wasInterrupted: ReturnType<typeof vi.fn>;
	triggerData(chunk: string | Buffer): void;
	triggerExit(exitCode: number | null): void;
}

let cwd = "";

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "kanban-harness-characterization-"));
	prepareAgentLaunchMock.mockReset();
	ptySessionSpawnMock.mockReset();
	locateAgentTranscriptMock.mockReset();
	captureCodexSessionIdMock.mockReset();
	captureGeminiSessionIdMock.mockReset();
	locateAgentTranscriptMock.mockResolvedValue({ present: false });
	captureCodexSessionIdMock.mockResolvedValue(null);
	captureGeminiSessionIdMock.mockResolvedValue(null);
	prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
		binary: input.binary,
		args: [...input.args],
		env: {},
	}));
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => createMockPtySession(111, request));
});

afterEach(async () => {
	vi.useRealTimers();
	await rm(cwd, { recursive: true, force: true });
});

function createMockPtySession(pid: number, request: MockSpawnRequest): MockPtySession {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		triggerData(chunk: string | Buffer) {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit(exitCode: number | null) {
			request.onExit?.({ exitCode });
		},
	};
}

function latestSession(): MockPtySession {
	const result = ptySessionSpawnMock.mock.results.at(-1);
	const session = result?.value as MockPtySession | undefined;
	expect(session).toBeDefined();
	if (!session) {
		throw new Error("Expected a spawned PTY session.");
	}
	return session;
}

async function startTaskSession(
	manager: TerminalSessionManager,
	overrides: Partial<Parameters<TerminalSessionManager["startTaskSession"]>[0]> = {},
): Promise<RuntimeTaskSessionSummary> {
	return await manager.startTaskSession({
		taskId: "task-1",
		agentId: "codex",
		binary: "codex",
		args: [],
		cwd,
		prompt: "Fix the bug",
		workspaceId: "workspace-1",
		...overrides,
	});
}

describe("TerminalSessionManager per-harness characterization", () => {
	it("given Codex is awaiting human input, when prompt-looking PTY bytes arrive before Enter, then the card remains blocked", async () => {
		// given
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			detectOutputTransition: (data: string) => (data.includes("›") ? { type: "agent.prompt-ready" } : null),
			shouldInspectOutputForTransition: () => true,
		});
		const manager = new TerminalSessionManager();
		await startTaskSession(manager);
		manager.transitionToReview("task-1", "needs_input");

		// when
		latestSession().triggerData("\u001b[32m›\u001b[39m ");

		// then
		expect(manager.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "needs_input",
		});
	});

	it("given Codex is awaiting needs-input review, when Enter is written and prompt-ready bytes arrive, then the card remains blocked", async () => {
		// given
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			detectOutputTransition: (data: string) => (data.includes("›") ? { type: "agent.prompt-ready" } : null),
			shouldInspectOutputForTransition: () => true,
		});
		const manager = new TerminalSessionManager();
		await startTaskSession(manager);
		manager.transitionToReview("task-1", "needs_input");

		// when
		manager.writeInput("task-1", Buffer.from("\r", "utf8"));
		latestSession().triggerData("› ");

		// then
		expect(manager.getSummary("task-1")).toMatchObject({
			state: "awaiting_review",
			reviewReason: "needs_input",
		});
	});

	it("given Codex deferred startup input and workspace trust are both visible, when the prompt renders, then trust is confirmed before startup input is sent", async () => {
		// given
		vi.useFakeTimers();
		const deferredStartupInput = "\u001b[200~hello\u001b[201~";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupInput,
		});
		const manager = new TerminalSessionManager();
		await startTaskSession(manager);
		const session = latestSession();

		// when
		session.triggerData("Do you trust the contents of this directory?\n› ");
		await vi.advanceTimersByTimeAsync(100);
		session.triggerData("› ");

		// then
		expect(session.write).toHaveBeenNthCalledWith(1, "\r");
		expect(session.write).toHaveBeenNthCalledWith(2, deferredStartupInput);
	});

	it("given Codex assigns its own id after boot, when discovery succeeds during polling, then the summary stores it", async () => {
		// given
		vi.useFakeTimers();
		captureCodexSessionIdMock.mockResolvedValueOnce(null).mockResolvedValueOnce("codex-session-1");
		const manager = new TerminalSessionManager();
		await startTaskSession(manager, { agentId: "codex", binary: "codex" });

		// when
		await vi.advanceTimersByTimeAsync(1_000);

		// then
		expect(captureCodexSessionIdMock).toHaveBeenCalledTimes(2);
		expect(manager.getSummary("task-1")?.agentSessionId).toBe("codex-session-1");
	});

	it("given Gemini assigns its own id after boot, when discovery times out, then the session remains attached without an id", async () => {
		// given
		vi.useFakeTimers();
		captureGeminiSessionIdMock.mockResolvedValue(null);
		const manager = new TerminalSessionManager();
		await startTaskSession(manager, { agentId: "gemini", binary: "gemini" });

		// when
		await vi.advanceTimersByTimeAsync(10_500);

		// then
		expect(captureGeminiSessionIdMock).toHaveBeenCalledTimes(20);
		expect(manager.getSummary("task-1")).toMatchObject({
			state: "running",
			agentId: "gemini",
			agentSessionId: null,
			agentSessionLifecycle: "attached",
		});
	});

	it("given a Claude overseer session has no transcript, when it starts, then it launches under a deterministic session id", async () => {
		// given
		const workspaceId = "workspace-1";
		const taskId = createHomeAgentSessionId(workspaceId);
		const manager = new TerminalSessionManager();

		// when
		await startTaskSession(manager, {
			taskId,
			agentId: "claude",
			binary: "claude",
			workspaceId,
		});

		// then
		const expectedId = deriveHomeAgentClaudeSessionId(workspaceId, "claude", 0);
		expect(prepareAgentLaunchMock).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: expectedId }));
		expect(manager.getSummary(taskId)?.agentSessionId).toBe(expectedId);
	});

	it("given a Claude overseer transcript exists, when it starts after restart, then it resumes the deterministic id without replaying the prompt", async () => {
		// given
		locateAgentTranscriptMock.mockResolvedValue({ present: true, path: "/tmp/claude-home.jsonl" });
		const workspaceId = "workspace-1";
		const taskId = createHomeAgentSessionId(workspaceId);
		const manager = new TerminalSessionManager();

		// when
		await startTaskSession(manager, {
			taskId,
			agentId: "claude",
			binary: "claude",
			workspaceId,
		});

		// then
		const expectedId = deriveHomeAgentClaudeSessionId(workspaceId, "claude", 0);
		expect(prepareAgentLaunchMock).toHaveBeenCalledWith(
			expect.objectContaining({
				agentSessionId: expectedId,
				resumeSession: true,
				prompt: "",
			}),
		);
	});
});
