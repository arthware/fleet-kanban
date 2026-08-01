import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { RUNTIME_AGENT_CATALOG, type RuntimeAgentCatalogEntry } from "../../core/agent-catalog";
import type { RuntimeTaskChatMessage, RuntimeTaskTokenUsage } from "../../core/api-contract";
import { resolveHomeAgentAppendSystemPrompt } from "../../prompts/append-system-prompt";
import { toBracketedPaste } from "../../terminal/agent-session-adapters";
import { configureCodexHooks, hasCodexConfigOverride } from "../../terminal/codex-hook-config";
import { createHookRuntimeEnv } from "../../terminal/hook-runtime-context";
import type {
	AgentDriver,
	AgentObservationMessage,
	LaunchIdentityPlan,
	LaunchPlan,
	ObservationRequest,
	SteerStep,
} from "../driver";
import { supported, unsupported } from "../driver";
import type { SessionSignal } from "../session-signal";
import { binaryPreflight, hasCliOption } from "../shared/launch";
import {
	deriveFromTranscript,
	selectFromTranscriptTail,
	type TranscriptDerivation,
	type TranscriptRecord,
	type TranscriptTailQuery,
} from "../shared/observe";
import { SIGNAL_SEQUENCE_TRACKER } from "../shared/signals";
import { findCodexRolloutFileForCwd, getCodexSessionsRoot } from "./paths";

async function getRolloutFilesSorted(dir: string): Promise<string[]> {
	const files: { path: string; mtimeMs: number }[] = [];
	const walk = async (currentDir: string) => {
		try {
			const entries = await readdir(currentDir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(currentDir, entry.name);
				if (entry.isDirectory()) {
					await walk(fullPath);
				} else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
					try {
						const s = await stat(fullPath);
						files.push({ path: fullPath, mtimeMs: s.mtimeMs });
					} catch {
						// Ignore stat errors
					}
				}
			}
		} catch {
			// Ignore read errors
		}
	};
	await walk(dir);
	return files.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
}

function isoToUnix(s: string | null | undefined): number | null {
	if (!s) return null;
	try {
		const ms = Date.parse(s);
		if (Number.isNaN(ms)) return null;
		return Math.floor(ms / 1000);
	} catch {
		return null;
	}
}

function parseWindowValue(val: unknown): { used: number; remaining: number } | null {
	if (val === null || val === undefined || typeof val === "boolean") {
		return null;
	}
	const parsed = Number(val);
	if (Number.isNaN(parsed)) {
		return null;
	}
	const u = Math.max(0.0, Math.min(100.0, Math.round(parsed * 10) / 10));
	const rem = Math.round((100.0 - u) * 10) / 10;
	return { used: u, remaining: rem };
}

async function lastRateLimits(rolloutPath: string): Promise<{ rateLimits: any; timestamp: number | null } | null> {
	try {
		const content = await readFile(rolloutPath, "utf8");
		const lines = content.split("\n");
		let foundRl: any = null;
		let foundTs: number | null = null;
		for (const line of lines) {
			if (!line.includes('"rate_limits"')) {
				continue;
			}
			try {
				const obj = JSON.parse(line);
				const rl = obj?.payload?.rate_limits;
				if (rl) {
					foundRl = rl;
					const tsStr = obj?.timestamp;
					foundTs = tsStr ? isoToUnix(tsStr) : null;
				}
			} catch {
				// Ignore parse errors on partial lines
			}
		}
		if (foundRl) {
			return { rateLimits: foundRl, timestamp: foundTs };
		}
	} catch {
		return null;
	}
	return null;
}

