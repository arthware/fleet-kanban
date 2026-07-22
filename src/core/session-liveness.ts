import type { RuntimeAgentSessionLifecycle, RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "./api-contract";

export type ProcessKillProbe = (pid: number, signal: 0) => boolean;

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

export function probePersistedPid(pid: number | null, kill: ProcessKillProbe = process.kill): boolean {
	if (pid === null || !Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		kill(pid, 0);
		return true;
	} catch (error) {
		if (isNodeErrorWithCode(error, "ESRCH")) {
			return false;
		}
		return true;
	}
}

export function reconcileTaskSessionSummaryLiveness(input: {
	summary: RuntimeTaskSessionSummary;
	lifecycle: RuntimeAgentSessionLifecycle;
}): RuntimeTaskSessionSummary {
	const isAttached = input.lifecycle === "attached";
	if (isAttached || input.summary.state !== "running") {
		return {
			...input.summary,
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
