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
