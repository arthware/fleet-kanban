import { describe, expect, it } from "vitest";
import { formatCliTokenUsage } from "../../../src/commands/task";
import type { RuntimeTaskTokenUsage } from "../../../src/core/api-contract";

describe("formatCliTokenUsage", () => {
	it("returns '-' (neutral placeholder) when the task has no captured session", () => {
		const result = formatCliTokenUsage(null, false);
		expect(result).toBe("-");
	});

	it("returns '?' (unresolved placeholder) when there is a session but token usage is null", () => {
		const result = formatCliTokenUsage(null, true);
		expect(result).toBe("?");
	});

	it("returns '0' when there is a session, usage is present, but conversational work is exactly 0", () => {
		const usage: RuntimeTaskTokenUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 1000, // separate cache lane doesn't count as real conversational work
			cacheCreationTokens: 50,
			costUsd: null,
		};
		const result = formatCliTokenUsage(usage, true);
		expect(result).toBe("0");
	});

	it("renders numbers below 1,000 as raw rounded integers", () => {
		const usage: RuntimeTaskTokenUsage = {
			inputTokens: 400,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: null,
		};
		expect(formatCliTokenUsage(usage, true)).toBe("450");
	});

	it("renders numbers from 1,000 to 999,999 with 'k' suffix and one decimal if fractional", () => {
		const usage1: RuntimeTaskTokenUsage = {
			inputTokens: 1200,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: null,
		};
		expect(formatCliTokenUsage(usage1, true)).toBe("1.3k");

		const usage2: RuntimeTaskTokenUsage = {
			inputTokens: 128000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: null,
		};
		expect(formatCliTokenUsage(usage2, true)).toBe("128k");
	});

	it("renders numbers from 1,000,000 and above with 'M' suffix and one decimal if fractional", () => {
		const usage1: RuntimeTaskTokenUsage = {
			inputTokens: 1200000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: null,
		};
		expect(formatCliTokenUsage(usage1, true)).toBe("1.2M");

		const usage2: RuntimeTaskTokenUsage = {
			inputTokens: 1250000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: null,
		};
		expect(formatCliTokenUsage(usage2, true)).toBe("1.3M");
	});
});
