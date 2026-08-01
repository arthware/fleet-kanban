import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	deriveFromTranscript,
	foldTranscript,
	forgetTranscripts,
	getTranscriptReadCost,
	readFirstTranscriptRecord,
	resetTranscriptReadCost,
	STRUGGLE_DETECTOR,
	selectFromTranscriptTail,
	type TranscriptRecord,
} from "../../../src/agents/shared/observe";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "transcript-source-"));
	forgetTranscripts();
	resetTranscriptReadCost();
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** One JSONL line, padded so a transcript of a given byte size is cheap to build. */
function line(index: number, padBytes = 0): string {
	return `${JSON.stringify({ type: "turn", index, pad: "x".repeat(padBytes) })}\n`;
}

/** Write a transcript of roughly `targetBytes`, returning its path and line count. */
function writeTranscript(name: string, targetBytes: number): { path: string; lines: number } {
	const path = join(home, name);
	const sample = line(0, 512);
	const lines = Math.max(2, Math.ceil(targetBytes / sample.length));
	let buffer = "";
	for (let index = 0; index < lines; index += 1) {
		buffer += line(index, 512);
	}
	writeFileSync(path, buffer, "utf8");
	return { path, lines };
}

const LATEST_TURN = {
	id: "latest-turn",
	select: (record: TranscriptRecord) => (record.type === "turn" ? Number(record.index) : null),
};

const SUM_OF_INDEXES = {
	id: "sum-of-indexes",
	seed: () => ({ total: 0, counted: 0 }),
	step: (accumulator: { total: number; counted: number }, record: TranscriptRecord) =>
		record.type === "turn"
			? { total: accumulator.total + Number(record.index), counted: accumulator.counted + 1 }
			: accumulator,
	finish: (accumulator: { total: number; counted: number }) => accumulator,
};

describe("transcript tail — the liveness path", () => {
	it("given a 20 MB transcript and a 256 KB transcript, when each is polled for its latest record, then both cost the same bounded work", async () => {
		const large = writeTranscript("large.jsonl", 20 * 1024 * 1024);
		const small = writeTranscript("small.jsonl", 256 * 1024);

		resetTranscriptReadCost();
		await selectFromTranscriptTail(large.path, LATEST_TURN);
		const largeCost = getTranscriptReadCost();
		resetTranscriptReadCost();
		await selectFromTranscriptTail(small.path, LATEST_TURN);
		const smallCost = getTranscriptReadCost();

		expect(largeCost.bytesRead).toBe(smallCost.bytesRead);
		expect(largeCost.recordsParsed).toBe(smallCost.recordsParsed);
		expect(largeCost.bytesRead).toBeLessThan(128 * 1024);
	});

	it("given a 20 MB transcript, when polled for its latest record, then it returns the last record", async () => {
		const large = writeTranscript("large.jsonl", 20 * 1024 * 1024);

		const latest = await selectFromTranscriptTail(large.path, LATEST_TURN);

		expect(latest).toBe(large.lines - 1);
	});

	it("given an unchanged transcript, when polled a second time, then it costs a stat and no read", async () => {
		const { path } = writeTranscript("stable.jsonl", 64 * 1024);
		await selectFromTranscriptTail(path, LATEST_TURN);

		resetTranscriptReadCost();
		await selectFromTranscriptTail(path, LATEST_TURN);
		const cost = getTranscriptReadCost();

		expect(cost.statCalls).toBe(1);
		expect(cost.fileReads).toBe(0);
		expect(cost.bytesRead).toBe(0);
	});

	it("given a transcript whose final line is still being flushed, when polled, then it returns the last complete record", async () => {
		const path = join(home, "partial.jsonl");
		writeFileSync(path, `${line(1)}${line(2)}${JSON.stringify({ type: "turn", index: 3 }).slice(0, 12)}`, "utf8");

		const latest = await selectFromTranscriptTail(path, LATEST_TURN);

		expect(latest).toBe(2);
	});

	it("given a transcript replaced by a shorter session, when polled again, then it reports the new session's last record", async () => {
		const path = join(home, "rotated.jsonl");
		writeFileSync(path, `${line(1)}${line(2)}${line(3)}`, "utf8");
		await selectFromTranscriptTail(path, LATEST_TURN);

		writeFileSync(path, line(9), "utf8");
		const latest = await selectFromTranscriptTail(path, LATEST_TURN);

		expect(latest).toBe(9);
	});

	it("given a missing transcript, when polled, then it reports nothing rather than throwing", async () => {
		const latest = await selectFromTranscriptTail(join(home, "absent.jsonl"), LATEST_TURN);

		expect(latest).toBeNull();
	});
});

