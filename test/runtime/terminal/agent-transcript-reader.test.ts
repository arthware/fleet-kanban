import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAgentTranscript } from "../../../src/terminal/agent-transcript-reader";
import {
	getClaudeMockTranscriptPath,
	getCodexMockTranscriptPath,
	getGeminiMockTranscriptPath,
} from "../../fixtures/agent-paths";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let homePath = "";

beforeEach(async () => {
	homePath = await mkdtemp(join(tmpdir(), "transcript-reader-"));
});

afterEach(async () => {
	await rm(homePath, { recursive: true, force: true });
});

async function writeJsonl(relativePath: string, records: unknown[]): Promise<void> {
	const absolutePath = join(homePath, relativePath);
	await mkdir(join(absolutePath, ".."), { recursive: true });
	await writeFile(absolutePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

async function writeFixture(relativePath: string, fixtureName: string): Promise<void> {
	const absolutePath = join(homePath, relativePath);
	await mkdir(join(absolutePath, ".."), { recursive: true });
	await writeFile(absolutePath, await readFile(join(fixtureDir, fixtureName), "utf8"), "utf8");
}

describe("readAgentTranscript — claude", () => {
	const sessionId = "claude-read-1";

	it("given a recorded Claude transcript, when it is read through the locator path, then production can render the main conversation", async () => {
		// given
		await writeFixture(
			getClaudeMockTranscriptPath("", sessionId, "-Users-arthur-code-repos-tools"),
			"claude-transcript-recorded.jsonl",
		);

		// when
		const result = await readAgentTranscript({ agentId: "claude", sessionId, homePath });

		// then
		expect(result.present).toBe(true);
		expect(result.messages.map((message) => message.role)).toEqual([
			"user",
			"reasoning",
			"assistant",
			"tool",
			"tool",
		]);
		expect(result.messages[2]?.content).toBe("The card asks for characterization tests.");
	});

	it("normalizes user prompt, assistant prose, reasoning, and tool call/result into ordered messages", async () => {
		await writeJsonl(getClaudeMockTranscriptPath("", sessionId, "-Users-dev-repo"), [
			{ type: "mode", mode: "default" },
			{
				type: "user",
				timestamp: "2026-07-10T10:00:00.000Z",
				message: { role: "user", content: "hello world" },
			},
			{
				type: "assistant",
				timestamp: "2026-07-10T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "let me think" },
						{ type: "text", text: "hi there" },
						{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
					],
				},
			},
			{
				type: "user",
				timestamp: "2026-07-10T10:00:02.000Z",
				message: {
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "file1\nfile2" }] },
					],
				},
			},
			{ type: "user", isSidechain: true, message: { role: "user", content: "sidechain prompt" } },
			{ type: "user", isMeta: true, message: { role: "user", content: "meta prompt" } },
			{ type: "system", subtype: "stop_hook", content: null },
		]);

		const result = await readAgentTranscript({ agentId: "claude", sessionId, homePath });

		expect(result.present).toBe(true);
		expect(result.messages.map((message) => message.role)).toEqual([
			"user",
			"reasoning",
			"assistant",
			"tool",
			"tool",
		]);
		const [user, reasoning, assistant, toolCall, toolResult] = result.messages;
		expect(user.content).toBe("hello world");
		expect(reasoning.content).toContain("let me think");
		expect(assistant.content).toBe("hi there");
		expect(toolCall.meta?.toolName).toBe("Bash");
		expect(toolCall.content).toContain("ls");
		expect(toolResult.content).toContain("file1");
		// The tool result is correlated back to its call name.
		expect(toolResult.content).toContain("Bash");
	});

	it("reports absent with no messages when the transcript is gone", async () => {
		const result = await readAgentTranscript({ agentId: "claude", sessionId: "missing-session", homePath });
		expect(result).toEqual({ present: false, messages: [] });
	});
});

