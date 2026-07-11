import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveClaudeUsage, readAgentUsage } from "../../../src/terminal/agent-usage-reader";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-usage-transcript.jsonl");

/** Parse a JSONL blob the same way the reader does, so tests feed it real records. */
function parseJsonl(raw: string): Record<string, unknown>[] {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function loadFixtureRecords(): Promise<Record<string, unknown>[]> {
	return parseJsonl(await readFile(fixturePath, "utf8"));
}

describe("deriveClaudeUsage", () => {
	// The fixture holds three real, distinct assistant records captured from a
	// live Claude Code transcript. These totals are the per-field sums of those
	// records — asserting them proves we read the real field names, not a
	// hand-fabricated shape.
	const FIXTURE_TOTALS = {
		inputTokens: 11106 + 367 + 129,
		outputTokens: 1398 + 345 + 209,
		cacheReadTokens: 18664 + 18492 + 46422,
		cacheCreationTokens: 14697 + 27930 + 710,
	};

	it("sums each usage field across every assistant record, leaving cost unpriced", async () => {
		const usage = deriveClaudeUsage(await loadFixtureRecords());

		expect(usage).toEqual({ ...FIXTURE_TOTALS, costUsd: null });
	});

	it("counts a resent assistant record once, keyed by message id and request id", async () => {
		const records = await loadFixtureRecords();
		// A streaming retry / resumed session re-writes the same assistant turn:
		// same message.id + requestId. It must not be double-counted.
		const duplicate = structuredClone(records[0]);

		const usage = deriveClaudeUsage([...records, duplicate]);

		expect(usage).toEqual({ ...FIXTURE_TOTALS, costUsd: null });
	});

	it("counts records that share a message id but differ in request id", async () => {
		const records = await loadFixtureRecords();
		const first = records[0] as { requestId: string; message: { usage: { input_tokens: number } } };
		const distinctRequest = structuredClone(records[0]) as typeof first;
		distinctRequest.requestId = "req_distinct";

		const usage = deriveClaudeUsage([...records, distinctRequest]);

		// The extra request adds its own input tokens on top of the fixture total.
		expect(usage?.inputTokens).toBe(FIXTURE_TOTALS.inputTokens + first.message.usage.input_tokens);
	});

	it("ignores assistant records that carry no usage block", async () => {
		const records = await loadFixtureRecords();
		const withoutUsage = {
			type: "assistant",
			requestId: "req_no_usage",
			message: { id: "msg_no_usage", role: "assistant", content: [{ type: "text", text: "hi" }] },
		};

		const usage = deriveClaudeUsage([...records, withoutUsage]);

		expect(usage).toEqual({ ...FIXTURE_TOTALS, costUsd: null });
	});

	it("ignores sidechain and meta records so only the main agent's turns count", async () => {
		const records = await loadFixtureRecords();
		const template = records[0] as { message: { usage: unknown } };
		const sidechain = {
			type: "assistant",
			isSidechain: true,
			requestId: "req_sidechain",
			message: { id: "msg_sidechain", role: "assistant", usage: template.message.usage },
		};
		const meta = {
			type: "assistant",
			isMeta: true,
			requestId: "req_meta",
			message: { id: "msg_meta", role: "assistant", usage: template.message.usage },
		};

		const usage = deriveClaudeUsage([...records, sidechain, meta]);

		expect(usage).toEqual({ ...FIXTURE_TOTALS, costUsd: null });
	});

	it("returns null when the transcript has no usage-bearing records", () => {
		expect(deriveClaudeUsage([])).toBeNull();
		expect(deriveClaudeUsage([{ type: "user", message: { role: "user", content: "hi" } }])).toBeNull();
	});
});

describe("readAgentUsage — claude", () => {
	let homePath = "";

	beforeEach(async () => {
		homePath = await mkdtemp(join(tmpdir(), "usage-reader-"));
	});

	afterEach(async () => {
		await rm(homePath, { recursive: true, force: true });
	});

	async function writeTranscript(sessionId: string, records: unknown[]): Promise<void> {
		const absolutePath = join(homePath, ".claude", "projects", "-Users-dev-repo", `${sessionId}.jsonl`);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	}

	it("locates the transcript and returns the summed usage", async () => {
		const sessionId = "claude-usage-1";
		await writeTranscript(sessionId, await loadFixtureRecords());

		const result = await readAgentUsage({ agentId: "claude", sessionId, homePath });

		expect(result.present).toBe(true);
		expect(result.usage).toEqual({
			inputTokens: 11106 + 367 + 129,
			outputTokens: 1398 + 345 + 209,
			cacheReadTokens: 18664 + 18492 + 46422,
			cacheCreationTokens: 14697 + 27930 + 710,
			costUsd: null,
		});
	});

	it("reports absent with null usage when the transcript is gone", async () => {
		const result = await readAgentUsage({ agentId: "claude", sessionId: "missing", homePath });

		expect(result).toEqual({ present: false, usage: null });
	});

	it("reports present with null usage when the transcript carries no usage records", async () => {
		const sessionId = "claude-empty";
		await writeTranscript(sessionId, [{ type: "user", message: { role: "user", content: "hi" } }]);

		const result = await readAgentUsage({ agentId: "claude", sessionId, homePath });

		expect(result).toEqual({ present: true, usage: null });
	});

	it("returns absent for a non-Claude agent (other agents land in a later card)", async () => {
		const result = await readAgentUsage({ agentId: "codex", sessionId: "whatever", homePath });

		expect(result).toEqual({ present: false, usage: null });
	});
});
