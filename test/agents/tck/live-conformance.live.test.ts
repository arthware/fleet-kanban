import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { createClaudeDriver } from "../../../src/agents/claude/driver";
import { createCodexDriver } from "../../../src/agents/codex/driver";
import { createGeminiDriver } from "../../../src/agents/gemini/driver";
import { describeLiveDriverTck, registerLiveSummaryHandler } from "./live-tck";

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
