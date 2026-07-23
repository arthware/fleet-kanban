// Bridge to `fleet budget --json` — the remaining agent-session budget (Claude /
// Codex / Cursor) the operator otherwise has to check in a terminal before
// dispatching heavy work. Shells out to the CLI bundled at `fleet-cli/` rather
// than reimplementing its per-provider window math (see fleet-cli/budget.py),
// and caches the result so the polled header query doesn't hit the network on
// every read.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type { RuntimeAgentBudgetProvider, RuntimeAgentBudgetResponse } from "../core/api-contract";

const execFileAsync = promisify(execFile);

const BUDGET_TIMEOUT_MS = 10_000;
const BUDGET_MAX_BUFFER_BYTES = 1024 * 1024;
export const AGENT_BUDGET_CACHE_TTL_MS = 10 * 60 * 1000;

const UNAVAILABLE_RESPONSE: RuntimeAgentBudgetResponse = {
	available: false,
	generatedAt: null,
	providers: [],
};

const rawWindowSchema = z.object({
	name: z.string(),
	remaining_percent: z.number().nullable().optional(),
	resets_at: z.number().nullable().optional(),
});

const rawProviderSchema = z.object({
	provider: z.string(),
	plan: z.string().nullable().optional(),
	stale_seconds: z.number().nullable().optional(),
	error: z.string().optional(),
	windows: z.array(rawWindowSchema).optional(),
	worst_remaining_percent: z.number().nullable().optional(),
});

const rawBudgetReportSchema = z.object({
	generated_at: z.number(),
	providers: z.array(rawProviderSchema),
});

/** A provider that errored (unconfigured, unauthenticated, ...) carries no usable windows — drop it. */
function mapProvider(raw: z.infer<typeof rawProviderSchema>): RuntimeAgentBudgetProvider | null {
	if (raw.error || !raw.windows || raw.windows.length === 0) {
		return null;
	}
	return {
		provider: raw.provider,
		plan: raw.plan ?? null,
		staleSeconds: raw.stale_seconds ?? null,
		worstRemainingPercent: raw.worst_remaining_percent ?? null,
		windows: raw.windows.map((w) => ({
			name: w.name,
			remainingPercent: w.remaining_percent ?? null,
			resetsAt: w.resets_at ?? null,
		})),
	};
}

function resolveFleetBudgetBinary(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	// Bundled (esbuild): dist/cli.js -> repo-root/fleet-cli/fleet
	// Source / per-file dist: src|dist/server/agent-budget.(ts|js) -> repo-root/fleet-cli/fleet
	const candidates = [resolve(here, "../fleet-cli/fleet"), resolve(here, "../../fleet-cli/fleet")];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export interface RunFleetBudgetCliResult {
	stdout: string;
}

export type RunFleetBudgetCliFn = (binary: string, args: string[]) => Promise<RunFleetBudgetCliResult>;

const runFleetBudgetCli: RunFleetBudgetCliFn = (binary, args) =>
	execFileAsync(binary, args, {
		encoding: "utf8",
		timeout: BUDGET_TIMEOUT_MS,
		maxBuffer: BUDGET_MAX_BUFFER_BYTES,
	});

export interface GetAgentBudgetOptions {
	/** Overrides binary resolution; pass `null` to force the unavailable path. Defaults to the resolved bundled CLI. */
	binary?: string | null;
	run?: RunFleetBudgetCliFn;
	now?: () => number;
}

async function refreshAgentBudget(options: GetAgentBudgetOptions): Promise<RuntimeAgentBudgetResponse> {
	const binary = options.binary === undefined ? resolveFleetBudgetBinary() : options.binary;
	if (!binary) {
		return UNAVAILABLE_RESPONSE;
	}
	try {
		const run = options.run ?? runFleetBudgetCli;
		const { stdout } = await run(binary, ["budget", "--json"]);
		const parsed = rawBudgetReportSchema.parse(JSON.parse(stdout));
		return {
			available: true,
			generatedAt: parsed.generated_at,
			providers: parsed.providers.map(mapProvider).filter((p): p is RuntimeAgentBudgetProvider => p !== null),
		};
	} catch {
		return UNAVAILABLE_RESPONSE;
	}
}

let cache: { data: RuntimeAgentBudgetResponse; fetchedAtMs: number } | null = null;
let inFlight: Promise<RuntimeAgentBudgetResponse> | null = null;

/**
 * Cached, non-throwing accessor for the agent budget. Serves the fresh cache
 * with no CLI call; on a stale/missing cache it refreshes, but only blocks the
 * caller when there is no last-good value to serve meanwhile. Concurrent
 * callers share one in-flight refresh.
 */
export async function getAgentBudget(options: GetAgentBudgetOptions = {}): Promise<RuntimeAgentBudgetResponse> {
	const now = options.now ?? Date.now;
	const nowMs = now();

	if (cache && nowMs - cache.fetchedAtMs < AGENT_BUDGET_CACHE_TTL_MS) {
		return cache.data;
	}

	if (!inFlight) {
		inFlight = refreshAgentBudget(options).then((data) => {
			cache = { data, fetchedAtMs: now() };
			inFlight = null;
			return data;
		});
	}

	if (cache) {
		return cache.data;
	}

	return await inFlight;
}

export function resetAgentBudgetCacheForTests(): void {
	cache = null;
	inFlight = null;
}
