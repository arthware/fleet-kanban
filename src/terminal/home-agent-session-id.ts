import { createHash } from "node:crypto";

import type { RuntimeAgentId } from "../core/api-contract";

/**
 * A fixed namespace UUID for deriving stable home/architect-agent session ids.
 * It only needs to be a constant, valid UUID; its value is otherwise arbitrary.
 */
const HOME_AGENT_UUID_NAMESPACE = "fee1c0de-0000-4000-8000-000000000001";

/**
 * Derive a DETERMINISTIC session id (a UUIDv5 over `workspaceId:agentId`) for a
 * workspace's home/architect agent.
 *
 * Because it depends only on `(workspaceId, agentId)`, it is identical on every
 * launch — so the home/architect chat (a single, persistent conversation) is
 * always resumable and can never be lost on a board restart. The first launch
 * starts the CLI session with this id (`--session-id`); every launch after
 * resumes it (`--resume`), chosen by whether its transcript already exists.
 */
export function deriveHomeAgentClaudeSessionId(workspaceId: string, agentId: RuntimeAgentId): string {
	return uuidV5(`${workspaceId}:${agentId}`, HOME_AGENT_UUID_NAMESPACE);
}

export interface HomeAgentLaunchDecision {
	/** The deterministic session id to launch with. */
	readonly agentSessionId: string;
	/** Resume when the session already exists on disk; otherwise start it fresh. */
	readonly resumeSession: boolean;
}

/**
 * Decide how to launch a home/architect agent: always with its deterministic id,
 * resuming when a transcript for that id is already present, else starting fresh.
 */
export function resolveHomeAgentLaunch(input: {
	readonly agentSessionId: string;
	readonly transcriptPresent: boolean;
}): HomeAgentLaunchDecision {
	return { agentSessionId: input.agentSessionId, resumeSession: input.transcriptPresent };
}

function uuidV5(name: string, namespace: string): string {
	const namespaceBytes = uuidToBytes(namespace);
	const digest = createHash("sha1").update(namespaceBytes).update(Buffer.from(name, "utf8")).digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	// Stamp the v4 shape the Claude CLI's --session-id validator already accepts.
	// The id stays fully deterministic (derived from the sha1 above); the version
	// nibble is cosmetic — we are not claiming true randomness.
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4 (shape only)
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function uuidToBytes(uuid: string): Buffer {
	return Buffer.from(uuid.replace(/-/g, ""), "hex");
}
