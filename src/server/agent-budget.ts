import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Capability } from "../agents/capability";
import { DRIVERS, supported, unsupported } from "../agents/driver";
import type { RuntimeAgentBudgetResponse } from "../core/api-contract";

const execFileAsync = promisify(execFile);

export const AGENT_BUDGET_CACHE_TTL_MS = 10 * 60 * 1000;

export interface AggregatedBudgetProvider {
	provider: string;
	plan?: string | null;
	staleSeconds?: number | null;
	worstRemainingPercent?: number | null;
	error?: string;
	windows?: readonly {
		readonly name: string;
		readonly remainingPercent: number | null;
		readonly resetsAt: number | null;
		readonly detail?: string;
	}[];
}

export interface AggregatedBudget {
	generatedAt: number;
	providers: AggregatedBudgetProvider[];
}

export interface GetAgentBudgetOptions {
	binary?: string | null;
	run?: any;
	now?: () => number;
}

// --- Cursor SQL / Token / API Logic -----------------------------------------

async function getCursorToken(): Promise<string | null> {
	const dbPath =
		process.env.CURSOR_STATE_DB ||
		join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
	try {
		const s = await stat(dbPath);
		if (!s.isFile()) {
			return null;
		}
	} catch {
		return null;
	}

	try {
		const { stdout } = await execFileAsync(
			"sqlite3",
			[dbPath, "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken';"],
			{ timeout: 8000 },
		);
		const token = stdout.trim();
		if (!token) {
			return null;
		}
		return token;
	} catch {
		return null;
	}
}

function decodeJwtSub(jwt: string): string | null {
	try {
		const parts = jwt.split(".");
		if (parts.length < 2) {
			return null;
		}
		const seg = parts[1];
		const padded = seg.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (seg.length % 4)) % 4);
		const jsonStr = Buffer.from(padded, "base64").toString("utf8");
		const payload = JSON.parse(jsonStr);
		return payload?.sub ?? null;
	} catch {
		return null;
	}
}

