import type { RuntimeConfigResponse } from "../../../src/core/api-contract";
import {
	LINKED_CHILD_TASK_ID,
	LINKED_PARENT_TASK_ID,
	STUB_LIFECYCLE_TASK_ID,
	seedIsolatedBoardState,
} from "../../utilities/board-seed";
import { requestJson } from "../../utilities/trpc-request";
import {
	assertOk,
	completeTask,
	driverContext,
	loadState,
	moveCard,
	mutateBoard,
	type ScenarioDriver,
	waitFor,
} from "../scenario-api";

export async function givenLifecycleCardWhenCompletedThenLinkedCardStarts(driver: ScenarioDriver): Promise<void> {
	const context = driverContext(driver);
	seedIsolatedBoardState({ homeDir: context.instance.homeDir, workspaceId: context.workspaceId });
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
	await waitFor(async () => {
		const state = await loadState(context);
		const summary = state.sessions[STUB_LIFECYCLE_TASK_ID];
		return summary?.state === "awaiting_review" && summary.exitCode === 0 ? true : null;
	}, "stub card to reach review");
	await mutateBoard(context, (board) => moveCard(board, STUB_LIFECYCLE_TASK_ID, "review"));
	await driver.expectColumn(STUB_LIFECYCLE_TASK_ID, "review");
	await mutateBoard(context, (board) => completeTask(board, STUB_LIFECYCLE_TASK_ID).board);
	await driver.expectColumn(STUB_LIFECYCLE_TASK_ID, "done");
	await mutateBoard(context, (board) =>
		moveCard(moveCard(board, LINKED_PARENT_TASK_ID, "in_progress"), LINKED_PARENT_TASK_ID, "review"),
	);
	const completed = completeTask((await loadState(context)).board, LINKED_PARENT_TASK_ID);
	assertOk(
		completed.readyTaskIds.includes(LINKED_CHILD_TASK_ID),
		"Completing the linked parent did not unblock child.",
	);
	await mutateBoard(context, () => completed.board);
	await driver.startCard(LINKED_CHILD_TASK_ID);
	await driver.expectColumn(LINKED_CHILD_TASK_ID, "in_progress");
}
