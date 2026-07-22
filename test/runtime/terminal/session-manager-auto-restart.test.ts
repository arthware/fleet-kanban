import { beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
const locateAgentTranscriptMock = vi.hoisted(() => vi.fn());

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

import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
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
	};
}

describe("TerminalSessionManager auto-restart", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		locateAgentTranscriptMock.mockReset();
		locateAgentTranscriptMock.mockResolvedValue({ present: false });
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	it("does not auto-restart a prior task launch without a resumable session", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		spawnedSessions[0]?.triggerExit(130);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-1")?.state).not.toBe("running");
		expect(manager.getSummary("task-1")?.pid).toBeNull();
	});

	it("resumes by stored id when the transcript is present", async () => {
		locateAgentTranscriptMock.mockResolvedValue({ present: true, path: "/tmp/session.jsonl" });
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => createMockPtySession(111, request));

		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": {
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
				agentSessionId: "stored-session",
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			},
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Original card prompt",
			resumeFromTrash: true,
		});

		expect(prepareAgentLaunchMock).toHaveBeenCalledWith(
			expect.objectContaining({
				agentSessionId: "stored-session",
				resumeSession: true,
				prompt: "",
			}),
		);
	});

	it("given a review card with no resumable session, when resume is requested, then it does not relaunch or replay the prompt", async () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": {
				taskId: "task-1",
				state: "awaiting_review",
				agentId: "codex",
				workspacePath: "/tmp/task-1",
				pid: null,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: 1,
				reviewReason: null,
				exitCode: 0,
				agentSessionId: null,
				agentSessionLifecycle: "gone",
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			},
		});

		const summary = await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Original card prompt",
			resumeMode: "resume",
		});

		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		expect(summary.state).toBe("awaiting_review");
		expect(summary.pid).toBeNull();
	});

	it("does not start fresh when a stored session id is gone", async () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": {
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
				agentSessionId: "dead-session",
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			},
		});
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Original card prompt",
			resumeFromTrash: true,
			resumeMode: "resume",
		});

		expect(prepareAgentLaunchMock).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock).not.toHaveBeenCalled();
		expect(manager.getSummary("task-1")?.agentSessionId).toBe("dead-session");
	});

	it("normalizes a hydrated running record with a dead pid before transcript classification", async () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
			const error = new Error("No such process") as Error & { code: string };
			error.code = "ESRCH";
			throw error;
		}) as typeof process.kill);
		locateAgentTranscriptMock.mockResolvedValue({ present: true, path: "/tmp/session.jsonl" });
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": {
				taskId: "task-1",
				state: "running",
				agentId: "claude",
				workspacePath: "/tmp/task-1",
				pid: 999_999,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				agentSessionId: "stored-session",
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			},
		});

		const summary = await manager.refreshAgentSessionLifecycle("task-1");

		expect(killSpy).toHaveBeenCalledWith(999_999, 0);
		expect(locateAgentTranscriptMock).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "claude",
				sessionId: "stored-session",
			}),
		);
		expect(summary).toMatchObject({
			state: "interrupted",
			pid: null,
			reviewReason: "interrupted",
			agentSessionLifecycle: "resumable",
		});
		killSpy.mockRestore();
	});

	it("keeps a hydrated running record attached when its persisted pid probes alive", async () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
		locateAgentTranscriptMock.mockResolvedValue({ present: false });
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": {
				taskId: "task-1",
				state: "running",
				agentId: "claude",
				workspacePath: "/tmp/task-1",
				pid: process.pid,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				agentSessionId: "stored-session",
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			},
		});

		const summary = await manager.refreshAgentSessionLifecycle("task-1");

		expect(killSpy).toHaveBeenCalledWith(process.pid, 0);
		expect(summary).toMatchObject({
			state: "running",
			pid: process.pid,
			agentSessionLifecycle: "attached",
		});
		killSpy.mockRestore();
	});

	it("does not restart an attached agent session after an explicit stop", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		manager.stopTaskSession("task-1");
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.pid).toBeNull();
	});

	it("sends non-plan deferred Codex startup input when the prompt marker appears", async () => {
		const deferredStartupInput = "\u001b[200~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData("Booting Codex\n");
		expect(session.write).not.toHaveBeenCalledWith(deferredStartupInput);

		session.triggerData("› ");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
	});

	it("sends non-plan deferred Codex startup input when the startup UI header appears", async () => {
		const deferredStartupInput = "\u001b[200~\r";
		prepareAgentLaunchMock.mockResolvedValue({
			binary: "codex",
			args: [],
			env: {},
			deferredStartupInput,
		});

		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		const session = spawnedSessions[0];
		expect(session).toBeDefined();
		if (!session) {
			return;
		}

		session.triggerData(">_ OpenAI Codex (v0.117.0)\n");
		expect(session.write).toHaveBeenCalledWith(deferredStartupInput);
		expect(session.write).toHaveBeenCalledTimes(1);
	});
});
