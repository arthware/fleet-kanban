import { homedir } from "node:os";
import { join } from "node:path";

import { findCodexRolloutFileForCwd } from "../commands/hook-events/codex-hook-events";

// Codex names each rollout file `rollout-<timestamp>-<sessionId>.jsonl`, where
// the session id is a trailing UUID. The timestamp also contains hyphens, so
// match the UUID shape at the end rather than splitting on "-".
const CODEX_ROLLOUT_SESSION_ID_PATTERN =
	/-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

/** Extract the Codex session id from a rollout file path, or null if it is not one. */
export function extractCodexSessionIdFromRolloutPath(rolloutPath: string): string | null {
	const match = CODEX_ROLLOUT_SESSION_ID_PATTERN.exec(rolloutPath);
	return match ? match[1] : null;
}

export interface CaptureCodexSessionIdInput {
	/** The task worktree the Codex session was launched in. */
	readonly cwd: string;
	/** When the session started, used to ignore stale rollout files. */
	readonly startedAtMs: number;
	/** Root of Codex's session logs; defaults to `~/.codex/sessions`. */
	readonly sessionsRoot?: string;
}

/**
 * Discover the session id of a freshly-spawned Codex session by locating the
 * rollout file that matches the task's cwd, then reading the id from its name.
 * Returns null when no matching rollout file has appeared yet.
 */
export async function captureCodexSessionId(input: CaptureCodexSessionIdInput): Promise<string | null> {
	const sessionsRoot = input.sessionsRoot ?? join(homedir(), ".codex", "sessions");
	const rolloutPath = await findCodexRolloutFileForCwd(input.cwd, input.startedAtMs, sessionsRoot);
	if (!rolloutPath) {
		return null;
	}
	return extractCodexSessionIdFromRolloutPath(rolloutPath);
}
