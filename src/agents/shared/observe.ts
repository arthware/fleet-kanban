/**
 * The single owner of agent-transcript file access.
 *
 * Transcripts are append-only JSONL that grow for the whole life of a session —
 * routinely tens of megabytes. Anything the board does on a poll must therefore
 * cost work proportional to the bytes *appended* since the last observation, and
 * to nothing else. A driver that reads its transcript from byte zero saturates
 * the event loop, and the board stops serving HTTP while still holding its
 * listening socket: alive to every liveness check, dead to its operator.
 *
 * So no driver reads a transcript path itself. All three read through here, and
 * the shape of the derivation picks the access path:
 *
 * - `selectFromTranscriptTail` — "latest value wins" derivations. Scans backwards
 *   from the end within a bounded budget. O(1) in file size, even on a cold cache.
 * - `foldTranscript` — cumulative derivations that genuinely need history. Keeps a
 *   byte-offset cursor and an accumulator, so history is parsed once per file and
 *   every later observation parses only what was appended.
 * - `deriveFromTranscript` — the on-demand full read (opening a card's
 *   conversation). Cached on file identity, so repeat views are free.
 *
 * Every read is accounted in `getTranscriptReadCost()`. That exists so tests can
 * assert what an observation *cost*, not only what it returned — a correctness-only
 * test passes cleanly against whole-file re-parsing, which is why this defect
 * survived five separate fixes.
 */
import { open, stat } from "node:fs/promises";

export type TranscriptRecord = Record<string, unknown>;

/** How far back a tail scan reads per step. */
const TAIL_WINDOW_BYTES = 64 * 1024;
/** Hard ceiling on a backwards scan: a derivation not found within this gives up. */
const MAX_TAIL_SCAN_BYTES = 256 * 1024;
/** Enough to hold the first record of any harness. */
const HEAD_WINDOW_BYTES = 64 * 1024;
/** Derived conversations are large; only the most recently opened cards stay cached. */
const MAX_CACHED_DERIVATIONS = 4;
/** Cursors are small, but a long-lived board sees many sessions. */
const MAX_CACHED_FOLDS = 64;

const NEWLINE = 0x0a;
/** `subarray` widens a Buffer's backing store, so byte slices carry the wider type. */
type Bytes = Buffer<ArrayBufferLike>;
const EMPTY: Bytes = Buffer.alloc(0);

// --- Cost accounting -------------------------------------------------------

export interface TranscriptReadCost {
	readonly statCalls: number;
	readonly fileReads: number;
	readonly bytesRead: number;
	readonly recordsParsed: number;
}

const cost = { statCalls: 0, fileReads: 0, bytesRead: 0, recordsParsed: 0 };

export function getTranscriptReadCost(): TranscriptReadCost {
	return { ...cost };
}

export function resetTranscriptReadCost(): void {
	cost.statCalls = 0;
	cost.fileReads = 0;
	cost.bytesRead = 0;
	cost.recordsParsed = 0;
}

/** Drop every cursor and cached derivation. For tests and hard resets. */
export function forgetTranscripts(): void {
	tailCache.clear();
	foldCursors.clear();
	derivations.clear();
}

// --- File identity ---------------------------------------------------------

interface FileIdentity {
	readonly size: number;
	readonly mtimeMs: number;
	readonly inode: number;
}

async function identify(path: string): Promise<FileIdentity | null> {
	cost.statCalls += 1;
	try {
		const stats = await stat(path);
		return { size: stats.size, mtimeMs: stats.mtimeMs, inode: stats.ino };
	} catch {
		return null;
	}
}

function sameFileVersion(left: FileIdentity, right: FileIdentity): boolean {
	return left.size === right.size && left.mtimeMs === right.mtimeMs && left.inode === right.inode;
}

/**
 * A transcript is normally appended to, but a restarted or rotated session
 * replaces it. Anything other than "same file, grown or unchanged" forces a
 * re-read from byte zero rather than resuming a stale cursor.
 */
