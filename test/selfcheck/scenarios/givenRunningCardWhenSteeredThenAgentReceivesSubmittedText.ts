import {
	assertOk,
	createSelfcheckCard,
	type ScenarioDriver,
} from "../scenario-api";

export async function givenRunningCardWhenSteeredThenAgentReceivesSubmittedText(driver: ScenarioDriver): Promise<void> {
	// Card 1: steer with submit enabled (true)
	const taskId1 = "card-1-steer-submit";
	await driver.createCard({
		column: "backlog",
		card: createSelfcheckCard({
			id: taskId1,
			title: "Card 1 steer with submit",
			agentId: "claude",
		}),
	});
	await driver.startCard(taskId1);
	await driver.expectAgentRunning(taskId1);

	// Steer card 1 with PING-42 and submit: true
	await driver.steerCard(taskId1, "PING-42", true);

	// Assert captured stdin contains PING-42 and is followed by a newline/carriage return
	const stdin1 = await driver.readAgentStdin(taskId1);
	assertOk(stdin1.includes("PING-42"), `Card 1 stdin should contain PING-42, got: ${JSON.stringify(stdin1)}`);
	assertOk(
		stdin1.includes("PING-42\u001b[201~\n") || stdin1.includes("PING-42\u001b[201~\r"),
		`Card 1 stdin should have PING-42 followed by a translated newline/carriage return, got: ${JSON.stringify(stdin1)}`,
	);

	// Card 2: steer with submit disabled (false)
	const taskId2 = "card-2-steer-no-submit";
	await driver.createCard({
		column: "backlog",
		card: createSelfcheckCard({
			id: taskId2,
			title: "Card 2 steer without submit",
			agentId: "claude",
		}),
	});
	await driver.startCard(taskId2);
	await driver.expectAgentRunning(taskId2);

	// Steer card 2 with PING-42 and submit: false
	await driver.steerCard(taskId2, "PING-42", false);

	// Assert captured stdin contains PING-42 and does NOT contain newline/carriage return
	const stdin2 = await driver.readAgentStdin(taskId2);
	assertOk(stdin2.includes("PING-42"), `Card 2 stdin should contain PING-42, got: ${JSON.stringify(stdin2)}`);
	assertOk(
		!stdin2.endsWith("\n") && !stdin2.endsWith("\r"),
		`Card 2 stdin should not end with carriage return/newline, got: ${JSON.stringify(stdin2)}`,
	);
}
