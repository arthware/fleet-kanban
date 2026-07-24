import { describe, expect, it } from "vitest";

import { resolveAgentChatWorkspace } from "@/runtime/agent-chat-workspace";

describe("resolveAgentChatWorkspace", () => {
	it("anchors the agent chat to the architect, independent of the selected project", () => {
		const viewingImpl = resolveAgentChatWorkspace({
			architectWorkspaceId: "tools",
			currentProjectId: "fleet-kanban",
			projects: [{ id: "tools" }, { id: "fleet-kanban" }],
		});
		const viewingAnotherImpl = resolveAgentChatWorkspace({
			architectWorkspaceId: "tools",
			currentProjectId: "docs-site",
			projects: [{ id: "tools" }, { id: "docs-site" }],
		});

		// Switching which project's board is displayed must not move the chat.
		expect(viewingImpl.agentChatWorkspaceId).toBe("tools");
		expect(viewingAnotherImpl.agentChatWorkspaceId).toBe("tools");
		expect(viewingImpl.isArchitectChatDetached).toBe(true);
		expect(viewingAnotherImpl.isArchitectChatDetached).toBe(true);
	});

	it("anchors the agent chat to the epic workspace when an epic is selected", () => {
		const resolved = resolveAgentChatWorkspace({
			architectWorkspaceId: "tools",
			currentProjectId: "epic-cool-feature",
			projects: [
				{ id: "tools" },
				{ id: "fleet-kanban" },
				{
					id: "epic-cool-feature",
					epic: { name: "Cool Feature", branch: "epic/cool-feature" },
				},
			],
		});

		// Selecting an epic workspace must bind both board and chat to the epic workspace.
		expect(resolved.agentChatWorkspaceId).toBe("epic-cool-feature");
		expect(resolved.isArchitectChatDetached).toBe(false);
	});

	it("falls back to the selected project when the board has no architect", () => {
		const resolved = resolveAgentChatWorkspace({
			architectWorkspaceId: null,
			currentProjectId: "solo-repo",
		});

		// A flat board keeps today's per-project home agent — not detached.
		expect(resolved.agentChatWorkspaceId).toBe("solo-repo");
		expect(resolved.isArchitectChatDetached).toBe(false);
	});

	it("is not detached while the architect is loading or absent", () => {
		expect(resolveAgentChatWorkspace({ architectWorkspaceId: null, currentProjectId: null })).toEqual({
			agentChatWorkspaceId: null,
			isArchitectChatDetached: false,
		});
	});
});
