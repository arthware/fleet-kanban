import { afterEach, describe, expect, it, vi } from "vitest";

import { ScenarioAssertionError, waitFor } from "../../selfcheck/scenario-api";

describe("selfcheck wait helper", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("given readiness appears after the last sampled miss, when the poll budget elapses, then it checks readiness before failing", async () => {
		// Given
		vi.useFakeTimers();
		let calls = 0;

		// When
		const ready = waitFor(
			async () => {
				calls += 1;
				return calls >= 2 ? "ready" : null;
			},
			"delayed readiness",
			100,
		);
		await vi.advanceTimersByTimeAsync(100);

		// Then
		await expect(ready).resolves.toBe("ready");
		expect(calls).toBe(2);
	});

	it("given readiness never appears, when the poll budget elapses, then it still fails", async () => {
		// Given

		// When / Then
		await expect(waitFor(async () => null, "missing readiness", 1)).rejects.toThrow(ScenarioAssertionError);
	});
});
