import { expect, type Page, test } from "@playwright/test";

import {
	attachContext,
	createTrpcScenarioDriver,
	givenReviewCardWhenSteeredThenMovesToInProgress,
	type ScenarioDriver,
	type SelfcheckContext,
} from "../../test/selfcheck/scenario-api";

const baseUrl = process.env.KANBAN_SELFCHECK_BASE_URL;
const workspaceId = process.env.KANBAN_SELFCHECK_WORKSPACE_ID;
const homeDir = process.env.KANBAN_SELFCHECK_HOME;

if (!baseUrl || !workspaceId || !homeDir) {
	throw new Error("KANBAN_SELFCHECK_BASE_URL, KANBAN_SELFCHECK_WORKSPACE_ID, and KANBAN_SELFCHECK_HOME are required.");
}

function createBrowserDriver(page: Page): ScenarioDriver {
	const context: SelfcheckContext = {
		baseUrl,
		workspaceId,
		instance: {
			baseUrl,
			port: Number(new URL(baseUrl).port),
			homeDir,
			stop: async () => undefined,
		},
		fixture: {
			path: "",
			baseCommit: "",
			cleanup: () => undefined,
		},
		stop: async () => undefined,
	};
	const trpcDriver = attachContext(createTrpcScenarioDriver(context), context);
	return {
		...trpcDriver,
		steerCard: async (taskId, text) => {
			await page.goto("/");
			await expect(cardInColumn(page, taskId, "review")).toBeVisible();
			await trpcDriver.steerCard(taskId, text);
			await trpcDriver.expectColumn(taskId, "in_progress");
		},
	};
}

function cardInColumn(page: Page, taskId: string, columnId: string) {
	return page.getByTestId(`board-column-${columnId}`).getByTestId(`board-card-${taskId}`);
}

test("GIVEN a Review card WHEN it is steered THEN the board moves it to In Progress", async ({ page }) => {
	await givenReviewCardWhenSteeredThenMovesToInProgress(createBrowserDriver(page));
});
