import { describe, expect, it } from "vitest";

import type { RuntimeTaskTokenUsage } from "@/runtime/types";
import { formatCostUsd, formatTokenCount, realWorkTokenCount, totalTokenCount } from "@/utils/format-token-count";

describe("formatTokenCount", () => {
	it("humanizes millions with one decimal", () => {
		expect(formatTokenCount(1_200_000)).toBe("1.2M tok");
	});

	it("humanizes thousands with one decimal", () => {
		expect(formatTokenCount(2_345)).toBe("2.3K tok");
	});

	it("drops a trailing zero decimal for round thousands", () => {
		expect(formatTokenCount(847_000)).toBe("847K tok");
	});

	it("drops a trailing zero decimal for round millions", () => {
		expect(formatTokenCount(1_000_000)).toBe("1M tok");
	});

	it("renders a bare count below one thousand", () => {
		expect(formatTokenCount(512)).toBe("512 tok");
	});
});

describe("formatCostUsd", () => {
	it("shows a dollars-and-cents estimate with two decimals", () => {
		expect(formatCostUsd(3.4)).toBe("$3.40");
	});

	it("rounds to the nearest cent", () => {
		expect(formatCostUsd(3.395)).toBe("$3.40");
		expect(formatCostUsd(12.344)).toBe("$12.34");
	});

	it("collapses a sub-cent estimate to a less-than marker", () => {
		expect(formatCostUsd(0.004)).toBe("<$0.01");
	});

	it("shows exactly one cent at the sub-cent boundary", () => {
		expect(formatCostUsd(0.01)).toBe("$0.01");
	});
});

describe("totalTokenCount", () => {
	it("sums input, output, and both cache token fields", () => {
		const usage: RuntimeTaskTokenUsage = {
			inputTokens: 100,
			outputTokens: 200,
			cacheReadTokens: 30,
			cacheCreationTokens: 4,
			costUsd: null,
		};

		expect(totalTokenCount(usage)).toBe(334);
	});
});

describe("realWorkTokenCount", () => {
	it("counts only the conversational work, excluding both cache lanes", () => {
		const usage: RuntimeTaskTokenUsage = {
			inputTokens: 74_000,
			outputTokens: 608_000,
			cacheReadTokens: 84_000_000,
			cacheCreationTokens: 3_200_000,
			costUsd: null,
		};

		// cache-read re-reads dominate the raw total (~88M) but are not new work;
		// the headline reflects the 682K of distinct input+output instead.
		expect(realWorkTokenCount(usage)).toBe(682_000);
	});

	it("is zero when a card has only cached context and no input or output", () => {
		const usage: RuntimeTaskTokenUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 5_000_000,
			cacheCreationTokens: 120_000,
			costUsd: null,
		};

		expect(realWorkTokenCount(usage)).toBe(0);
	});
});
