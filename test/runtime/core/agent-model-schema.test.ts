import { describe, expect, it } from "vitest";

import { runtimeBoardCardSchema, runtimeTaskSessionStartRequestSchema } from "../../../src/core/api-contract";

describe("per-card agent model schema", () => {
	it("carries agentModel through a board card round-trip", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "task-1",
			prompt: "Mechanical task",
			startInPlanMode: false,
			agentId: "claude",
			agentModel: "claude-haiku-4-5",
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});

		expect(card.agentModel).toBe("claude-haiku-4-5");
	});

	it("parses a board card written before agentModel existed", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "task-legacy",
			prompt: "Old task",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});

		expect(card.agentModel).toBeUndefined();
	});

	it("accepts agentModel on a task-session start request", () => {
		const request = runtimeTaskSessionStartRequestSchema.parse({
			taskId: "task-1",
			prompt: "go",
			baseRef: "main",
			agentModel: "gpt-5-codex",
		});

		expect(request.agentModel).toBe("gpt-5-codex");
	});
});
