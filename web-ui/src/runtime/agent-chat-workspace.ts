// Resolves which workspace hosts the sidebar agent chat.
//
// The sidebar "Kanban Agent" chat is the operator's single steering seat. When
// the board has an architect (the overseer workspace above the projects), the
// chat is pinned to it and stays put no matter which project's board is being
// viewed — only the board columns follow the project selector. A board with no
// architect keeps today's per-project home agent.

export interface AgentChatWorkspaceInput {
	/** The pinned overseer workspace, or `null` for a flat board. */
	architectWorkspaceId: string | null;
	/** The currently selected project board. */
	currentProjectId: string | null;
}

export interface AgentChatWorkspace {
	/** The workspace the agent chat runs in — stable across selector changes when an architect exists. */
	agentChatWorkspaceId: string | null;
	/**
	 * `true` when the chat is anchored to an architect distinct from the selected
	 * board, so its live messages need a dedicated stream rather than the board's.
	 */
	isArchitectChatDetached: boolean;
}

export function resolveAgentChatWorkspace({
	architectWorkspaceId,
	currentProjectId,
}: AgentChatWorkspaceInput): AgentChatWorkspace {
	const agentChatWorkspaceId = architectWorkspaceId ?? currentProjectId;
	const isArchitectChatDetached = agentChatWorkspaceId !== null && agentChatWorkspaceId !== currentProjectId;
	return { agentChatWorkspaceId, isArchitectChatDetached };
}
