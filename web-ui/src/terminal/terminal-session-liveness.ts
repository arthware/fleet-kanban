import type { RuntimeTaskSessionSummary } from "@/runtime/types";

/**
 * True only when a task session has a live PTY process to attach a terminal to.
 *
 * The server keeps `pid` in lockstep with the real process: it is set on spawn
 * and reset to `null` the moment the PTY exits (see the `process.exit` reducer
 * in `session-state-machine.ts`). Idle, failed, interrupted and post-exit
 * sessions therefore all carry `pid === null`, as do non-PTY Cline chat
 * sessions. `state` alone is ambiguous — an `awaiting_review` session can be
 * either alive (hook-driven, PTY still running) or dead (process exited) — so
 * `pid` is the reliable signal for "there is something to attach to".
 *
 * Gating the live-terminal machinery on this avoids wiring up a WebSocket +
 * ResizeObserver for a session that no longer exists, which is what freezes the
 * renderer when a stale card is reopened.
 */
export function hasLiveTerminalSession(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	return summary != null && summary.pid != null;
}
