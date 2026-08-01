import { describe, expect, it } from "vitest";

import { estimateAgentCostUsd } from "../../../src/core/agent-catalog";

const NONE = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

describe("estimateAgentCostUsd", () => {
	// Each lane is priced from the static table at its own per-MTok rate, so
	// exactly one million tokens on a lane bills that lane's headline price. This
	// proves cache-read and cache-write are priced SEPARATELY, not folded into
	// the input rate — a lumped-in-input model would misprice all four.
	it("prices each Claude Opus 4.8 token lane at its own per-MTok rate", () => {
		expect(estimateAgentCostUsd("claude", "claude-opus-4-8", { ...NONE, inputTokens: 1_000_000 })).toBe(5.0);
		expect(estimateAgentCostUsd("claude", "claude-opus-4-8", { ...NONE, outputTokens: 1_000_000 })).toBe(25.0);
		expect(estimateAgentCostUsd("claude", "claude-opus-4-8", { ...NONE, cacheCreationTokens: 1_000_000 })).toBe(6.25);
		expect(estimateAgentCostUsd("claude", "claude-opus-4-8", { ...NONE, cacheReadTokens: 1_000_000 })).toBe(0.5);
	});

	it("prices the Sonnet 5 and Haiku 4.5 lanes from their own table rows", () => {
		// Sonnet 5 at its standard (non-intro) rate; cache-write is the 5-minute rate.
		expect(estimateAgentCostUsd("claude", "claude-sonnet-5", { ...NONE, inputTokens: 1_000_000 })).toBe(3.0);
		expect(estimateAgentCostUsd("claude", "claude-sonnet-5", { ...NONE, cacheCreationTokens: 1_000_000 })).toBe(3.75);
		expect(estimateAgentCostUsd("claude", "claude-haiku-4-5", { ...NONE, outputTokens: 1_000_000 })).toBe(5.0);
		expect(estimateAgentCostUsd("claude", "claude-haiku-4-5", { ...NONE, cacheReadTokens: 1_000_000 })).toBe(0.1);
	});

	it("prices Opus 5 and Fable 5 lanes from Anthropic's published pricing rows", () => {
		expect(estimateAgentCostUsd("claude", "claude-opus-5", { ...NONE, inputTokens: 1_000_000 })).toBe(5.0);
		expect(estimateAgentCostUsd("claude", "claude-opus-5", { ...NONE, outputTokens: 1_000_000 })).toBe(25.0);
		expect(estimateAgentCostUsd("claude", "claude-fable-5", { ...NONE, cacheCreationTokens: 1_000_000 })).toBe(12.5);
		expect(estimateAgentCostUsd("claude", "claude-fable-5", { ...NONE, cacheReadTokens: 1_000_000 })).toBe(1.0);
	});

	it("sums a realistic mixed-usage session into one dollar total", () => {
		// 1M input ($5) + 200K output ($5) + 400K cache-write ($2.50) + 2M cache-read ($1) = $13.50
		const cost = estimateAgentCostUsd("claude", "claude-opus-4-8", {
			inputTokens: 1_000_000,
			outputTokens: 200_000,
			cacheCreationTokens: 400_000,
			cacheReadTokens: 2_000_000,
		});

		expect(cost).toBeCloseTo(13.5, 6);
	});

	it("returns null for a model absent from the price table, so tokens render alone", () => {
		expect(estimateAgentCostUsd("claude", "gpt-5-codex", { ...NONE, inputTokens: 1_000_000 })).toBeNull();
		expect(estimateAgentCostUsd("claude", "claude-opus-4-7", { ...NONE, inputTokens: 1_000_000 })).toBeNull();
	});

	it("returns null when the model id is missing entirely", () => {
		expect(estimateAgentCostUsd("claude", null, { ...NONE, inputTokens: 1_000_000 })).toBeNull();
		expect(estimateAgentCostUsd("claude", undefined, { ...NONE, inputTokens: 1_000_000 })).toBeNull();
	});

	it("prices a zero-usage card for a known model at exactly zero", () => {
		// The render-nothing rule lives in the chip; at the pricing layer a known
		// model with no tokens is a well-defined $0, not null.
		expect(estimateAgentCostUsd("claude", "claude-opus-4-8", NONE)).toBe(0);
	});

	it("returns null honestly for unpriced Codex and Gemini models", () => {
		expect(estimateAgentCostUsd("codex", "gpt-5-codex", { ...NONE, inputTokens: 1_000_000 })).toBeNull();
		expect(estimateAgentCostUsd("gemini", "gemini-3.5-flash", { ...NONE, inputTokens: 1_000_000 })).toBeNull();
	});
});
