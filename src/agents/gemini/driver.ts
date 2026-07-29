import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { RUNTIME_AGENT_CATALOG, type RuntimeAgentCatalogEntry } from "../../core/agent-catalog";
import type { RuntimeTaskChatMessage, RuntimeTaskTokenUsage } from "../../core/api-contract";
import type { AgentDriver, AgentObservationMessage, LaunchIdentityPlan, ObservationRequest } from "../driver";
import { supported, unsupported } from "../driver";
import type { SessionSignal } from "../session-signal";

export function createGeminiDriver(context?: ObservationRequest): AgentDriver {
	return {
		id: "gemini",
		catalog: catalogEntryById("gemini"),
		launch: {
			preflight: async () => unsupported("gemini launch is not bound yet"),
			prepare: async () => unsupported("gemini launch is not bound yet"),
			applyModel: (args, model) => supported([...args, "--model", model]),
		},
		identity: {
			durability: "persisted",
			resolve: (input) =>
				supported({
					agentSessionId: input.stored ?? `gemini-persisted-${input.ref.taskId}-${input.generation}`,
					resumeSession: input.lifecycle === "resumable" && input.stored !== null,
					discoverAfterSpawn: true,
					durability: "persisted",
				} satisfies LaunchIdentityPlan),
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
					const richMsgs = parseGeminiTranscript(records);
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
					const richMsgs = parseGeminiTranscript(records);
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
					const usage = deriveGeminiUsage(records);
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
					const usage = deriveGeminiUsage(records);
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
				if (input.name === "gemini.progress") {
					return supported({
						seq: 1,
						at: input.observedAt,
						activity: null,
						fact: { type: "progress" },
					} satisfies SessionSignal);
				}
				if (input.name === "gemini.stop") {
					return supported({
						seq: 2,
						at: input.observedAt,
						activity: null,
						fact: { type: "turn.ended", finalMessage: "complete" },
					} satisfies SessionSignal);
				}
				return unsupported(`Gemini driver does not map ${input.name}`);
			},
			attentionSupport: () => unsupported("attention is not bound yet"),
		},
		control: {
			steer: async () => unsupported("gemini control is not bound yet"),
			interrupt: async () => unsupported("gemini control is not bound yet"),
		},
	};
}

function catalogEntryById(agentId: "gemini"): RuntimeAgentCatalogEntry {
	const entry = RUNTIME_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
	if (!entry) {
		throw new Error(`Missing catalog entry for ${agentId}`);
	}
	return entry;
}

// --- Locating --------------------------------------------------------------

type AgentTranscriptLocation = { readonly present: true; readonly path: string } | { readonly present: false };

async function locate(sessionId: string, homePath: string): Promise<AgentTranscriptLocation> {
	const tmpRoot = join(homePath, ".gemini", "tmp");
	const projectDirs = await readDirEntries(tmpRoot);

	const suffix8 = `-${sessionId.slice(0, 8)}.jsonl`;
	const suffixFull = `-${sessionId}.jsonl`;

	for (const entry of projectDirs) {
		if (!entry.isDirectory()) {
			continue;
		}
		const chatsDir = join(tmpRoot, entry.name, "chats");
		const chatFiles = await readDirEntries(chatsDir);
		for (const file of chatFiles) {
			if (file.isFile() && file.name.startsWith("session-")) {
				if (file.name.endsWith(suffix8) || file.name.endsWith(suffixFull)) {
					return { present: true, path: join(chatsDir, file.name) };
				}
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

function parseGeminiTranscript(records: Record<string, unknown>[]): RuntimeTaskChatMessage[] {
	const messages: RuntimeTaskChatMessage[] = [];
	let index = 0;
	const nextId = () => `gemini-${index++}`;

	for (const record of records) {
		const type = readString(record, "type");
		if (type !== "user" && type !== "gemini") {
			continue;
		}
		const createdAt = toMillis(record.timestamp);
		const content = record.content;

		if (type === "user") {
			let text = "";
			if (typeof content === "string") {
				text = content.trim();
			} else if (Array.isArray(content)) {
				const parts: string[] = [];
				for (const block of content) {
					if (isRecord(block)) {
						const blockText = readString(block, "text")?.trim();
						if (blockText) {
							parts.push(blockText);
						}
					}
				}
				text = parts.join("\n").trim();
			}
			if (text) {
				messages.push(makeMessage(nextId(), "user", text, createdAt));
			}
		} else if (type === "gemini") {
			let text = "";
			if (typeof content === "string") {
				text = content.trim();
			}
			if (text) {
				messages.push(makeMessage(nextId(), "assistant", text, createdAt));
			}
		}
	}
	return messages;
}

export function deriveGeminiUsage(records: Record<string, unknown>[]): RuntimeTaskTokenUsage | null {
	let latestTokens: Record<string, unknown> | null = null;

	for (const record of records) {
		if (readString(record, "type") !== "gemini") {
			continue;
		}
		const tokens = asRecord(record.tokens);
		if (tokens) {
			latestTokens = tokens;
		}
	}

	if (!latestTokens) {
		return null;
	}

	return {
		inputTokens: readNumber(latestTokens, "input"),
		outputTokens: readNumber(latestTokens, "output"),
		cacheReadTokens: readNumber(latestTokens, "cached"),
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

function makeMessage(
	id: string,
	role: RuntimeTaskChatMessage["role"],
	content: string,
	createdAt: number,
): RuntimeTaskChatMessage {
	return {
		id,
		role,
		content,
		createdAt,
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

function readString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
