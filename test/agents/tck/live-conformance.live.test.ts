import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { createClaudeDriver } from "../../../src/agents/claude/driver";
import { createCodexDriver } from "../../../src/agents/codex/driver";
import { createGeminiDriver } from "../../../src/agents/gemini/driver";
import { describeLiveDriverTck, registerLiveSummaryHandler } from "./live-tck";

/** How far back a just-spawned Codex rollout file may be stamped and still count as this run's. */
const CODEX_SESSION_LOOKBACK_MS = 5 * 60 * 1000;

// 1. Session Discovery Helpers

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

/**
 * Codex nests its rollout files under `sessions/YYYY/MM/DD/` and names each one after
 * the session it belongs to. The runtime already knows how to find the rollout that
 * matches a given working directory, so the test asks it rather than keeping a second,
 * subtly different copy of that knowledge — a flat directory scan here silently found
 * nothing and reported it as a missing session.
 */
async function findLatestCodexSession(home: string): Promise<{ sessionId: string } | null> {
	const driver = createCodexDriver();
	const sessionId = await driver.observe.discoverSession({
		cwd: process.cwd(),
		startedAtMs: Date.now() - CODEX_SESSION_LOOKBACK_MS,
		homePath: home,
	});
	return sessionId ? { sessionId } : null;
}

// 2. Register Summary and Exit Safety Handler
registerLiveSummaryHandler();

// 3. Declarative TCK Conformance Suite
describe("Live Conformance Suite", () => {
	describeLiveDriverTck(createClaudeDriver(), {
		args: (sessionId) => ["--session-id", sessionId, "-p", "reply with OK"],
		env: { CLAUDE_CODE_ENABLE_AUTO_MODE: "1" },
		expectations: {
			assertMessages: (messages) => {
				const roles = messages.map((m) => m.role);
				expect(roles).toContain("user");
			},
			assertUsage: (usage) => {
				expect(usage.inputTokens).toBeGreaterThan(0);
			},
		},
	});

	describeLiveDriverTck(createCodexDriver(), {
		args: () => ["exec", "reply with OK"],
		discoverSessionId: findLatestCodexSession,
	});

	describeLiveDriverTck(createGeminiDriver(), {
		args: () => ["-p", "reply with OK"],
		discoverSessionId: findLatestGeminiSession,
	});
});
