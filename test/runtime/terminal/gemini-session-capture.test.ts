import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureGeminiSessionId, findGeminiSlugForCwd } from "../../../src/terminal/gemini-session-capture";

const SESSION_ID = "afd41427-2374-46d9-84f1-9634c8e89cee";

let geminiRoot = "";

beforeEach(async () => {
	geminiRoot = await mkdtemp(join(tmpdir(), "gemini-capture-"));
});

afterEach(async () => {
	await rm(geminiRoot, { recursive: true, force: true });
});

async function writeProjectsJson(projects: Record<string, string>): Promise<void> {
	await writeFile(join(geminiRoot, "projects.json"), JSON.stringify({ projects }, null, 2), "utf8");
}

async function writeProjectRoot(slug: string, cwd: string): Promise<void> {
	const dir = join(geminiRoot, "tmp", slug);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, ".project_root"), cwd, "utf8");
}

async function writeChatFile(slug: string, fileName: string, content: string): Promise<string> {
	const dir = join(geminiRoot, "tmp", slug, "chats");
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, fileName);
	await writeFile(filePath, content, "utf8");
	return filePath;
}

describe("findGeminiSlugForCwd", () => {
	it("maps cwd to slug using projects.json", async () => {
		const cwd = "/Users/arthur/my-project";
		await writeProjectsJson({ [cwd]: "my-project-slug" });

		const slug = await findGeminiSlugForCwd(geminiRoot, cwd);

		expect(slug).toBe("my-project-slug");
	});

	it("falls back to scanning .project_root files when projects.json doesn't exist or is invalid", async () => {
		const cwd = "/Users/arthur/my-project-fallback";
		await writeProjectRoot("fallback-slug", cwd);

		const slug = await findGeminiSlugForCwd(geminiRoot, cwd);

		expect(slug).toBe("fallback-slug");
	});

	it("returns null when no mapping can be found", async () => {
		const slug = await findGeminiSlugForCwd(geminiRoot, "/Users/arthur/unknown-project");

		expect(slug).toBeNull();
	});
});

describe("captureGeminiSessionId", () => {
	it("discovers the session id from the newest chat file matching the task cwd", async () => {
		const cwd = "/Users/arthur/my-project";
		const slug = "my-project-slug";
		await writeProjectsJson({ [cwd]: slug });

		const chatContent = `${JSON.stringify({ sessionId: SESSION_ID })}\n`;
		await writeChatFile(slug, "session-2026-07-23T18-23-afd41427.jsonl", chatContent);

		const captured = await captureGeminiSessionId({ cwd, startedAtMs: Date.now(), geminiRoot });

		expect(captured).toBe(SESSION_ID);
	});

	it("ignores chat files that are too old", async () => {
		const cwd = "/Users/arthur/my-project";
		const slug = "my-project-slug";
		await writeProjectsJson({ [cwd]: slug });

		const chatContent = `${JSON.stringify({ sessionId: SESSION_ID })}\n`;
		const filePath = await writeChatFile(slug, "session-2026-07-23T18-23-afd41427.jsonl", chatContent);

		// Artificially make the file old (e.g. 1 hour ago)
		const pastTime = Date.now() - 3600000;
		const fs = require("node:fs/promises");
		await fs.utimes(filePath, pastTime / 1000, pastTime / 1000);

		const captured = await captureGeminiSessionId({ cwd, startedAtMs: Date.now(), geminiRoot });

		expect(captured).toBeNull();
	});
});