describe("transcript fold — cumulative totals behind a byte cursor", () => {
	it("given a transcript that has grown, when folded again, then it reads only the appended bytes", async () => {
		const path = join(home, "growing.jsonl");
		writeFileSync(path, `${line(1, 4096)}${line(2, 4096)}`, "utf8");
		await foldTranscript(path, SUM_OF_INDEXES);
		const appended = line(3, 4096);
		appendFileSync(path, appended, "utf8");

		resetTranscriptReadCost();
		const totals = await foldTranscript(path, SUM_OF_INDEXES);
		const cost = getTranscriptReadCost();

		expect(totals).toEqual({ total: 6, counted: 3 });
		expect(cost.bytesRead).toBe(Buffer.byteLength(appended));
		expect(cost.recordsParsed).toBe(1);
	});

	it("given a transcript appended to across many polls, when folded each time, then the running total matches a fold over the whole file", async () => {
		const path = join(home, "incremental.jsonl");
		writeFileSync(path, line(1), "utf8");
		for (let index = 2; index <= 20; index += 1) {
			appendFileSync(path, line(index), "utf8");
			await foldTranscript(path, SUM_OF_INDEXES);
		}

		const incremental = await foldTranscript(path, SUM_OF_INDEXES);
		forgetTranscripts();
		const fromScratch = await foldTranscript(path, SUM_OF_INDEXES);

		expect(incremental).toEqual(fromScratch);
		expect(incremental).toEqual({ total: 210, counted: 20 });
	});

	it("given a poll that lands mid-write, when the line completes on the next poll, then the record is counted exactly once", async () => {
		const path = join(home, "torn.jsonl");
		const complete = line(1);
		const half = line(2).slice(0, 10);
		writeFileSync(path, `${complete}${half}`, "utf8");
		await foldTranscript(path, SUM_OF_INDEXES);

		appendFileSync(path, line(2).slice(10), "utf8");
		const totals = await foldTranscript(path, SUM_OF_INDEXES);

		expect(totals).toEqual({ total: 3, counted: 2 });
	});

	it("given a transcript truncated and rewritten, when folded again, then the accumulator restarts from the new content", async () => {
		const path = join(home, "truncated.jsonl");
		writeFileSync(path, `${line(5)}${line(6)}${line(7)}`, "utf8");
		await foldTranscript(path, SUM_OF_INDEXES);

		writeFileSync(path, line(1), "utf8");
		const totals = await foldTranscript(path, SUM_OF_INDEXES);

		expect(totals).toEqual({ total: 1, counted: 1 });
	});

	it("given a missing transcript, when folded, then it yields the seed rather than throwing", async () => {
		const totals = await foldTranscript(join(home, "absent.jsonl"), SUM_OF_INDEXES);

		expect(totals).toEqual({ total: 0, counted: 0 });
	});
});

describe("full transcript derivation — the on-demand path", () => {
	const ALL_INDEXES = {
		id: "all-indexes",
		derive: (records: readonly TranscriptRecord[]) => records.map((record) => Number(record.index)),
	};

	it("given a transcript, when derived, then it returns every record in order", async () => {
		const path = join(home, "full.jsonl");
		writeFileSync(path, `${line(1)}${line(2)}${line(3)}`, "utf8");

		const indexes = await deriveFromTranscript(path, ALL_INDEXES);

		expect(indexes).toEqual([1, 2, 3]);
	});

	it("given an unchanged transcript, when derived a second time, then the file is not re-read", async () => {
		const { path } = writeTranscript("cached.jsonl", 128 * 1024);
		await deriveFromTranscript(path, ALL_INDEXES);

		resetTranscriptReadCost();
		await deriveFromTranscript(path, ALL_INDEXES);
		const cost = getTranscriptReadCost();

		expect(cost.fileReads).toBe(0);
		expect(cost.recordsParsed).toBe(0);
	});

	it("given a transcript that grew since the last derivation, when derived again, then it sees the new records", async () => {
		const path = join(home, "changed.jsonl");
		writeFileSync(path, line(1), "utf8");
		await deriveFromTranscript(path, ALL_INDEXES);

		appendFileSync(path, line(2), "utf8");
		const indexes = await deriveFromTranscript(path, ALL_INDEXES);

		expect(indexes).toEqual([1, 2]);
	});
});