function wasReplaced(previous: FileIdentity, current: FileIdentity, consumedBytes: number): boolean {
	if (previous.inode !== current.inode) {
		return true;
	}
	if (current.size < consumedBytes) {
		return true;
	}
	return current.size === consumedBytes && current.mtimeMs !== previous.mtimeMs;
}

// --- Reading ---------------------------------------------------------------

async function readRange(path: string, start: number, end: number): Promise<Bytes> {
	const length = end - start;
	if (length <= 0) {
		return EMPTY;
	}
	const buffer = Buffer.allocUnsafe(length);
	const handle = await open(path, "r");
	try {
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		cost.fileReads += 1;
		cost.bytesRead += bytesRead;
		return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

export function parseJsonlRecords(raw: string): TranscriptRecord[] {
	const records: TranscriptRecord[] = [];
	for (const line of raw.split("\n")) {
		const record = parseJsonlLine(line);
		if (record) {
			records.push(record);
		}
	}
	return records;
}

function parseJsonlLine(line: string): TranscriptRecord | null {
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}
	cost.recordsParsed += 1;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isRecord(parsed) ? parsed : null;
	} catch {
		// Tolerate a partially-flushed / corrupt line.
		return null;
	}
}

function isRecord(value: unknown): value is TranscriptRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- Bounded caches --------------------------------------------------------

function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > limit) {
		const oldest = cache.keys().next();
		if (oldest.done) {
			return;
		}
		cache.delete(oldest.value);
	}
}

function cacheKey(path: string, id: string): string {
	return `${path}\0${id}`;
}

// --- Path A: the tail ------------------------------------------------------

export interface TranscriptTailQuery<T> {
	/** Stable identifier for this derivation, so its cached answer is not shared. */
	readonly id: string;
	/** Return the derived value for a record, or `null` to keep scanning backwards. */
	select(record: TranscriptRecord): T | null;
}

interface TailCacheEntry {
	readonly identity: FileIdentity;
	readonly value: unknown;
}

const tailCache = new Map<string, TailCacheEntry>();

/**
 * The newest record satisfying `query`, found by scanning backwards from the end
 * of the transcript. Bounded by `MAX_TAIL_SCAN_BYTES`, so cost never grows with
 * the session's history. Returns `null` when nothing matches within that budget —
 * callers keep their previously known value rather than showing a wrong one.
 */
export async function selectFromTranscriptTail<T>(path: string, query: TranscriptTailQuery<T>): Promise<T | null> {
	const identity = await identify(path);
	if (!identity) {
		return null;
	}

	const key = cacheKey(path, query.id);
	const cached = tailCache.get(key);
	if (cached && sameFileVersion(cached.identity, identity)) {
		return cached.value as T | null;
	}

	let value: T | null = null;
	let windowEnd = identity.size;
	let scanned = 0;
	// A window boundary can split a record, so each step re-reads from a line
	// boundary; `carry` holds the bytes belonging to the record that straddles it.
	let carry: Bytes = EMPTY;

	while (windowEnd > 0 && scanned < MAX_TAIL_SCAN_BYTES && value === null) {
		const windowStart = Math.max(0, windowEnd - TAIL_WINDOW_BYTES);
		const chunk = await readRange(path, windowStart, windowEnd);
		scanned += chunk.length;
		const buffer = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;

		// Everything before the first newline may be half a record from further
		// back — unless we reached the start of the file, where it is complete.
		const firstNewline = buffer.indexOf(NEWLINE);
		const atFileStart = windowStart === 0;
		const completeFrom = atFileStart || firstNewline === -1 ? 0 : firstNewline + 1;
		carry = atFileStart ? EMPTY : buffer.subarray(0, completeFrom);

		value = selectFromLinesBackwards(buffer.subarray(completeFrom).toString("utf8"), query);
		windowEnd = windowStart;
	}

	remember(tailCache, key, { identity, value }, MAX_CACHED_FOLDS);
	return value;
}

