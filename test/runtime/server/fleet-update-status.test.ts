import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	applyFleetUpdate,
	getFleetUpdateStatus,
	resetFleetUpdateStatusCacheForTests,
} from "../../../src/server/fleet-update-status";

const VENDOR_UP_TO_DATE_STDOUT = JSON.stringify({
	mode: "vendor",
	current: "abc1234abc1234abc1234abc1234abc1234abc1",
	latest: "abc1234abc1234abc1234abc1234abc1234abc1",
	updateAvailable: false,
});

const VENDOR_BEHIND_STDOUT = JSON.stringify({
	mode: "vendor",
	current: "abc1234abc1234abc1234abc1234abc1234abc1",
	latest: "def5678def5678def5678def5678def5678def5",
	updateAvailable: true,
});

const SOURCE_MODE_STDOUT = JSON.stringify({
	mode: "source",
	current: null,
	latest: null,
	updateAvailable: false,
});

function makeCountingRun(stdout: string) {
	let calls = 0;
	const run = async (_binary: string, _args: string[]) => {
		calls += 1;
		return { stdout };
	};
	return { run, callCount: () => calls };
}

describe("getFleetUpdateStatus", () => {
	beforeEach(() => {
		resetFleetUpdateStatusCacheForTests();
	});

	it("given a captured fleet update --check --json fixture reporting an update, when resolved, then it maps to the status shape", async () => {
		const { run } = makeCountingRun(VENDOR_BEHIND_STDOUT);

		const result = await getFleetUpdateStatus({ binary: "stub-fleet", run });

		expect(result).toEqual({
			mode: "vendor",
			current: "abc1234abc1234abc1234abc1234abc1234abc1",
			latest: "def5678def5678def5678def5678def5678def5",
			updateAvailable: true,
		});
	});

	it("given a source-mode fixture, when resolved, then updateAvailable is false and current/latest are null", async () => {
		const { run } = makeCountingRun(SOURCE_MODE_STDOUT);

		const result = await getFleetUpdateStatus({ binary: "stub-fleet", run });

		expect(result).toEqual({ mode: "source", current: null, latest: null, updateAvailable: false });
	});

	it("given the fleet binary cannot be resolved, when getFleetUpdateStatus is called, then it returns the source-mode unavailable default instead of throwing", async () => {
		const result = await getFleetUpdateStatus({ binary: null });

		expect(result).toEqual({ mode: "source", current: null, latest: null, updateAvailable: false });
	});

	it("given the CLI exits non-zero, when getFleetUpdateStatus is called, then it returns the unavailable default instead of throwing", async () => {
		const run = async () => {
			throw new Error("boom: non-zero exit");
		};

		const result = await getFleetUpdateStatus({ binary: "stub-fleet", run });

		expect(result).toEqual({ mode: "source", current: null, latest: null, updateAvailable: false });
	});

	it("given a fresh cache within the TTL, when getFleetUpdateStatus is called again, then the CLI is not re-invoked", async () => {
		const { run, callCount } = makeCountingRun(VENDOR_UP_TO_DATE_STDOUT);
		let now = 0;
		const nowFn = () => now;

		await getFleetUpdateStatus({ binary: "stub-fleet", run, now: nowFn });
		now += 5 * 60 * 1000; // well within the 60-minute TTL
		await getFleetUpdateStatus({ binary: "stub-fleet", run, now: nowFn });

		expect(callCount()).toBe(1);
	});

	it("given a stale cache with a prior good value, when getFleetUpdateStatus is called, then it serves the last-good value without waiting on the refresh", async () => {
		const { run: firstRun } = makeCountingRun(VENDOR_UP_TO_DATE_STDOUT);
		let now = 0;
		const nowFn = () => now;

		const first = await getFleetUpdateStatus({ binary: "stub-fleet", run: firstRun, now: nowFn });
		expect(first.mode).toBe("vendor");

		now += 61 * 60 * 1000; // past the 60-minute TTL
		let resolveSecondRun: (() => void) | undefined;
		const secondRun: typeof firstRun = () =>
			new Promise((resolve) => {
				resolveSecondRun = () => resolve({ stdout: VENDOR_BEHIND_STDOUT });
			});

		const staleRead = await getFleetUpdateStatus({ binary: "stub-fleet", run: secondRun, now: nowFn });

		expect(staleRead).toEqual(first);
		resolveSecondRun?.();
	});

	it("given concurrent calls on a cold cache, when getFleetUpdateStatus is called twice without awaiting, then only one CLI call is made", async () => {
		const { run, callCount } = makeCountingRun(VENDOR_UP_TO_DATE_STDOUT);

		const [a, b] = await Promise.all([
			getFleetUpdateStatus({ binary: "stub-fleet", run }),
			getFleetUpdateStatus({ binary: "stub-fleet", run }),
		]);

		expect(callCount()).toBe(1);
		expect(a).toEqual(b);
	});
});

