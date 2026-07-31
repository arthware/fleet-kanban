import { describe, expect, it } from "vitest";

import { applySignalsBySeq, findDriverIntegrationScopeViolations } from "./driver-tck";

describe("driver TCK executable intent", () => {
	it("goes red when duplicate seq values are not deduped", () => {
		const signal = {
			seq: 7,
			at: 1_000,
			fact: { type: "progress" as const },
			activity: null,
		};

		expect(applySignalsBySeq([signal, signal])).toHaveLength(1);
	});

	it("goes red when an older seq arrives after a newer signal", () => {
		const newer = {
			seq: 7,
			at: 1_000,
			fact: { type: "turn.ended" as const, finalMessage: "done" },
			activity: null,
		};
		const older = {
			seq: 6,
			at: 1_001,
			fact: { type: "attention.required" as const, cause: "question" as const },
			activity: null,
		};

		expect(applySignalsBySeq([newer, older])).toEqual([newer]);
	});

	it("codifies the allowed file scope for adding a new driver", () => {
		expect(
			findDriverIntegrationScopeViolations({
				driverId: "pi",
				changedFiles: [
					"src/agents/pi/driver.ts",
					"test/agents/tck/fixtures/pi/transcript.jsonl",
					"src/agents/driver.ts",
					"src/core/api-contract.ts",
					"test/agents/tck/driver-tck.ts",
				],
			}),
		).toEqual([]);
	});

	it("rejects driver integrations that edit runtime orchestration", () => {
		expect(
			findDriverIntegrationScopeViolations({
				driverId: "pi",
				changedFiles: ["src/agents/pi/driver.ts", "src/terminal/session-manager.ts"],
			}),
		).toEqual(["src/terminal/session-manager.ts"]);
	});
});
