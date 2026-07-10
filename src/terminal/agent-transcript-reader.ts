import { readFile } from "node:fs/promises";

import type { RuntimeAgentId, RuntimeTaskChatMessage } from "../core/api-contract";
import { locateAgentTranscript } from "./agent-transcript-locator";

/**
 * Reads an agent CLI's own on-disk transcript for a session and normalizes it
 * into the same read-only message shape the chat surfaces already render
 * (`RuntimeTaskChatMessage`). This is the durable "observe" path: when a task's
 * live PTY is gone, the detail pane renders these messages instead of a blank
 * terminal. Agent-agnostic (Claude `.jsonl`, Codex rollout); derives everything
 * from the CLI's artifacts rather than a separate kanban-owned transcript store.
 */
export interface ReadAgentTranscriptInput {
	/** Which agent CLI produced the session. Unknown kinds resolve to absent. */
	readonly agentId: RuntimeAgentId | string;
	/** The agent CLI's own session id (claude session UUID / codex rollout id). */
	readonly sessionId: string;
	/** The host `$HOME` under which the CLI writes its transcripts. */
	readonly homePath: string;
}

export interface AgentTranscriptResult {
	/** True when a transcript file was located and read (even if it had no renderable turns). */
	readonly present: boolean;
	/** The normalized conversation, oldest first. Empty when nothing is renderable. */
	readonly messages: RuntimeTaskChatMessage[];
}

const ABSENT: AgentTranscriptResult = { present: false, messages: [] };

/**
 * Locate and parse the transcript for an agent session. Pure over the
 * filesystem: any I/O error (missing file, permission, unreadable) collapses to
 * `{ present: false }` so callers get a single total signal — a missing
 * transcript never surfaces as a fresh/empty session.
 */
export async function readAgentTranscript(input: ReadAgentTranscriptInput): Promise<AgentTranscriptResult> {
	const location = await locateAgentTranscript(input);
	if (!location.present) {
		return ABSENT;
	}

	let raw: string;
	try {
		raw = await readFile(location.path, "utf8");
	} catch {
		return ABSENT;
	}

	const records = parseJsonlRecords(raw);
	const messages = input.agentId === "codex" ? parseCodexTranscript(records) : parseClaudeTranscript(records);
	return { present: true, messages };
}

function parseJsonlRecords(raw: string): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isRecord(parsed)) {
				records.push(parsed);
			}
		} catch {
			// Tolerate a partially-flushed / corrupt trailing line.
		}
	}
	return records;
}

// --- Claude ----------------------------------------------------------------

/**
 * Claude writes one JSON object per line, discriminated by `type`. Only `user`
 * and `assistant` records carry conversation; everything else (mode,
 * permission-mode, file-history-snapshot, attachment, last-prompt, ai-title,
 * system, …) is skipped, as are sidechain (subagent) and meta records.
 */
function parseClaudeTranscript(records: Record<string, unknown>[]): RuntimeTaskChatMessage[] {
	const messages: RuntimeTaskChatMessage[] = [];
	const toolNamesById = new Map<string, string>();
	let index = 0;
	const nextId = () => `claude-${index++}`;

	for (const record of records) {
		const type = readString(record, "type");
		if ((type !== "user" && type !== "assistant") || record.isSidechain === true || record.isMeta === true) {
			continue;
		}
		const createdAt = toMillis(record.timestamp);
		const message = asRecord(record.message);
		const content = message?.content;

		if (type === "user") {
			if (typeof content === "string") {
				const text = content.trim();
				if (text) {
					messages.push(makeMessage(nextId(), "user", text, createdAt));
				}
				continue;
			}
			for (const block of asArray(content)) {
				const blockRecord = asRecord(block);
				if (!blockRecord) {
					continue;
				}
				const blockType = readString(blockRecord, "type");
				if (blockType === "tool_result") {
					const toolUseId = readString(blockRecord, "tool_use_id");
					const toolName = (toolUseId && toolNamesById.get(toolUseId)) || "tool";
					const output = extractClaudeText(blockRecord.content);
					messages.push(
						makeMessage(nextId(), "tool", formatToolBlock(toolName, null, output), createdAt, toolName),
					);
				} else if (blockType === "text") {
					const text = readString(blockRecord, "text")?.trim();
					if (text) {
						messages.push(makeMessage(nextId(), "user", text, createdAt));
					}
				}
			}
			continue;
		}

		// assistant
		for (const block of asArray(content)) {
			const blockRecord = asRecord(block);
			if (!blockRecord) {
				continue;
			}
			const blockType = readString(blockRecord, "type");
			if (blockType === "text") {
				const text = readString(blockRecord, "text")?.trim();
				if (text) {
					messages.push(makeMessage(nextId(), "assistant", text, createdAt));
				}
			} else if (blockType === "thinking") {
				const text = readString(blockRecord, "thinking")?.trim();
				if (text) {
					messages.push(makeMessage(nextId(), "reasoning", text, createdAt));
				}
			} else if (blockType === "tool_use") {
				const toolName = readString(blockRecord, "name") ?? "tool";
				const toolUseId = readString(blockRecord, "id");
				if (toolUseId) {
					toolNamesById.set(toolUseId, toolName);
				}
				const inputText = stringifyToolInput(blockRecord.input);
				messages.push(
					makeMessage(nextId(), "tool", formatToolBlock(toolName, inputText, null), createdAt, toolName),
				);
			}
		}
	}

	return messages;
}

