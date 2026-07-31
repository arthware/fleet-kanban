import { assertOk, createSelfcheckCard, driverContext, loadState, type ScenarioDriver, waitFor } from "../scenario-api";

/**
 * The stub agent writes a Codex-shaped rollout file under this id for this task,
 * standing in for an agent that mints its own session id and only reveals it
 * after booting.
 */
const DISCOVERED_SESSION_ID = "5e1fc4ec-0000-4000-8000-000000000001";

/**
 * A card must keep a durable pointer to its conversation with no browser open.
 *
 * Claude is told its session id up front, but Codex and Gemini mint their own and
 * only reveal it once they have written a transcript, so the runtime discovers it
 * after spawn. That discovered id used to live only in memory — the board relied on
 * a connected browser to write session state back — so a headless board lost the
 * pointer on restart and the card rendered as dead with an empty transcript panel.
 *
 * This scenario never opens a runtime stream: if it passes, the server alone wrote
 * the pointer down.
 */
export async function givenAgentThatMintsItsOwnSessionIdWhenStartedThenTheCardKeepsItsConversationPointer(
	driver: ScenarioDriver,
): Promise<void> {
	const context = driverContext(driver);
	const taskId = "selfcheck-discovered-session-id";
	await driver.createCard({
		card: createSelfcheckCard({
			id: taskId,
			title: "Selfcheck discovered session id",
			agentId: "codex",
		}),
		column: "backlog",
	});
	await driver.startCard(taskId);

	const persisted = await waitFor(async () => {
		const state = await loadState(context);
		return state.sessions[taskId]?.agentSessionId ?? null;
	}, `session ${taskId} to persist the session id its agent minted after spawn`);

	assertOk(
		persisted === DISCOVERED_SESSION_ID,
		`Card kept session id "${persisted}" instead of the one its agent minted, "${DISCOVERED_SESSION_ID}". ` +
			"The card would point at the wrong conversation, or none at all.",
	);
}
