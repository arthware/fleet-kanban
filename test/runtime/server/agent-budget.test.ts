import { beforeEach, describe, expect, it } from "vitest";

import { getAgentBudget, resetAgentBudgetCacheForTests } from "../../../src/server/agent-budget";

const FIXTURE_STDOUT = JSON.stringify({
	generated_at: 1784812901,
	providers: [
		{
			provider: "claude",
			plan: "max",
			stale_seconds: 0,
			windows: [
				{ name: "5h", remaining_percent: 95.0, resets_at: 1784829600 },
				{ name: "week", remaining_percent: 55.0, resets_at: 1785203999 },
			],
			worst_remaining_percent: 55.0,
		},
		{
			provider: "codex",
			plan: "plus",
			stale_seconds: 60342,
			windows: [{ name: "week", remaining_percent: 6.0, resets_at: 1785262088 }],
			worst_remaining_percent: 6.0,
		},
		{
			provider: "cursor",
			error: "no Cursor auth found (is the desktop app signed in?)",
		},
	],
});

function makeCountingRun(stdout: string) {
	let calls = 0;
	const run = async (_binary: string, _args: string[]) => {
		calls += 1;
		return { stdout };
	};
	return { run, callCount: () => calls };
}

describe("getAgentBudget", () => {
	beforeEach(() => {
		resetAgentBudgetCacheForTests();
	});

	it("given a captured fleet budget --json fixture, when resolved, then it maps to the camelCase provider shape and drops errored providers", async () => {
		const { run } = makeCountingRun(FIXTURE_STDOUT);

		const result = await getAgentBudget({ binary: "stub-fleet", run });

		expect(result).toEqual({
			available: true,
			generatedAt: 1784812901,
			providers: [
				{
					provider: "claude",
					plan: "max",
					staleSeconds: 0,
					worstRemainingPercent: 55.0,
					windows: [
						{ name: "5h", remainingPercent: 95.0, resetsAt: 1784829600 },
						{ name: "week", remainingPercent: 55.0, resetsAt: 1785203999 },
					],
				},
				{
					provider: "codex",
					plan: "plus",
					staleSeconds: 60342,
					worstRemainingPercent: 6.0,
					windows: [{ name: "week", remainingPercent: 6.0, resetsAt: 1785262088 }],
				},
			],
		});
	});

	it("given the fleet binary cannot be resolved, when getAgentBudget is called, then it returns unavailable instead of throwing", async () => {
		const result = await getAgentBudget({ binary: null });

		expect(result).toEqual({ available: false, generatedAt: null, providers: [] });
	});

	it("given the CLI exits non-zero, when getAgentBudget is called, then it returns unavailable instead of throwing", async () => {
		const run = async () => {
			throw new Error("boom: non-zero exit");
		};

		const result = await getAgentBudget({ binary: "stub-fleet", run });

		expect(result).toEqual({ available: false, generatedAt: null, providers: [] });
	});

	it("given a fresh cache within the TTL, when getAgentBudget is called again, then the CLI is not re-invoked", async () => {
		const { run, callCount } = makeCountingRun(FIXTURE_STDOUT);
		let now = 0;
		const nowFn = () => now;

		await getAgentBudget({ binary: "stub-fleet", run, now: nowFn });
		now += 1_000; // well within the 10-minute TTL
		await getAgentBudget({ binary: "stub-fleet", run, now: nowFn });

		expect(callCount()).toBe(1);
	});

	it("given a stale cache with a prior good value, when getAgentBudget is called, then it serves the last-good value without waiting on the refresh", async () => {
		const { run: firstRun } = makeCountingRun(FIXTURE_STDOUT);
		let now = 0;
		const nowFn = () => now;

		const first = await getAgentBudget({ binary: "stub-fleet", run: firstRun, now: nowFn });
		expect(first.available).toBe(true);

		now += 11 * 60 * 1000; // past the 10-minute TTL
		let resolveSecondRun: (() => void) | undefined;
		const secondRun: typeof firstRun = () =>
			new Promise((resolve) => {
				resolveSecondRun = () => resolve({ stdout: FIXTURE_STDOUT });
			});

		const staleRead = await getAgentBudget({ binary: "stub-fleet", run: secondRun, now: nowFn });

		expect(staleRead).toEqual(first);
		resolveSecondRun?.();
	});

	it("given concurrent calls on a cold cache, when getAgentBudget is called twice without awaiting, then only one CLI call is made", async () => {
		const { run, callCount } = makeCountingRun(FIXTURE_STDOUT);

		const [a, b] = await Promise.all([
			getAgentBudget({ binary: "stub-fleet", run }),
			getAgentBudget({ binary: "stub-fleet", run }),
		]);

		expect(callCount()).toBe(1);
		expect(a).toEqual(b);
	});
});
