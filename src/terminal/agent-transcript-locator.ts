import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

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

	switch (input.agentId) {
		case "claude":
			return locateClaudeTranscript(input.homePath, sessionId);
		case "codex":
			return locateCodexTranscript(input.homePath, sessionId);
		default:
			// Agents without a known transcript layout: report absent rather than
			// guessing a path. Keeps the function total for every agent kind.
			return ABSENT;
	}
}

/**
 * Claude stores one transcript per session at
 * `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`. The cwd-slug directory is
 * not derivable from the session id alone, so scan the project directories and
 * match on the `<sessionId>.jsonl` leaf.
 */
async function locateClaudeTranscript(homePath: string, sessionId: string): Promise<AgentTranscriptLocation> {
	const projectsRoot = join(homePath, ".claude", "projects");
	const projectDirs = await readDirEntries(projectsRoot);
	const transcriptName = `${sessionId}.jsonl`;

	for (const entry of projectDirs) {
		if (!entry.isDirectory()) {
			continue;
		}
		const candidate = join(projectsRoot, entry.name, transcriptName);
		if (await isFile(candidate)) {
			return { present: true, path: candidate };
		}
	}

	return ABSENT;
}

/**
 * Codex stores rollout transcripts under a date-partitioned tree at
 * `~/.codex/sessions/**\/rollout-<timestamp>-<sessionId>.jsonl`. Walk the tree
 * and match the file whose name ends with `-<sessionId>.jsonl`.
 */
async function locateCodexTranscript(homePath: string, sessionId: string): Promise<AgentTranscriptLocation> {
	const sessionsRoot = join(homePath, ".codex", "sessions");
	const suffix = `-${sessionId}.jsonl`;
	const stack = [sessionsRoot];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}
		for (const entry of await readDirEntries(current)) {
			const entryPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
				continue;
			}
			if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
				return { present: true, path: entryPath };
			}
		}
	}

	return ABSENT;
}

async function readDirEntries(dirPath: string): Promise<Dirent[]> {
	try {
		return await readdir(dirPath, { withFileTypes: true });
	} catch {
		return [];
	}
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}