export function createCodexDriver(context?: ObservationRequest): AgentDriver {
	return {
		id: "codex",
		catalog: catalogEntryById("codex"),
		budget: {
			read: async () => {
				const sessionsRoot = getCodexSessionsRoot();
				try {
					const s = await stat(sessionsRoot);
					if (!s.isDirectory()) {
						return unsupported(`no sessions dir at ${sessionsRoot}`);
					}
				} catch {
					return unsupported(`no sessions dir at ${sessionsRoot}`);
				}

				try {
					const rollouts = await getRolloutFilesSorted(sessionsRoot);
					for (const path of rollouts) {
						const snapshot = await lastRateLimits(path);
						if (snapshot) {
							const nowSec = Math.floor(Date.now() / 1000);
							const names: Record<number, string> = { 300: "5h", 10080: "week" };
							const windows: { name: string; remainingPercent: number | null; resetsAt: number | null }[] = [];

							for (const key of ["primary", "secondary"]) {
								const w = snapshot.rateLimits[key];
								if (!w) {
									continue;
								}
								const usedVal = w.used_percent;
								const p = parseWindowValue(usedVal);
								const mins = w.window_minutes;
								const name = names[mins] || (mins ? `${mins}m` : key);
								windows.push({
									name,
									remainingPercent: p ? p.remaining : null,
									resetsAt: w.resets_at ?? null,
								});
							}

							return supported({
								plan: snapshot.rateLimits.plan_type ?? null,
								staleSeconds: snapshot.timestamp ? Math.max(0, nowSec - snapshot.timestamp) : null,
								windows,
							});
						}
					}
					return unsupported("no rate-limit snapshot in any rollout yet");
				} catch (e: any) {
					return unsupported(`error scanning rollouts: ${e?.message || e}`);
				}
			},
		},
		launch: {
			preflight: () => binaryPreflight("codex"),
			prepare: async (input) => {
				const codexArgs = [...input.args];
				const env: Record<string, string | undefined> = {};
				const binary = input.binary;
				const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId, {
					architectContextPreamble: input.architectContextPreamble ?? undefined,
				});

				if (!hasCodexConfigOverride(codexArgs, "check_for_update_on_startup")) {
					codexArgs.push("-c", "check_for_update_on_startup=false");
				}

				if (input.autonomousModeEnabled && !hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")) {
					codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
				}

				const codexSessionId = input.agentSessionId?.trim();
				if (input.resumeSession && codexSessionId) {
					// Resume the exact prior conversation by id instead of `resume --last`.
					if (!codexArgs.includes("resume")) {
						codexArgs.push("resume");
					}
					if (!codexArgs.includes(codexSessionId)) {
						codexArgs.push(codexSessionId);
					}
				} else if (input.resumeFromTrash) {
					if (!codexArgs.includes("resume")) {
						codexArgs.push("resume");
					}
					if (!hasCliOption(codexArgs, "--last")) {
						codexArgs.push("--last");
					}
				}

				if (appendedSystemPrompt && !hasCodexConfigOverride(codexArgs, "developer_instructions")) {
					codexArgs.push("-c", `developer_instructions=${JSON.stringify(appendedSystemPrompt)}`);
				}

				// Apply model using applyModel method
				const finalArgs = [...codexArgs];
				if (input.agentModel) {
					if (hasCliOption(finalArgs, "--model") || hasCliOption(finalArgs, "-m")) {
						// user-supplied model wins
					} else {
						finalArgs.push("--model", input.agentModel);
					}
				}

				const hasWorkspaceId = input.workspaceId?.trim();
				if (hasWorkspaceId) {
					configureCodexHooks(finalArgs);
					Object.assign(
						env,
						createHookRuntimeEnv({
							taskId: input.taskId,
							workspaceId: hasWorkspaceId,
						}),
					);
				}

				const prompt = input.prompt;
				const trimmed = prompt.trim();
				if (trimmed) {
					finalArgs.push(trimmed);
				}

				return supported({
					binary,
					args: finalArgs,
					env,
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
				const richMsgs = await deriveFromTranscript(loc.path, CODEX_TRANSCRIPT);
				return supported(mapToObservationMessages(richMsgs));
			},
			transcript: async (input) => {
				const ctx = input ?? context;
				if (!ctx) return supported([]);
				const loc = await locate(ctx.sessionId, ctx.homePath);
				if (!loc.present) return supported([]);
				return supported(await deriveFromTranscript(loc.path, CODEX_TRANSCRIPT));
			},
			usage: async (input) => {
				const ctx = input ?? context;
				if (!ctx) return supported({ inputTokens: 0, outputTokens: 0 });
				const loc = await locate(ctx.sessionId, ctx.homePath);
				if (!loc.present) return supported({ inputTokens: 0, outputTokens: 0 });
				const usage = await selectFromTranscriptTail(loc.path, CODEX_USAGE);
				if (!usage) return supported({ inputTokens: 0, outputTokens: 0 });
				return supported({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
			},
			richUsage: async (input) => {
				const ctx = input ?? context;
				if (!ctx) return supported(null);
				const loc = await locate(ctx.sessionId, ctx.homePath);
				if (!loc.present) return supported(null);
				return supported(await selectFromTranscriptTail(loc.path, CODEX_USAGE));
			},
			artifactPath: async (input) => {
				const loc = await locate(input.sessionId, input.homePath);
				return loc.present ? loc.path : null;
			},
			discoverSession: async (input) => {
				const sessionsRoot = getCodexSessionsRoot(input.homePath);
				const rolloutPath = await findCodexRolloutFileForCwd(input.cwd, input.startedAtMs, sessionsRoot);
				if (!rolloutPath) {
					return null;
				}
				const match = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(
					rolloutPath,
				);
				return match ? match[1] : null;
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
						source: "codex",
					},
				};

				const normalizedName = hookEventName.toLowerCase();
				if (
					normalizedName === "approval_request" ||
					normalizedName === "permission_request" ||
					normalizedName === "approval_requested" ||
					normalizedName === "permissionrequest" ||
					normalizedName.endsWith("_approval_request") ||
					notificationType === "permission_prompt" ||
					notificationType === "permission.asked"
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
					normalizedName === "task_started" ||
					normalizedName === "userpromptsubmit" ||
					normalizedName === "beforeagent" ||
					normalizedName === "start" ||
					normalizedName === "to_in_progress"
				) {
					return supported({
						...base,
						fact: { type: "turn.started" },
					} satisfies SessionSignal);
				}
				if (
					normalizedName === "task_complete" ||
					normalizedName === "stop" ||
					normalizedName === "afteragent" ||
					normalizedName === "to_review"
				) {
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
				// Write the bracketed paste WITHOUT a trailing Enter. Codex's TUI/PTY
				// treats a carriage return fused onto the paste-end marker (… [201~\r)
				// as buffered text, not a submit — so the steer text lands but never sends.
				const plan: SteerStep[] = [{ type: "write", data: toBracketedPaste(input.text) }];
				if (input.submit) {
					// Submit the Enter as a SEPARATE write on a LATER tick. Written back-to-back
					// with the paste, the PTY coalesces both into one read, so the TUI still sees
					// the Enter fused onto the paste-end marker and swallows it.
					// For Codex, a 50ms gap is per-harness specific: it lets the paste flush and
					// paste-mode close first, so the Enter registers as a submit keypress.
					plan.push({ type: "wait", delayMs: 50 });
					plan.push({ type: "write", data: "\r" });
				}
				return supported(plan);
			},
			interrupt: async () => unsupported("Codex CLI does not support interactive interruption"),
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

/** The full conversation — the on-demand path, taken when a card is opened. */
const CODEX_TRANSCRIPT: TranscriptDerivation<RuntimeTaskChatMessage[]> = {
	id: "codex-transcript",
	derive: (records) => parseCodexTranscript([...records]),
};

/**
 * Codex emits a `token_count` event carrying the session's running totals, so the
 * newest one already holds the cumulative figure. That makes usage a tail read:
 * bounded work, whatever the session's history weighs.
 */
const CODEX_USAGE: TranscriptTailQuery<RuntimeTaskTokenUsage> = {
	id: "codex-usage",
	select: (record) => selectCodexUsage(record),
};

function selectCodexUsage(record: TranscriptRecord): RuntimeTaskTokenUsage | null {
	if (readString(record, "type") !== "event_msg") {
		return null;
	}
	const payload = asRecord(record.payload);
	if (!payload || readString(payload, "type") !== "token_count") {
		return null;
	}
	const info = asRecord(payload.info);
	const total = info ? asRecord(info.total_token_usage) : null;
	if (!total) {
		return null;
	}
	const cachedInputTokens = readNumber(total, "cached_input_tokens");
	return {
		inputTokens: readNumber(total, "input_tokens") - cachedInputTokens,
		outputTokens: readNumber(total, "output_tokens"),
		cacheReadTokens: cachedInputTokens,
		cacheCreationTokens: 0,
		costUsd: null,
	};
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

/** The same "newest totals win" rule as {@link CODEX_USAGE}, over records already in hand. */
export function deriveCodexUsage(records: Record<string, unknown>[]): RuntimeTaskTokenUsage | null {
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const usage = selectCodexUsage(records[index]);
		if (usage) {
			return usage;
		}
	}
	return null;
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

export { getCodexSessionsRoot } from "./paths";
