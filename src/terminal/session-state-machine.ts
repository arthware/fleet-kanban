import type {
	RuntimeTaskHookActivity,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";

export type SessionTransitionEvent =
	| { type: "hook.to_review" }
	| { type: "hook.to_needs_input" }
	| { type: "hook.to_in_progress" }
	| { type: "agent.prompt-ready" }
	| { type: "process.exit"; exitCode: number | null; interrupted: boolean };

/**
 * A `to_review` hook that means "blocked — answer me" rather than "done — review
 * me". The claude adapter already emits the raw distinction: a `PermissionRequest`
 * hook or a `Notification(permission_prompt)` fire while the agent waits on the
 * human, whereas `Stop` fires when the turn simply ended. Both currently collapse
 * to `reviewReason: "hook"`; this classifier lets the ingest path lift the former
 * to `reviewReason: "needs_input"` so the architect can tell them apart at a glance.
 */
export function isNeedsInputReviewHook(metadata: Partial<RuntimeTaskHookActivity> | null | undefined): boolean {
	if (!metadata) {
		return false;
	}
	const notificationType = metadata.notificationType?.trim().toLowerCase() ?? "";
	const hookEventName = metadata.hookEventName?.trim().toLowerCase() ?? "";
	return (
		notificationType === "permission_prompt" ||
		notificationType === "permission.asked" ||
		hookEventName === "permissionrequest"
	);
}

export interface SessionTransitionResult {
	changed: boolean;
	patch: Partial<RuntimeTaskSessionSummary>;
	clearAttentionBuffer: boolean;
}

function canReturnToRunning(reason: RuntimeTaskSessionReviewReason): boolean {
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
		case "hook.to_in_progress":
		case "agent.prompt-ready": {
			if (summary.state !== "awaiting_review" || !canReturnToRunning(summary.reviewReason)) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					state: "running",
					reviewReason: null,
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