describe("readAgentTranscript — codex", () => {
	const sessionId = "019f3e14-664d-7da1-958b-030480aa2f8d";

	it("given a recorded Codex rollout, when it is read through the locator path, then production can render the conversation without duplicate event messages", async () => {
		// given
		const recordedSessionId = "019f4b49-a9e3-74b3-8beb-75b8dec8a874";
		await writeFixture(
			getCodexMockTranscriptPath(
				"",
				recordedSessionId,
				"2026/07/10",
				`rollout-2026-07-10T09-09-07-${recordedSessionId}.jsonl`,
			),
			"codex-transcript-recorded.jsonl",
		);

		// when
		const result = await readAgentTranscript({ agentId: "codex", sessionId: recordedSessionId, homePath });

		// then
		expect(result.present).toBe(true);
		expect(result.messages.map((message) => message.role)).toEqual([
			"user",
			"reasoning",
			"assistant",
			"tool",
			"tool",
		]);
		expect(result.messages.filter((message) => message.content === "I will add black-box tests.")).toHaveLength(1);
	});

	it("renders human/assistant turns and tool activity, skipping injected preamble and duplicate event stream", async () => {
		await writeJsonl(
			getCodexMockTranscriptPath("", sessionId, "2026/07/07", `rollout-2026-07-07T21-35-52-${sessionId}.jsonl`),
			[
				{
					type: "session_meta",
					timestamp: "2026-07-07T21:35:52.000Z",
					payload: { id: sessionId, type: "session_meta" },
				},
				{
					type: "response_item",
					timestamp: "2026-07-07T21:35:53.000Z",
					payload: {
						type: "message",
						role: "developer",
						content: [{ type: "input_text", text: "sandbox instructions" }],
					},
				},
				{
					type: "response_item",
					timestamp: "2026-07-07T21:35:54.000Z",
					payload: {
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "<environment_context>cwd=/repo</environment_context>" }],
					},
				},
				{
					type: "response_item",
					timestamp: "2026-07-07T21:35:55.000Z",
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "what is 2+2?" }] },
				},
				{
					type: "response_item",
					timestamp: "2026-07-07T21:35:56.000Z",
					payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "2+2 = 4" }] },
				},
				{
					type: "response_item",
					timestamp: "2026-07-07T21:35:57.000Z",
					payload: { type: "function_call", name: "shell", arguments: '{"command":["ls"]}', call_id: "fc1" },
				},
				{
					type: "response_item",
					timestamp: "2026-07-07T21:35:58.000Z",
					payload: { type: "function_call_output", call_id: "fc1", output: "file1\nfile2" },
				},
				{
					type: "event_msg",
					timestamp: "2026-07-07T21:35:59.000Z",
					payload: { type: "agent_message", message: "2+2 = 4" },
				},
			],
		);

		const result = await readAgentTranscript({ agentId: "codex", sessionId, homePath });

		expect(result.present).toBe(true);
		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool"]);
		const [user, assistant, toolCall, toolResult] = result.messages;
		expect(user.content).toBe("what is 2+2?");
		expect(assistant.content).toBe("2+2 = 4");
		expect(toolCall.meta?.toolName).toBe("shell");
		expect(toolCall.content).toContain("ls");
		expect(toolResult.content).toContain("file1");
	});
});

describe("readAgentTranscript — unknown agent", () => {
	it("reports absent without touching the filesystem layout", async () => {
		const result = await readAgentTranscript({ agentId: "unknown-agent", sessionId: "whatever", homePath });
		expect(result).toEqual({ present: false, messages: [] });
	});
});

describe("readAgentTranscript — gemini", () => {
	it("known-red card 4: given a recorded Gemini transcript, when it is read, then production should render non-empty user and assistant turns", async () => {
		// given
		const sessionId = "84456eab-7b3b-49d8-babb-3a49e2ecd15c";
		await writeFixture(
			getGeminiMockTranscriptPath("", sessionId, "fleet-kanban-4", "session-2026-07-23T18-22-84456eab.jsonl"),
			"gemini-transcript-recorded.jsonl",
		);

		// when
		const result = await readAgentTranscript({ agentId: "gemini", sessionId, homePath });

		// then
		expect(result.present).toBe(true);
		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(result.messages[0]?.content).toBe("Update the fleet implement skill.");
		expect(result.messages[1]?.content).toBe("I will now update the skill file.");
	});
});
