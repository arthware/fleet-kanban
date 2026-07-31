import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGeminiDriver } from "../../../src/agents/gemini/driver";
import { getGeminiMockTranscriptPath } from "../../fixtures/agent-paths";
import { describeDriverTck } from "../tck/driver-tck";

const homePath = mkdtempSync(join(tmpdir(), "gemini-tck-"));
const sessionId = "gemini-session-1";
const expectedPath = getGeminiMockTranscriptPath(
	homePath,
	sessionId,
	"fleet-kanban-gemini",
	`session-2026-07-29T10-00-00-${sessionId}.jsonl`,
);
mkdirSync(dirname(expectedPath), { recursive: true });
writeFileSync(
	expectedPath,
	JSON.stringify({
		type: "user",
		timestamp: "2026-07-29T10:00:00.000Z",
		content: [{ text: "Please inspect the workspace." }],
	}) +
		"\n" +
		JSON.stringify({
			type: "gemini",
			timestamp: "2026-07-29T10:00:01.000Z",
			content: "Inspection complete.",
		}) +
		"\n",
	"utf8",
);

const driver = createGeminiDriver({ sessionId, homePath });

describeDriverTck(driver, {
	nativeSignals: [
		{ name: "BeforeAgent", payload: {}, expectedFactType: "turn.started" },
		{ name: "AfterAgent", payload: {}, expectedFactType: "turn.ended" },
		{
			name: "Notification",
			payload: { notificationType: "permission_prompt" },
			expectedFactType: "attention.required",
		},
		{ name: "BeforeTool", payload: {}, expectedFactType: "progress" },
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
