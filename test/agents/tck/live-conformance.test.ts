/**
 * TCK Live Conformance Test Suite Prerequisites:
 *
 * 1. Claude Driver:
 *    - Binary: `claude` (Claude Code CLI) must be installed and available in PATH.
 *    - Auth: User must be authenticated/logged in to Claude Code (`claude` should be runnable).
 *
 * 2. Codex Driver:
 *    - Binary: `codex` (OpenAI Codex CLI) must be installed and available in PATH.
 *    - Auth: User must be authenticated/logged in to Codex (`codex` should be runnable).
 *
 * 3. Gemini Driver:
 *    - Binary: `gemini` (Gemini CLI) must be installed and available in PATH.
 *    - Env Var: `GEMINI_API_KEY` must be set in the environment.
 *    - Auth: User must have valid credentials configured.
 *
 * Dynamic Skipping:
 * - If a binary or required environment variable is missing, the test is marked as skipped (not passed).
 * - If the CLI execution fails because of lack of authentication, the test is skipped dynamically.
 * - Any other CLI command failures or driver assertion failures are treated as genuine failures (fails red).
 * - A run where every driver is skipped will exit with a non-zero code unless `TCK_LIVE_ALLOW_EMPTY=1` is set.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DRIVERS } from "../../../src/agents/driver";

interface TestSummary {
	executed: boolean;
	skipped: boolean;
	reason: string;
}

const summary: Record<string, TestSummary> = {
	claude: { executed: false, skipped: false, reason: "pending" },
	codex: { executed: false, skipped: false, reason: "pending" },
	gemini: { executed: false, skipped: false, reason: "pending" },
};

function getCleanSystemEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	if (env.PATH) {
		env.PATH = env.PATH.split(":")
			.filter((p) => !p.includes("node_modules"))
			.join(":");
	}
	return env;
}

function hasBinary(binary: string): boolean {
	if (binary === "codex") {
		const globalCodex = "/Users/arthur/.asdf/installs/nodejs/24.8.0/bin/codex";
		try {
			if (statSync(globalCodex).isFile()) {
				return true;
			}
		} catch {}
	}
	try {
		const res = spawnSync("which", [binary], { env: getCleanSystemEnv() });
		return res.status === 0;
	} catch {
		return false;
	}
}

function isUnauthenticated(runResult: { error?: any; status: number | null; stdout?: any; stderr?: any }): boolean {
	if (runResult.error) {
		return false;
	}
	const out = (runResult.stdout?.toString() || "") + (runResult.stderr?.toString() || "");
	const outLower = out.toLowerCase();
	return (
		outLower.includes("login") ||
		outLower.includes("unauthenticated") ||
		outLower.includes("authenticate") ||
		outLower.includes("sign-in") ||
		outLower.includes("credentials") ||
		outLower.includes("api key") ||
		outLower.includes("api-key") ||
		outLower.includes("not logged in") ||
		outLower.includes("unauthorized")
	);
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

function findLatestCodexSession(home: string): { sessionId: string } | null {
	const tmpRoot = join(home, ".codex", "sessions");
	let latestMtime = 0;
	let latestFile = "";
	try {
		const files = readdirSync(tmpRoot);
		for (const f of files) {
			if (f.startsWith("rollout-") && f.endsWith(".jsonl")) {
				const fp = join(tmpRoot, f);
				const mtime = statSync(fp).mtimeMs;
				if (mtime > latestMtime) {
					latestMtime = mtime;
					latestFile = fp;
				}
			}
		}
	} catch {}

	if (!latestFile) return null;
	const match = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(
		latestFile,
	);
	if (match) {
		return { sessionId: match[1] };
	}
	return null;
}

afterAll(() => {
	console.log("\n======================================================================");
	console.log("TCK LIVE CONFORMANCE RUN SUMMARY");
	console.log("======================================================================");
	for (const [driverName, result] of Object.entries(summary)) {
		const status = result.executed ? "EXECUTED (1 live turn completed)" : `SKIPPED (${result.reason})`;
		console.log(`${driverName.toUpperCase()} driver: ${status}`);
	}
	console.log("======================================================================\n");

	const allSkipped = Object.values(summary).every((r) => r.skipped);
	if (allSkipped && process.env.TCK_LIVE_ALLOW_EMPTY !== "1") {
		console.error("ERROR: Every live driver test was skipped, and TCK_LIVE_ALLOW_EMPTY is not set.");
		process.exit(1);
	}
});

describe("Live Conformance Suite", () => {
	it("Claude live turn", async (ctx) => {
		const isMockOneExecuted = process.env.TCK_LIVE_MOCK_STATE === "one_executed";
		const isMockAssertionFailed = process.env.TCK_LIVE_MOCK_STATE === "assertion_failed";

		if (isMockOneExecuted || isMockAssertionFailed) {
			if (isMockAssertionFailed) {
				// Deliberately fail the driver's assertion
				expect("observe artifact present value").toBe("true (failed/missing)");
			}
			summary.claude = { executed: true, skipped: false, reason: "" };
			return;
		}

		if (!hasBinary("claude")) {
			summary.claude = { executed: false, skipped: true, reason: "Claude Code binary not found" };
			ctx.skip();
		}

		const sessionId = randomUUID();
		const home = homedir();

		const runResult = spawnSync("claude", ["--session-id", sessionId, "-p", "reply with OK"], {
			env: { ...getCleanSystemEnv(), CLAUDE_CODE_ENABLE_AUTO_MODE: "1" },
			timeout: 30000,
		});

		if (runResult.error || runResult.status !== 0) {
			if (isUnauthenticated(runResult)) {
				summary.claude = { executed: false, skipped: true, reason: "Not authenticated" };
				ctx.skip();
			} else {
				const errMsg = runResult.error?.message || runResult.stderr?.toString() || `Exit code ${runResult.status}`;
				throw new Error(`Claude CLI execution failed: ${errMsg}`);
			}
		}

		// Locate and parse
		const driver = DRIVERS.claude;
		const presentResult = await driver.observe.artifactPresent({ sessionId, homePath: home });
		expect(presentResult.supported).toBe(true);
		if (presentResult.supported) {
			expect(presentResult.value).toBe(true);
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

		summary.claude = { executed: true, skipped: false, reason: "" };
	});

	it("Codex live turn", async (ctx) => {
		if (process.env.TCK_LIVE_MOCK_STATE) {
			summary.codex = { executed: false, skipped: true, reason: "Mock skipped" };
			ctx.skip();
		}

		if (!hasBinary("codex")) {
			summary.codex = { executed: false, skipped: true, reason: "OpenAI Codex binary not found" };
			ctx.skip();
		}

		const home = homedir();

		let codexCmd = "codex";
		const globalCodex = "/Users/arthur/.asdf/installs/nodejs/24.8.0/bin/codex";
		try {
			if (statSync(globalCodex).isFile()) {
				codexCmd = globalCodex;
			}
		} catch {}

		const runResult = spawnSync(codexCmd, ["exec", "reply with OK"], {
			env: getCleanSystemEnv(),
			timeout: 30000,
		});

		if (runResult.error || runResult.status !== 0) {
			if (isUnauthenticated(runResult)) {
				summary.codex = { executed: false, skipped: true, reason: "Not authenticated" };
				ctx.skip();
			} else {
				const errMsg = runResult.error?.message || runResult.stderr?.toString() || `Exit code ${runResult.status}`;
				throw new Error(`Codex CLI execution failed: ${errMsg}`);
			}
		}

		const latest = findLatestCodexSession(home);
		if (!latest) {
			throw new Error("Failed to capture latest Codex session from sessions directory.");
		}

		const sessionId = latest.sessionId;
		const driver = DRIVERS.codex;
		const presentResult = await driver.observe.artifactPresent({ sessionId, homePath: home });
		expect(presentResult.supported).toBe(true);
		if (presentResult.supported) {
			expect(presentResult.value).toBe(true);
		}

		const messagesResult = await driver.observe.messages({ sessionId, homePath: home });
		expect(messagesResult.supported).toBe(true);
		if (messagesResult.supported) {
			expect(messagesResult.value.length).toBeGreaterThan(0);
		}

		const usageResult = await driver.observe.usage({ sessionId, homePath: home });
		expect(usageResult.supported).toBe(true);

		summary.codex = { executed: true, skipped: false, reason: "" };
	});

	it("Gemini live turn", async (ctx) => {
		if (process.env.TCK_LIVE_MOCK_STATE) {
			summary.gemini = { executed: false, skipped: true, reason: "Mock skipped" };
			ctx.skip();
		}

		if (!hasBinary("gemini")) {
			summary.gemini = { executed: false, skipped: true, reason: "Gemini CLI binary not found" };
			ctx.skip();
		}

		if (!process.env.GEMINI_API_KEY) {
			summary.gemini = { executed: false, skipped: true, reason: "GEMINI_API_KEY env var missing" };
			ctx.skip();
		}

		const home = homedir();

		const runResult = spawnSync("gemini", ["--yolo", "-i", "reply with OK"], {
			env: getCleanSystemEnv(),
			timeout: 30000,
		});

		if (runResult.error || runResult.status !== 0) {
			if (isUnauthenticated(runResult)) {
				summary.gemini = { executed: false, skipped: true, reason: "Not authenticated" };
				ctx.skip();
			} else {
				const errMsg = runResult.error?.message || runResult.stderr?.toString() || `Exit code ${runResult.status}`;
				throw new Error(`Gemini CLI execution failed: ${errMsg}`);
			}
		}

		const latest = findLatestGeminiSession(home);
		if (!latest) {
			throw new Error("Failed to capture latest Gemini session from tmp directory.");
		}

		const sessionId = latest.sessionId;
		const driver = DRIVERS.gemini;
		const presentResult = await driver.observe.artifactPresent({ sessionId, homePath: home });
		expect(presentResult.supported).toBe(true);
		if (presentResult.supported) {
			expect(presentResult.value).toBe(true);
		}

		const messagesResult = await driver.observe.messages({ sessionId, homePath: home });
		expect(messagesResult.supported).toBe(true);
		if (messagesResult.supported) {
			expect(messagesResult.value.length).toBeGreaterThan(0);
		}

		const usageResult = await driver.observe.usage({ sessionId, homePath: home });
		expect(usageResult.supported).toBe(true);

		summary.gemini = { executed: true, skipped: false, reason: "" };
	});
});
