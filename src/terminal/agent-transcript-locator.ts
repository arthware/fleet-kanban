import { DRIVERS } from "../agents/driver";
import type { RuntimeAgentId } from "../core/api-contract";

/**
 * Where an agent CLI stores the transcript for a given session, resolved on
 * disk. This is the "resumable vs gone" signal the durable-session manager
 * needs: a present transcript means the session can be resumed by id; an absent
 * one means it is gone.
 */
export type AgentTranscriptLocation = { readonly present: true; readonly path: string } | { readonly present: false };

const ABSENT: AgentTranscriptLocation = { present: false };

export interface LocateAgentTranscriptInput {
	/** Which agent CLI produced the session. Unknown kinds resolve to absent. */
	readonly agentId: RuntimeAgentId | string;
	/** The agent CLI's own session id (claude session UUID / codex rollout id). */
	readonly sessionId: string;
	/** The host `$HOME` under which the CLI writes its transcripts. */
	readonly homePath: string;
}

/**
 * Resolve the on-disk transcript path for an agent session, if it exists.
 *
 * Pure over the filesystem: it only reads directory listings and file stats,
 * never writes. Any I/O error (missing directory, permission) is treated as
 * "absent" rather than thrown, so callers get a single, total signal.
 */
export async function locateAgentTranscript(input: LocateAgentTranscriptInput): Promise<AgentTranscriptLocation> {
	const sessionId = input.sessionId.trim();
	if (!sessionId) {
		return ABSENT;
	}

	const driver = DRIVERS[input.agentId as RuntimeAgentId];
	if (!driver || !driver.observe.artifactPath) {
		return ABSENT;
	}

	const path = await driver.observe.artifactPath({ sessionId, homePath: input.homePath });
	return path ? { present: true, path } : ABSENT;
}
