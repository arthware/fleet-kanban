import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
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

function createSummary(taskId: string, overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/repo",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		agentSessionId: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

describe("review notification helpers", () => {
	it("formats the architect wake message with the card id and resolved title", () => {
		expect(buildTaskReadyForReviewMessage(createCard())).toBe(
			'Card card-1 ("Fix review flow") was moved to review and is awaiting your review.',
		);
	});

	it("resolves the running home-agent session for the workspace", () => {
		const homeAgentTaskId = createHomeAgentSessionId("workspace-1", "claude");

		expect(
			resolveRunningHomeAgentTaskId({
				workspaceId: "workspace-1",
				taskId: "card-1",
				summaries: [createSummary("card-1"), createSummary(homeAgentTaskId)],
				isActive: (taskId) => taskId === homeAgentTaskId,
			}),
		).toBe(homeAgentTaskId);
	});

	it("returns null when no home-agent session is active", () => {
		const homeAgentTaskId = createHomeAgentSessionId("workspace-1", "claude");

		expect(
			resolveRunningHomeAgentTaskId({
				workspaceId: "workspace-1",
				taskId: "card-1",
				summaries: [createSummary(homeAgentTaskId)],
				isActive: () => false,
			}),
		).toBeNull();
	});

	it("does not resolve a hydrated home-agent summary with a live-looking pid when derived liveness is not attached", () => {
		const homeAgentTaskId = createHomeAgentSessionId("workspace-1", "claude");

		expect(
			resolveRunningHomeAgentTaskId({
				workspaceId: "workspace-1",
				taskId: "card-1",
				summaries: [
					createSummary(homeAgentTaskId, {
						pid: process.pid,
						agentSessionLifecycle: "resumable",
					}),
				],
				isActive: (_taskId, summary) => summary.agentSessionLifecycle === "attached",
			}),
		).toBeNull();
	});

	it("does not notify when the moved card is itself the home-agent session", () => {
		const homeAgentTaskId = createHomeAgentSessionId("workspace-1", "claude");

		expect(
			resolveRunningHomeAgentTaskId({
				workspaceId: "workspace-1",
				taskId: homeAgentTaskId,
				summaries: [createSummary(homeAgentTaskId)],
				isActive: () => true,
			}),
		).toBeNull();
	});
});
