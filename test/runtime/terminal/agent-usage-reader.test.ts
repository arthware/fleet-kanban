import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClineSdkAccumulatedUsage } from "../../../src/cline-sdk/sdk-runtime-boundary";
import {
	deriveClaudeUsage,
	deriveCodexUsage,
	mapClineUsage,
	readAgentUsage,
} from "../../../src/terminal/agent-usage-reader";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixturePath = join(fixtureDir, "claude-usage-transcript.jsonl");
const codexFixturePath = join(fixtureDir, "codex-usage-rollout.jsonl");

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

async function loadCodexFixtureRecords(): Promise<Record<string, unknown>[]> {
	return parseJsonl(await readFile(codexFixturePath, "utf8"));
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

describe("deriveCodexUsage", () => {
	// Codex's `payload.info.total_token_usage` is CUMULATIVE for the whole
	// session, so the LAST token_count record is the running total. These are the
	// exact numbers of the final real record captured in the fixture.
	const LAST_TOTAL = { input_tokens: 14540591, cached_input_tokens: 13658624, output_tokens: 37096 };

	it("takes the last cumulative token_count total rather than summing records", async () => {
		const usage = deriveCodexUsage(await loadCodexFixtureRecords());

		// The fixture carries three increasing cumulative records; summing them
		// would multiply-count. Only the final total survives.
		expect(usage).toEqual({
			inputTokens: LAST_TOTAL.input_tokens - LAST_TOTAL.cached_input_tokens,
			outputTokens: LAST_TOTAL.output_tokens,
			cacheReadTokens: LAST_TOTAL.cached_input_tokens,
			cacheCreationTokens: 0,
			costUsd: null,
		});
	});

	it("excludes cached tokens from the input count, since Codex folds them into input_tokens", async () => {
		const usage = deriveCodexUsage(await loadCodexFixtureRecords());

		// Codex reports input_tokens INCLUSIVE of cache reads (unlike Claude); the
		// uncached prompt is the difference.
		expect(usage?.inputTokens).toBe(881967);
		expect(usage?.cacheReadTokens).toBe(LAST_TOTAL.cached_input_tokens);
	});

	it("counts reasoning tokens as output and reports no separately-billed cache writes", async () => {
		const usage = deriveCodexUsage(await loadCodexFixtureRecords());

		// output_tokens (37096) already includes reasoning_output_tokens (7890) —
		// we do not add it again. OpenAI-style caching bills no cache-write.
		expect(usage?.outputTokens).toBe(LAST_TOTAL.output_tokens);
		expect(usage?.cacheCreationTokens).toBe(0);
	});

	it("returns null for a rollout that predates token_count reporting", () => {
		const preTokenCount = [
			{ type: "session_meta", payload: { session_id: "old" } },
			{ type: "event_msg", payload: { type: "task_started" } },
		];

		expect(deriveCodexUsage(preTokenCount)).toBeNull();
		expect(deriveCodexUsage([])).toBeNull();
	});
});

describe("mapClineUsage", () => {
	// Cline reports usage through its SDK, not a transcript. The normalized shape
	// is a straight pass-through of `SessionAccumulatedUsage` — the only renames
	// are cacheWriteTokens → cacheCreationTokens and totalCost → costUsd.
	it("passes SDK usage through, renaming cache-write and carrying Cline's own cost", () => {
		const sdkUsage: ClineSdkAccumulatedUsage = {
			inputTokens: 1200,
			outputTokens: 340,
			cacheReadTokens: 5000,
			cacheWriteTokens: 800,
			totalCost: 0.0123,
		};

		expect(mapClineUsage(sdkUsage)).toEqual({
			inputTokens: 1200,
			outputTokens: 340,
			cacheReadTokens: 5000,
			cacheCreationTokens: 800,
			costUsd: 0.0123,
		});
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

	it("returns absent for an agent with no known transcript layout", async () => {
		const result = await readAgentUsage({ agentId: "unknown-agent", sessionId: "whatever", homePath });

		expect(result).toEqual({ present: false, usage: null });
	});
});

describe("readAgentUsage — codex", () => {
	let homePath = "";

	beforeEach(async () => {
		homePath = await mkdtemp(join(tmpdir(), "usage-reader-codex-"));
	});

	afterEach(async () => {
		await rm(homePath, { recursive: true, force: true });
	});

	async function writeRollout(sessionId: string, records: unknown[]): Promise<void> {
		// Mirror the codex layout the locator scans: a date-partitioned tree of
		// `rollout-<timestamp>-<sessionId>.jsonl` files.
		const absolutePath = join(
			homePath,
			".codex",
			"sessions",
			"2026",
			"07",
			"10",
			`rollout-2026-07-10T11-09-06-${sessionId}.jsonl`,
		);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	}

	it("locates the rollout and returns the last cumulative total", async () => {
		const sessionId = "019f4b49-a9e3-74b3-8beb-75b8dec8a874";
		await writeRollout(sessionId, await loadCodexFixtureRecords());

		const result = await readAgentUsage({ agentId: "codex", sessionId, homePath });

		expect(result.present).toBe(true);
		expect(result.usage).toEqual({
			inputTokens: 881967,
			outputTokens: 37096,
			cacheReadTokens: 13658624,
			cacheCreationTokens: 0,
			costUsd: null,
		});
	});

	it("reports present with null usage for a rollout that predates token_count", async () => {
		const sessionId = "codex-pre-token-count";
		await writeRollout(sessionId, [{ type: "event_msg", payload: { type: "task_started" } }]);

		const result = await readAgentUsage({ agentId: "codex", sessionId, homePath });

		expect(result).toEqual({ present: true, usage: null });
	});

	it("reports absent with null usage when the rollout is gone", async () => {
		const result = await readAgentUsage({ agentId: "codex", sessionId: "missing", homePath });

		expect(result).toEqual({ present: false, usage: null });
	});
});

describe("readAgentUsage — cline", () => {
	// Cline usage is SDK-reported, not transcript-derived, and the derive-on-read
	// endpoint holds no live ClineCore handle to call getAccumulatedUsage — so the
	// reader returns absent until that handle is reachable (mapClineUsage is the
	// ready mapping). This pins the documented deferral.
	it("returns absent because no live SDK handle is reachable on the read path", async () => {
		const result = await readAgentUsage({ agentId: "cline", sessionId: "any", homePath: tmpdir() });

		expect(result).toEqual({ present: false, usage: null });
	});
});
