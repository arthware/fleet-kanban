import { describe, expect, it } from "vitest";

import { classifyAgentSessionLifecycle, resolveLaunchSessionId } from "../../../src/terminal/agent-session-launch";

describe("resolveLaunchSessionId", () => {
	it("mints a fresh session id for a new Claude start", () => {
		const result = resolveLaunchSessionId({
			agentId: "claude",
			storedSessionId: null,
			resumeMode: "fresh",
			mintSessionId: () => "minted-id",
		});

		expect(result).toEqual({ agentSessionId: "minted-id", resumeSession: false });
	});

	it("resumes by the stored id when a task already has one", () => {
		const result = resolveLaunchSessionId({
			agentId: "claude",
			storedSessionId: "stored-id",
			resumeMode: "resume",
			mintSessionId: () => "should-not-be-used",
		});

		expect(result).toEqual({ agentSessionId: "stored-id", resumeSession: true });
	});

	it("starts fresh instead of resuming a gone stored session id", () => {
		const result = resolveLaunchSessionId({
			agentId: "claude",
			storedSessionId: "dead-stored-id",
			resumeMode: "fresh",
			mintSessionId: () => "minted-id",
		});

		expect(result).toEqual({ agentSessionId: "minted-id", resumeSession: false });
	});

	it("does not mint a replacement id when a requested resume is not resumable", () => {
		const result = resolveLaunchSessionId({
			agentId: "claude",
			storedSessionId: "dead-stored-id",
			resumeMode: "unavailable",
			mintSessionId: () => "should-not-be-used",
		});

		expect(result).toEqual({ agentSessionId: "dead-stored-id", resumeSession: false });
	});

	it("does not mint an id for a fresh Codex start, since Codex assigns its own", () => {
		const result = resolveLaunchSessionId({
			agentId: "codex",
			storedSessionId: null,
			resumeMode: "fresh",
			mintSessionId: () => "should-not-be-used",
		});

		expect(result).toEqual({ agentSessionId: null, resumeSession: false });
	});

	it("leaves agents without id-based resume to their heuristic fallback", () => {
		const result = resolveLaunchSessionId({
			agentId: "gemini",
			storedSessionId: null,
			resumeMode: "fresh",
			mintSessionId: () => "should-not-be-used",
		});

		expect(result).toEqual({ agentSessionId: null, resumeSession: false });
	});
});

describe("classifyAgentSessionLifecycle", () => {
	it("reports a session with a live process as attached", () => {
		expect(
			classifyAgentSessionLifecycle({
				hasLiveProcess: true,
				agentSessionId: "id",
				transcriptPresent: true,
			}),
		).toBe("attached");
	});

	it("reports a dead session with a stored id and an on-disk transcript as resumable", () => {
		expect(
			classifyAgentSessionLifecycle({
				hasLiveProcess: false,
				agentSessionId: "id",
				transcriptPresent: true,
			}),
		).toBe("resumable");
	});

	it("reports a dead session whose transcript is gone as gone", () => {
		expect(
			classifyAgentSessionLifecycle({
				hasLiveProcess: false,
				agentSessionId: "id",
				transcriptPresent: false,
			}),
		).toBe("gone");
	});

	it("reports a dead session that never captured an id as gone", () => {
		expect(
			classifyAgentSessionLifecycle({
				hasLiveProcess: false,
				agentSessionId: null,
				transcriptPresent: true,
			}),
		).toBe("gone");
	});
});
