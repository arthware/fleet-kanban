import type { RuntimeTaskTokenUsage } from "./api-contract";

/**
 * Per-model Claude API prices in USD per MILLION tokens. Cached 2026-07-11 from
 * the `claude-api` skill's pricing table (which matches
 * `docs/design/per-card-token-usage.md` §7). Cache-write uses the 5-minute-TTL
 * rate — Claude Code's default — which is 1.25× base input; cache-read is 0.1×
 * base input.
 *
 * This is a best-effort estimate for a "watch it burn" glance, not a billing
 * figure: a model absent from this table yields a `null` cost (tokens render
 * alone) rather than a wrong number. Keep it beside the model catalog in
 * `agent-catalog.ts` so a price update is one obvious edit.
 */
export interface ClaudeModelPrice {
	/** USD per million uncached input (prompt) tokens. */
	readonly inputPerMTok: number;
	/** USD per million generated output tokens (includes reasoning). */
	readonly outputPerMTok: number;
	/** USD per million prompt-cache WRITE tokens (5-minute-TTL rate). */
	readonly cacheWritePerMTok: number;
	/** USD per million prompt-cache READ tokens. */
	readonly cacheReadPerMTok: number;
}

export const CLAUDE_MODEL_PRICES: Readonly<Record<string, ClaudeModelPrice>> = {
	"claude-opus-4-8": { inputPerMTok: 5.0, outputPerMTok: 25.0, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
	// Sonnet 5 carries introductory pricing ($2 input / $10 output per MTok)
	// through 2026-08-31; we price at the STANDARD rate ($3 / $15) since cost is
	// an estimate, not a bill, and the intro rate would understate the steady state.
	"claude-sonnet-5": { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
	"claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
};

/**
 * Estimate the USD cost of a card's cumulative token usage for a Claude model.
 *
 * Every token lane is priced SEPARATELY — cache-read and cache-write are not
 * folded into the input rate (cache is often the dominant line for a long Claude
 * session, so lumping it in would misprice badly). Returns `null` when the model
 * id is unknown or absent so callers render tokens only, never a wrong dollar
 * figure.
 */
export function estimateClaudeCostUsd(
	usage: Pick<RuntimeTaskTokenUsage, "inputTokens" | "outputTokens" | "cacheCreationTokens" | "cacheReadTokens">,
	modelId: string | null | undefined,
): number | null {
	if (!modelId) {
		return null;
	}
	const price = CLAUDE_MODEL_PRICES[modelId];
	if (!price) {
		return null;
	}
	return (
		(usage.inputTokens / 1_000_000) * price.inputPerMTok +
		(usage.outputTokens / 1_000_000) * price.outputPerMTok +
		(usage.cacheCreationTokens / 1_000_000) * price.cacheWritePerMTok +
		(usage.cacheReadTokens / 1_000_000) * price.cacheReadPerMTok
	);
}