function selectFromLinesBackwards<T>(text: string, query: TranscriptTailQuery<T>): T | null {
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const record = parseJsonlLine(lines[index]);
		if (!record) {
			continue;
		}
		const selected = query.select(record);
		if (selected !== null) {
			return selected;
		}
	}
	return null;
}

/** The first record of a transcript, read from a bounded head rather than the whole file. */
export async function readFirstTranscriptRecord(path: string): Promise<TranscriptRecord | null> {
	const identity = await identify(path);
	if (!identity) {
		return null;
	}
	const chunk = await readRange(path, 0, Math.min(identity.size, HEAD_WINDOW_BYTES));
	for (const line of chunk.toString("utf8").split("\n")) {
		const record = parseJsonlLine(line);
		if (record) {
			return record;
		}
	}
	return null;
}

// --- Cumulative: the byte-offset cursor ------------------------------------

export interface TranscriptFold<TAccumulator, TResult> {
	/** Stable identifier for this derivation, so its cursor is not shared. */
	readonly id: string;
	seed(): TAccumulator;
	step(accumulator: TAccumulator, record: TranscriptRecord): TAccumulator;
	finish(accumulator: TAccumulator): TResult;
}

interface FoldCursor {
	identity: FileIdentity;
	/** Bytes already handed to the fold, including any incomplete trailing line. */
	consumed: number;
	/** The trailing bytes that did not yet form a complete line. */
	pending: Bytes;
	accumulator: unknown;
}

const foldCursors = new Map<string, FoldCursor>();

/**
 * Fold every record of a transcript, parsing only what was appended since the
 * last call. History is read once per file; a session that has been running for
 * hours costs the same per observation as one that just started.
 */
export async function foldTranscript<TAccumulator, TResult>(
	path: string,
	fold: TranscriptFold<TAccumulator, TResult>,
): Promise<TResult> {
	const identity = await identify(path);
	if (!identity) {
		return fold.finish(fold.seed());
	}

	const key = cacheKey(path, fold.id);
	let cursor = foldCursors.get(key);
	if (!cursor || wasReplaced(cursor.identity, identity, cursor.consumed)) {
		cursor = { identity, consumed: 0, pending: EMPTY, accumulator: fold.seed() };
	}

	if (identity.size > cursor.consumed) {
		const chunk = await readRange(path, cursor.consumed, identity.size);
		cursor.consumed += chunk.length;
		const buffer = cursor.pending.length > 0 ? Buffer.concat([cursor.pending, chunk]) : chunk;
		const lastNewline = buffer.lastIndexOf(NEWLINE);
		if (lastNewline === -1) {
			cursor.pending = buffer;
		} else {
			cursor.pending = buffer.subarray(lastNewline + 1);
			let accumulator = cursor.accumulator as TAccumulator;
			for (const record of parseJsonlRecords(buffer.subarray(0, lastNewline).toString("utf8"))) {
				accumulator = fold.step(accumulator, record);
			}
			cursor.accumulator = accumulator;
		}
	}

	cursor.identity = identity;
	remember(foldCursors, key, cursor, MAX_CACHED_FOLDS);
	return fold.finish(cursor.accumulator as TAccumulator);
}

// --- Path B: the on-demand full read ---------------------------------------

export interface TranscriptDerivation<T> {
	/** Stable identifier for this derivation, so its cached answer is not shared. */
	readonly id: string;
	derive(records: readonly TranscriptRecord[]): T;
}

interface DerivationCacheEntry {
	readonly identity: FileIdentity;
	readonly value: unknown;
}

const derivations = new Map<string, DerivationCacheEntry>();

/**
 * Derive a value from the complete transcript. This is the expensive path and it
 * belongs off the poll: call it when a card's conversation is actually requested.
 * The result is cached on file identity, so re-opening the same card is free.
 */
export async function deriveFromTranscript<T>(path: string, derivation: TranscriptDerivation<T>): Promise<T> {
	const identity = await identify(path);
	if (!identity) {
		return derivation.derive([]);
	}

	const key = cacheKey(path, derivation.id);
	const cached = derivations.get(key);
	if (cached && sameFileVersion(cached.identity, identity)) {
		return cached.value as T;
	}

	const chunk = await readRange(path, 0, identity.size);
	const value = derivation.derive(parseJsonlRecords(chunk.toString("utf8")));
	remember(derivations, key, { identity, value }, MAX_CACHED_DERIVATIONS);
	return value;
}

