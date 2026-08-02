// Projects a task session's state onto its card's board column.
//
// The session state machine (`TerminalSessionManager`) is the single source of truth
// for what a card's agent is doing, and it emits summaries in the order the state
// actually changed: running -> awaiting_review -> running -> ...
//
// The column is a *reduction of that ordered stream*, so it may only be written in
// emission order. Applying an emission concurrently loses that guarantee: each write
// takes the workspace file lock separately, lock acquisition is not FIFO, and a
// `running` emitted before an `awaiting_review` can therefore land after it — bouncing
// a card that had already reached Review back through In Progress and appending a
// round-trip that never happened. That is a *correctness* bug in the card's
// append-only `transitions` history, not a timing wobble.
//
// `createSessionColumnProjector` is what removes it: one serialized writer per card,
// so emission order is application order. Nothing here compares timestamps or
// allow-lists columns to decide whether a write is stale — a write cannot be stale if
// it cannot be overtaken.
import type { RuntimeBoardColumnId, RuntimeTaskSessionState } from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { getTaskColumnId, moveTaskToColumn } from "../core/task-board-mutations";
import { isTerminalLifecycleColumn } from "../core/task-lifecycle";
import { mutateWorkspaceStateById } from "../state/workspace-state";

/** The slice of a session summary the column projection reads. */
export interface ProjectableSessionSummary {
	taskId: string;
	state: RuntimeTaskSessionState;
}

export type BroadcastWorkspaceStateUpdated = (workspaceId: string, workspacePath: string) => Promise<void> | void;

export function getTargetColumnForSession(summary: ProjectableSessionSummary): RuntimeBoardColumnId | null {
	if (isHomeAgentSessionId(summary.taskId)) {
		return null;
	}
	switch (summary.state) {
		case "awaiting_review":
			return "review";
		case "running":
			return "in_progress";
		case "idle":
		case "failed":
		case "interrupted":
			return null;
		default: {
			const _exhaustive: never = summary.state;
			return null;
		}
	}
}

/**
 * Apply one session state to the card's column. Callers MUST go through
 * `createSessionColumnProjector` so a card's applications stay ordered; this is
 * exported on its own only so the single-application rules stay directly testable.
 *
 * It reads only `ProjectableSessionSummary`, never a whole session summary: the
 * summary's `workspacePath` points at the card's *worktree*, and the board lives in
 * the workspace repo. Narrowing the parameter makes writing to the wrong path
 * unrepresentable rather than merely tested for.
 *
 * A terminal card (`done` / `trash`) is never pulled back onto the agent-driven
 * stages: its lifecycle is over and the session that keeps reporting is a remnant.
 * (This is the call site `caeff`'s configurable-columns work replaces with a stage
 * lookup — see also `applyPersistedCardPrToBoard` in `runtime-state-hub.ts`.)
 */
export async function projectSessionSummaryColumn(
	workspaceId: string,
	summary: ProjectableSessionSummary,
	broadcastWorkspaceStateUpdated: BroadcastWorkspaceStateUpdated,
): Promise<boolean> {
	const targetColumnId = getTargetColumnForSession(summary);
	if (!targetColumnId) {
		return false;
	}
	try {
		const mutation = await mutateWorkspaceStateById(workspaceId, (state) => {
			const previousColumnId = getTaskColumnId(state.board, summary.taskId);
			if (!previousColumnId || previousColumnId === targetColumnId) {
				return { board: state.board, value: false, save: false };
			}
			if (isTerminalLifecycleColumn(previousColumnId)) {
				return { board: state.board, value: false, save: false };
			}
			const moved = moveTaskToColumn(state.board, summary.taskId, targetColumnId, Date.now());
			return { board: moved.board, value: moved.moved, save: moved.moved };
		});
		if (mutation.saved && mutation.value) {
			await broadcastWorkspaceStateUpdated(workspaceId, mutation.state.repoPath);
			return true;
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
		process.stderr.write(
			`[kanban] Background projection mutation failed for task "${summary.taskId}" in workspace "${workspaceId}": ${errorMessage}\n`,
		);
	}
	return false;
}

export interface SessionColumnProjector {
	/**
	 * Queue `summary` behind this card's outstanding projections. Resolves once this
	 * projection has been applied; callers on the emit path fire and forget.
	 */
	project(workspaceId: string, summary: ProjectableSessionSummary): Promise<void>;
}

/**
 * One serialized column writer per card.
 *
 * Serializing per card rather than per workspace keeps the ordering guarantee where
 * it belongs — a card's own state stream — without making every card on a busy board
 * queue behind the slowest one. Two cards writing concurrently is safe: the workspace
 * state mutation re-reads the board under its lock, so neither loses the other's move.
 */
export function createSessionColumnProjector(
	broadcastWorkspaceStateUpdated: BroadcastWorkspaceStateUpdated,
): SessionColumnProjector {
	const pendingByCard = new Map<string, Promise<void>>();

	return {
		project: (workspaceId, summary) => {
			const cardKey = JSON.stringify([workspaceId, summary.taskId]);
			// `projectSessionSummaryColumn` reports failures instead of throwing, so a
			// failed projection cannot break the chain for the states that follow it.
			const applied = (pendingByCard.get(cardKey) ?? Promise.resolve()).then(async () => {
				await projectSessionSummaryColumn(workspaceId, summary, broadcastWorkspaceStateUpdated);
			});
			pendingByCard.set(cardKey, applied);
			void applied.then(() => {
				if (pendingByCard.get(cardKey) === applied) {
					pendingByCard.delete(cardKey);
				}
			});
			return applied;
		},
	};
}
