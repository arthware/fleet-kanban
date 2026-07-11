import type { RuntimeTaskTokenUsage } from "@/runtime/types";

/** Total tokens a card's agent has processed — input, output, and both cache lanes. */
export function totalTokenCount(usage: RuntimeTaskTokenUsage): number {
	return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

/**
 * The distinct conversational work a card's agent has done — `inputTokens +
 * outputTokens`, deliberately excluding BOTH cache lanes.
 *
 * This is the headline number for the board chip, not {@link totalTokenCount}.
 * In a long Claude session cache-read tokens are the same context re-read on
 * every turn (billed at only 0.1× base input), so they dominate the raw total
 * by ~100× — a real transcript showed 84.0M cache-read + 3.2M cache-write next
 * to just 74K input + 608K output, i.e. an 87.9M grand total against 682K of
 * actual work. Summing all four lanes makes a card's "weight" read ~130× too
 * heavy, so the headline counts only new, non-cached work. The full grand total
 * still lives in the chip tooltip, and cost is priced per-lane separately (a
 * cache-read at 0.1×) — neither is affected by this.
 */
export function realWorkTokenCount(usage: RuntimeTaskTokenUsage): number {
	return usage.inputTokens + usage.outputTokens;
}

function formatCompact(value: number, suffix: string): string {
	const rounded = Math.round(value * 10) / 10;
	// Show one decimal, but drop it when the value lands on a whole number
	// (`847K`, not `847.0K`).
	const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
	return `${text}${suffix}`;
}

/**
 * Humanize a cumulative token count for the compact board-card chip:
 * `1_200_000 → "1.2M tok"`, `847_000 → "847K tok"`, `2_345 → "2.3K tok"`.
 */
export function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		return `${formatCompact(count / 1_000_000, "M")} tok`;
	}
	if (count >= 1_000) {
		return `${formatCompact(count / 1_000, "K")} tok`;
	}
	return `${Math.round(count)} tok`;
}

/**
 * Format an estimated per-card cost for the board-card chip: two decimals
 * (`3.4 → "$3.40"`), collapsing a sub-cent estimate to `"<$0.01"` so a tiny but
 * non-zero burn never reads as free.
 */
export function formatCostUsd(costUsd: number): string {
	if (costUsd < 0.01) {
		return "<$0.01";
	}
	return `$${costUsd.toFixed(2)}`;
}
