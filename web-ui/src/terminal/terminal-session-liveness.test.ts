import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { hasLiveTerminalSession } from "@/terminal/terminal-session-liveness";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: null,
		workspacePath: null,
		pid: 4321,
		startedAt: 1000,
		updatedAt: 1000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		agentSessionId: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

describe("hasLiveTerminalSession", () => {
	it("is not live when there is no session summary", () => {
		expect(hasLiveTerminalSession(null)).toBe(false);
	});

	it("is live when the session still has a running PTY process", () => {
		expect(hasLiveTerminalSession(createSummary({ state: "running", pid: 4321 }))).toBe(true);
	});

	it("stays live for a review session whose agent process is still attached", () => {
		// awaiting_review reached via a hook keeps the PTY alive (pid stays set),
		// so the review-column terminal must remain attachable.
		expect(hasLiveTerminalSession(createSummary({ state: "awaiting_review", pid: 4321 }))).toBe(true);
	});

	it("is not live once the PTY process has exited", () => {
		// process.exit nulls the pid but keeps the summary (state awaiting_review / interrupted).
		expect(hasLiveTerminalSession(createSummary({ state: "awaiting_review", pid: null }))).toBe(false);
		expect(hasLiveTerminalSession(createSummary({ state: "interrupted", pid: null }))).toBe(false);
	});

	it("is not live for an idle or failed session with no PTY", () => {
		expect(hasLiveTerminalSession(createSummary({ state: "idle", pid: null }))).toBe(false);
		expect(hasLiveTerminalSession(createSummary({ state: "failed", pid: null }))).toBe(false);
	});
});
