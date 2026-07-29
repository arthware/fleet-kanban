import { DRIVERS } from "../agents/driver";
import type { RuntimeAgentId, RuntimeTaskChatMessage } from "../core/api-contract";

export interface ReadAgentTranscriptInput {
	/** Which agent CLI produced the session. Unknown kinds resolve to absent. */
	readonly agentId: RuntimeAgentId | string;
	/** The agent CLI's own session id (claude session UUID / codex rollout id). */
	readonly sessionId: string;
	/** The host `$HOME` under which the CLI writes its transcripts. */
	readonly homePath: string;
}

export interface AgentTranscriptResult {
	/** True when a transcript file was located and read (even if it had no renderable turns). */
	readonly present: boolean;
	/** The normalized conversation, oldest first. Empty when nothing is renderable. */
	readonly messages: RuntimeTaskChatMessage[];
}

const ABSENT: AgentTranscriptResult = { present: false, messages: [] };

/**
 * Locate and parse the transcript for an agent session. Pure over the
 * filesystem: any I/O error (missing file, permission, unreadable) collapses to
 * `{ present: false }` so callers get a single total signal — a missing
 * transcript never surfaces as a fresh/empty session.
 */
export async function readAgentTranscript(input: ReadAgentTranscriptInput): Promise<AgentTranscriptResult> {
	const driver = DRIVERS[input.agentId as RuntimeAgentId];
	if (!driver) {
		return ABSENT;
	}

	const artifactResult = await driver.observe.artifactPresent(input);
	if (!artifactResult.supported || !artifactResult.value) {
		return ABSENT;
	}

	const transcriptResult = await driver.observe.transcript(input);
	if (!transcriptResult.supported) {
		return ABSENT;
	}

	return {
		present: true,
		messages: [...transcriptResult.value],
	};
}
