import { describe, expect, it } from "vitest";
import { SignalSequenceTracker } from "../../../src/agents/shared/signals";

describe("SignalSequenceTracker", () => {
	it("should assign distinct monotonic sequences for consecutive identical payloads with different observedAt times", () => {
		const tracker = new SignalSequenceTracker();
		const sessionId = "session-123";
		const name = "Stop";
		const payload = { finalMessage: "done" };

		const seq1 = tracker.getSequence(sessionId, name, payload, 1000);
		const seq2 = tracker.getSequence(sessionId, name, payload, 2000);

		expect(seq1).toBe(1);
		expect(seq2).toBe(2); // Legitimate repeat is not dropped
	});

	it("should assign the same sequence for a true replay (identical name, payload, and observedAt)", () => {
		const tracker = new SignalSequenceTracker();
		const sessionId = "session-123";
		const name = "Stop";
		const payload = { finalMessage: "done" };

		const seq1 = tracker.getSequence(sessionId, name, payload, 1000);
		const seq2 = tracker.getSequence(sessionId, name, payload, 1000); // True replay

		expect(seq1).toBe(1);
		expect(seq2).toBe(1); // Same sequence returned, which the caller will discard
	});

	it("should evict session data on request", () => {
		const tracker = new SignalSequenceTracker();
		const sessionId = "session-123";
		const name = "Stop";
		const payload = { finalMessage: "done" };

		const seq1 = tracker.getSequence(sessionId, name, payload, 1000);
		expect(seq1).toBe(1);

		tracker.evictSession(sessionId);

		const seq2 = tracker.getSequence(sessionId, name, payload, 2000);
		expect(seq2).toBe(1); // Cleared and restarted sequence
	});
});
