import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { reduceSessionTransition } from "../../../src/terminal/session-state-machine";

function createRunningSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 4242,
		startedAt: 1_000,
		updatedAt: 1_000,
		lastOutputAt: 1_000,
		reviewReason: null,
		exitCode: null,
		agentSessionId: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

describe("reduceSessionTransition", () => {
	describe("hook.to_review (permission prompt / end-of-turn stop)", () => {
		it("moves a running session to awaiting_review WITHOUT killing the PTY process", () => {
			// This is the load-bearing invariant behind `fleet task say`: a card that
			// hits a permission prompt keeps a live PTY (pid stays non-null), so the
			// architect's steering message can still be written into the session.
			const summary = createRunningSummary({ pid: 4242 });

			const result = reduceSessionTransition(summary, { type: "hook.to_review" });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("awaiting_review");
			expect(result.patch.reviewReason).toBe("hook");
			// The patch must not null the pid — the process is still alive and blocked.
			expect(result.patch).not.toHaveProperty("pid");
			const next = { ...summary, ...result.patch };
			expect(next.pid).toBe(4242);
		});

		it("is a no-op when the session is not running", () => {
			const summary = createRunningSummary({ state: "awaiting_review", reviewReason: "hook" });

			const result = reduceSessionTransition(summary, { type: "hook.to_review" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
		});
	});

	describe("process.exit", () => {
		it("nulls the pid so the session reads as ended (not steerable)", () => {
			const summary = createRunningSummary({ pid: 4242 });

			const result = reduceSessionTransition(summary, {
				type: "process.exit",
				exitCode: 0,
				interrupted: false,
			});

			expect(result.patch.pid).toBeNull();
			const next = { ...summary, ...result.patch };
			expect(next.pid).toBeNull();
		});
	});
});
