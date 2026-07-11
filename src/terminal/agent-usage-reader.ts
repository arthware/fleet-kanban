import { readFile } from "node:fs/promises";

import type { ClineSdkAccumulatedUsage } from "../cline-sdk/sdk-runtime-boundary";
import type { RuntimeAgentId, RuntimeTaskTokenUsage } from "../core/api-contract";
import { locateAgentTranscript } from "./agent-transcript-locator";

/**
 * Derives one cumulative token-usage total per card from the agent CLI's own
 * on-disk transcript — the same "observe, don't re-track" path
 * `agent-transcript-reader.ts` uses to rebuild the conversation, but summing
 * `usage` records instead of rendering messages. Kept a SIBLING of the message
 * reader so the transcript-tail path never pays for a usage pass it doesn't need
 * (and vice-versa).
 *
 * Claude and Codex derive from their transcripts here. Cline reports usage
 * through its SDK rather than a transcript file, so it is handled separately
 * (see `mapClineUsage` and the dispatch note in `readAgentUsage`).
 */
export interface ReadAgentUsageInput {
	/** Which agent CLI produced the session. Unknown kinds resolve to absent. */
	readonly agentId: RuntimeAgentId | string;
	/** The agent CLI's own session id (claude session UUID / codex rollout id). */
	readonly sessionId: string;
	/** The host `$HOME` under which the CLI writes its transcripts. */
	readonly homePath: string;
}

export interface AgentUsageResult {
	/** True when a transcript file was located and read (even if it held no usage). */
	readonly present: boolean;
	/** The normalized cumulative usage, or `null` when present but no usage records. */
	readonly usage: RuntimeTaskTokenUsage | null;
}

const ABSENT: AgentUsageResult = { present: false, usage: null };

/**
 * The transcript-derived agents: each maps its own CLI's JSONL records into the
 * normalized usage shape. Agents absent from this table (notably Cline, whose
 * usage is SDK-reported) don't touch disk here.
 */
const TRANSCRIPT_USAGE_DERIVERS: Record<string, (records: Record<string, unknown>[]) => RuntimeTaskTokenUsage | null> =
	{
		claude: deriveClaudeUsage,
		codex: deriveCodexUsage,
	};

/**
 * Locate and total the token usage for an agent session. Pure over the
 * filesystem: any I/O error (missing file, permission, unreadable) collapses to
 * `{ present: false, usage: null }` so callers get a single total signal — the
 * same contract as `readAgentTranscript`, never a throw.
 */
export async function readAgentUsage(input: ReadAgentUsageInput): Promise<AgentUsageResult> {
	const derive = TRANSCRIPT_USAGE_DERIVERS[input.agentId];
	if (!derive) {
		// Cline's usage is SDK-reported (`ClineCore.getAccumulatedUsage`), not a
		// transcript we parse — and this derive-on-read path holds no live
		// `ClineCore` handle to call, while the persisted session record on disk
		// carries only `totalCost`, not the token breakdown. So Cline (and any
		// agent without a known transcript layout) reports absent here; Cline
		// usage lands once a live handle is reachable, mapped through
		// `mapClineUsage`. Bail before touching disk.
		return ABSENT;
	}

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

	const usage = derive(parseJsonlRecords(raw));
	return { present: true, usage };
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

/**
 * Sum Claude Code's per-request `message.usage` across every assistant record.
 *
 * Each assistant record's `usage` describes its own API request — the four token
 * fields are counted independently and do NOT accumulate across requests, so we
 * add them up ourselves. Claude Code can write the same assistant turn more than
 * once (streaming retries, resumed sessions), so each contribution is DEDUPED by
 * `message.id` + `requestId` (ccusage's key) and counted once. Sidechain/meta
 * bookkeeping records and records without a `message.usage` block are skipped.
 *
 * Returns `null` when no usage-bearing record was found (a fresh/empty session).
 * `costUsd` is always `null` here — pricing lands in a later card.
 */
export function deriveClaudeUsage(records: Record<string, unknown>[]): RuntimeTaskTokenUsage | null {
	const seen = new Set<string>();
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheCreationTokens = 0;
	let counted = 0;

	for (const record of records) {
		if (readString(record, "type") !== "assistant" || record.isSidechain === true || record.isMeta === true) {
			continue;
		}
		const message = asRecord(record.message);
		const usage = message ? asRecord(message.usage) : null;
		if (!message || !usage) {
			continue;
		}

		const dedupeKey = `${readString(message, "id") ?? ""} ${readString(record, "requestId") ?? ""}`;
		if (seen.has(dedupeKey)) {
			continue;
		}
		seen.add(dedupeKey);

		inputTokens += readNumber(usage, "input_tokens");
		outputTokens += readNumber(usage, "output_tokens");
		cacheReadTokens += readNumber(usage, "cache_read_input_tokens");
		cacheCreationTokens += readNumber(usage, "cache_creation_input_tokens");
		counted += 1;
	}

	if (counted === 0) {
		return null;
	}
	return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd: null };
}

/**
 * Derive Codex usage from its rollout JSONL. Codex emits `event_msg` records
 * with `payload.type:"token_count"`, whose `info.total_token_usage` is a running
 * CUMULATIVE total for the session — so we take the LAST such record (summing
 * would multiply-count the same tokens).
 *
 * Mapping differs from Claude in two ways: Codex's `input_tokens` INCLUDES
 * `cached_input_tokens`, so uncached input is the difference; and OpenAI-style
 * caching bills no separate cache-write, so `cacheCreationTokens` is always 0.
 * `output_tokens` already includes reasoning tokens. Returns `null` for a
 * rollout that predates `token_count` reporting. `costUsd` is `null` (pricing
 * lands in a later card).
 */
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

/**
 * Map Cline's SDK-reported `SessionAccumulatedUsage` into the normalized shape.
 * A straight pass-through — the only renames are `cacheWriteTokens →
 * cacheCreationTokens` (same meaning) and `totalCost → costUsd`. Cline computes
 * cost itself, so unlike the transcript agents it fills `costUsd` without the
 * price table.
 *
 * Wired into `readAgentUsage` once a live `ClineCore` handle is reachable on the
 * derive-on-read path; kept here as the ready, SDK-typed mapping so that wiring
 * is a one-line call, not a re-derivation.
 */
export function mapClineUsage(usage: ClineSdkAccumulatedUsage): RuntimeTaskTokenUsage {
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheCreationTokens: usage.cacheWriteTokens,
		costUsd: usage.totalCost,
	};
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
