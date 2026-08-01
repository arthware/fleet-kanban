import type { RuntimeAgentId, RuntimeTaskTokenUsage } from "./api-contract";

export interface ModelPrice {
	/** USD per million uncached input (prompt) tokens. */
	readonly inputPerMTok: number;
	/** USD per million generated output tokens (includes reasoning). */
	readonly outputPerMTok: number;
	/** USD per million prompt-cache WRITE tokens (e.g. 5-minute-TTL rate). */
	readonly cacheWritePerMTok: number;
	/** USD per million prompt-cache READ tokens. */
	readonly cacheReadPerMTok: number;
	/** The source the rate was taken from. */
	readonly source: string;
	/** The date the rate was taken from (YYYY-MM-DD). */
	readonly date: string;
}

export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	shortLabel?: string;
	binary: string;
	binaryAliases?: string[];
	baseArgs: string[];
	autonomousArgs: string[];
	installUrl: string;
	// Whether this agent's CLI takes a native --model flag, so a per-card
	// agentModel override (task.agentModel) can be applied. See
	// terminal/agent-session-adapters.ts's applyAgentModel.
	supportsAgentModelOverride?: boolean;
	// Per-model static pricing facts. A model absent from this table yields null.
	readonly modelPrices?: Record<string, ModelPrice>;
}

export const RUNTIME_AGENT_CATALOG: RuntimeAgentCatalogEntry[] = [
	{
		id: "claude",
		label: "Claude Code",
		shortLabel: "Claude",
		binary: "claude",
		baseArgs: [],
		autonomousArgs: ["--permission-mode", "auto"],
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
		supportsAgentModelOverride: true,
		modelPrices: {
			// Per-model Claude API prices in USD per MILLION tokens. Cached 2026-07-28 from
			// Anthropic's published pricing table. Cache-write uses the 5-minute-TTL rate —
			// Claude Code's default — which is 1.25× base input; cache-read is 0.1× base
			// input. Cost is a best-effort estimate for a "watch it burn" glance, not a
			// billing figure: a model absent from this table yields a `null` cost (tokens
			// render alone) rather than a wrong number.
			"claude-opus-5": {
				inputPerMTok: 5.0,
				outputPerMTok: 25.0,
				cacheWritePerMTok: 6.25, // 5-minute-TTL rate (1.25x of input rate)
				cacheReadPerMTok: 0.5, // 0.1x of input rate
				source: "Anthropic published pricing table",
				date: "2026-07-28",
			},
			"claude-opus-4-8": {
				inputPerMTok: 5.0,
				outputPerMTok: 25.0,
				cacheWritePerMTok: 6.25, // 5-minute-TTL rate (1.25x of input rate)
				cacheReadPerMTok: 0.5, // 0.1x of input rate
				source: "Anthropic published pricing table",
				date: "2026-07-28",
			},
			"claude-fable-5": {
				inputPerMTok: 10.0,
				outputPerMTok: 50.0,
				cacheWritePerMTok: 12.5, // 5-minute-TTL rate (1.25x of input rate)
				cacheReadPerMTok: 1.0, // 0.1x of input rate
				source: "Anthropic published pricing table",
				date: "2026-07-28",
			},
			"claude-sonnet-5": {
				inputPerMTok: 3.0,
				outputPerMTok: 15.0,
				cacheWritePerMTok: 3.75, // 5-minute-TTL rate (1.25x of input rate)
				cacheReadPerMTok: 0.3, // 0.1x of input rate
				// Sonnet 5 carries introductory pricing ($2 input / $10 output per MTok)
				// through 2026-08-31; we price at the STANDARD rate ($3 / $15) since cost is
				// an estimate, not a bill, and the intro rate would understate the steady state.
				source:
					"Anthropic published pricing table. Priced at standard rate rather than temporary intro rate ($2/$10) to reflect steady-state estimate.",
				date: "2026-07-28",
			},
			"claude-haiku-4-5": {
				inputPerMTok: 1.0,
				outputPerMTok: 5.0,
				cacheWritePerMTok: 1.25, // 5-minute-TTL rate (1.25x of input rate)
				cacheReadPerMTok: 0.1, // 0.1x of input rate
				source: "Anthropic published pricing table",
				date: "2026-07-28",
			},
		},
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		shortLabel: "Codex",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
		supportsAgentModelOverride: true,
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		shortLabel: "Gemini",
		binary: "gemini",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/google-gemini/gemini-cli",
	},
];

export const RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = ["claude", "codex", "gemini"];

const RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET = new Set<RuntimeAgentId>(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS);

export function isRuntimeAgentLaunchSupported(agentId: RuntimeAgentId): boolean {
	return RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET.has(agentId);
}

export function getRuntimeLaunchSupportedAgentCatalog(): RuntimeAgentCatalogEntry[] {
	return RUNTIME_AGENT_CATALOG.filter((entry) => isRuntimeAgentLaunchSupported(entry.id));
}

export function getRuntimeAgentCatalogEntry(agentId: RuntimeAgentId): RuntimeAgentCatalogEntry | null {
	return RUNTIME_AGENT_CATALOG.find((entry) => entry.id === agentId) ?? null;
}

export function getRuntimeAgentBinaryCandidates(agentId: RuntimeAgentId): string[] {
	const entry = getRuntimeAgentCatalogEntry(agentId);
	if (!entry) {
		return [agentId];
	}
	return [entry.binary, ...(entry.binaryAliases ?? [])];
}

/**
 * Estimate the USD cost of an agent's token usage.
 *
 * Every token lane is priced SEPARATELY — cache-read and cache-write are not
 * lumped into the input rate. Returns `null` when the model id is unknown or absent
 * so callers render tokens only, never a wrong dollar figure.
 */
export function estimateAgentCostUsd(
	agentId: RuntimeAgentId,
	modelId: string | null | undefined,
	usage: Pick<RuntimeTaskTokenUsage, "inputTokens" | "outputTokens" | "cacheCreationTokens" | "cacheReadTokens">,
): number | null {
	if (!modelId) {
		return null;
	}
	const entry = getRuntimeAgentCatalogEntry(agentId);
	if (!entry || !entry.modelPrices) {
		return null;
	}
	const price = entry.modelPrices[modelId];
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
