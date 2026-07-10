import { describe, expect, it } from "vitest";

import { runFleetAgentHelp } from "../../../src/server/fleet-cli";

describe("runFleetAgentHelp", () => {
	it("reports a resolution failure instead of throwing when the fleet binary is missing from PATH", async () => {
		const result = await runFleetAgentHelp("/tmp", "fleet-cli-that-does-not-exist-xyz");

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("expected the missing binary to resolve as a failure");
		}
		expect(result.error).toContain("PATH");
	});

	it("returns the trimmed stdout of the resolved binary on success", async () => {
		// Stand in for `fleet` with a binary that ignores the args and prints a
		// known instruction blob, so the success path is exercised hermetically.
		const result = await runFleetAgentHelp("/tmp", "printf", ["fleet task ls — overview\n"]);

		expect(result).toEqual({ ok: true, instructions: "fleet task ls — overview" });
	});
});
