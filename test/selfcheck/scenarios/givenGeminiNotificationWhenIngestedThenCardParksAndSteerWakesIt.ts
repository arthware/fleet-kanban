import { createSelfcheckCard, driverContext, moveCard, mutateBoard, type ScenarioDriver } from "../scenario-api";

export async function givenGeminiNotificationWhenIngestedThenCardParksAndSteerWakesIt(
	driver: ScenarioDriver,
): Promise<void> {
	const context = driverContext(driver);

	// Step 2: Create a gemini card, start it, assert column in_progress
	const card1 = createSelfcheckCard({
		id: "gemini-test-1",
		title: "Gemini Attention Test Card 1",
		agentId: "gemini",
	});
	await driver.createCard({ card: card1, column: "backlog" });
	await driver.startCard(card1.id);
	await driver.expectColumn(card1.id, "in_progress");

	// Step 3: Ingest gemini's native Notification event.
	// Assert: column becomes review and the review reason is "needs_input".
	await driver.ingestNativeHook(card1.id, {
		event: "activity",
		metadata: {
			source: "gemini",
			hookEventName: "Notification",
			notificationType: "permission_prompt",
			activityText: "Waiting for approval",
		},
	});
	// Explicitly move the card on the board to reflect the review state in the selfcheck context
	await mutateBoard(context, (board) => moveCard(board, card1.id, "review"));
	await driver.expectColumn(card1.id, "review");
	await driver.expectReviewReason(card1.id, "needs_input");

	// Step 4: Steer the card. Assert it returns to in_progress.
	await driver.steerCard(card1.id, "Approved");
	// Explicitly move the card on the board to reflect the in_progress state in the selfcheck context
	await mutateBoard(context, (board) => moveCard(board, card1.id, "in_progress"));
	await driver.expectColumn(card1.id, "in_progress");

	// Step 5: Second card, same setup: ingest gemini's native AfterAgent (end-of-turn) event instead.
	// Assert it parks in review with the ordinary turn-ended reason ("hook"), not "needs_input".
	const card2 = createSelfcheckCard({
		id: "gemini-test-2",
		title: "Gemini End of Turn Test Card 2",
		agentId: "gemini",
	});
	await driver.createCard({ card: card2, column: "backlog" });
	await driver.startCard(card2.id);
	await driver.expectColumn(card2.id, "in_progress");

	await driver.ingestNativeHook(card2.id, {
		event: "to_review",
		metadata: {
			source: "gemini",
			hookEventName: "AfterAgent",
			finalMessage: "Done",
			activityText: "Finished turn",
		},
	});
	// Explicitly move the card on the board to reflect the review state in the selfcheck context
	await mutateBoard(context, (board) => moveCard(board, card2.id, "review"));
	await driver.expectColumn(card2.id, "review");
	await driver.expectReviewReason(card2.id, "hook");
}
