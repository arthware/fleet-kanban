import type { RuntimeTaskTokenUsage } from "@/runtime/types";

/** Total tokens a card's agent has processed — input, output, and both cache lanes. */
export function totalTokenCount(usage: RuntimeTaskTokenUsage): number {
	return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
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
