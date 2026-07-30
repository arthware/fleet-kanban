import { isHomeAgentSessionId } from "./home-agent-session";

export type SessionKind = "card" | "overseer";

export interface SessionRef {
	readonly kind: SessionKind;
	readonly taskId: string;
}

export function classifySessionRef(taskId: string): SessionRef {
	return {
		kind: isHomeAgentSessionId(taskId) ? "overseer" : "card",
		taskId,
	};
}
