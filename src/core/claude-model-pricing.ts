import { estimateAgentCostUsd, getRuntimeAgentCatalogEntry } from "./agent-catalog";
import type { RuntimeTaskTokenUsage } from "./api-contract";

export interface ClaudeModelPrice {
	readonly inputPerMTok: number;
	readonly outputPerMTok: number;
	readonly cacheWritePerMTok: number;
	readonly cacheReadPerMTok: number;
}

const claudeEntry = getRuntimeAgentCatalogEntry("claude");
export const CLAUDE_MODEL_PRICES: Readonly<Record<string, ClaudeModelPrice>> = claudeEntry?.modelPrices ?? {};

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
	return estimateAgentCostUsd("claude", modelId, usage);
}