// --- Struggle/Thrashing detection fold ------------------------------------

export interface StruggleAnalysis {
	readonly struggling: boolean;
	readonly reasons: readonly string[];
	readonly repeatsCount: number;
	readonly failureRate: number;
	readonly maxEditChurn: number;
	readonly details: {
		readonly repeatingTool?: string;
		readonly churningFile?: string;
		readonly failureCount?: string;
	};
}

export interface StruggleAccumulator {
	readonly recentCalls: Array<{
		readonly name: string;
		readonly inputStr: string;
		readonly fileEdited: string | null;
		failed: boolean;
	}>;
	consecutiveRepeats: number;
	lastCallKey: string | null;
	lastCallName: string | null;
}

interface ToolCallInfo {
	readonly name: string;
	readonly input: unknown;
}

function extractToolCalls(record: TranscriptRecord): ToolCallInfo[] {
	const calls: ToolCallInfo[] = [];

	// Claude format: assistant with message.content array
	if (record.type === "assistant" && record.message && typeof record.message === "object") {
		const message = record.message as Record<string, unknown>;
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block && typeof block === "object") {
					const b = block as Record<string, unknown>;
					if (b.type === "tool_use" && typeof b.name === "string") {
						calls.push({ name: b.name, input: b.input });
					}
				}
			}
		}
	}

	// Codex format: response_item with payload
	if (record.type === "response_item" && record.payload && typeof record.payload === "object") {
		const payload = record.payload as Record<string, unknown>;
		if (
			(payload.type === "function_call" || payload.type === "custom_tool_call") &&
			typeof payload.name === "string"
		) {
			calls.push({ name: payload.name, input: payload.arguments ?? payload.input });
		}
	}

	return calls;
}

function isEditTool(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower.includes("write") ||
		lower.includes("edit") ||
		lower.includes("replace") ||
		lower.includes("patch") ||
		lower.includes("pencil") ||
		lower.includes("insert") ||
		lower.includes("update") ||
		lower.includes("delete") ||
		lower.includes("design")
	);
}

function extractEditedFilePath(call: ToolCallInfo): string | null {
	if (!isEditTool(call.name)) {
		return null;
	}
	if (call.input && typeof call.input === "object") {
		const inp = call.input as Record<string, unknown>;
		if (typeof inp.file_path === "string") return inp.file_path;
		if (typeof inp.filePath === "string") return inp.filePath;
		if (typeof inp.path === "string") return inp.path;
		if (typeof inp.target === "string") return inp.target;
		if (typeof inp.dest === "string") return inp.dest;
	}
	return "unknown";
}

function extractToolResultText(record: TranscriptRecord): string | null {
	// Claude format
	if (record.type === "user" && record.message && typeof record.message === "object") {
		const message = record.message as Record<string, unknown>;
		if (Array.isArray(message.content)) {
			const parts: string[] = [];
			for (const block of message.content) {
				if (block && typeof block === "object") {
					const b = block as Record<string, unknown>;
					if (b.type === "tool_result") {
						if (typeof b.content === "string") {
							parts.push(b.content);
						} else if (Array.isArray(b.content)) {
							for (const sub of b.content) {
								if (sub && typeof sub === "object") {
									const s = sub as Record<string, unknown>;
									if (s.type === "text" && typeof s.text === "string") {
										parts.push(s.text);
									}
								}
							}
						}
					}
				}
			}
			if (parts.length > 0) {
				return parts.join("\n");
			}
		}
	}

	// Codex format
	if (record.type === "response_item" && record.payload && typeof record.payload === "object") {
		const payload = record.payload as Record<string, unknown>;
		if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
			const output = payload.output;
			if (typeof output === "string") {
				return output;
			}
			if (output && typeof output === "object") {
				const outRec = output as Record<string, unknown>;
				if (typeof outRec.content === "string") {
					return outRec.content;
				}
			}
		}
	}

	return null;
}

