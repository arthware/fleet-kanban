import { assertOk, createSelfcheckCard, driverContext, loadState, type ScenarioDriver, waitFor } from "../scenario-api";

const EXPECTED_ROUND_TRIP = "backlog > in_progress > review > in_progress > review";

export async function givenReviewCardWhenSteeredThenMovesToInProgress(driver: ScenarioDriver): Promise<void> {
	const taskId = "selfcheck-steer-review";
	await createReviewSteeringCard(driver, taskId);
	await driver.steerCard(taskId, "Continue after review.");
	await driver.expectEnteredColumnTimes(taskId, "in_progress", 2);
	await driver.expectReviewReason(taskId, null);
}

export async function givenSteeredReviewCardWhenReturnsToReviewThenTransitionsRecordRoundTrip(
	driver: ScenarioDriver,
): Promise<void> {
	const taskId = "selfcheck-steer-review-history";
	const context = driverContext(driver);
	await createReviewSteeringCard(driver, taskId);
	await driver.steerCard(taskId, "Continue after review.");
	await driver.expectEnteredColumnTimes(taskId, "in_progress", 2);
	await driver.ingestNativeHook(taskId, {
		event: "to_review",
		metadata: { source: "claude", hookEventName: "Stop" },
	});
	await driver.expectColumn(taskId, "review");

	// The card's column may only ever follow its session's state stream in order, so
	// this asserts the WHOLE sequence: an extra `in_progress > review` pair here means
	// a session state was applied to the board out of order, not that the board is slow.
	let observed = "<no transitions read yet>";
	await waitFor(
		async () => {
			const state = await loadState(context);
			const task = state.board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId);
			assertOk(task, `Expected ${taskId} to exist.`);
			observed = (task.transitions ?? []).map((transition) => transition.column).join(" > ");
			return observed === EXPECTED_ROUND_TRIP ? true : null;
		},
		() =>
			`${taskId} to record the review steering round-trip.\n  expected: ${EXPECTED_ROUND_TRIP}\n  actual:   ${observed}`,
	);
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
