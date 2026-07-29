import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeDriver } from "../../../src/agents/claude/driver";
import { describeDriverTck } from "../tck/driver-tck";

const homePath = mkdtempSync(join(tmpdir(), "claude-tck-"));
const sessionId = "claude-session-1";
const projectDir = join(homePath, ".claude", "projects", "some-proj");
mkdirSync(projectDir, { recursive: true });
writeFileSync(
	join(projectDir, `${sessionId}.jsonl`),
	JSON.stringify({
		type: "user",
		timestamp: "2026-07-29T10:00:00.000Z",
		message: { role: "user", content: "Please inspect the workspace." },
	}) +
		"\n" +
		JSON.stringify({
			type: "assistant",
			timestamp: "2026-07-29T10:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Inspection complete." }],
			},
		}) +
		"\n",
	"utf8",
);

const driver = createClaudeDriver({ sessionId, homePath });

describeDriverTck(driver, {
	nativeSignals: [
		{ name: "claude.progress", payload: {}, expectedFactType: "progress" },
		{ name: "claude.stop", payload: {}, expectedFactType: "turn.ended" },
	],
	observation: {
		expectedMessages: [
			{ role: "user", text: "Please inspect the workspace." },
			{ role: "assistant", text: "Inspection complete." },
		],
	},
	identity: {
		card: { kind: "card", taskId: "card-123" },
		overseer: { kind: "overseer", taskId: "home:workspace-123", workspaceId: "workspace-123" },
		generation: 2,
	},
});
