import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { RUNTIME_AGENT_CATALOG, type RuntimeAgentCatalogEntry } from "../../core/agent-catalog";
import type { RuntimeTaskChatMessage, RuntimeTaskTokenUsage } from "../../core/api-contract";
import type { AgentDriver, AgentObservationMessage, DriverSessionRef, LaunchIdentityPlan, ObservationRequest } from "../driver";
import { supported, unsupported } from "../driver";
import type { SessionSignal } from "../session-signal";

export function createCodexDriver(context?: ObservationRequest): AgentDriver {
	return {
		id: "codex",
		catalog: catalogEntryById("codex"),
		launch: {
			preflight: async () => unsupported("codex launch is not bound yet"),
			prepare: async () => unsupported("codex launch is not bound yet"),
			applyModel: (args, model) => supported([...args, "--model", model]),
		},
		identity: {
			durability: "persisted",
			resolve: (input) => {
				switch (input.ref.kind) {
					case "overseer":
					case "card": {
						const stored = input.stored?.trim() || null;
						const resumeSession = (input.lifecycle === "resumable" || input.lifecycle === "attached") && stored !== null;
						const agentSessionId = resumeSession ? stored : null;
						return supported({
							agentSessionId,
							resumeSession,
							discoverAfterSpawn: true,
							durability: "persisted",
						} satisfies LaunchIdentityPlan);
					}
				}
			},
		},
		observe: {
			artifactPresent: async (input) => {
				const ctx = input ?? context;
				if (!ctx) return supported(false);
				const loc = await locate(ctx.sessionId, ctx.homePath);
				return supported(loc.present);
			},
			messages: async (input) => {
				const ctx = input ?? context;
				if (!ctx) return supported([]);
				const loc = await locate(ctx.sessionId, ctx.homePath);
				if (!loc.present) return supported([]);
				try {
					const raw = await readFile(loc.path, "utf8");
					const records = parseJsonlRecords(raw);
					const richMsgs = parseCodexTranscript(records);
					return supported(mapToObservationMessages(richMsgs));
				} catch {
					return supported([]);
				}
			},
			transcript: async (input) => {
				const ctx = input ?? context;
				if (!ctx) return supported([]);
				const loc = await locate(ctx.sessionId, ctx.homePath);
				if (!loc.present) return supported([]);
				try {
					const raw = await readFile(loc.path, "utf8");
					const records = parseJsonlRecords(raw);
					const richMsgs = parseCodexTranscript(records);
					return supported(richMsgs);
				} catch {
					return supported([]);
				}
			},
			usage: async (input) => {
				const ctx = input ?? context;
				if (!ctx) return supported({ inputTokens: 0, outputTokens: 0 });
				const loc = await locate(ctx.sessionId, ctx.homePath);
				if (!loc.present) return supported({ inputTokens: 0, outputTokens: 0 });
				try {
					const raw = await readFile(loc.path, "utf8");
					const records = parseJsonlRecords(raw);
					const usage = deriveCodexUsage(records);
					if (!usage) return supported({ inputTokens: 0, outputTokens: 0 });
					return supported({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
				} catch {
					return supported({ inputTokens: 0, outputTokens: 0 });
				}
			},
			richUsage: async (input) => {
				const ctx = input ?? context;
				if (!ctx) return supported(null);
				const loc = await locate(ctx.sessionId, ctx.homePath);
				if (!loc.present) return supported(null);
				try {
					const raw = await readFile(loc.path, "utf8");
					const records = parseJsonlRecords(raw);
					const usage = deriveCodexUsage(records);
					return supported(usage);
				} catch {
					return supported(null);
				}
			},
			artifactPath: async (input) => {
				const loc = await locate(input.sessionId, input.homePath);
				return loc.present ? loc.path : null;
			},
		},
		signals: {
			mapNativeSignal: (input) => {
				if (input.name === "codex.progress") {
					return supported({
						seq: 1,
						at: input.observedAt,
						activity: null,
						fact: { type: "progress" },
					} satisfies SessionSignal);
				}
				if (input.name === "codex.stop") {
					return supported({
						seq: 2,
						at: input.observedAt,
						activity: null,
						fact: { type: "turn.ended", finalMessage: "complete" },
					} satisfies SessionSignal);
				}
				return unsupported(`Codex driver does not map ${input.name}`);
			},
			attentionSupport: () => unsupported("attention is not bound yet"),
		},
		control: {
			steer: async () => unsupported("codex control is not bound yet"),
			interrupt: async () => unsupported("codex control is not bound yet"),
		},
	};
}

function catalogEntryById(agentId: "codex"): RuntimeAgentCatalogEntry {
	const entry = RUNTIME_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
	if (!entry) {
		throw new Error(`Missing catalog entry for ${agentId}`);
	}
	return entry;
}

// --- Locating --------------------------------------------------------------

type AgentTranscriptLocation = { readonly present: true; readonly path: string } | { readonly present: false };

async function locate(sessionId: string, homePath: string): Promise<AgentTranscriptLocation> {
	const sessionsRoot = join(homePath, ".codex", "sessions");
	const suffix = `-${sessionId}.jsonl`;
	const stack = [sessionsRoot];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}
		for (const entry of await readDirEntries(current)) {
			const entryPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
				continue;
			}
			if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
				return { present: true, path: entryPath };
			}
		}
	}

	return { present: false };
}

async function readDirEntries(dirPath: string): Promise<Dirent[]> {
	try {
		return await readdir(dirPath, { withFileTypes: true });
	} catch {
		return [];
	}
}

// --- Parsing ---------------------------------------------------------------

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

function isCodexPreamble(text: string): boolean {
	return (
		text.startsWith("<environment_context>") ||
		text.startsWith("<user_instructions>") ||
		text.includes("# AGENTS.md") ||
		text.includes("<AGENTS.md>")
	);
}

export function deriveCodexUsage(records: Record<string, unknown>[]): RuntimeTaskTokenUsage | null {
	let latestTotal: Record<string, unknown> | null = null;

	for (const record of records) {
		if (readString(record, "type") !== "event_msg") {
			continue;
		}
		const payload = asRecord(record.payload);
		if (!payload || readString(payload, "type") !== "token_count") {
			continue;
		}
		const info = asRecord(payload.info);
		const total = info ? asRecord(info.total_token_usage) : null;
		if (total) {
			latestTotal = total;
		}
	}

	if (!latestTotal) {
		return null;
	}

	const cachedInputTokens = readNumber(latestTotal, "cached_input_tokens");
	return {
		inputTokens: readNumber(latestTotal, "input_tokens") - cachedInputTokens,
		outputTokens: readNumber(latestTotal, "output_tokens"),
		cacheReadTokens: cachedInputTokens,
		cacheCreationTokens: 0,
		costUsd: null,
	};
}

// --- Mapping ---------------------------------------------------------------

function mapToObservationMessages(messages: readonly RuntimeTaskChatMessage[]): readonly AgentObservationMessage[] {
	return messages.map((m) => {
		let role: "user" | "assistant" | "system" = "assistant";
		if (m.role === "user") {
			role = "user";
		} else if (m.role === "system") {
			role = "system";
		}
		return {
			role,
			text: m.content,
		};
	});
}

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

function readNumber(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
