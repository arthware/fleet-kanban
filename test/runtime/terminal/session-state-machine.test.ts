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

	describe("hook.to_needs_input (agent blocked on a question)", () => {
		it("moves a running session to awaiting_review with reviewReason 'needs_input'", () => {
			const summary = createRunningSummary({ pid: 4242 });

			const result = reduceSessionTransition(summary, { type: "hook.to_needs_input" });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("awaiting_review");
			expect(result.patch.reviewReason).toBe("needs_input");
			// Like to_review, it must keep the PTY alive so `fleet task say` can answer.
			expect(result.patch).not.toHaveProperty("pid");
			const next = { ...summary, ...result.patch };
			expect(next.pid).toBe(4242);
		});

		it("is a no-op when the session is not running", () => {
			const summary = createRunningSummary({ state: "awaiting_review", reviewReason: "needs_input" });

			const result = reduceSessionTransition(summary, { type: "hook.to_needs_input" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
		});

		it("clears back to running on to_in_progress once the agent is answered", () => {
			const summary = createRunningSummary({ state: "awaiting_review", reviewReason: "needs_input" });

			const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("running");
			expect(result.patch.reviewReason).toBeNull();
		});

		it("clears back to running on agent.prompt-ready", () => {
			const summary = createRunningSummary({ state: "awaiting_review", reviewReason: "needs_input" });

			const result = reduceSessionTransition(summary, { type: "agent.prompt-ready" });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("running");
			expect(result.patch.reviewReason).toBeNull();
		});
	});

	describe("human review dormancy", () => {
		it("wakes a completed review card when an explicit to_in_progress hook arrives", () => {
			const summary = createRunningSummary({ state: "awaiting_review", reviewReason: "hook" });

			const result = reduceSessionTransition(summary, { type: "hook.to_in_progress" });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("running");
			expect(result.patch.reviewReason).toBeNull();
		});

		it("keeps a completed review card dormant when idle terminal output only looks prompt-ready", () => {
			const summary = createRunningSummary({ state: "awaiting_review", reviewReason: "hook" });

			const result = reduceSessionTransition(summary, { type: "agent.prompt-ready" });

			expect(result.changed).toBe(false);
			expect(result.patch).toEqual({});
		});

		it("wakes a completed review card when a human submits steering input", () => {
			const summary = createRunningSummary({ state: "awaiting_review", reviewReason: "hook" });

			const result = reduceSessionTransition(summary, { type: "human.input_submitted" });

			expect(result.changed).toBe(true);
			expect(result.patch.state).toBe("running");
			expect(result.patch.reviewReason).toBeNull();
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