async function fetchCursorSummary(sub: string, jwt: string): Promise<any> {
	const response = await fetch("https://cursor.com/api/usage-summary", {
		method: "POST",
		headers: {
			Cookie: `WorkosCursorSessionToken=${sub}::${jwt}`,
			"Content-Type": "application/json",
			Origin: "https://cursor.com",
			Referer: "https://cursor.com/dashboard",
			"User-Agent": "fleet-budget",
		},
		body: "{}",
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return await response.json();
}

function parseWindowValue(val: unknown): { used: number; remaining: number } | null {
	if (val === null || val === undefined || typeof val === "boolean") {
		return null;
	}
	const parsed = Number(val);
	if (Number.isNaN(parsed)) {
		return null;
	}
	const u = Math.max(0.0, Math.min(100.0, Math.round(parsed * 10) / 10));
	const rem = Math.round((100.0 - u) * 10) / 10;
	return { used: u, remaining: rem };
}

function isoToUnix(s: string | null | undefined): number | null {
	if (!s) return null;
	try {
		const ms = Date.parse(s);
		if (Number.isNaN(ms)) return null;
		return Math.floor(ms / 1000);
	} catch {
		return null;
	}
}

function parseCursorWindows(summary: any): any {
	const resetsAt = isoToUnix(summary?.billingCycleEnd);
	const iu = summary?.individualUsage || {};
	const windows: any[] = [];

	const plan = iu.plan;
	if (plan) {
		const p = parseWindowValue(plan.totalPercentUsed ?? 0);
		windows.push({
			name: "cycle",
			remainingPercent: p ? p.remaining : null,
			resetsAt,
			detail: `${plan.used ?? 0}/${plan.limit ?? 0}`,
		});
	}

	const od = iu.onDemand;
	if (od?.enabled) {
		const limit = od.limit ?? 0;
		const usedRaw = od.used ?? 0;
		const ratio = limit > 0 ? (usedRaw / limit) * 100 : 0;
		const p = parseWindowValue(ratio);
		windows.push({
			name: "on-demand",
			remainingPercent: p ? p.remaining : null,
			resetsAt,
			detail: `${usedRaw}/${limit}`,
		});
	}

	return {
		plan: summary?.membershipType ?? null,
		staleSeconds: 0,
		windows,
	};
}

async function readCursor(): Promise<Capability<any>> {
	const token = await getCursorToken();
	if (!token) {
		return unsupported("no Cursor auth found (is the desktop app signed in?)");
	}
	const sub = decodeJwtSub(token);
	if (!sub) {
		return unsupported("no Cursor auth found (is the desktop app signed in?)");
	}
	try {
		const summary = await fetchCursorSummary(sub, token);
		return supported(parseCursorWindows(summary));
	} catch (e: any) {
		return unsupported(`request failed: ${e?.message || e}`);
	}
}

// --- Aggregator --------------------------------------------------------------

function computeWorstRemainingPercent(windows: readonly { remainingPercent: number | null }[]): number | null {
	const values = windows.map((w) => w.remainingPercent).filter((p): p is number => p !== null);
	if (values.length === 0) {
		return null;
	}
	return Math.min(...values);
}

export async function getAggregatedBudget(): Promise<AggregatedBudget> {
	const nowSec = Math.floor(Date.now() / 1000);
	const providers: AggregatedBudgetProvider[] = [];

	// 1. Claude
	try {
		const res = await DRIVERS.claude.budget.read();
		if (res.supported) {
			const worst = computeWorstRemainingPercent(res.value.windows);
			providers.push({
				provider: "claude",
				plan: res.value.plan,
				staleSeconds: res.value.staleSeconds,
				worstRemainingPercent: worst,
				windows: res.value.windows,
			});
		} else {
			providers.push({
				provider: "claude",
				error: res.reason,
			});
		}
	} catch (e: any) {
		providers.push({
			provider: "claude",
			error: `error: ${e?.message || e}`,
		});
	}

	// 2. Codex
	try {
		const res = await DRIVERS.codex.budget.read();
		if (res.supported) {
			const worst = computeWorstRemainingPercent(res.value.windows);
			providers.push({
				provider: "codex",
				plan: res.value.plan,
				staleSeconds: res.value.staleSeconds,
				worstRemainingPercent: worst,
				windows: res.value.windows,
			});
		} else {
			providers.push({
				provider: "codex",
				error: res.reason,
			});
		}
	} catch (e: any) {
		providers.push({
			provider: "codex",
			error: `error: ${e?.message || e}`,
		});
	}

	// 3. Gemini (unsupported)
	try {
		const res = await DRIVERS.gemini.budget.read();
		if (res.supported) {
			const worst = computeWorstRemainingPercent(res.value.windows);
			providers.push({
				provider: "gemini",
				plan: res.value.plan,
				staleSeconds: res.value.staleSeconds,
				worstRemainingPercent: worst,
				windows: res.value.windows,
			});
		} else {
			// Skip gemini
		}
	} catch {
		// Ignore
	}

	// 4. Cursor
	try {
		const res = await readCursor();
		if (res.supported) {
			const worst = computeWorstRemainingPercent(res.value.windows);
			providers.push({
				provider: "cursor",
				plan: res.value.plan,
				staleSeconds: res.value.staleSeconds,
				worstRemainingPercent: worst,
				windows: res.value.windows,
			});
		} else {
			providers.push({
				provider: "cursor",
				error: res.reason,
			});
		}
	} catch (e: any) {
		providers.push({
			provider: "cursor",
			error: `error: ${e?.message || e}`,
		});
	}

	return {
		generatedAt: nowSec,
		providers,
	};
}

let cache: { data: RuntimeAgentBudgetResponse; fetchedAtMs: number } | null = null;
let inFlight: Promise<RuntimeAgentBudgetResponse> | null = null;

async function refreshAgentBudget(): Promise<RuntimeAgentBudgetResponse> {
	try {
		const report = await getAggregatedBudget();
		return {
			available: true,
			generatedAt: report.generatedAt,
			providers: report.providers
				.filter((p) => !p.error && p.windows && p.windows.length > 0)
				.map((p) => ({
					provider: p.provider,
					plan: p.plan ?? null,
					staleSeconds: p.staleSeconds ?? null,
					worstRemainingPercent: p.worstRemainingPercent ?? null,
					windows: (p.windows ?? []).map((w) => ({
						name: w.name,
						remainingPercent: w.remainingPercent,
						resetsAt: w.resetsAt,
					})),
				})),
		};
	} catch {
		return {
			available: false,
			generatedAt: null,
			providers: [],
		};
	}
}

export async function getAgentBudget(options: GetAgentBudgetOptions = {}): Promise<RuntimeAgentBudgetResponse> {
	const now = options.now ?? Date.now;
	const nowMs = now();

	if (cache && nowMs - cache.fetchedAtMs < AGENT_BUDGET_CACHE_TTL_MS) {
		return cache.data;
	}

	if (!inFlight) {
		inFlight = refreshAgentBudget().then((data) => {
			if (data.available || !cache) {
				cache = { data, fetchedAtMs: now() };
			}
			inFlight = null;
			return cache ? cache.data : data;
		});
	}

	return await inFlight;
}

export function resetAgentBudgetCacheForTests(): void {
	cache = null;
	inFlight = null;
}

function formatReset(resetsAt: number | null | undefined, nowSec: number): string {
	if (!resetsAt) {
		return "";
	}
	const delta = resetsAt - nowSec;
	if (delta <= 0) {
		return "resets now";
	}
	const h = Math.floor(delta / 3600);
	const m = Math.floor((delta % 3600) / 60);
	const mStr = String(m).padStart(2, "0");
	const when = h > 0 ? `${h}h${mStr}m` : `${m}m`;
	return `resets in ${when}`;
}

function getColor(remaining: number | null | undefined): string {
	if (remaining === null || remaining === undefined) {
		return "";
	}
	if (remaining <= 10) {
		return "\x1b[31m"; // red
	}
	if (remaining <= 25) {
		return "\x1b[33m"; // yellow
	}
	return "\x1b[32m"; // green
}

export function formatTable(providers: any[], nowSec?: number, color = true): string {
	const now = nowSec ?? Math.floor(Date.now() / 1000);
	const R = color ? "\x1b[0m" : "";
	const G = color ? "\x1b[90m" : "";
	const lines: string[] = [];

	for (const p of providers) {
		const name = p.provider ?? "?";
		const namePad = name.padEnd(8);
		if (p.error) {
			lines.push(color ? `${namePad} ${G}${p.error}${R}` : `${namePad} ${p.error}`);
			continue;
		}
		const plan = p.plan ?? "?";
		const planPad = plan.padEnd(6);
		const head = `${namePad}${planPad}`;
		const stale = p.staleSeconds;
		const cells: string[] = [];

		const windows = p.windows ?? [];
		for (const w of windows) {
			const rem = w.remainingPercent;
			const c = color ? getColor(rem) : "";
			const reset = formatReset(w.resetsAt, now);
			const detail = w.detail ? ` ${w.detail}` : "";
			const remStr = rem !== null && rem !== undefined ? rem.toFixed(1) : "unknown";
			let cell = `${w.name.padEnd(9)} ${c}${remStr.padStart(5)}% left${R}${detail}`;
			if (reset) {
				cell += color ? `  ${G}${reset}${R}` : `  ${reset}`;
			}
			cells.push(cell);
		}
		let row = `${head}   ${cells.join("   ")}`;
		if (stale && stale > 90) {
			const mins = Math.floor(stale / 60);
			const age = mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m` : `${mins}m`;
			row += color ? `   ${G}(snapshot ${age} old)${R}` : `   (snapshot ${age} old)`;
		}
		lines.push(row);
	}
	return lines.join("\n");
}
