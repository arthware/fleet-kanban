import type { RuntimeTaskChatMessage } from "../core/api-contract";

/**
 * Read-only "tail" of a running agent's conversation: pure transforms that turn
 * the normalized transcript (produced by the agent CLI's own on-disk session,
 * via `readAgentTranscript`) into a compact, terminal-friendly window. The
 * board never re-streams or re-persists — it derives this view from the CLI's
 * artifacts on demand, so the architect can glance at what a card is doing and
 * decide whether to steer it (`fleet task say`).
 */

/**
 * Rendered lines to show when the caller gives neither an explicit line count
 * nor a time window — enough to read the current turn without flooding a shell.
 */
export const DEFAULT_TAIL_LINES = 40;

const MINUTE_MS = 60_000;

/** Fixed-width role column so multi-turn output aligns and continuation lines
 * hang cleanly beneath their turn. Widest label is 5 chars. */
const ROLE_LABELS: Record<RuntimeTaskChatMessage["role"], string> = {
	user: "user",
	assistant: "asst",
	reasoning: "think",
	tool: "tool",
	system: "sys",
	status: "stat",
};
const LABEL_WIDTH = 5;
const GUTTER = " │ ";
const CONTINUATION_INDENT = " ".repeat(LABEL_WIDTH + GUTTER.length);

/**
 * One physical line of a rendered transcript tail, tagged with its source
 * turn's creation time so a time-window filter can keep or drop the whole turn.
 */
export interface RenderedTranscriptLine {
	readonly text: string;
	readonly createdAt: number;
}

export interface SelectTranscriptTailOptions {
	/** Keep only the last N rendered lines. */
	readonly lines?: number;
	/** Keep only lines from turns created within the last M minutes. */
	readonly sinceMinutes?: number;
	/** Injectable clock (ms) for deterministic behavior; defaults to `Date.now()`. */
	readonly now?: number;
}

/**
 * Render a normalized transcript into flat display lines, oldest first (newest
 * last, matching `tail`). Each turn contributes one line per physical line of
 * its content: the first carries a role label, the rest hang-indent so a
 * multi-line turn reads as one block. Pure — no clock, no I/O.
 */
export function renderTranscriptTailLines(messages: readonly RuntimeTaskChatMessage[]): RenderedTranscriptLine[] {
	const rendered: RenderedTranscriptLine[] = [];
	for (const message of messages) {
		const label = (ROLE_LABELS[message.role] ?? message.role).padEnd(LABEL_WIDTH);
		let isFirst = true;
		for (const line of message.content.split("\n")) {
			rendered.push({
				text: isFirst ? `${label}${GUTTER}${line}` : `${CONTINUATION_INDENT}${line}`,
				createdAt: message.createdAt,
			});
			isFirst = false;
		}
	}
	return rendered;
}

/**
 * Apply the tail window: an optional time filter (last M minutes) then an
 * optional line cap (last N lines). With a line count, keep the last N. With
 * only a time window, keep everything inside it. With neither, fall back to the
 * last {@link DEFAULT_TAIL_LINES}. Order is preserved (newest last). Pure over
 * its `now`, so tests inject a fixed clock.
 */
export function selectTranscriptTail(
	lines: readonly RenderedTranscriptLine[],
	options: SelectTranscriptTailOptions = {},
): RenderedTranscriptLine[] {
	const now = options.now ?? Date.now();
	let windowed = [...lines];

	if (options.sinceMinutes !== undefined && options.sinceMinutes > 0) {
		const cutoff = now - options.sinceMinutes * MINUTE_MS;
		windowed = windowed.filter((line) => line.createdAt >= cutoff);
	}

	const maxLines =
		options.lines !== undefined ? options.lines : options.sinceMinutes !== undefined ? undefined : DEFAULT_TAIL_LINES;
	if (maxLines !== undefined && maxLines > 0 && windowed.length > maxLines) {
		windowed = windowed.slice(windowed.length - maxLines);
	}

	return windowed;
}
