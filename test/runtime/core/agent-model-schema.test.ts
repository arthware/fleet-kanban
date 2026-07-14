import { describe, expect, it } from "vitest";

import { runtimeBoardCardSchema, runtimeTaskSessionStartRequestSchema } from "../../../src/core/api-contract";

describe("per-card agent model and skill schema", () => {
	it("carries agentModel and skill through a board card round-trip", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "task-1",
			prompt: "Mechanical task",
			startInPlanMode: false,
			agentId: "claude",
			agentModel: "claude-haiku-4-5",
			skill: "fleet-smoke",
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});

		expect(card.agentModel).toBe("claude-haiku-4-5");
		expect(card.skill).toBe("fleet-smoke");
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
		expect(card.skill).toBeUndefined();
	});

	it("accepts agentModel and skill on a task-session start request", () => {
		const request = runtimeTaskSessionStartRequestSchema.parse({
			taskId: "task-1",
			prompt: "go",
			baseRef: "main",
			agentModel: "gpt-5-codex",
			skill: "fleet-smoke",
		});

		expect(request.agentModel).toBe("gpt-5-codex");
		expect(request.skill).toBe("fleet-smoke");
	});
});
