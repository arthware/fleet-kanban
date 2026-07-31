import type { RuntimeTaskSessionReviewReason, RuntimeTaskSessionSummary } from "../core/api-contract";

export type SessionTransitionEvent =
	| { type: "hook.to_review" }
	| { type: "hook.to_needs_input" }
	| { type: "hook.to_in_progress" }
	| { type: "human.input_submitted" }
	| { type: "agent.prompt-ready" }
	| { type: "process.exit"; exitCode: number | null; interrupted: boolean };

export interface SessionTransitionResult {
	changed: boolean;
	patch: Partial<RuntimeTaskSessionSummary>;
	clearAttentionBuffer: boolean;
}

function canReturnToRunning(reason: RuntimeTaskSessionReviewReason): boolean {
	return reason === "needs_input";
}

export function canWakeFromAnyReviewReason(reason: RuntimeTaskSessionReviewReason): boolean {
	return reason === "attention" || reason === "hook" || reason === "error" || reason === "needs_input";
}

function asReviewState(reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary["state"] {
	if (reason === "interrupted") {
		return "interrupted";
	}
	return "awaiting_review";
}

export function reduceSessionTransition(
	summary: RuntimeTaskSessionSummary,
	event: SessionTransitionEvent,
): SessionTransitionResult {
	switch (event.type) {
		case "hook.to_review": {
			if (summary.state !== "running") {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "hook",
				},
				clearAttentionBuffer: true,
			};
		}
		case "hook.to_needs_input": {
			// Same halt as `to_review` (keep the PTY alive so `fleet task say` can
			// answer), but tag the reason so the architect sees "blocked" not "done".
			if (summary.state !== "running") {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "needs_input",
				},
				clearAttentionBuffer: true,
			};
		}
		case "hook.to_in_progress": {
			if (summary.state !== "awaiting_review") {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "running",
					reviewReason: null,
					lastReviewNotificationKey: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "agent.prompt-ready": {
			if (summary.state !== "awaiting_review" || !canReturnToRunning(summary.reviewReason)) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "running",
					reviewReason: null,
					lastReviewNotificationKey: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "human.input_submitted": {
			if (summary.state !== "awaiting_review" || !canWakeFromAnyReviewReason(summary.reviewReason)) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "running",
					reviewReason: null,
					lastReviewNotificationKey: null,
				},
				clearAttentionBuffer: true,
			};
		}
		case "process.exit": {
			let reason: RuntimeTaskSessionReviewReason = event.exitCode === 0 ? "exit" : "error";
			if (event.interrupted) {
				reason = "interrupted";
			}
			return {
				changed: true,
				patch: {
					state: asReviewState(reason),
					reviewReason: reason,
					exitCode: event.exitCode,
					pid: null,
				},
				clearAttentionBuffer: false,
			};
		}
		default: {
			return { changed: false, patch: {}, clearAttentionBuffer: false };
		}
	}
}
