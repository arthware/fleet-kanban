import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeWorktreeEnsureResponse } from "../../../src/core/api-contract";
import { requestJson } from "../../utilities/trpc-request";
import { assertOk, createSelfcheckCard, driverContext, type ScenarioDriver } from "../scenario-api";

export async function givenCardWithGoneAgentWhenStartedThenNewAgentRuns(driver: ScenarioDriver): Promise<void> {
	const context = driverContext(driver);
	const taskId = "selfcheck-restart-after-gone";
	const card = createSelfcheckCard({
		id: taskId,
		title: "Selfcheck restart after gone",
		agentId: "claude",
		baseRef: "main",
	});
	await driver.createCard({
		column: "backlog",
		card,
	});

	await driver.expectColumn(taskId, "backlog");
	await driver.startCard(taskId);
	await driver.expectColumn(taskId, "in_progress");

	// Capture initial PID
	const pid1 = await driver.expectAgentRunning(taskId);
	assertOk(pid1 > 0, "Agent PID must be greater than 0");

	// Write a sentinel file with known content into the card's worktree, and leave it UNCOMMITTED.
	const ensured = await requestJson<RuntimeWorktreeEnsureResponse>({
		baseUrl: context.baseUrl,
		procedure: "workspace.ensureWorktree",
		type: "mutation",
		workspaceId: context.workspaceId,
		payload: { taskId, baseRef: "main" },
	});
	assertOk(ensured.status === 200 && ensured.payload.ok, "Could not ensure worktree to write sentinel.");
	const worktreePath = ensured.payload.path;
	const sentinelPath = join(worktreePath, "restart-sentinel.txt");
	writeFileSync(sentinelPath, "survivor\n", "utf8");

	// Kill the agent process, then expect session gone.
	await driver.killAgentProcess(taskId);
	await driver.expectSessionGone(taskId);

	// Start card a second time
	await driver.startCard(taskId);

	// Assert pid2 = expectAgentRunning(taskId) is a live pid and pid2 !== pid1
	const pid2 = await driver.expectAgentRunning(taskId);
	assertOk(pid2 > 0, "Second agent PID must be greater than 0");
	assertOk(pid2 !== pid1, "New agent process must have a different PID than the killed one");

	// Assert the sentinel file still exists with identical content
	assertOk(existsSync(sentinelPath), "Sentinel file must survive restart");
	const sentinelContent = readFileSync(sentinelPath, "utf8");
	assertOk(sentinelContent === "survivor\n", "Sentinel file content must be untouched");
}
