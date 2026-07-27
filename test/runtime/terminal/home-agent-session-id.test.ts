import { describe, expect, it } from "vitest";

import { deriveHomeAgentClaudeSessionId, resolveHomeAgentLaunch } from "../../../src/terminal/home-agent-session-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("deriveHomeAgentClaudeSessionId", () => {
	it("returns the same id every time for a workspace so the chat is always resumable", () => {
		const first = deriveHomeAgentClaudeSessionId("tools", "claude");
		const second = deriveHomeAgentClaudeSessionId("tools", "claude");
		expect(second).toBe(first);
	});

	it("returns the same id within a generation and a new deterministic id after the generation changes", () => {
		const firstGeneration = deriveHomeAgentClaudeSessionId("tools", "claude", 0);
		const sameGeneration = deriveHomeAgentClaudeSessionId("tools", "claude", 0);
		const nextGeneration = deriveHomeAgentClaudeSessionId("tools", "claude", 1);

		expect(sameGeneration).toBe(firstGeneration);
		expect(nextGeneration).not.toBe(firstGeneration);
		expect(deriveHomeAgentClaudeSessionId("tools", "claude", 1)).toBe(nextGeneration);
	});

	it("produces a valid UUID the CLI will accept as a session id", () => {
		expect(deriveHomeAgentClaudeSessionId("tools", "claude")).toMatch(UUID_PATTERN);
	});

	it("gives each workspace its own id so architect and impl chats never collide", () => {
		expect(deriveHomeAgentClaudeSessionId("tools", "claude")).not.toBe(
			deriveHomeAgentClaudeSessionId("fleet-kanban", "claude"),
		);
	});

	it("distinguishes agents within the same workspace", () => {
		expect(deriveHomeAgentClaudeSessionId("tools", "claude")).not.toBe(
			deriveHomeAgentClaudeSessionId("tools", "codex"),
		);
	});
});

describe("resolveHomeAgentLaunch", () => {
	it("starts the session fresh when no transcript exists yet (first ever launch)", () => {
		const decision = resolveHomeAgentLaunch({ agentSessionId: "sid-1", transcriptPresent: false });
		expect(decision).toEqual({ agentSessionId: "sid-1", resumeSession: false });
	});

	it("resumes the existing conversation when its transcript is on disk", () => {
		const decision = resolveHomeAgentLaunch({ agentSessionId: "sid-1", transcriptPresent: true });
		expect(decision).toEqual({ agentSessionId: "sid-1", resumeSession: true });
	});
});
