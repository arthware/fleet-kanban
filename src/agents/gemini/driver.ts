import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	getRuntimeAgentBinaryCandidates,
	RUNTIME_AGENT_CATALOG,
	type RuntimeAgentCatalogEntry,
} from "../../core/agent-catalog";
import type { RuntimeTaskChatMessage, RuntimeTaskTokenUsage } from "../../core/api-contract";
import { buildHooksCommand, getHookAgentDirectory, toBracketedPaste } from "../../terminal/agent-session-adapters";
import { isBinaryAvailableOnPath } from "../../terminal/command-discovery";
import { createHookRuntimeEnv } from "../../terminal/hook-runtime-context";
import type {
	AgentDriver,
	AgentObservationMessage,
	LaunchIdentityPlan,
	LaunchPlan,
	ObservationRequest,
	SteerPlan,
	SteerStep,
} from "../driver";
import { supported, unsupported } from "../driver";
import { hasCliOption, withPrompt } from "../launch-utils";
import type { SessionSignal } from "../session-signal";
import { SIGNAL_SEQUENCE_TRACKER } from "../signal-sequence";

export function createGeminiDriver(context?: ObservationRequest): AgentDriver {
	return {
		id: "gemini",
		catalog: catalogEntryById("gemini"),
		launch: {
			preflight: async () => {
				const testFail = process.env.KANBAN_TEST_PREFLIGHT_FAIL;
				if (testFail) {
					return unsupported(testFail);
				}
				const isTest =
					(typeof process.env.VITEST !== "undefined" && !process.env.KANBAN_TEST_PREFLIGHT_RUN_REALLY) ||
					typeof process.env.KANBAN_TEST_AGENT_BINARY !== "undefined";
				if (!isTest) {
					const candidates = getRuntimeAgentBinaryCandidates("gemini");
					const binary = candidates.find((candidate) => isBinaryAvailableOnPath(candidate));
					if (!binary) {
						return unsupported("binary missing: 'gemini' CLI binary not found on PATH");
					}
					if (process.env.KANBAN_WORKSPACE_TRUST === "untrusted") {
						return unsupported("not trusted: workspace is not trusted");
					}
				}
				return supported({ ok: true as const });
			},
			prepare: async (input) => {
				const args = [...input.args];
				const env: Record<string, string | undefined> = {};

				if (input.autonomousModeEnabled && !hasCliOption(args, "--yolo")) {
					args.push("--yolo");
				}

				const geminiSessionId = input.agentSessionId?.trim();
				const hasResumeFlag = hasCliOption(args, "--resume") || hasCliOption(args, "-r");
				if (input.resumeSession && geminiSessionId && !hasResumeFlag) {
					args.push("--resume", geminiSessionId);
				} else if (input.resumeFromTrash && !hasResumeFlag) {
					args.push("--resume", "latest");
				}

				const filesToWrite: { path: string; content: string }[] = [];
				const configPath = join(getHookAgentDirectory("gemini"), "settings.json");
				const hasWorkspaceId = input.workspaceId?.trim();
				const config: { security: { folderTrust: { enabled: boolean } }; hooks?: Record<string, unknown> } = {
					// Board worktrees are already trusted by the harness; disabling this here
					// prevents the "Do you trust the files in this folder?" gate from hanging
					// every fresh Gemini session (--yolo only covers tool-call approval, not this).
					security: {
						folderTrust: {
							enabled: false,
						},
					},
				};

				if (hasWorkspaceId) {
					const geminiHookCommand = buildHooksCommand(["gemini-hook"]);
					config.hooks = {
						BeforeTool: [
							{
								hooks: [{ type: "command", command: geminiHookCommand }],
							},
						],
						AfterTool: [
							{
								hooks: [{ type: "command", command: geminiHookCommand }],
							},
						],
						AfterAgent: [
							{
								hooks: [{ type: "command", command: geminiHookCommand }],
							},
						],
						BeforeAgent: [
							{
								hooks: [{ type: "command", command: geminiHookCommand }],
							},
						],
						Notification: [
							{
								hooks: [{ type: "command", command: geminiHookCommand }],
							},
						],
					};
					Object.assign(
						env,
						createHookRuntimeEnv({
							taskId: input.taskId,
							workspaceId: hasWorkspaceId,
						}),
					);
				}

				filesToWrite.push({
					path: configPath,
					content: JSON.stringify(config, null, 2),
				});
				env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = configPath;

				// Apply model using applyModel method
				const finalArgs = [...args];
				if (input.agentModel) {
					if (hasCliOption(finalArgs, "--model") || hasCliOption(finalArgs, "-m")) {
						// user-supplied model wins
					} else {
						finalArgs.push("--model", input.agentModel);
					}
				}

				const finalArgsWithPrompt = withPrompt(finalArgs, input.prompt, "flag", "-i");
				return supported({
					binary: input.binary,
					args: finalArgsWithPrompt,
					env,
					filesToWrite,
				} satisfies LaunchPlan);
			},
			applyModel: (args, model) => {
				if (hasCliOption(args, "--model") || hasCliOption(args, "-m")) {
					return supported(args);
				}
				return supported([...args, "--model", model]);
			},
		},
		identity: {
			durability: "persisted",
			resolve: (input) => {
				switch (input.ref.kind) {
					case "overseer":
					case "card": {
						const stored = input.stored?.trim() || null;
						const resumeSession =
							(input.lifecycle === "resumable" || input.lifecycle === "attached") && stored !== null;
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
				const payloadRecord = asRecord(input.payload) || {};
				const sessionId = (payloadRecord.sessionId as string) || "default-session";
				const metadata = asRecord(payloadRecord.metadata) || payloadRecord;

				const hookEventName = String(metadata.hookEventName || metadata.hook_event_name || input.name).trim();
				const notificationType = String(metadata.notificationType || metadata.notification_type || "")
					.trim()
					.toLowerCase();
				const finalMessage = metadata.finalMessage ? String(metadata.finalMessage) : null;

				const seq = SIGNAL_SEQUENCE_TRACKER.getSequence(sessionId, input.name, input.payload, input.observedAt);
				const base = {
					seq,
					at: input.observedAt,
					activity: {
						activityText: metadata.activityText ? String(metadata.activityText) : null,
						toolName: metadata.toolName ? String(metadata.toolName) : null,
						toolInputSummary: metadata.toolInputSummary ? String(metadata.toolInputSummary) : null,
						finalMessage: metadata.finalMessage ? String(metadata.finalMessage) : null,
						hookEventName: metadata.hookEventName ? String(metadata.hookEventName) : null,
						notificationType: metadata.notificationType ? String(metadata.notificationType) : null,
						source: "gemini",
					},
				};

				const normalizedName = hookEventName.toLowerCase();
				if (
					normalizedName === "permissionrequest" ||
					notificationType === "permission_prompt" ||
					notificationType === "permission.asked" ||
					notificationType === "user_attention"
				) {
					return supported({
						...base,
						fact: { type: "attention.required", cause: "permission" },
					} satisfies SessionSignal);
				}
				if (notificationType === "request_user_input") {
					return supported({
						...base,
						fact: { type: "attention.required", cause: "question" },
					} satisfies SessionSignal);
				}
				if (
					normalizedName === "beforeagent" ||
					normalizedName === "start" ||
					normalizedName === "userpromptsubmit" ||
					normalizedName === "task_started" ||
					normalizedName === "to_in_progress"
				) {
					return supported({
						...base,
						fact: { type: "turn.started" },
					} satisfies SessionSignal);
				}
				if (normalizedName === "afteragent" || normalizedName === "stop" || normalizedName === "to_review") {
					return supported({
						...base,
						fact: { type: "turn.ended", finalMessage },
					} satisfies SessionSignal);
				}
				if (normalizedName === "activity") {
					return supported({
						...base,
						fact: { type: "progress" },
					} satisfies SessionSignal);
				}
				return supported({
					...base,
					fact: { type: "progress" },
				} satisfies SessionSignal);
			},
			attentionSupport: () => supported(true),
		},
		control: {
			steer: async (input) => {
				// Write the bracketed paste WITHOUT a trailing Enter. Gemini's TUI/PTY
				// treats a carriage return fused onto the paste-end marker (… [201~\r)
				// as buffered text, not a submit — so the steer text lands but never sends.
				const plan: SteerStep[] = [{ type: "write", data: toBracketedPaste(input.text) }];
				if (input.submit) {
					// Submit the Enter as a SEPARATE write on a LATER tick. Written back-to-back
					// with the paste, the PTY coalesces both into one read, so the TUI still sees
					// the Enter fused onto the paste-end marker and swallows it.
					// For Gemini, a 300ms gap is required because Gemini's internal input processor
					// and PTY event loop are slower and need more time to process the paste-end
					// boundary before receiving the carriage return submit keypress.
					plan.push({ type: "wait", delayMs: 300 });
					plan.push({ type: "write", data: "\r" });
				}
				return supported(plan);
			},
			interrupt: async () => unsupported("Gemini CLI does not support interactive interruption"),
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
