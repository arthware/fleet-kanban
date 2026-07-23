import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { locateAgentTranscript } from "../../../src/terminal/agent-transcript-locator";

let homePath = "";

beforeEach(async () => {
	homePath = await mkdtemp(join(tmpdir(), "transcript-locator-"));
});

afterEach(async () => {
	await rm(homePath, { recursive: true, force: true });
});

async function writeTranscript(relativePath: string): Promise<string> {
	const absolutePath = join(homePath, relativePath);
	await mkdir(join(absolutePath, ".."), { recursive: true });
	await writeFile(absolutePath, "{}\n", "utf8");
	return absolutePath;
}

describe("locateAgentTranscript", () => {
	it("finds a claude transcript stored under a cwd-slug project directory", async () => {
		const sessionId = "claude-session-1";
		const expectedPath = await writeTranscript(
			join(".claude", "projects", "-Users-dev-some-repo", `${sessionId}.jsonl`),
		);

		const location = await locateAgentTranscript({ agentId: "claude", sessionId, homePath });

		expect(location).toEqual({ present: true, path: expectedPath });
	});

	it("finds a codex rollout transcript nested under a date-partitioned directory", async () => {
		const sessionId = "codex-session-1";
		const expectedPath = await writeTranscript(
			join(".codex", "sessions", "2026", "07", "09", `rollout-2026-07-09T12-00-00-${sessionId}.jsonl`),
		);

		const location = await locateAgentTranscript({ agentId: "codex", sessionId, homePath });

		expect(location).toEqual({ present: true, path: expectedPath });
	});

	it("reports a claude transcript absent when no matching file exists", async () => {
		await writeTranscript(join(".claude", "projects", "-Users-dev-some-repo", "a-different-session.jsonl"));

		const location = await locateAgentTranscript({ agentId: "claude", sessionId: "missing-session", homePath });

		expect(location).toEqual({ present: false });
	});

	it("reports a codex transcript absent when no rollout file matches the session id", async () => {
		await writeTranscript(
			join(".codex", "sessions", "2026", "07", "09", "rollout-2026-07-09T12-00-00-other-session.jsonl"),
		);

		const location = await locateAgentTranscript({ agentId: "codex", sessionId: "missing-session", homePath });

		expect(location).toEqual({ present: false });
	});

	it("finds a gemini transcript stored under a tmp slug chats directory", async () => {
		const sessionId = "afd41427-2374-46d9-84f1-9634c8e89cee";
		const expectedPath = await writeTranscript(
			join(".gemini", "tmp", "fleet-kanban-5", "chats", `session-2026-07-23T18-23-${sessionId.slice(0, 8)}.jsonl`),
		);

		const location = await locateAgentTranscript({ agentId: "gemini", sessionId, homePath });

		expect(location).toEqual({ present: true, path: expectedPath });
	});

	it("reports a gemini transcript absent when no matching file exists", async () => {
		const sessionId = "afd41427-2374-46d9-84f1-9634c8e89cee";
		await writeTranscript(
			join(".gemini", "tmp", "fleet-kanban-5", "chats", "session-2026-07-23T18-23-different.jsonl"),
		);

		const location = await locateAgentTranscript({ agentId: "gemini", sessionId, homePath });

		expect(location).toEqual({ present: false });
	});

	it("reports absent for an unknown agent kind instead of throwing", async () => {
		const location = await locateAgentTranscript({ agentId: "unknown-agent", sessionId: "any-session", homePath });

		expect(location).toEqual({ present: false });
	});

	it("reports absent for an empty session id", async () => {
		const location = await locateAgentTranscript({ agentId: "claude", sessionId: "", homePath });

		expect(location).toEqual({ present: false });
	});
});
