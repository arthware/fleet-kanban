import { describe, expect, it } from "vitest";

import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

function runningSummaryWithSessionId(taskId: string, agentSessionId: string) {
	return runtimeTaskSessionSummarySchema.parse({
		taskId,
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 4321,
		startedAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		lastOutputAt: 1_700_000_000_000,
		reviewReason: null,
		exitCode: null,
		agentSessionId,
	});
}

describe("recovering a stale session", () => {
	it("keeps the agent session id so the task can be resumed later", () => {
		const manager = new TerminalSessionManager();
		// Hydrate a task that was mid-run when the runtime died: its summary says
		// "running" but no live process is attached (hydrate never restores one).
		manager.hydrateFromRecord({
			"task-1": runningSummaryWithSessionId("task-1", "session-to-resume"),
		});

		const recovered = manager.recoverStaleSession("task-1");

		expect(recovered?.state).toBe("idle");
		expect(recovered?.agentSessionId).toBe("session-to-resume");
	});
});