function isToolFailure(text: string): boolean {
	const lower = text.toLowerCase();
	if (
		lower.includes("error:") ||
		lower.includes("failed:") ||
		lower.includes("exception:") ||
		lower.includes("exit code:") ||
		lower.includes("command failed")
	) {
		return true;
	}
	if (lower.includes("fail") && (lower.includes("tests") || lower.includes("spec"))) {
		return true;
	}
	return false;
}

export const STRUGGLE_DETECTOR: TranscriptFold<StruggleAccumulator, StruggleAnalysis> = {
	id: "struggle-detector",
	seed: () => ({
		recentCalls: [],
		consecutiveRepeats: 0,
		lastCallKey: null,
		lastCallName: null,
	}),
	step: (acc, record) => {
		const calls = extractToolCalls(record);
		for (const call of calls) {
			const inputStr = JSON.stringify(call.input);
			const fileEdited = extractEditedFilePath(call);
			const key = `${call.name}:${inputStr}`;

			if (acc.lastCallKey === key) {
				acc.consecutiveRepeats += 1;
			} else {
				acc.consecutiveRepeats = 0;
			}
			acc.lastCallKey = key;
			acc.lastCallName = call.name;

			acc.recentCalls.push({
				name: call.name,
				inputStr,
				fileEdited,
				failed: false,
			});

			if (acc.recentCalls.length > 15) {
				acc.recentCalls.shift();
			}
		}

		const resultText = extractToolResultText(record);
		if (resultText !== null && acc.recentCalls.length > 0) {
			const lastCall = acc.recentCalls[acc.recentCalls.length - 1];
			if (isToolFailure(resultText)) {
				lastCall.failed = true;
			}
		}

		return acc;
	},
	finish: (acc) => {
		const reasons: string[] = [];
		const details: Record<string, string> = {};

		if (acc.consecutiveRepeats >= 3 && acc.lastCallName) {
			reasons.push(`Tool ${acc.lastCallName} was invoked with identical arguments 4 times consecutively`);
			details.repeatingTool = acc.lastCallName;
		}

		const callCounts = new Map<string, number>();
		for (const call of acc.recentCalls) {
			const key = `${call.name}:${call.inputStr}`;
			callCounts.set(key, (callCounts.get(key) || 0) + 1);
		}
		for (const [key, count] of callCounts.entries()) {
			if (count >= 4) {
				const toolName = key.split(":")[0];
				reasons.push(`Tool ${toolName} was repeated with identical arguments ${count} times recently`);
				details.repeatingTool = toolName;
			}
		}

		const editCounts = new Map<string, number>();
		for (const call of acc.recentCalls) {
			if (call.fileEdited) {
				editCounts.set(call.fileEdited, (editCounts.get(call.fileEdited) || 0) + 1);
			}
		}
		for (const [file, count] of editCounts.entries()) {
			if (count >= 5) {
				reasons.push(`File ${file} was edited ${count} times recently without resolution`);
				details.churningFile = file;
			}
		}

		const totalCalls = acc.recentCalls.length;
		const failedCalls = acc.recentCalls.filter((c) => c.failed).length;
		const failureRate = totalCalls >= 5 ? failedCalls / totalCalls : 0;
		if (failureRate >= 0.7) {
			reasons.push(
				`High recent tool failure rate of ${(failureRate * 100).toFixed(0)}% (${failedCalls}/${totalCalls} failed)`,
			);
			details.failureCount = `${failedCalls}/${totalCalls}`;
		}

		const struggling = reasons.length > 0;

		return {
			struggling,
			reasons,
			repeatsCount: acc.consecutiveRepeats,
			failureRate,
			maxEditChurn: Math.max(0, ...editCounts.values()),
			details,
		};
	},
};

export async function detectStruggle(path: string): Promise<StruggleAnalysis> {
	return foldTranscript(path, STRUGGLE_DETECTOR);
}
