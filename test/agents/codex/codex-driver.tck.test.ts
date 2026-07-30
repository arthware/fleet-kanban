import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexDriver } from "../../../src/agents/codex/driver";
import { describeDriverTck } from "../tck/driver-tck";

const homePath = mkdtempSync(join(tmpdir(), "codex-tck-"));
const sessionId = "codex-session-1";
const sessionDir = join(homePath, ".codex", "sessions", "2026", "07");
mkdirSync(sessionDir, { recursive: true });
writeFileSync(
	join(sessionDir, `rollout-2026-07-29T10-00-00-${sessionId}.jsonl`),
	JSON.stringify({
		type: "response_item",
		timestamp: "2026-07-29T10:00:00.000Z",
		payload: {
			type: "message",
			role: "user",
			content: "Please inspect the workspace.",
		},
	}) +
		"\n" +
		JSON.stringify({
			type: "response_item",
			timestamp: "2026-07-29T10:00:01.000Z",
			payload: {
				type: "message",
				role: "assistant",
				content: "Inspection complete.",
			},
		}) +
		"\n",
	"utf8",
);

const driver = createCodexDriver({ sessionId, homePath });

describeDriverTck(driver, {
	nativeSignals: [
		{ name: "task_started", payload: {}, expectedFactType: "turn.started" },
		{ name: "task_complete", payload: {}, expectedFactType: "turn.ended" },
		{ name: "approval_request", payload: {}, expectedFactType: "attention.required" },
		{ name: "exec_command_begin", payload: {}, expectedFactType: "progress" },
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
