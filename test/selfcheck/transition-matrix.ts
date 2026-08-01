import type { RuntimeBoardColumnId } from "../../src/core/api-contract";

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
		productionRoute: "workspace.ensureWorktree -> runtime.startTaskSession -> session-summary projection",
		sideEffects: "keeps or creates the task worktree",
		pinnedBy: ["test/selfcheck/scenarios/givenLifecycleCardWhenCompletedThenLinkedCardStarts.ts"],
	},
	{
		id: "review-hook",
		from: "in_progress",
		to: "review",
		trigger: "agent emits an end-of-turn review hook",
		productionRoute: "hooks.ingest -> transitionToReview -> session-summary projection",
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
		productionRoute: "TerminalSessionManager process.exit -> session-summary projection",
		sideEffects: "clears the live pid and records exit review reason",
		pinnedBy: ["test/selfcheck/scenarios/givenLifecycleCardWhenCompletedThenLinkedCardStarts.ts"],
	},
	{
		id: "steer-review",
		from: "review",
		to: "in_progress",
		trigger: "human steering input is submitted",
		productionRoute: "runtime.sendTaskSessionInput -> resumeFromHumanInput -> session-summary projection",
		sideEffects: "clears reviewReason and preserves the live worktree",
		pinnedBy: ["test/selfcheck/scenarios/givenReviewCardWhenSteeredThenMovesToInProgress.ts"],
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
