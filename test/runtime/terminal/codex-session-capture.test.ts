import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	captureCodexSessionId,
	extractCodexSessionIdFromRolloutPath,
} from "../../../src/terminal/codex-session-capture";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let sessionsRoot = "";

beforeEach(async () => {
	sessionsRoot = await mkdtemp(join(tmpdir(), "codex-capture-"));
});

afterEach(async () => {
	await rm(sessionsRoot, { recursive: true, force: true });
});

async function writeRollout(relativePath: string, cwd: string): Promise<string> {
	const absolutePath = join(sessionsRoot, relativePath);
	await mkdir(join(absolutePath, ".."), { recursive: true });
	await writeFile(absolutePath, `${JSON.stringify({ type: "session_meta", cwd })}\n`, "utf8");
	return absolutePath;
}

describe("extractCodexSessionIdFromRolloutPath", () => {
	it("reads the session id from the tail of a rollout file name", () => {
		const id = extractCodexSessionIdFromRolloutPath(
			`/root/2026/07/09/rollout-2026-07-09T12-00-00-${SESSION_ID}.jsonl`,
		);

		expect(id).toBe(SESSION_ID);
	});

	it("returns null for a path that is not a codex rollout file", () => {
		expect(extractCodexSessionIdFromRolloutPath("/root/notes.txt")).toBeNull();
	});
});

describe("captureCodexSessionId", () => {
	it("discovers the session id from the rollout file matching the task cwd", async () => {
		const cwd = join(sessionsRoot, "worktree");
		await writeRollout(join("2026", "07", "09", `rollout-2026-07-09T12-00-00-${SESSION_ID}.jsonl`), cwd);

		const captured = await captureCodexSessionId({ cwd, startedAtMs: Date.now(), sessionsRoot });

		expect(captured).toBe(SESSION_ID);
	});

	it("returns null when no rollout file matches the task cwd", async () => {
		await writeRollout(
			join("2026", "07", "09", `rollout-2026-07-09T12-00-00-${SESSION_ID}.jsonl`),
			"/some/other/worktree",
		);

		const captured = await captureCodexSessionId({
			cwd: join(sessionsRoot, "worktree"),
			startedAtMs: Date.now(),
			sessionsRoot,
		});

		expect(captured).toBeNull();
	});
});
