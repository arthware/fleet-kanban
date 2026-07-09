import { describe, expect, it } from "vitest";

import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

// A minimal sessions.json record as it would be written to disk, minus the
// agentSessionId field — i.e. exactly what an older build persisted before this
// field existed. Kept deliberately terse: only the fields the schema requires.
const legacySessionRecord = {
	taskId: "task-1",
	state: "idle",
	agentId: "claude",
	workspacePath: "/tmp/worktree",
	pid: null,
	startedAt: null,
	updatedAt: 1_700_000_000_000,
	lastOutputAt: null,
	reviewReason: null,
	exitCode: null,
};

describe("agentSessionId on the task-session summary", () => {
	it("defaults to null when a sessions.json written before this field is parsed", () => {
		const parsed = runtimeTaskSessionSummarySchema.parse(legacySessionRecord);

		expect(parsed.agentSessionId).toBeNull();
	});

	it("preserves an agent session id that was written to sessions.json", () => {
		const parsed = runtimeTaskSessionSummarySchema.parse({
			...legacySessionRecord,
			agentSessionId: "11111111-2222-3333-4444-555555555555",
		});

		expect(parsed.agentSessionId).toBe("11111111-2222-3333-4444-555555555555");
	});

	it("keeps the agent session id stable across a write → read → write cycle", () => {
		const first = runtimeTaskSessionSummarySchema.parse({
			...legacySessionRecord,
			agentSessionId: "abc-session-id",
		});
		const roundTripped = runtimeTaskSessionSummarySchema.parse(first);

		expect(roundTripped.agentSessionId).toBe("abc-session-id");
	});
});

describe("TerminalSessionManager session-id hydration", () => {
	it("keeps an agent session id set on start alive through a hydrate round-trip", () => {
		const record = {
			"task-1": runtimeTaskSessionSummarySchema.parse({
				...legacySessionRecord,
				agentSessionId: "session-from-start",
			}),
		};

		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord(record);

		expect(manager.getSummary("task-1")?.agentSessionId).toBe("session-from-start");
	});

	it("re-hydrates a persisted summary without losing the agent session id", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": runtimeTaskSessionSummarySchema.parse({
				...legacySessionRecord,
				agentSessionId: "session-a",
			}),
		});

		// Simulate the persist → reload path: read the current summary back out,
		// then hand it to a fresh manager as if it were loaded from sessions.json.
		const persisted = manager.getSummary("task-1");
		expect(persisted).not.toBeNull();

		const reloaded = new TerminalSessionManager();
		reloaded.hydrateFromRecord({ "task-1": persisted as NonNullable<typeof persisted> });

		expect(reloaded.getSummary("task-1")?.agentSessionId).toBe("session-a");
	});

	it("defaults a hydrated legacy summary's agent session id to null", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": runtimeTaskSessionSummarySchema.parse(legacySessionRecord),
		});

		expect(manager.getSummary("task-1")?.agentSessionId).toBeNull();
	});
});
