import { assertOk, createSelfcheckCard, driverContext, loadState, type ScenarioDriver, waitFor } from "../scenario-api";

export async function givenReviewCardWhenSteeredThenMovesToInProgress(driver: ScenarioDriver): Promise<void> {
	const taskId = "selfcheck-steer-review";
	await createReviewSteeringCard(driver, taskId);
	await driver.steerCard(taskId, "Continue after review.");
	await driver.expectEnteredColumn(taskId, "in_progress");
}

export async function givenSteeredReviewCardWhenReturnsToReviewThenTransitionsRecordRoundTrip(
	driver: ScenarioDriver,
): Promise<void> {
	const taskId = "selfcheck-steer-review-history";
	const context = driverContext(driver);
	await createReviewSteeringCard(driver, taskId);
	await driver.steerCard(taskId, "Continue after review.");
	await driver.expectEnteredColumn(taskId, "in_progress");
	await driver.ingestNativeHook(taskId, {
		event: "to_review",
		metadata: { source: "claude", hookEventName: "Stop" },
	});
	await driver.expectColumn(taskId, "review");

	await waitFor(async () => {
		const state = await loadState(context);
		const task = state.board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId);
		assertOk(task, `Expected ${taskId} to exist.`);
		const columns = task.transitions?.map((transition) => transition.column) ?? [];
		return columns.join(" > ") === "backlog > in_progress > review > in_progress > review" ? true : null;
	}, `${taskId} to record a full review steering round-trip`);
}

async function createReviewSteeringCard(driver: ScenarioDriver, taskId: string): Promise<void> {
	await driver.createCard({
		column: "backlog",
		card: createSelfcheckCard({
			id: taskId,
			title: "Selfcheck steer review",
			agentId: "claude",
			prompt: "Wait for steering input.",
		}),
	});
	await driver.startCard(taskId);
	await driver.expectColumn(taskId, "review");
}
