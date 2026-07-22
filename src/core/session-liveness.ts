import type { RuntimeAgentSessionLifecycle, RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "./api-contract";

export function reconcileTaskSessionSummaryLiveness(input: {
	summary: RuntimeTaskSessionSummary;
	lifecycle: RuntimeAgentSessionLifecycle;
}): RuntimeTaskSessionSummary {
	const isAttached = input.lifecycle === "attached";
	if (isAttached) {
		return {
			...input.summary,
			agentSessionLifecycle: input.lifecycle,
		};
	}

	if (input.summary.state !== "running") {
		return {
			...input.summary,
			pid: null,
			agentSessionLifecycle: input.lifecycle,
		};
	}

	const interruptedState: RuntimeTaskSessionState = input.summary.startedAt === null ? "idle" : "interrupted";
	return {
		...input.summary,
		state: interruptedState,
		pid: null,
		reviewReason: interruptedState === "interrupted" ? "interrupted" : input.summary.reviewReason,
		agentSessionLifecycle: input.lifecycle,
	};
}
