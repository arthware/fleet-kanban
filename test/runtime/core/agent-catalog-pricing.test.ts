import { describe, expect, it } from "vitest";

import { estimateAgentCostUsd } from "../../../src/core/agent-catalog";

const NONE = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

describe("estimateAgentCostUsd", () => {
	it("prices a known Claude model correctly", () => {
		expect(estimateAgentCostUsd("claude", "claude-opus-4-8", { ...NONE, inputTokens: 1_000_000 })).toBe(5.0);
		expect(estimateAgentCostUsd("claude", "claude-opus-4-8", { ...NONE, outputTokens: 1_000_000 })).toBe(25.0);
		expect(estimateAgentCostUsd("claude", "claude-opus-4-8", { ...NONE, cacheCreationTokens: 1_000_000 })).toBe(6.25);
		expect(estimateAgentCostUsd("claude", "claude-opus-4-8", { ...NONE, cacheReadTokens: 1_000_000 })).toBe(0.5);
	});

	it("prices a known Codex model correctly", () => {
		expect(estimateAgentCostUsd("codex", "gpt-5-codex", { ...NONE, inputTokens: 1_000_000 })).toBe(2.5);
		expect(estimateAgentCostUsd("codex", "gpt-5-codex", { ...NONE, outputTokens: 1_000_000 })).toBe(10.0);
		expect(estimateAgentCostUsd("codex", "gpt-5-codex", { ...NONE, cacheReadTokens: 1_000_000 })).toBe(1.25);
	});

	it("prices a known Gemini model correctly", () => {
		expect(estimateAgentCostUsd("gemini", "gemini-3.5-flash", { ...NONE, inputTokens: 1_000_000 })).toBe(0.075);
		expect(estimateAgentCostUsd("gemini", "gemini-3.5-flash", { ...NONE, outputTokens: 1_000_000 })).toBe(0.3);
		expect(estimateAgentCostUsd("gemini", "gemini-3.5-flash", { ...NONE, cacheReadTokens: 1_000_000 })).toBe(0.01875);
	});

	it("returns null for an unknown model ID", () => {
		expect(estimateAgentCostUsd("claude", "unknown-model", { ...NONE, inputTokens: 1_000_000 })).toBeNull();
		expect(estimateAgentCostUsd("codex", "unknown-model", { ...NONE, inputTokens: 1_000_000 })).toBeNull();
		expect(estimateAgentCostUsd("gemini", "unknown-model", { ...NONE, inputTokens: 1_000_000 })).toBeNull();
	});

	it("returns null for a missing model ID", () => {
		expect(estimateAgentCostUsd("claude", null, { ...NONE, inputTokens: 1_000_000 })).toBeNull();
		expect(estimateAgentCostUsd("claude", undefined, { ...NONE, inputTokens: 1_000_000 })).toBeNull();
	});

	it("prices a zero-usage known model at exactly zero", () => {
		expect(estimateAgentCostUsd("claude", "claude-opus-4-8", NONE)).toBe(0);
		expect(estimateAgentCostUsd("codex", "gpt-5-codex", NONE)).toBe(0);
		expect(estimateAgentCostUsd("gemini", "gemini-3.5-flash", NONE)).toBe(0);
	});
});
