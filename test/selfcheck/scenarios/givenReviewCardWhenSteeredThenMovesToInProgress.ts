import { createSelfcheckCard, type ScenarioDriver } from "../scenario-api";

export async function givenReviewCardWhenSteeredThenMovesToInProgress(driver: ScenarioDriver): Promise<void> {
	const taskId = "selfcheck-steer-review";
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
	await driver.expectEnteredColumn(taskId, "in_progress");
	await driver.ingestNativeHook(taskId, {
		event: "to_review",
		metadata: {
			source: "claude",
			hookEventName: "Stop",
			activityText: "Waiting in review before steering",
		},
	});
	await driver.expectEnteredColumn(taskId, "review");
	await driver.expectReviewReason(taskId, "hook");
	await driver.steerCard(taskId, "Continue after review.");
	await driver.expectEnteredColumnTimes(taskId, "in_progress", 2);
	await driver.expectReviewReason(taskId, null);
}
