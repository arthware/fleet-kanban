import { createSelfcheckCard, type ScenarioDriver } from "../scenario-api";

export async function givenReviewCardWhenSteeredThenMovesToInProgress(driver: ScenarioDriver): Promise<void> {
	const taskId = "selfcheck-steer-review";
	await driver.createCard({
		column: "review",
		card: createSelfcheckCard({
			id: taskId,
			title: "Selfcheck steer review",
			agentId: "claude",
			prompt: "Wait for steering input.",
		}),
	});
	await driver.startCard(taskId);
	await driver.expectColumn(taskId, "review");
	await driver.steerCard(taskId, "Continue after review.");
	await driver.expectColumn(taskId, "in_progress");
}
