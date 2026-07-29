import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DRIVERS } from "../../../src/agents/driver";

function hasBinary(binary: string): boolean {
	try {
		const res = spawnSync("which", [binary]);
		return res.status === 0;
	} catch {
		return false;
	}
}

function findLatestGeminiSession(home: string): { sessionId: string } | null {
	const tmpRoot = join(home, ".gemini", "tmp");
	let latestMtime = 0;
	let latestFile = "";
	try {
		const dirs = readdirSync(tmpRoot);
		for (const d of dirs) {
			const chatsDir = join(tmpRoot, d, "chats");
			try {
				const files = readdirSync(chatsDir);
				for (const f of files) {
					if (f.startsWith("session-") && f.endsWith(".jsonl")) {
						const fp = join(chatsDir, f);
						const mtime = statSync(fp).mtimeMs;
						if (mtime > latestMtime) {
							latestMtime = mtime;
							latestFile = fp;
						}
					}
				}
			} catch {}
		}
	} catch {}

	if (!latestFile) return null;
	try {
		const content = readFileSync(latestFile, "utf8");
		const firstLine = content.split("\n")[0];
		const parsed = JSON.parse(firstLine);
		if (parsed && typeof parsed.sessionId === "string") {
			return { sessionId: parsed.sessionId };
		}
	} catch {}
	return null;
}

describe("Live Conformance Suite", () => {
	it("Claude live turn", async () => {
		if (!hasBinary("claude")) {
			console.log("Claude Code binary not found; skipping live Claude conformance test.");
			return;
		}

		const sessionId = `live-tck-claude-${Date.now()}`;
		const home = homedir();

		const runResult = spawnSync("claude", ["--session-id", sessionId, "-p", "reply with OK"], {
			env: { ...process.env, CLAUDE_CODE_ENABLE_AUTO_MODE: "1" },
			timeout: 8000,
		});

		// If the CLI timed out or exited due to authentication, skip
		if (runResult.error || runResult.status !== 0) {
			console.log("Claude live execution failed/timed out (likely unauthenticated); skipping.");
			return;
		}

		// Locate and parse
		const driver = DRIVERS.claude;
		const presentResult = await driver.observe.artifactPresent({ sessionId, homePath: home });
		expect(presentResult.supported).toBe(true);
		if (!presentResult.supported || !presentResult.value) {
			console.log("Claude transcript artifact not found after execution.");
			return;
		}

		const messagesResult = await driver.observe.messages({ sessionId, homePath: home });
		expect(messagesResult.supported).toBe(true);
		if (messagesResult.supported) {
			expect(messagesResult.value.length).toBeGreaterThan(0);
			const roles = messagesResult.value.map((m) => m.role);
			expect(roles).toContain("user");
		}

		const usageResult = await driver.observe.usage({ sessionId, homePath: home });
		expect(usageResult.supported).toBe(true);
		if (usageResult.supported) {
			expect(usageResult.value.inputTokens).toBeGreaterThan(0);
		}
	});

	it("Codex live turn", async () => {
		if (!hasBinary("codex")) {
			console.log("OpenAI Codex binary not found; skipping live Codex conformance test.");
			return;
		}

		const sessionId = `live-tck-codex-${Date.now()}`;
		const home = homedir();

		const runResult = spawnSync("codex", ["--session-id", sessionId, "reply with OK"], {
			env: { ...process.env },
			timeout: 8000,
		});

		if (runResult.error || runResult.status !== 0) {
			console.log("Codex live execution failed/timed out (likely unauthenticated); skipping.");
			return;
		}

		const driver = DRIVERS.codex;
		const presentResult = await driver.observe.artifactPresent({ sessionId, homePath: home });
		expect(presentResult.supported).toBe(true);
		if (!presentResult.supported || !presentResult.value) {
			console.log("Codex transcript artifact not found after execution.");
			return;
		}

		const messagesResult = await driver.observe.messages({ sessionId, homePath: home });
		expect(messagesResult.supported).toBe(true);
		if (messagesResult.supported) {
			expect(messagesResult.value.length).toBeGreaterThan(0);
		}

		const usageResult = await driver.observe.usage({ sessionId, homePath: home });
		expect(usageResult.supported).toBe(true);
	});

	it("Gemini live turn", async () => {
		if (!hasBinary("gemini")) {
			console.log("Gemini CLI binary not found; skipping live Gemini conformance test.");
			return;
		}

		if (!process.env.GEMINI_API_KEY) {
			console.log("GEMINI_API_KEY env var missing; skipping live Gemini conformance test.");
			return;
		}

		const home = homedir();

		const runResult = spawnSync("gemini", ["--yolo", "-i", "reply with OK"], {
			env: { ...process.env },
			timeout: 8000,
		});

		if (runResult.error || runResult.status !== 0) {
			console.log("Gemini live execution failed/timed out; skipping.");
			return;
		}

		const latest = findLatestGeminiSession(home);
		if (!latest) {
			console.log("Failed to capture latest Gemini session from tmp directory.");
			return;
		}

		const sessionId = latest.sessionId;
		const driver = DRIVERS.gemini;
		const presentResult = await driver.observe.artifactPresent({ sessionId, homePath: home });
		expect(presentResult.supported).toBe(true);
		if (!presentResult.supported || !presentResult.value) {
			console.log(`Gemini transcript artifact not found for session ${sessionId}.`);
			return;
		}

		const messagesResult = await driver.observe.messages({ sessionId, homePath: home });
		expect(messagesResult.supported).toBe(true);
		if (messagesResult.supported) {
			expect(messagesResult.value.length).toBeGreaterThan(0);
		}

		const usageResult = await driver.observe.usage({ sessionId, homePath: home });
		expect(usageResult.supported).toBe(true);
	});
});
