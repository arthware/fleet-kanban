import { resolve } from "node:path";

import { type IsolatedKanbanInstance, startIsolatedKanbanInstance } from "../../utilities/kanban-test-instance";
import { createPetRepoFixtureCopy } from "../../utilities/pet-repo-fixture";
import {
	assertOk,
	attachContext,
	createSelfcheckCard,
	createTrpcScenarioDriver,
	driverContext,
	resolveCurrentWorkspaceId,
	type ScenarioDriver,
} from "../scenario-api";

export async function givenCardWithModelOverrideWhenStartedThenCliReceivesModel(driver: ScenarioDriver): Promise<void> {
	const _context = driverContext(driver);

	// Card A: created with a per-card model override, started.
	// Assert the recorded argv contains `--model` followed by exactly that override value.
	const taskIdA = "card-a-override";
	await driver.createCard({
		column: "backlog",
		card: createSelfcheckCard({
			id: taskIdA,
			title: "Card A override model",
			agentModel: "sonnet-3-5",
		}),
	});
	await driver.startCard(taskIdA);
	const argvA = await driver.readLaunchedArgv(taskIdA);
	assertOk(argvA.includes("--model"), `Card A argv should contain --model, got ${JSON.stringify(argvA)}`);
	const modelIndexA = argvA.indexOf("--model");
	assertOk(
		argvA[modelIndexA + 1] === "sonnet-3-5",
		`Card A model override should be sonnet-3-5, got ${argvA[modelIndexA + 1]}`,
	);

	// Card C: created with no override, started.
	// Assert the recorded argv contains no `--model` at all.
	const taskIdC = "card-c-no-override";
	await driver.createCard({
		column: "backlog",
		card: createSelfcheckCard({
			id: taskIdC,
			title: "Card C no override",
		}),
	});
	await driver.startCard(taskIdC);
	const argvC = await driver.readLaunchedArgv(taskIdC);
	assertOk(!argvC.includes("--model"), "Card C argv should not contain --model");

	// Card B: created with a per-card model override AND a user-supplied `--model` already present in the configured agent args, started.
	// Assert the recorded argv contains the user's value and does NOT contain the card override.
	const stubAgentPath = resolve(process.cwd(), "test/fixtures/stub-agent/stub-agent.mjs");
	const bFixture = createPetRepoFixtureCopy("kanban-selfcheck-pet-repo-b-");
	let bInstance: IsolatedKanbanInstance | null = null;
	try {
		bInstance = await startIsolatedKanbanInstance({
			cwd: bFixture.path,
			env: {
				KANBAN_TEST_AGENT_BINARY: stubAgentPath,
				KANBAN_TEST_AGENT_ARGS_JSON: JSON.stringify(["--model", "user-wins-model"]),
			},
		});
		const bBaseUrl = new URL(bInstance.baseUrl).origin;
		const bWorkspaceId = await resolveCurrentWorkspaceId(bBaseUrl);
		const bContext = {
			instance: bInstance,
			baseUrl: bBaseUrl,
			workspaceId: bWorkspaceId,
			fixture: bFixture,
			stop: async () => {},
		};
		const bDriver = attachContext(createTrpcScenarioDriver(bContext), bContext);

		const taskIdB = "card-b-user-supplied";
		await bDriver.createCard({
			column: "backlog",
			card: createSelfcheckCard({
				id: taskIdB,
				title: "Card B user supplied model",
				agentModel: "should-be-overridden",
			}),
		});
		await bDriver.startCard(taskIdB);
		const argvB = await bDriver.readLaunchedArgv(taskIdB);
		assertOk(argvB.includes("--model"), "Card B argv should contain --model");
		const modelIndexB = argvB.indexOf("--model");
		assertOk(
			argvB[modelIndexB + 1] === "user-wins-model",
			`Card B model should be user-wins-model, got ${argvB[modelIndexB + 1]}`,
		);
		const occurrences = argvB.filter((arg) => arg === "--model").length;
		assertOk(occurrences === 1, `Card B argv should contain --model exactly once, got ${occurrences}`);
		assertOk(
			!argvB.includes("should-be-overridden"),
			"Card B argv should not contain the card override value when user supplied it",
		);
	} finally {
		if (bInstance) {
			await bInstance.stop();
		}
		bFixture.cleanup();
	}
}
