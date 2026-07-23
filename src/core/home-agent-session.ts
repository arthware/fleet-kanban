import type { RuntimeAgentId } from "./api-contract";

// The home sidebar agent panel is not backed by a real task card.
// We mint a synthetic home agent session id so the existing task-scoped
// runtime APIs can manage its chat and terminal lifecycle without creating
// a worktree-backed task. Home sidebar sessions should use a stable synthetic
// task id so refreshes and session reloads can reconnect to the same chat.
const HOME_AGENT_SESSION_NAMESPACE = "__home_agent__";

export const HOME_AGENT_SESSION_PREFIX = `${HOME_AGENT_SESSION_NAMESPACE}:`;

export function createHomeAgentSessionId(workspaceId: string, _agentId?: RuntimeAgentId): string {
	return `${HOME_AGENT_SESSION_PREFIX}${workspaceId}`;
}

export function isHomeAgentSessionId(sessionId: string): boolean {
	return sessionId.startsWith(HOME_AGENT_SESSION_PREFIX);
}

export function isHomeAgentSessionIdForWorkspace(sessionId: string, workspaceId: string): boolean {
	return (
		sessionId === createHomeAgentSessionId(workspaceId) ||
		sessionId.startsWith(`${HOME_AGENT_SESSION_PREFIX}${workspaceId}:`)
	);
}

/**
 * Inverse of {@link createHomeAgentSessionId}: recover the `workspaceId` from a
 * canonical home-agent session id, or from a legacy `:<agentId>`-suffixed id.
 */
export function parseHomeAgentSessionId(sessionId: string): { workspaceId: string; agentId: string | null } | null {
	if (!isHomeAgentSessionId(sessionId)) {
		return null;
	}
	const rest = sessionId.slice(HOME_AGENT_SESSION_PREFIX.length);
	if (!rest) {
		return null;
	}
	const separatorIndex = rest.lastIndexOf(":");
	if (separatorIndex <= 0) {
		return { workspaceId: rest, agentId: null };
	}
	return { workspaceId: rest.slice(0, separatorIndex), agentId: rest.slice(separatorIndex + 1) };
}
