import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
	RuntimeStateStreamSnapshotMessage,
	RuntimeTaskSessionStartResponse,
} from "../../../src/core/api-contract";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import { getTaskSessionsDir, listSessions } from "../../../src/core/session-ledger";
import { requestJson } from "../../utilities/trpc-request";
import { connectRuntimeStream } from "../runtime-stream";
import {
	assertOk,
	createSelfcheckCard,
	createSelfcheckContext,
	createTrpcScenarioDriver,
	loadState,
	moveCard,
	mutateBoard,
	waitFor,
} from "../scenario-api";

export async function givenArchivedCardWhenBoardReloadsThenLedgerKeepsItsPointer(): Promise<void> {
	const context = await createSelfcheckContext();
	try {
		const taskId = "selfcheck-archive-ledger-task";
		const card = createSelfcheckCard({
			id: taskId,
			title: "Selfcheck archive ledger task",
			agentId: "claude",
		});

		// Connect to runtime stream to trigger starting/reconnecting the home agent session
		const stream = await connectRuntimeStream(
			`ws://127.0.0.1:${context.instance.port}/api/runtime/ws?workspaceId=${encodeURIComponent(
				context.workspaceId,
			)}`,
		);
		await stream.waitForMessage(
			(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
		);

		// 1. Create card and start it
		const driver = createTrpcScenarioDriver(context);
		await driver.createCard({ card, column: "backlog" });
		await driver.startCard(taskId);

		// Also start the overseer home agent session explicitly so it boots up and gets an id
		const overseerId = createHomeAgentSessionId(context.workspaceId);
		const startOverseer = await requestJson<RuntimeTaskSessionStartResponse>({
			baseUrl: context.baseUrl,
			procedure: "runtime.startTaskSession",
			type: "mutation",
			workspaceId: context.workspaceId,
			payload: {
				taskId: overseerId,
				prompt: "Hello",
				taskTitle: "Home Agent",
				startInPlanMode: false,
				baseRef: "HEAD",
				agentId: "claude",
				cols: 100,
				rows: 30,
			},
		});
		assertOk(
			startOverseer.status === 200 && startOverseer.payload.ok,
			"Could not start overseer home agent session.",
		);

		// Wait/poll until the session record carries an agentSessionId.
		const capturedSessionId = await waitFor(async () => {
			const state = await loadState(context);
			const session = state.sessions[taskId];
			return session?.agentSessionId ? session.agentSessionId : null;
		}, `session ${taskId} to carry an agentSessionId`);

		// Also do the overseer mirror: capture overseer's agentSessionId
		const overseerSessionId = await waitFor(async () => {
			const state = await loadState(context);
			const session = state.sessions[overseerId];
			return session?.agentSessionId ? session.agentSessionId : null;
		}, `overseer ${overseerId} to carry an agentSessionId`);

		// Close stream
		await stream.close();

		// Stop the card and overseer sessions explicitly so no child processes are left running
		const stopCard = await requestJson<unknown>({
			baseUrl: context.baseUrl,
			procedure: "runtime.stopTaskSession",
			type: "mutation",
			workspaceId: context.workspaceId,
			payload: { taskId },
		});
		assertOk(stopCard.status === 200, "Could not stop card task session.");

		const stopOverseer = await requestJson<unknown>({
			baseUrl: context.baseUrl,
			procedure: "runtime.stopTaskSession",
			type: "mutation",
			workspaceId: context.workspaceId,
			payload: { taskId: overseerId },
		});
		assertOk(stopOverseer.status === 200, "Could not stop overseer task session.");

		// 2. Move the card to trash (so prune applies to it on next saveState/mutateBoard)
		await mutateBoard(context, (board) => moveCard(board, taskId, "trash"));

		// 3. Force the reload path that prunes session records, then assert the record is gone from sessions.json — this pins the premise
		const sessionsJsonPath = join(
			context.instance.homeDir,
			".cline",
			"kanban",
			"workspaces",
			context.workspaceId,
			"sessions.json",
		);
		const sessionsOnDisk = JSON.parse(readFileSync(sessionsJsonPath, "utf8"));
		assertOk(
			sessionsOnDisk[taskId] === undefined,
			`Card session for ${taskId} was NOT pruned from sessions.json as expected.`,
		);

		// 4. Assert the ledger still returns a manifest for that card whose agentSessionId equals the captured id
		// Temporarily set CLINE_HOME in the runner to resolve to the isolated instance's state
		const originalClineHome = process.env.CLINE_HOME;
		process.env.CLINE_HOME = join(context.instance.homeDir, ".cline");

		try {
			// First verify the index
			const index = await listSessions(context.workspaceId, taskId);
			assertOk(index !== null, "Card session was not found in the ledger index.");
			assertOk(
				index.generations.length > 0,
				"Card session should have at least one generation in the ledger index.",
			);

			// Read the manifest.json
			const sessionsDir = getTaskSessionsDir(context.workspaceId, taskId);
			const manifestPath = join(sessionsDir, "0", "manifest.json");
			const manifestContent = JSON.parse(readFileSync(manifestPath, "utf8"));
			assertOk(
				manifestContent.agentSessionId === capturedSessionId,
				`Card session manifest has agentSessionId "${manifestContent.agentSessionId}" instead of expected "${capturedSessionId}".`,
			);

			// 5. Overseer mirror: assert the overseer ledger manifest has the correct agentSessionId and remains intact
			const overseerIndex = await listSessions(context.workspaceId, overseerId);
			assertOk(overseerIndex !== null, "Overseer session was not found in the ledger index.");

			const overseerGen = sessionsOnDisk[overseerId]?.homeAgentSessionGeneration ?? 0;
			const overseerSessionsDir = getTaskSessionsDir(context.workspaceId, overseerId);
			const overseerManifestPath = join(overseerSessionsDir, String(overseerGen), "manifest.json");
			const overseerManifestContent = JSON.parse(readFileSync(overseerManifestPath, "utf8"));
			assertOk(
				overseerManifestContent.agentSessionId === overseerSessionId,
				`Overseer session manifest has agentSessionId "${overseerManifestContent.agentSessionId}" instead of expected "${overseerSessionId}".`,
			);
		} finally {
			if (originalClineHome === undefined) {
				delete process.env.CLINE_HOME;
			} else {
				process.env.CLINE_HOME = originalClineHome;
			}
		}
	} finally {
		await context.stop();
	}
}
