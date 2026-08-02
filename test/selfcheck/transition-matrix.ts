import type { RuntimeBoardColumnId } from "../../src/core/api-contract";

/**
 * Every way a card can change column, and what pins it.
 *
 * The board's `transitions` history is measured (agent quality, cycle time), so a
 * transition that fires when it should not is a data bug, not a cosmetic one. This
 * table exists so the gaps are *visible*: `pinnedBy` names the test that actually
 * exercises the row, and a row nobody covers fails the guard rather than quietly
 * going unwatched.
 *
 * Note how many rows route through `src/server/session-column-projection.ts`: the
 * agent-driven stages are not written by the hook, the steer, or the process exit
 * directly — all three change the *session* state, and the column follows from that
 * one ordered stream. Anything reworking these routes (e.g. configurable columns
 * replacing the column ids here with a stage lookup) should start from that file.
 */
export interface LifecycleTransitionMatrixRow {
	id: string;
	from: RuntimeBoardColumnId | "none";
	to: RuntimeBoardColumnId;
	trigger: string;
	productionRoute: string;
	sideEffects: string;
	pinnedBy: readonly string[];
}

export const LIFECYCLE_TRANSITION_MATRIX: readonly LifecycleTransitionMatrixRow[] = [
	{
		id: "create-card",
		from: "none",
		to: "backlog",
		trigger: "human or CLI creates a task",
		productionRoute: "addTaskToColumn",
		sideEffects: "seeds the first append-only transition entry",
		pinnedBy: ["test/runtime/task-board-mutations.test.ts"],
	},
	{
		id: "start-card",
		from: "backlog",
		to: "in_progress",
		trigger: "human starts a task session",
		productionRoute: "workspace.ensureWorktree -> runtime.startTaskSession -> session-column-projection",
		sideEffects: "keeps or creates the task worktree",
		pinnedBy: ["test/selfcheck/scenarios/givenLifecycleCardWhenCompletedThenLinkedCardStarts.ts"],
	},
	{
		id: "review-hook",
		from: "in_progress",
		to: "review",
		trigger: "agent emits an end-of-turn review hook",
		productionRoute: "hooks.ingest -> transitionToReview -> session-column-projection",
		sideEffects: "sets reviewReason=hook, captures a turn checkpoint, notifies the overseer",
		pinnedBy: [
			"test/selfcheck/scenarios/givenReviewCardWhenSteeredThenMovesToInProgress.ts",
			"test/selfcheck/scenarios/givenReviewHookWhenIngestedThenOverseerIsNotified.ts",
		],
	},
	{
		id: "process-exit-review",
		from: "in_progress",
		to: "review",
		trigger: "agent process exits",
		productionRoute: "TerminalSessionManager process.exit -> session-column-projection",
		sideEffects: "clears the live pid and records exit review reason",
		pinnedBy: ["test/selfcheck/scenarios/givenLifecycleCardWhenCompletedThenLinkedCardStarts.ts"],
	},
	{
		id: "steer-review",
		from: "review",
		to: "in_progress",
		trigger: "human steering input is submitted",
		productionRoute: "runtime.sendTaskSessionInput -> resumeFromHumanInput -> session-column-projection",
		sideEffects: "clears reviewReason and preserves the live worktree",
		pinnedBy: [
			"test/selfcheck/scenarios/givenReviewCardWhenSteeredThenMovesToInProgress.ts",
			"test/runtime/server/session-column-projection.test.ts",
		],
	},
	{
		id: "complete-review",
		from: "review",
		to: "done",
		trigger: "human completes a reviewed task",
		productionRoute: "completeTaskAndGetReadyLinkedTaskIds",
		sideEffects: "keeps the worktree and returns ready linked backlog task ids",
		pinnedBy: ["test/selfcheck/scenarios/givenLifecycleCardWhenCompletedThenLinkedCardStarts.ts"],
	},
	{
		id: "linked-card-auto-start",
		from: "backlog",
		to: "in_progress",
		trigger: "linked prerequisite task is completed",
		productionRoute: "completeTaskAndGetReadyLinkedTaskIds -> runtime.startTaskSession",
		sideEffects: "auto-starts newly unblocked linked backlog cards",
		pinnedBy: ["test/selfcheck/scenarios/givenLifecycleCardWhenCompletedThenLinkedCardStarts.ts"],
	},
	{
		id: "archive-reviewed-card",
		from: "review",
		to: "trash",
		trigger: "human archives a reviewed task",
		productionRoute: "trashTaskAndGetReadyLinkedTaskIds",
		sideEffects: "does not auto-start linked backlog cards",
		pinnedBy: ["test/runtime/task-board-mutations.test.ts"],
	},
	{
		id: "pr-merged",
		from: "review",
		to: "done",
		trigger: "metadata monitor observes a merged PR",
		productionRoute: "applyPersistedCardPrToBoard",
		sideEffects: "persists PR metadata and completes the card",
		pinnedBy: ["test/runtime/server/runtime-state-hub.test.ts"],
	},
	{
		id: "pr-closed",
		from: "review",
		to: "trash",
		trigger: "metadata monitor observes a closed unmerged PR",
		productionRoute: "applyPersistedCardPrToBoard",
		sideEffects: "persists PR metadata and archives abandoned work without auto-starting linked cards",
		pinnedBy: ["test/runtime/server/runtime-state-hub.test.ts"],
	},
];
