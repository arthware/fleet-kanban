import { createSelfcheckCard, type ScenarioDriver } from "../scenario-api";

export async function givenReviewHookWhenIngestedThenOverseerIsNotified(driver: ScenarioDriver): Promise<void> {
	const taskId = "selfcheck-review-ping";
	await driver.createCard({
		column: "review",
		card: createSelfcheckCard({
			id: taskId,
			title: "Selfcheck review ping",
			agentId: "claude",
		}),
	});
	await driver.startCard(taskId);
	await driver.expectOverseerNotified(taskId);
}
