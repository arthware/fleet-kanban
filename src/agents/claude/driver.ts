import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { RUNTIME_AGENT_CATALOG, type RuntimeAgentCatalogEntry } from "../../core/agent-catalog";
import type { RuntimeTaskChatMessage, RuntimeTaskTokenUsage } from "../../core/api-contract";
import { estimateClaudeCostUsd } from "../../core/claude-model-pricing";
import { resolveHomeAgentAppendSystemPrompt } from "../../prompts/append-system-prompt";
import { getHookAgentDirectory, toBracketedPaste } from "../../terminal/agent-session-adapters";
import {
	isClaudeCloudProviderBackend,
	resolveClaudePermissionStrategy,
} from "../../terminal/claude-permission-strategy";
import { deriveHomeAgentClaudeSessionId } from "../../terminal/home-agent-session-id";
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
import { supported } from "../driver";
import type { SessionSignal } from "../session-signal";
import { binaryPreflight, hasCliOption, withPrompt } from "../shared/launch";
import {
	deriveFromTranscript,
	foldTranscript,
	type TranscriptDerivation,
	type TranscriptFold,
	type TranscriptRecord,
} from "../shared/observe";
import { SIGNAL_SEQUENCE_TRACKER } from "../shared/signals";
import { buildClaudeHookSettings } from "./hook-settings";

