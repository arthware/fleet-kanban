import { describe, expect, it } from "vitest";

import { createHomeAgentSessionId, parseHomeAgentSessionId } from "../../../src/core/home-agent-session";

describe("parseHomeAgentSessionId", () => {
	it("round-trips the id created by createHomeAgentSessionId", () => {
		const sessionId = createHomeAgentSessionId("tools", "claude");
		expect(sessionId).toBe("__home_agent__:tools");
		expect(parseHomeAgentSessionId(sessionId)).toEqual({ workspaceId: "tools", agentId: null });
	});

	it("recovers a hyphenated workspace id from the canonical id", () => {
		const sessionId = createHomeAgentSessionId("fleet-kanban");
		expect(parseHomeAgentSessionId(sessionId)).toEqual({ workspaceId: "fleet-kanban", agentId: null });
	});

	it("recovers a legacy agent suffix for migration", () => {
		const sessionId = "__home_agent__:fleet-kanban:claude";
		expect(parseHomeAgentSessionId(sessionId)).toEqual({ workspaceId: "fleet-kanban", agentId: "claude" });
	});

	it("returns null for a normal task id that is not a home agent", () => {
		expect(parseHomeAgentSessionId("4934b")).toBeNull();
	});
});
