import { describe, expect, it } from "vitest";
import {
	DEFAULT_TAIL_LINES,
	renderTranscriptTailLines,
	selectTranscriptTail,
} from "../../../src/commands/task-transcript-tail";
import type { RuntimeTaskChatMessage } from "../../../src/core/api-contract";

function message(
	overrides: Partial<RuntimeTaskChatMessage> & Pick<RuntimeTaskChatMessage, "role" | "content">,
): RuntimeTaskChatMessage {
	return {
		id: overrides.id ?? "m",
		role: overrides.role,
		content: overrides.content,
		createdAt: overrides.createdAt ?? 0,
	};
}

const MINUTE = 60_000;

describe("renderTranscriptTailLines", () => {
	it("labels each turn by role and keeps conversation order, newest last", () => {
		const rendered = renderTranscriptTailLines([
			message({ role: "user", content: "fix the bug", createdAt: 1 }),
			message({ role: "assistant", content: "on it", createdAt: 2 }),
		]);

		expect(rendered.map((line) => line.text)).toEqual(["user  │ fix the bug", "asst  │ on it"]);
		expect(rendered.map((line) => line.createdAt)).toEqual([1, 2]);
	});

	it("hangs continuation lines under a multi-line turn so it reads as one block", () => {
		const rendered = renderTranscriptTailLines([
			message({ role: "tool", content: "Tool: Bash\nInput: ls -la", createdAt: 7 }),
		]);

		expect(rendered.map((line) => line.text)).toEqual(["tool  │ Tool: Bash", "        Input: ls -la"]);
		// Every physical line inherits the source turn's time so a --since window
		// keeps or drops the whole turn together.
		expect(rendered.every((line) => line.createdAt === 7)).toBe(true);
	});

	it("renders an empty transcript as no lines", () => {
		expect(renderTranscriptTailLines([])).toEqual([]);
	});
});

describe("selectTranscriptTail", () => {
	function lines(count: number, at = 0) {
		return Array.from({ length: count }, (_unused, index) => ({ text: `line-${index}`, createdAt: at }));
	}

	it("keeps only the last N lines when a line count is given", () => {
		const tail = selectTranscriptTail(lines(10), { lines: 3 });

		expect(tail.map((line) => line.text)).toEqual(["line-7", "line-8", "line-9"]);
	});

	it("keeps only lines from turns within the last M minutes", () => {
		const now = 100 * MINUTE;
		const windowed = selectTranscriptTail(
			[
				{ text: "old", createdAt: now - 30 * MINUTE },
				{ text: "recent", createdAt: now - 4 * MINUTE },
				{ text: "newest", createdAt: now - 1 * MINUTE },
			],
			{ sinceMinutes: 5, now },
		);

		expect(windowed.map((line) => line.text)).toEqual(["recent", "newest"]);
	});

	it("applies the time window first, then caps to the line count", () => {
		const now = 100 * MINUTE;
		const within = Array.from({ length: 6 }, (_unused, index) => ({
			text: `in-${index}`,
			createdAt: now - 2 * MINUTE,
		}));
		const stale = { text: "stale", createdAt: now - 30 * MINUTE };

		const tail = selectTranscriptTail([stale, ...within], { sinceMinutes: 5, lines: 2, now });

		expect(tail.map((line) => line.text)).toEqual(["in-4", "in-5"]);
	});

	it("falls back to the default tail length when neither window nor count is given", () => {
		const tail = selectTranscriptTail(lines(DEFAULT_TAIL_LINES + 5));

		expect(tail).toHaveLength(DEFAULT_TAIL_LINES);
		expect(tail[0]?.text).toBe(`line-${5}`);
	});

	it("returns everything within the window when only a time filter is given", () => {
		const now = 10 * MINUTE;
		const tail = selectTranscriptTail(lines(DEFAULT_TAIL_LINES + 20, now), { sinceMinutes: 60, now });

		expect(tail).toHaveLength(DEFAULT_TAIL_LINES + 20);
	});

	it("returns an empty tail for an empty transcript", () => {
		expect(selectTranscriptTail([])).toEqual([]);
	});
});
