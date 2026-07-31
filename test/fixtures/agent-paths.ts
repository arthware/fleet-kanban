import { join } from "node:path";

/**
 * Declared Test Fixture for Agent Path Literals
 * This is one of the legal places where agent path literals are allowed to exist.
 */

export function getClaudeRoot(homePath: string): string {
	return join(homePath, ".claude");
}

export function getCodexRoot(homePath: string): string {
	return join(homePath, ".codex");
}

export function getGeminiRoot(homePath: string): string {
	return join(homePath, ".gemini");
}

export function getClaudeMockTranscriptPath(homePath: string, sessionId: string, projectDirName = "some-proj"): string {
	return join(getClaudeRoot(homePath), "projects", projectDirName, `${sessionId}.jsonl`);
}

export function getCodexMockTranscriptPath(
	homePath: string,
	sessionId: string,
	datePart = "2026/07/09",
	filename = `rollout-2026-07-09T12-00-00-${sessionId}.jsonl`,
): string {
	const parts = datePart.split("/");
	return join(getCodexRoot(homePath), "sessions", ...parts, filename);
}

export function getGeminiMockTranscriptPath(
	homePath: string,
	sessionId: string,
	slug = "fleet-kanban-gemini",
	filename?: string,
): string {
	const fName = filename ?? `session-2026-07-23T18-23-${sessionId.slice(0, 8)}.jsonl`;
	return join(getGeminiRoot(homePath), "tmp", slug, "chats", fName);
}
