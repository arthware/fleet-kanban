import { describe, expect, it } from "vitest";

import { runtimeBoardCardSchema } from "../../../src/core/api-contract";

describe("board card externalIssue schema", () => {
	it("carries an external issue through a board card round-trip", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "task-1",
			prompt: "Ship a feature",
			startInPlanMode: false,
			baseRef: "main",
			externalIssue: {
				provider: "github",
				key: "owner/repo#42",
				url: "https://github.com/owner/repo/issues/42",
				raw: "owner/repo#42",
			},
			createdAt: 1,
			updatedAt: 1,
		});

		expect(card.externalIssue).toEqual({
			provider: "github",
			key: "owner/repo#42",
			url: "https://github.com/owner/repo/issues/42",
			raw: "owner/repo#42",
		});
	});

	it("parses a board card written before externalIssue existed", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "task-legacy",
			prompt: "Old task",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});

		expect(card.externalIssue).toBeUndefined();
	});
});