describe("transcript head", () => {
	it("given a 20 MB transcript, when its first record is read, then only a bounded head is read", async () => {
		const { path } = writeTranscript("head.jsonl", 20 * 1024 * 1024);

		resetTranscriptReadCost();
		const first = await readFirstTranscriptRecord(path);
		const cost = getTranscriptReadCost();

		expect(first?.index).toBe(0);
		expect(cost.bytesRead).toBeLessThan(128 * 1024);
	});
});

describe("struggle detector", () => {
	it("given an active session transcript, when folded again, then it reads only appended bytes", async () => {
		const path = join(home, "struggle-cost.jsonl");
		writeFileSync(path, "", "utf8");
		await foldTranscript(path, STRUGGLE_DETECTOR);

		const firstTurn = `${JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } }] },
		})}\n`;
		appendFileSync(path, firstTurn, "utf8");

		resetTranscriptReadCost();
		await foldTranscript(path, STRUGGLE_DETECTOR);
		const cost = getTranscriptReadCost();

		expect(cost.bytesRead).toBe(Buffer.byteLength(firstTurn));
		expect(cost.recordsParsed).toBe(1);
	});

	it("given a thrashing pattern, when analyzed, then it flags as struggling", async () => {
		const path = join(home, "thrashing.jsonl");

		// 4 consecutive identical tool calls
		const record = {
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						name: "replace",
						input: { file_path: "src/lib.ts", old_string: "foo", new_string: "bar" },
					},
				],
			},
		};
		const lineStr = `${JSON.stringify(record)}\n`;
		writeFileSync(path, lineStr.repeat(4), "utf8");

		const result = await foldTranscript(path, STRUGGLE_DETECTOR);
		expect(result.struggling).toBe(true);
		expect(result.reasons[0]).toContain("Tool replace was invoked with identical arguments 4 times consecutively");
	});

	it("given an edit-churn pattern, when analyzed, then it flags as struggling", async () => {
		const path = join(home, "churn.jsonl");

		// 5 edits to the same file in the sliding window
		let content = "";
		for (let i = 1; i <= 5; i++) {
			content += `${JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "tool_use", name: "replace", input: { file_path: "src/lib.ts", index: i } }] },
			})}\n`;
		}
		writeFileSync(path, content, "utf8");

		const result = await foldTranscript(path, STRUGGLE_DETECTOR);
		expect(result.struggling).toBe(true);
		expect(result.reasons[0]).toContain("File src/lib.ts was edited 5 times recently");
	});

	it("given a high-failure pattern, when analyzed, then it flags as struggling", async () => {
		const path = join(home, "failures.jsonl");

		// 5 tools, and more than 70% fail
		let content = "";
		for (let i = 1; i <= 5; i++) {
			content += `${JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "tool_use", name: "replace", input: { file_path: `src/file${i}.ts` } }] },
			})}\n`;
			content += `${JSON.stringify({
				type: "user",
				message: { content: [{ type: "tool_result", content: "Error: failed to compile" }] },
			})}\n`;
		}
		writeFileSync(path, content, "utf8");

		const result = await foldTranscript(path, STRUGGLE_DETECTOR);
		expect(result.struggling).toBe(true);
		expect(result.reasons[0]).toContain("High recent tool failure rate");
	});

	it("given a hard but productive pattern, when analyzed, then it does NOT flag as struggling", async () => {
		const path = join(home, "productive.jsonl");

		// 5 edits to DIFFERENT files, and some successful tool results
		let content = "";
		for (let i = 1; i <= 5; i++) {
			content += `${JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "tool_use", name: "replace", input: { file_path: `src/file${i}.ts` } }] },
			})}\n`;
			content += `${JSON.stringify({
				type: "user",
				message: { content: [{ type: "tool_result", content: "Success" }] },
			})}\n`;
		}
		writeFileSync(path, content, "utf8");

		const result = await foldTranscript(path, STRUGGLE_DETECTOR);
		expect(result.struggling).toBe(false);
		expect(result.reasons).toEqual([]);
	});
});
