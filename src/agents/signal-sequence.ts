export class SignalSequenceTracker {
	private readonly sequences = new Map<string, number>();
	// Map of sessionId -> Map of fingerprint -> seq
	private readonly seenFingerprints = new Map<string, Map<string, number>>();

	public getSequence(sessionId: string, name: string, payload: unknown, observedAt: number): number {
		let payloadStr = "";
		try {
			payloadStr = JSON.stringify(payload);
		} catch {
			payloadStr = String(payload);
		}
		// Fingerprint includes observedAt to distinguish identical repeat events from real replays
		const fingerprint = `${name}:${payloadStr}:${observedAt}`;

		let seen = this.seenFingerprints.get(sessionId);
		if (!seen) {
			seen = new Map();
			this.seenFingerprints.set(sessionId, seen);
		}

		const existingSeq = seen.get(fingerprint);
		if (existingSeq !== undefined) {
			return existingSeq;
		}

		let seq = this.sequences.get(sessionId) ?? 0;
		seq += 1;
		this.sequences.set(sessionId, seq);

		seen.set(fingerprint, seq);
		// Keep sliding window of size 10 to limit memory growth
		if (seen.size > 10) {
			const firstKey = seen.keys().next().value;
			if (firstKey !== undefined) {
				seen.delete(firstKey);
			}
		}

		return seq;
	}

	public evictSession(sessionId: string): void {
		this.sequences.delete(sessionId);
		this.seenFingerprints.delete(sessionId);
	}
}

export const SIGNAL_SEQUENCE_TRACKER = new SignalSequenceTracker();