export function createClaudeDriver(context?: ObservationRequest): AgentDriver {
	return {
		id: "claude",
		catalog: catalogEntryById("claude"),
		launch: {
			preflight: () => binaryPreflight("claude"),
			prepare: async (input) => {
				const args = [...input.args];
				const env: Record<string, string | undefined> = {
					FORCE_HYPERLINK: "1",
				};
				const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId, {
					architectContextPreamble: input.architectContextPreamble ?? undefined,
				});
				if (input.autonomousModeEnabled) {
					env.CLAUDE_CODE_ENABLE_AUTO_MODE = "1";
				}
				if (
					input.autonomousModeEnabled &&
					!hasCliOption(args, "--permission-mode") &&
					!hasCliOption(args, "--dangerously-skip-permissions")
				) {
					const strategy = resolveClaudePermissionStrategy({
						agentModel: input.agentModel ?? undefined,
						cloudProviderBackend: isClaudeCloudProviderBackend(),
					});
					if (strategy === "bypass-guarded") {
						args.push("--dangerously-skip-permissions");
					} else {
						args.push("--permission-mode", "auto");
					}
				}
				const claudeSessionId = input.agentSessionId?.trim();
				const claudeHasResumeFlag = hasCliOption(args, "--resume") || hasCliOption(args, "--continue");
				if (input.resumeSession && claudeSessionId && !claudeHasResumeFlag) {
					args.push("--resume", claudeSessionId);
				} else if (
					!input.resumeSession &&
					claudeSessionId &&
					!claudeHasResumeFlag &&
					!hasCliOption(args, "--session-id")
				) {
					args.push("--session-id", claudeSessionId);
				} else if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
					args.push("--continue");
				}

				// Apply model using applyModel method
				const finalArgs = [...args];
				if (input.agentModel) {
					if (hasCliOption(finalArgs, "--model") || hasCliOption(finalArgs, "-m")) {
						// user-supplied model wins
					} else {
						finalArgs.push("--model", input.agentModel);
					}
				}

				const bashGuardEnabled =
					input.autonomousModeEnabled === true && hasCliOption(finalArgs, "--dangerously-skip-permissions");

				const filesToWrite: { path: string; content: string }[] = [];
				const hasWorkspaceId = input.workspaceId?.trim();
				if (hasWorkspaceId) {
					const settingsPath = join(getHookAgentDirectory("claude"), "settings.json");

					const hooksSettings = buildClaudeHookSettings(bashGuardEnabled);
					filesToWrite.push({
						path: settingsPath,
						content: JSON.stringify(hooksSettings, null, 2),
					});
					finalArgs.push("--settings", settingsPath);
					Object.assign(
						env,
						createHookRuntimeEnv({
							taskId: input.taskId,
							workspaceId: hasWorkspaceId,
						}),
					);
				}

				if (
					appendedSystemPrompt &&
					!hasCliOption(finalArgs, "--append-system-prompt") &&
					!hasCliOption(finalArgs, "--system-prompt")
				) {
					finalArgs.push("--append-system-prompt", appendedSystemPrompt);
				}

				const finalArgsWithPrompt = withPrompt(finalArgs, input.prompt, "append");
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
			durability: "deterministic",
			resolve: (input) => {
				switch (input.ref.kind) {
					case "overseer": {
						const agentSessionId = deriveHomeAgentClaudeSessionId(
							input.ref.workspaceId,
							"claude",
							input.generation,
						);
						const resumeSession = input.lifecycle === "resumable" || input.lifecycle === "attached";
						return supported({
							agentSessionId,
							resumeSession,
							discoverAfterSpawn: false,
							durability: "deterministic",
						} satisfies LaunchIdentityPlan);
					}
					case "card": {
						const stored = input.stored?.trim() || null;
						const resumeSession =
							(input.lifecycle === "resumable" || input.lifecycle === "attached") && stored !== null;
						const agentSessionId = resumeSession ? stored : randomUUID();
						return supported({
							agentSessionId,
							resumeSession,
							discoverAfterSpawn: false,
							durability: "deterministic",
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
				const richMsgs = await deriveFromTranscript(loc.path, CLAUDE_TRANSCRIPT);
				return supported(mapToObservationMessages(richMsgs));
			},
			transcript: async (input) => {
				const ctx = input ?? context;
				if (!ctx) return supported([]);
				const loc = await locate(ctx.sessionId, ctx.homePath);
				if (!loc.present) return supported([]);
				return supported(await deriveFromTranscript(loc.path, CLAUDE_TRANSCRIPT));
			},
			usage: async (input) => {
				const ctx = input ?? context;
				if (!ctx) return supported({ inputTokens: 0, outputTokens: 0 });
				const loc = await locate(ctx.sessionId, ctx.homePath);
				if (!loc.present) return supported({ inputTokens: 0, outputTokens: 0 });
				const usage = await foldTranscript(loc.path, CLAUDE_USAGE);
				if (!usage) return supported({ inputTokens: 0, outputTokens: 0 });
				return supported({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
			},
			richUsage: async (input) => {
				const ctx = input ?? context;
				if (!ctx) return supported(null);
				const loc = await locate(ctx.sessionId, ctx.homePath);
				if (!loc.present) return supported(null);
				return supported(await foldTranscript(loc.path, CLAUDE_USAGE));
			},
			artifactPath: async (input) => {
				const loc = await locate(input.sessionId, input.homePath);
				return loc.present ? loc.path : null;
			},
			discoverSession: async () => {
				return null;
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
						source: "claude",
					},
				};

				const normalizedName = hookEventName.toLowerCase();
				if (
					normalizedName === "permissionrequest" ||
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
					normalizedName === "start" ||
					normalizedName === "beforeagent" ||
					normalizedName === "userpromptsubmit" ||
					normalizedName === "task_started" ||
					normalizedName === "to_in_progress"
				) {
					return supported({
						...base,
						fact: { type: "turn.started" },
					} satisfies SessionSignal);
				}
				if (normalizedName === "stop" || normalizedName === "afteragent" || normalizedName === "to_review") {
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
				// Write the bracketed paste WITHOUT a trailing Enter. Claude's Ink TUI
				// treats a carriage return fused onto the paste-end marker (… [201~\r)
				// as buffered text, not a submit — so the steer text lands but never sends.
				const plan: SteerStep[] = [{ type: "write", data: toBracketedPaste(input.text) }];
				if (input.submit) {
					// Submit the Enter as a SEPARATE write on a LATER tick. Written back-to-back
					// with the paste, the PTY coalesces both into one read, so the TUI still sees
					// the Enter fused onto the paste-end marker and swallows it.
					// For Claude, a 50ms gap is per-harness specific: it lets the paste flush and
					// paste-mode close first, so the Enter registers as a submit keypress.
					plan.push({ type: "wait", delayMs: 50 });
					plan.push({ type: "write", data: "\r" });
				}
				return supported(plan);
			},
			interrupt: async () => {
				const plan: SteerPlan = [{ type: "write", data: "\x03" }];
				return supported(plan);
			},
		},
	};
}

function catalogEntryById(agentId: "claude"): RuntimeAgentCatalogEntry {
	const entry = RUNTIME_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
	if (!entry) {
		throw new Error(`Missing catalog entry for ${agentId}`);
	}
	return entry;
}

// --- Locating --------------------------------------------------------------

type AgentTranscriptLocation = { readonly present: true; readonly path: string } | { readonly present: false };

async function locate(sessionId: string, homePath: string): Promise<AgentTranscriptLocation> {
	const projectsRoot = join(homePath, ".claude", "projects");
	const projectDirs = await readDirEntries(projectsRoot);
	const transcriptName = `${sessionId}.jsonl`;

	for (const entry of projectDirs) {
		if (!entry.isDirectory()) {
			continue;
		}
		const candidate = join(projectsRoot, entry.name, transcriptName);
		if (await isFile(candidate)) {
			return { present: true, path: candidate };
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

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

// --- Parsing ---------------------------------------------------------------

/** The full conversation — the on-demand path, taken when a card is opened. */
const CLAUDE_TRANSCRIPT: TranscriptDerivation<RuntimeTaskChatMessage[]> = {
	id: "claude-transcript",
	derive: (records) => parseClaudeTranscript([...records]),
};

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

/**
 * Claude reports per-message usage, never a running total, so the session's
 * cumulative figure is a genuine sum over history — it cannot be read from the
 * tail. It is expressed as a fold instead: the shared transcript source keeps the
 * accumulator behind a byte-offset cursor, so history is summed once per file and
 * every later observation folds only the records appended since.
 */
interface ClaudeUsageTotals {
	readonly seen: Set<string>;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	counted: number;
	modelId: string | null;
}

const CLAUDE_USAGE: TranscriptFold<ClaudeUsageTotals, RuntimeTaskTokenUsage | null> = {
	id: "claude-usage",
	seed: () => ({
		seen: new Set<string>(),
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		counted: 0,
		modelId: null,
	}),
	step: (totals, record) => addClaudeUsageRecord(totals, record),
	finish: (totals) => {
		if (totals.counted === 0) {
			return null;
		}
		const sums = {
			inputTokens: totals.inputTokens,
			outputTokens: totals.outputTokens,
			cacheReadTokens: totals.cacheReadTokens,
			cacheCreationTokens: totals.cacheCreationTokens,
		};
		return { ...sums, costUsd: estimateClaudeCostUsd(sums, totals.modelId) };
	},
};

/**
 * Add one record's usage to the running totals, ignoring anything that is not a
 * billable assistant turn. Retries re-log the same message, so a message is
 * counted once per `(message id, request id)` pair.
 */
function addClaudeUsageRecord(totals: ClaudeUsageTotals, record: TranscriptRecord): ClaudeUsageTotals {
	if (readString(record, "type") !== "assistant" || record.isSidechain === true || record.isMeta === true) {
		return totals;
	}
	const message = asRecord(record.message);
	const usage = message ? asRecord(message.usage) : null;
	if (!message || !usage) {
		return totals;
	}

	const dedupeKey = `${readString(message, "id") ?? ""} ${readString(record, "requestId") ?? ""}`;
	if (totals.seen.has(dedupeKey)) {
		return totals;
	}
	totals.seen.add(dedupeKey);

	totals.inputTokens += readNumber(usage, "input_tokens");
	totals.outputTokens += readNumber(usage, "output_tokens");
	totals.cacheReadTokens += readNumber(usage, "cache_read_input_tokens");
	totals.cacheCreationTokens += readNumber(usage, "cache_creation_input_tokens");
	totals.modelId = readString(message, "model") ?? totals.modelId;
	totals.counted += 1;
	return totals;
}

/** The same sum as {@link CLAUDE_USAGE}, over records already in hand. */
export function deriveClaudeUsage(records: Record<string, unknown>[]): RuntimeTaskTokenUsage | null {
	return CLAUDE_USAGE.finish(records.reduce(addClaudeUsageRecord, CLAUDE_USAGE.seed()));
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

export { CLAUDE_SKILLS_RELATIVE_PATH, isClaudeTranscriptPath } from "./paths";
