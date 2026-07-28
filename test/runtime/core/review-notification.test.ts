import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import { buildTaskReadyForReviewMessage, resolveRunningHomeAgentTaskId } from "../../../src/core/review-notification";

function createCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: "card-1",
		title: "Fix review flow",
		prompt: "Prompt body",
		startInPlanMode: false,
		autoReviewEnabled: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("review notification helpers", () => {
	it("formats the architect wake message with the card id and resolved title", () => {
		expect(buildTaskReadyForReviewMessage(createCard())).toBe(
			'Card card-1 ("Fix review flow") was moved to review and is awaiting your review.',
		);
	});

	it("resolves the home-agent session id for the workspace", () => {
		const homeAgentTaskId = createHomeAgentSessionId("workspace-1");

		expect(
			resolveRunningHomeAgentTaskId({
				architectWorkspaceId: "workspace-1",
				taskId: "card-1",
			}),
		).toBe(homeAgentTaskId);
	});

	it("resolves a sub-workspace card to the architect home-agent session", () => {
		const architectHomeAgentTaskId = createHomeAgentSessionId("tools");

		expect(
			resolveRunningHomeAgentTaskId({
				architectWorkspaceId: "tools",
				taskId: "card-1",
			}),
		).toBe(architectHomeAgentTaskId);
	});

	it("does not notify when the moved card is itself the home-agent session", () => {
		const homeAgentTaskId = createHomeAgentSessionId("workspace-1");

		expect(
			resolveRunningHomeAgentTaskId({
				architectWorkspaceId: "workspace-1",
				taskId: homeAgentTaskId,
			}),
		).toBeNull();
	});
});
