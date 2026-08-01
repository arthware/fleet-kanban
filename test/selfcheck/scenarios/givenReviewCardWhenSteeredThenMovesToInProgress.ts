import { assertOk, createSelfcheckCard, driverContext, loadState, type ScenarioDriver } from "../scenario-api";

export async function givenReviewCardWhenSteeredThenMovesToInProgress(driver: ScenarioDriver): Promise<void> {
	const taskId = "selfcheck-steer-review";
	const context = driverContext(driver);
	const now = Date.now();
	const card = createSelfcheckCard({
		id: taskId,
		title: "Selfcheck steer review",
		agentId: "claude",
		prompt: "Wait for steering input.",
	});
	await driver.createCard({
		column: "review",
		card: {
			...card,
			transitions: [...(card.transitions ?? []), { column: "review", at: now }],
		},
	});
	await driver.startCard(taskId);
	await driver.expectColumn(taskId, "review");
	await driver.steerCard(taskId, "Continue after review.");
	await driver.expectEnteredColumn(taskId, "in_progress");
	await driver.ingestNativeHook(taskId, {
		event: "to_review",
		metadata: { source: "claude", hookEventName: "Stop" },
	});
	await driver.expectColumn(taskId, "review");

	const state = await loadState(context);
	const task = state.board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId);
	const reviewEntries = task?.transitions?.filter((transition) => transition.column === "review") ?? [];
	assertOk(reviewEntries.length === 2, `Expected ${taskId} to record two review transitions.`);
}
