import type { RuntimeAgentId } from "../core/api-contract";

/**
 * How a task's agent session should be launched: which session id to hand the
 * CLI, and whether this launch resumes an existing session or starts a fresh
 * one. Consumed by the session manager and the per-agent adapters.
 */
export interface LaunchSessionIdResult {
	/** The session id to launch with, or null to let the agent assign its own. */
	readonly agentSessionId: string | null;
	/** True when this launch resumes an existing session rather than starting fresh. */
	readonly resumeSession: boolean;
}

export interface ResolveLaunchSessionIdInput {
	readonly agentId: RuntimeAgentId;
	/** The session id already persisted for this task, if any. */
	readonly storedSessionId: string | null;
	/** Whether this launch can resume, start for the first time, or has nothing to attach to. */
	readonly resumeMode: "resume" | "fresh" | "unavailable";
	/** Mints a fresh session id for agents that accept one at spawn time. */
	readonly mintSessionId: () => string;
}

/**
 * Decide the session id and fresh-vs-resume mode for a task launch.
 *
 * - A resumable task resumes its stored id.
 * - A gone task starts fresh even if an old id is still persisted.
 * - A fresh Claude start mints a new id so the session can be resumed later.
 * - Codex assigns its own id (discovered post-spawn), so a fresh start carries
 *   none; other agents have no id-based resume and fall back to their own
 *   heuristics.
 */
export function resolveLaunchSessionId(input: ResolveLaunchSessionIdInput): LaunchSessionIdResult {
	const stored = input.storedSessionId?.trim() || null;
	if (stored && input.resumeMode === "resume") {
		return { agentSessionId: stored, resumeSession: true };
	}
	if (input.resumeMode === "unavailable") {
		return { agentSessionId: stored, resumeSession: false };
	}
	if (input.agentId === "claude") {
		return { agentSessionId: input.mintSessionId(), resumeSession: false };
	}
	return { agentSessionId: null, resumeSession: false };
}

/**
 * The resume-relevant lifecycle of an agent session: whether it is currently
 * running, could be resumed from its transcript, or is gone for good.
 */
export type AgentSessionLifecycle = "attached" | "resumable" | "gone";

export interface ClassifyAgentSessionLifecycleInput {
	/** True when a live process is still attached to the session. */
	readonly hasLiveProcess: boolean;
	/** The session id captured for the task, if any. */
	readonly agentSessionId: string | null;
	/** True when the agent's transcript is still present on disk. */
	readonly transcriptPresent: boolean;
}

/**
 * Classify a session as attached (live), resumable (dead but has a stored id
 * and an on-disk transcript), or gone (nothing left to resume from).
 */
export function classifyAgentSessionLifecycle(input: ClassifyAgentSessionLifecycleInput): AgentSessionLifecycle {
	if (input.hasLiveProcess) {
		return "attached";
	}
	if (input.agentSessionId && input.transcriptPresent) {
		return "resumable";
	}
	return "gone";
}
