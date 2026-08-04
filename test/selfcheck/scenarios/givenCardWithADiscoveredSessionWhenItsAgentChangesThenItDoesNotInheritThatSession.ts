import type { RuntimeTaskSessionStopResponse } from "../../../src/core/api-contract";
import { requestJson } from "../../utilities/trpc-request";
import {
	assertOk,
	createSelfcheckCard,
	driverContext,
	loadState,
	moveCard,
	mutateBoard,
	type ScenarioDriver,
	waitFor,
} from "../scenario-api";

/** The id the stub agent mints for this task while it is running as codex. */
const DISCOVERED_SESSION_ID = "5e1fc4ec-0000-4000-8000-000000000001";

/**
 * A card's conversation belongs to the agent that minted it.
 *
 * A session id only means something to the harness that created it: `claude --resume`
 * cannot resume a Codex or Gemini session, and the transcript resolver would go looking
 * for it under the wrong harness. Switching a card's agent used to leave the previous
 * agent's id on the card, so the new agent adopted it — it launched `--resume` against a
 * foreign session, exited within seconds having produced nothing, and the card reported
 * its conversation as no longer on disk while it was demonstrably running.
 *
 * This scenario switches a card's agent after a session id has been discovered and
 * persisted, and asserts the card does not carry that id into the new agent.
 */
export async function givenCardWithADiscoveredSessionWhenItsAgentChangesThenItDoesNotInheritThatSession(
	driver: ScenarioDriver,
): Promise<void> {
	const context = driverContext(driver);
	const taskId = "selfcheck-agent-switch-identity";
	await driver.createCard({
		card: createSelfcheckCard({
			id: taskId,
			title: "Selfcheck agent switch identity",
			agentId: "codex",
			baseRef: "main",
		}),
		column: "backlog",
	});

	// given a card whose codex session id has been discovered and written down
	await driver.startCard(taskId);
	await waitFor(async () => {
		const state = await loadState(context);
		return state.sessions[taskId]?.agentSessionId === DISCOVERED_SESSION_ID ? true : null;
	}, `session ${taskId} to persist the session id codex minted after spawn`);

	// Stop the session the way an operator does. Unlike killing the process, this leaves
	// the discovered id on the card — which is the state that made the bug reachable.
	const stopped = await requestJson<RuntimeTaskSessionStopResponse>({
		baseUrl: context.baseUrl,
		procedure: "runtime.stopTaskSession",
		type: "mutation",
		workspaceId: context.workspaceId,
		payload: { taskId },
	});
	assertOk(stopped.status === 200 && stopped.payload.ok, `Could not stop task ${taskId}.`);
	await waitFor(async () => {
		const state = await loadState(context);
		const session = state.sessions[taskId];
		return session?.pid === null && session.agentSessionId === DISCOVERED_SESSION_ID ? true : null;
	}, `session ${taskId} to stop while keeping the codex session id it discovered`);

	// when the operator switches the card to a different agent and starts it again.
	// The card is parked in Review once its agent exits, so put it back in progress —
	// `startCard` launches a shell, not an agent, for a card sitting in Review.
	await mutateBoard(context, (board) =>
		moveCard(
			{
				...board,
				columns: board.columns.map((column) => ({
					...column,
					cards: column.cards.map((card) => (card.id === taskId ? { ...card, agentId: "claude" as const } : card)),
				})),
			},
			taskId,
			"in_progress",
		),
	);
	await driver.startCard(taskId);

	// then the claude session does not inherit the codex conversation
	const inherited = await waitFor(async () => {
		const state = await loadState(context);
		const session = state.sessions[taskId];
		return session?.agentId === "claude" ? (session.agentSessionId ?? "none") : null;
	}, `session ${taskId} to start under claude`);

	assertOk(
		inherited !== DISCOVERED_SESSION_ID,
		`Card carried its codex session id "${DISCOVERED_SESSION_ID}" into a claude session. ` +
			"Claude cannot resume it, so the card would die at launch and report its conversation as missing.",
	);
}
