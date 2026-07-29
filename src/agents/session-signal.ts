import type { RuntimeTaskHookActivity } from "../core/api-contract";

export type AgentFact =
	| { readonly type: "turn.started" }
	| { readonly type: "turn.ended"; readonly finalMessage: string | null }
	| { readonly type: "attention.required"; readonly cause: "permission" | "question" | "error" }
	| { readonly type: "progress" }
	| { readonly type: "session.ended"; readonly outcome: "completed" | "failed" | "interrupted" };

export interface SessionSignal {
	/** Monotonic per session, assigned by the driver so stale and duplicate facts can be dropped. */
	readonly seq: number;
	readonly at: number;
	readonly fact: AgentFact;
	/** Display-only. Never influences lifecycle. */
	readonly activity: RuntimeTaskHookActivity | null;
}
