import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

const GEMINI_SESSION_ID = "31dc7765-2ab0-4283-b013-ec2d227060be";
const CLAUDE_SESSION_ID = "9f0c1d22-1111-4444-8888-aaaabbbbcccc";

let cwd = "";

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "kanban-agent-switch-identity-"));
	prepareAgentLaunchMock.mockReset();
	ptySessionSpawnMock.mockReset();
	locateAgentTranscriptMock.mockReset();
	// The stored session is resumable for whoever minted it. Holding this at
	// `present` keeps these tests about the identity rule itself rather than
	// about a transcript lookup happening to miss on a foreign id.
	locateAgentTranscriptMock.mockResolvedValue({ present: true, path: "/tmp/transcript.jsonl" });
	prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
		binary: input.binary,
		args: [...input.args],
		env: {},
	}));
	ptySessionSpawnMock.mockImplementation(() => ({
		pid: 4242,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
	}));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

/** A card as `sessions.json` holds it after a previous run on `agentId` left `agentSessionId` behind. */
function storedCard(agentId: string, agentSessionId: string) {
	return {
		"task-1": runtimeTaskSessionSummarySchema.parse({
			taskId: "task-1",
			state: "idle",
			agentId,
			workspacePath: cwd,
			pid: null,
			startedAt: 1_785_654_154_129,
			updatedAt: 1_785_654_154_129,
			lastOutputAt: null,
			reviewReason: "exit",
			exitCode: 0,
			agentSessionId,
			agentSessionLifecycle: "resumable",
		}),
	};
}

function launchInput(): { agentSessionId: string | null; resumeSession: boolean } {
	const call = prepareAgentLaunchMock.mock.calls.at(-1)?.[0];
	expect(call).toBeDefined();
	return call as { agentSessionId: string | null; resumeSession: boolean };
}

describe("a card's session identity belongs to the agent that minted it", () => {
	it("given a stored session id minted by gemini, when the card starts on claude, then claude does not resume the gemini session", async () => {
		// given
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord(storedCard("gemini", GEMINI_SESSION_ID));

		// when
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd,
			prompt: "Continue the card",
			workspaceId: "workspace-1",
		});

		// then
		expect(launchInput().agentSessionId).not.toBe(GEMINI_SESSION_ID);
		expect(launchInput().resumeSession).toBe(false);
		expect(manager.getSummary("task-1")?.agentSessionId).not.toBe(GEMINI_SESSION_ID);
	});

	it("given a stored session id minted by claude, when the card starts on gemini, then gemini starts without a stored id", async () => {
		// given
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord(storedCard("claude", CLAUDE_SESSION_ID));

		// when
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd,
			prompt: "Continue the card",
			workspaceId: "workspace-1",
		});

		// then
		expect(launchInput().agentSessionId).toBeNull();
		expect(launchInput().resumeSession).toBe(false);
		expect(manager.getSummary("task-1")?.agentSessionId).toBeNull();
	});

	it("given a stored session id minted by gemini, when the card starts on claude, then the card reports that the gemini conversation did not carry over", async () => {
		// given
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord(storedCard("gemini", GEMINI_SESSION_ID));

		// when
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd,
			prompt: "Continue the card",
			workspaceId: "workspace-1",
		});

		// then
		expect(manager.getSummary("task-1")?.warningMessage).toBe(
			"Started a new claude session — the previous gemini conversation cannot be resumed by claude.",
		);
	});

	it("given a stored session id minted by claude, when the card restarts on claude, then it resumes that same session", async () => {
		// given
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord(storedCard("claude", CLAUDE_SESSION_ID));

		// when
		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd,
			prompt: "Continue the card",
			workspaceId: "workspace-1",
		});

		// then
		expect(launchInput().agentSessionId).toBe(CLAUDE_SESSION_ID);
		expect(launchInput().resumeSession).toBe(true);
		expect(manager.getSummary("task-1")?.agentSessionId).toBe(CLAUDE_SESSION_ID);
	});
});
