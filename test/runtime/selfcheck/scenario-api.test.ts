import { describe, expect, it } from "vitest";

import { ScenarioAssertionError, waitFor } from "../../selfcheck/scenario-api";

describe("selfcheck wait helper", () => {
	it("given readiness appears after the last sampled miss, when the poll budget elapses, then it checks readiness before failing", async () => {
		// Given
		let calls = 0;

		// When / Then
		await expect(
			waitFor(
				async () => {
					calls += 1;
					return calls >= 2 ? "ready" : null;
				},
				"delayed readiness",
				1,
			),
		).resolves.toBe("ready");
		expect(calls).toBe(2);
	});

	it("given readiness never appears, when the poll budget elapses, then it still fails", async () => {
		// Given

		// When / Then
		await expect(waitFor(async () => null, "missing readiness", 1)).rejects.toThrow(ScenarioAssertionError);
	});
});
