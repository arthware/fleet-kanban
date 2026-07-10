import { describe, expect, it } from "vitest";

import { createHomeAgentSessionId, parseHomeAgentSessionId } from "../../../src/core/home-agent-session";

describe("parseHomeAgentSessionId", () => {
	it("round-trips the id created by createHomeAgentSessionId", () => {
		const sessionId = createHomeAgentSessionId("tools", "claude");
		expect(parseHomeAgentSessionId(sessionId)).toEqual({ workspaceId: "tools", agentId: "claude" });
	});

	it("recovers a hyphenated workspace id", () => {
		const sessionId = createHomeAgentSessionId("fleet-kanban", "claude");
		expect(parseHomeAgentSessionId(sessionId)).toEqual({ workspaceId: "fleet-kanban", agentId: "claude" });
	});

	it("returns null for a normal task id that is not a home agent", () => {
		expect(parseHomeAgentSessionId("4934b")).toBeNull();
	});
});