describe("applyFleetUpdate", () => {
	beforeEach(() => {
		resetFleetUpdateStatusCacheForTests();
	});

	it("given cards are in progress, when applyFleetUpdate is called, then it does not spawn and reports cards-in-progress", async () => {
		const { run } = makeCountingRun(VENDOR_BEHIND_STDOUT);
		const spawnDetached = vi.fn();

		const result = await applyFleetUpdate({
			binary: "stub-fleet",
			run,
			inProgressCount: 2,
			spawnDetached,
			openLogFd: () => 0,
		});

		expect(result).toEqual({ started: false, reason: "cards-in-progress" });
		expect(spawnDetached).not.toHaveBeenCalled();
	});

	it("given no cards in progress but the board is already up to date, when applyFleetUpdate is called, then it does not spawn and reports nothing-to-do", async () => {
		const { run } = makeCountingRun(VENDOR_UP_TO_DATE_STDOUT);
		const spawnDetached = vi.fn();

		const result = await applyFleetUpdate({
			binary: "stub-fleet",
			run,
			inProgressCount: 0,
			spawnDetached,
			openLogFd: () => 0,
		});

		expect(result).toEqual({ started: false, reason: "nothing-to-do" });
		expect(spawnDetached).not.toHaveBeenCalled();
	});

	it("given no cards in progress and a source-mode board, when applyFleetUpdate is called, then it does not spawn and reports nothing-to-do", async () => {
		const { run } = makeCountingRun(SOURCE_MODE_STDOUT);
		const spawnDetached = vi.fn();

		const result = await applyFleetUpdate({
			binary: "stub-fleet",
			run,
			inProgressCount: 0,
			spawnDetached,
			openLogFd: () => 0,
		});

		expect(result).toEqual({ started: false, reason: "nothing-to-do" });
		expect(spawnDetached).not.toHaveBeenCalled();
	});

	it("given no cards in progress and an update is available, when applyFleetUpdate is called, then it spawns the update+restart detached and reports started", async () => {
		const { run } = makeCountingRun(VENDOR_BEHIND_STDOUT);
		const unref = vi.fn();
		const spawnDetached = vi.fn().mockReturnValue({ unref });
		const openLogFd = vi.fn().mockReturnValue(7);
		const closeLogFd = vi.fn();

		const result = await applyFleetUpdate({
			binary: "stub-fleet",
			run,
			inProgressCount: 0,
			spawnDetached,
			openLogFd,
			closeLogFd,
		});

		expect(result).toEqual({ started: true, reason: null });
		expect(spawnDetached).toHaveBeenCalledWith(
			"sh",
			["-c", "fleet update && fleet service restart"],
			expect.objectContaining({ detached: true, stdio: ["ignore", 7, 7] }),
		);
		expect(unref).toHaveBeenCalledTimes(1);
		expect(closeLogFd).toHaveBeenCalledWith(7);
	});
});