/** Pull display text out of a Claude content value (string, or array of `{type:"text", text}`). */
function extractClaudeText(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	const parts: string[] = [];
	for (const block of asArray(content)) {
		const blockRecord = asRecord(block);
		const text = blockRecord ? readString(blockRecord, "text") : null;
		if (text) {
			parts.push(text);
		}
	}
	return parts.join("\n").trim();
}

// --- Codex -----------------------------------------------------------------

/**
 * Codex rollout lines nest the payload under `payload`, discriminated by
 * `payload.type`. We render from the `response_item` stream (full fidelity) and
 * skip the parallel `event_msg` stream to avoid double-rendering. Injected
 * preamble (the `developer` role and the boilerplate `<environment_context>` /
 * `<user_instructions>` / AGENTS.md user blocks) is dropped so the human's real
 * turns lead the conversation.
 */
function parseCodexTranscript(records: Record<string, unknown>[]): RuntimeTaskChatMessage[] {
	const messages: RuntimeTaskChatMessage[] = [];
	const toolNamesById = new Map<string, string>();
	let index = 0;
	const nextId = () => `codex-${index++}`;

	for (const record of records) {
		if (readString(record, "type") !== "response_item") {
			continue;
		}
		const payload = asRecord(record.payload);
		if (!payload) {
			continue;
		}
		const payloadType = readString(payload, "type");
		const createdAt = toMillis(record.timestamp);

		if (payloadType === "message") {
			const role = readString(payload, "role");
			if (role === "developer") {
				continue;
			}
			const text = extractCodexMessageText(payload.content);
			if (!text) {
				continue;
			}
			if (role === "assistant") {
				messages.push(makeMessage(nextId(), "assistant", text, createdAt));
			} else if (role === "user" && !isCodexPreamble(text)) {
				messages.push(makeMessage(nextId(), "user", text, createdAt));
			}
		} else if (payloadType === "reasoning") {
			const text = extractCodexMessageText(payload.content);
			if (text) {
				messages.push(makeMessage(nextId(), "reasoning", text, createdAt));
			}
		} else if (payloadType === "function_call" || payloadType === "custom_tool_call") {
			const toolName = readString(payload, "name") ?? "tool";
			const callId = readString(payload, "call_id");
			if (callId) {
				toolNamesById.set(callId, toolName);
			}
			const inputText = stringifyToolInput(payload.arguments ?? payload.input);
			messages.push(makeMessage(nextId(), "tool", formatToolBlock(toolName, inputText, null), createdAt, toolName));
		} else if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
			const callId = readString(payload, "call_id");
			const toolName = (callId && toolNamesById.get(callId)) || "tool";
			const output = extractCodexOutput(payload.output);
			messages.push(makeMessage(nextId(), "tool", formatToolBlock(toolName, null, output), createdAt, toolName));
		}
	}

	return messages;
}

/** Codex message content is an array of `{type:"input_text"|"output_text", text}` blocks. */
function extractCodexMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	const parts: string[] = [];
	for (const block of asArray(content)) {
		const blockRecord = asRecord(block);
		const text = blockRecord ? readString(blockRecord, "text") : null;
		if (text) {
			parts.push(text);
		}
	}
	return parts.join("\n").trim();
}

function extractCodexOutput(output: unknown): string {
	if (typeof output === "string") {
		return output.trim();
	}
	const outputRecord = asRecord(output);
	if (outputRecord) {
		const content = readString(outputRecord, "content");
		if (content) {
			return content.trim();
		}
	}
	return "";
}

/** Injected Codex context that precedes the human's real first prompt. */
function isCodexPreamble(text: string): boolean {
	return (
		text.startsWith("<environment_context>") ||
		text.startsWith("<user_instructions>") ||
		text.includes("# AGENTS.md") ||
		text.includes("<AGENTS.md>")
	);
}

// --- Shared helpers --------------------------------------------------------

/**
 * Render a tool call/result in the `Tool:/Input:/Output:` text format the
 * shared chat message item already parses (`parseToolMessageContent`), so the
 * read-only view reuses the same collapsible tool rendering.
 */
function formatToolBlock(toolName: string, input: string | null, output: string | null): string {
	const lines = [`Tool: ${toolName}`];
	if (input) {
		lines.push("Input:", input);
	}
	if (output) {
		lines.push("Output:", output);
	}
	return lines.join("\n");
}

function stringifyToolInput(input: unknown): string | null {
	if (input == null) {
		return null;
	}
	if (typeof input === "string") {
		return input.trim() || null;
	}
	try {
		return JSON.stringify(input);
	} catch {
		return null;
	}
}

function makeMessage(
	id: string,
	role: RuntimeTaskChatMessage["role"],
	content: string,
	createdAt: number,
	toolName?: string,
): RuntimeTaskChatMessage {
	return {
		id,
		role,
		content,
		createdAt,
		...(toolName ? { meta: { toolName } } : {}),
	};
}

function toMillis(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const millis = Date.parse(value);
		if (!Number.isNaN(millis)) {
			return millis;
		}
	}
	return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function readString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}
