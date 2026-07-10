import { describe, expect, it } from "vitest";

import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";

// The `needs_input` reviewReason is an additive refinement of an existing enum,
// not a new lifecycle column. These guard the two directions the design's §12
// calls out: an older sessions.json (no such value) must still parse, and a new
// record carrying `needs_input` must round-trip.
const baseSessionRecord = {
	taskId: "task-1",
	state: "running",
	agentId: "claude",
	workspacePath: "/tmp/worktree",
	pid: 4242,
	startedAt: null,
	updatedAt: 1_700_000_000_000,
	lastOutputAt: null,
	reviewReason: null,
	exitCode: null,
};

describe("needs_input reviewReason", () => {
	it("parses a legacy summary written before needs_input existed", () => {
		const parsed = runtimeTaskSessionSummarySchema.parse({ ...baseSessionRecord, reviewReason: "hook" });

		expect(parsed.reviewReason).toBe("hook");
	});

	it("accepts and preserves the needs_input reviewReason", () => {
		const parsed = runtimeTaskSessionSummarySchema.parse({
			...baseSessionRecord,
			state: "awaiting_review",
			reviewReason: "needs_input",
		});

		expect(parsed.state).toBe("awaiting_review");
		expect(parsed.reviewReason).toBe("needs_input");
	});

	it("rejects an unknown reviewReason value", () => {
		expect(() =>
			runtimeTaskSessionSummarySchema.parse({ ...baseSessionRecord, reviewReason: "totally-made-up" }),
		).toThrow();
	});
});
