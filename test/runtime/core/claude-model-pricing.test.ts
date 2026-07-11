import { describe, expect, it } from "vitest";

import { estimateClaudeCostUsd } from "../../../src/core/claude-model-pricing";

const NONE = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

describe("estimateClaudeCostUsd", () => {
	// Each lane is priced from the static table at its own per-MTok rate, so
	// exactly one million tokens on a lane bills that lane's headline price. This
	// proves cache-read and cache-write are priced SEPARATELY, not folded into
	// the input rate — a lumped-in-input model would misprice all four.
	it("prices each Opus 4.8 token lane at its own per-MTok rate", () => {
		expect(estimateClaudeCostUsd({ ...NONE, inputTokens: 1_000_000 }, "claude-opus-4-8")).toBe(5.0);
		expect(estimateClaudeCostUsd({ ...NONE, outputTokens: 1_000_000 }, "claude-opus-4-8")).toBe(25.0);
		expect(estimateClaudeCostUsd({ ...NONE, cacheCreationTokens: 1_000_000 }, "claude-opus-4-8")).toBe(6.25);
		expect(estimateClaudeCostUsd({ ...NONE, cacheReadTokens: 1_000_000 }, "claude-opus-4-8")).toBe(0.5);
	});

	it("prices the Sonnet 5 and Haiku 4.5 lanes from their own table rows", () => {
		// Sonnet 5 at its standard (non-intro) rate; cache-write is the 5-minute rate.
		expect(estimateClaudeCostUsd({ ...NONE, inputTokens: 1_000_000 }, "claude-sonnet-5")).toBe(3.0);
		expect(estimateClaudeCostUsd({ ...NONE, cacheCreationTokens: 1_000_000 }, "claude-sonnet-5")).toBe(3.75);
		expect(estimateClaudeCostUsd({ ...NONE, outputTokens: 1_000_000 }, "claude-haiku-4-5")).toBe(5.0);
		expect(estimateClaudeCostUsd({ ...NONE, cacheReadTokens: 1_000_000 }, "claude-haiku-4-5")).toBe(0.1);
	});

	it("sums a realistic mixed-usage session into one dollar total", () => {
		// 1M input ($5) + 200K output ($5) + 400K cache-write ($2.50) + 2M cache-read ($1) = $13.50
		const cost = estimateClaudeCostUsd(
			{ inputTokens: 1_000_000, outputTokens: 200_000, cacheCreationTokens: 400_000, cacheReadTokens: 2_000_000 },
			"claude-opus-4-8",
		);

		expect(cost).toBeCloseTo(13.5, 6);
	});

	it("returns null for a model absent from the price table, so tokens render alone", () => {
		expect(estimateClaudeCostUsd({ ...NONE, inputTokens: 1_000_000 }, "gpt-5-codex")).toBeNull();
		expect(estimateClaudeCostUsd({ ...NONE, inputTokens: 1_000_000 }, "claude-opus-4-7")).toBeNull();
	});

	it("returns null when the model id is missing entirely", () => {
		expect(estimateClaudeCostUsd({ ...NONE, inputTokens: 1_000_000 }, null)).toBeNull();
		expect(estimateClaudeCostUsd({ ...NONE, inputTokens: 1_000_000 }, undefined)).toBeNull();
	});

	it("prices a zero-usage card for a known model at exactly zero", () => {
		// The render-nothing rule lives in the chip; at the pricing layer a known
		// model with no tokens is a well-defined $0, not null.
		expect(estimateClaudeCostUsd(NONE, "claude-opus-4-8")).toBe(0);
	});
});
