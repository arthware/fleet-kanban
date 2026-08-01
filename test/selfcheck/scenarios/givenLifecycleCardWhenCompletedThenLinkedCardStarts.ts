import type { RuntimeConfigResponse } from "../../../src/core/api-contract";
import { LINKED_CHILD_TASK_ID, LINKED_PARENT_TASK_ID, STUB_LIFECYCLE_TASK_ID } from "../../utilities/board-seed";
import { requestJson } from "../../utilities/trpc-request";
import {
	assertOk,
	completeTask,
	driverContext,
	moveCard,
	mutateBoard,
	type ScenarioDriver,
	seedScenarioBoardState,
} from "../scenario-api";

export async function givenLifecycleCardWhenCompletedThenLinkedCardStarts(driver: ScenarioDriver): Promise<void> {
	const context = driverContext(driver);
	await seedScenarioBoardState(context);
	const config = await requestJson<RuntimeConfigResponse>({
		baseUrl: context.baseUrl,
		procedure: "runtime.getConfig",
		type: "query",
		workspaceId: context.workspaceId,
	});
	assertOk(config.status === 200, "Could not load runtime config.");
	assertOk(config.payload.effectiveCommand?.includes("stub-agent.mjs"), "Runtime is not using the stub agent.");

	await driver.expectColumn(STUB_LIFECYCLE_TASK_ID, "backlog");
	await driver.startCard(STUB_LIFECYCLE_TASK_ID);
	await driver.expectAgentFinishedCleanly(STUB_LIFECYCLE_TASK_ID);
	await mutateBoard(context, (board) => moveCard(board, STUB_LIFECYCLE_TASK_ID, "review"));
	await driver.expectColumn(STUB_LIFECYCLE_TASK_ID, "review");
	await mutateBoard(context, (board) => completeTask(board, STUB_LIFECYCLE_TASK_ID).board);
	await driver.expectColumn(STUB_LIFECYCLE_TASK_ID, "done");
	await mutateBoard(context, (board) =>
		moveCard(moveCard(board, LINKED_PARENT_TASK_ID, "in_progress"), LINKED_PARENT_TASK_ID, "review"),
	);
	// Complete from the board `mutateBoard` is about to write against, not from a board
	// read earlier: a completion computed against a stale read would overwrite whatever
	// landed in between, and on a revision-conflict retry it would replay that same
	// stale board.
	let readyTaskIds: readonly string[] = [];
	await mutateBoard(context, (board) => {
		const completedParent = completeTask(board, LINKED_PARENT_TASK_ID);
		readyTaskIds = completedParent.readyTaskIds;
		return completedParent.board;
	});
	assertOk(readyTaskIds.includes(LINKED_CHILD_TASK_ID), "Completing the linked parent did not unblock child.");
	await driver.startCard(LINKED_CHILD_TASK_ID);
	await driver.expectEnteredColumn(LINKED_CHILD_TASK_ID, "in_progress");
	await driver.expectAgentFinishedCleanly(LINKED_CHILD_TASK_ID);
}
