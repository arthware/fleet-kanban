// Bridge to `fleet update --check --json` — whether the running shared vendor
// build is behind the fork's remote `main`. Shells out to the CLI bundled at
// `fleet-cli/` (same tiered binary resolution as agent-budget.ts) and caches the
// result so the polled title-bar query doesn't hit the network on every read.
import { type ChildProcess, execFile, type SpawnOptions, spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { clineHomeDir } from "../config/cline-home";
import type { RuntimeFleetUpdateApplyResult, RuntimeFleetUpdateStatus } from "../core/api-contract";

const execFileAsync = promisify(execFile);

const UPDATE_CHECK_TIMEOUT_MS = 10_000;
const UPDATE_CHECK_MAX_BUFFER_BYTES = 1024 * 1024;
export const FLEET_UPDATE_STATUS_CACHE_TTL_MS = 60 * 60 * 1000;

const UNAVAILABLE_STATUS: RuntimeFleetUpdateStatus = {
	mode: "source",
	current: null,
	latest: null,
	updateAvailable: false,
};

const rawFleetUpdateStatusSchema = z.object({
	mode: z.enum(["vendor", "source"]),
	current: z.string().nullable().optional(),
	latest: z.string().nullable().optional(),
	updateAvailable: z.boolean(),
});

function resolveFleetUpdateBinary(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	// Bundled (esbuild): dist/cli.js -> repo-root/fleet-cli/fleet
	// Source / per-file dist: src|dist/server/fleet-update-status.(ts|js) -> repo-root/fleet-cli/fleet
	const candidates = [resolve(here, "../fleet-cli/fleet"), resolve(here, "../../fleet-cli/fleet")];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export interface RunFleetUpdateCliResult {
	stdout: string;
}

export type RunFleetUpdateCliFn = (binary: string, args: string[]) => Promise<RunFleetUpdateCliResult>;

const runFleetUpdateCli: RunFleetUpdateCliFn = (binary, args) =>
	execFileAsync(binary, args, {
		encoding: "utf8",
		timeout: UPDATE_CHECK_TIMEOUT_MS,
		maxBuffer: UPDATE_CHECK_MAX_BUFFER_BYTES,
	});

export interface GetFleetUpdateStatusOptions {
	/** Overrides binary resolution; pass `null` to force the unavailable path. Defaults to the resolved bundled CLI. */
	binary?: string | null;
	run?: RunFleetUpdateCliFn;
	now?: () => number;
}

async function refreshFleetUpdateStatus(options: GetFleetUpdateStatusOptions): Promise<RuntimeFleetUpdateStatus> {
	const binary = options.binary === undefined ? resolveFleetUpdateBinary() : options.binary;
	if (!binary) {
		return UNAVAILABLE_STATUS;
	}
	try {
		const run = options.run ?? runFleetUpdateCli;
		const { stdout } = await run(binary, ["update", "--check", "--json"]);
		const parsed = rawFleetUpdateStatusSchema.parse(JSON.parse(stdout));
		return {
			mode: parsed.mode,
			current: parsed.current ?? null,
			latest: parsed.latest ?? null,
			updateAvailable: parsed.updateAvailable,
		};
	} catch {
		return UNAVAILABLE_STATUS;
	}
}

let cache: { data: RuntimeFleetUpdateStatus; fetchedAtMs: number } | null = null;
let inFlight: Promise<RuntimeFleetUpdateStatus> | null = null;

/**
 * Cached, non-throwing accessor for the fleet vendor-build update status. Serves
 * the fresh cache with no CLI call; on a stale/missing cache it refreshes, but
 * only blocks the caller when there is no last-good value to serve meanwhile.
 * Concurrent callers share one in-flight refresh.
 */
export async function getFleetUpdateStatus(
	options: GetFleetUpdateStatusOptions = {},
): Promise<RuntimeFleetUpdateStatus> {
	const now = options.now ?? Date.now;
	const nowMs = now();

	if (cache && nowMs - cache.fetchedAtMs < FLEET_UPDATE_STATUS_CACHE_TTL_MS) {
		return cache.data;
	}

	if (!inFlight) {
		inFlight = refreshFleetUpdateStatus(options).then((data) => {
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

export function resetFleetUpdateStatusCacheForTests(): void {
	cache = null;
	inFlight = null;
}

export type SpawnFleetUpdateFn = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => Pick<ChildProcess, "unref">;

const defaultOpenLogFd = (): number => openSync(join(clineHomeDir(), "fleet-update.log"), "a");

export interface ApplyFleetUpdateOptions extends GetFleetUpdateStatusOptions {
	inProgressCount: number;
	spawnDetached?: SpawnFleetUpdateFn;
	openLogFd?: () => number;
	closeLogFd?: (fd: number) => void;
}

/**
 * Applies the pending fleet vendor-build update by spawning a detached
 * `fleet update && fleet service restart`. Re-checks both gates at call time —
 * cards in progress block the restart, and there's nothing to do if the board
 * isn't on the shared vendor build or is already current.
 */
export async function applyFleetUpdate(options: ApplyFleetUpdateOptions): Promise<RuntimeFleetUpdateApplyResult> {
	if (options.inProgressCount > 0) {
		return { started: false, reason: "cards-in-progress" };
	}

	const status = await getFleetUpdateStatus(options);
	if (status.mode !== "vendor" || !status.updateAvailable) {
		return { started: false, reason: "nothing-to-do" };
	}

	const spawnDetached = options.spawnDetached ?? spawn;
	const openLogFd = options.openLogFd ?? defaultOpenLogFd;
	const closeLogFd = options.closeLogFd ?? closeSync;
	const logFd = openLogFd();
	const child = spawnDetached("sh", ["-c", "fleet update && fleet service restart"], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
	});
	child.unref();
	closeLogFd(logFd);

	return { started: true, reason: null };
}
