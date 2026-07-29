import { DRIVERS } from "../agents/driver";
import type { RuntimeAgentId, RuntimeTaskTokenUsage } from "../core/api-contract";

export { deriveClaudeUsage } from "../agents/claude/driver";
export { deriveCodexUsage } from "../agents/codex/driver";
export { deriveGeminiUsage } from "../agents/gemini/driver";

export interface ReadAgentUsageInput {
	/** Which agent CLI produced the session. Unknown kinds resolve to absent. */
	readonly agentId: RuntimeAgentId | string;
	/** The agent CLI's own session id (claude session UUID / codex rollout id). */
	readonly sessionId: string;
	/** The host `$HOME` under which the CLI writes its transcripts. */
	readonly homePath: string;
}

export interface AgentUsageResult {
	/** True when a transcript file was located and read (even if it held no usage). */
	readonly present: boolean;
	/** The normalized cumulative usage, or `null` when present but no usage records. */
	readonly usage: RuntimeTaskTokenUsage | null;
}

const ABSENT: AgentUsageResult = { present: false, usage: null };

/**
 * Locate and total the token usage for an agent session. Pure over the
 * filesystem: any I/O error (missing file, permission, unreadable) collapses to
 * `{ present: false, usage: null }` so callers get a single total signal — the
 * same contract as `readAgentTranscript`, never a throw.
 */
export async function readAgentUsage(input: ReadAgentUsageInput): Promise<AgentUsageResult> {
	const driver = DRIVERS[input.agentId as RuntimeAgentId];
	if (!driver) {
		return ABSENT;
	}

	const artifactResult = await driver.observe.artifactPresent(input);
	if (!artifactResult.supported || !artifactResult.value) {
		return ABSENT;
	}

	const usageResult = await driver.observe.richUsage(input);
	if (!usageResult.supported) {
		return ABSENT;
	}

	return {
		present: true,
		usage: usageResult.value,
	};
}
