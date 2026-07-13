import { describe, expect, it } from "vitest";

import { runtimeBoardDataSchema, runtimeProjectTaskCountsSchema } from "../../../src/core/api-contract";

describe("done/trash board schema", () => {
	it("migrates an old four-column board by remapping legacy trash cards to done and appending empty trash", () => {
		const parsed = runtimeBoardDataSchema.parse({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{
					id: "trash",
					title: "Done",
					cards: [
						{
							id: "finished-1",
							prompt: "Legacy completed task",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 2,
						},
					],
				},
			],
			dependencies: [],
		});

		expect(parsed.columns.map((column) => column.id)).toEqual(["backlog", "in_progress", "review", "done", "trash"]);
		expect(parsed.columns.find((column) => column.id === "done")?.cards.map((card) => card.id)).toEqual([
			"finished-1",
		]);
		expect(parsed.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});

	it("backfills lifecycle transitions for legacy cards using their current column", () => {
		const parsed = runtimeBoardDataSchema.parse({
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "backlog-1",
							prompt: "Legacy backlog task",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 10,
							updatedAt: 20,
						},
					],
				},
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{
					id: "done",
					title: "Done",
					cards: [
						{
							id: "done-1",
							prompt: "Legacy done task",
							startInPlanMode: false,
							baseRef: "main",
							createdAt: 30,
							updatedAt: 40,
						},
					],
				},
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		});

		const backlogCard = parsed.columns.find((column) => column.id === "backlog")?.cards[0];
		const doneCard = parsed.columns.find((column) => column.id === "done")?.cards[0];
		expect(backlogCard?.transitions).toEqual([{ column: "backlog", at: 10 }]);
		expect(doneCard?.transitions).toEqual([
			{ column: "backlog", at: 30 },
			{ column: "done", at: 40 },
		]);
	});

	it("sorts done cards by completedAt across a serialize/parse round trip", () => {
		const parsed = runtimeBoardDataSchema.parse(
			JSON.parse(
				JSON.stringify({
					columns: [
						{ id: "backlog", title: "Backlog", cards: [] },
						{ id: "in_progress", title: "In Progress", cards: [] },
						{ id: "review", title: "Review", cards: [] },
						{
							id: "done",
							title: "Done",
							cards: [
								{
									id: "older",
									prompt: "Older done task",
									startInPlanMode: false,
									baseRef: "main",
									createdAt: 1,
									updatedAt: 1000,
									transitions: [
										{ column: "backlog", at: 1 },
										{ column: "done", at: 100 },
									],
								},
								{
									id: "newer",
									prompt: "Newer done task",
									startInPlanMode: false,
									baseRef: "main",
									createdAt: 2,
									updatedAt: 200,
									transitions: [
										{ column: "backlog", at: 2 },
										{ column: "done", at: 200 },
									],
								},
							],
						},
						{ id: "trash", title: "Trash", cards: [] },
					],
					dependencies: [],
				}),
			),
		);

		expect(parsed.columns.find((column) => column.id === "done")?.cards.map((card) => card.id)).toEqual([
			"newer",
			"older",
		]);
	});

	it("leaves a new five-column board in order", () => {
		const parsed = runtimeBoardDataSchema.parse({
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "done", title: "Done", cards: [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		});

		expect(parsed.columns.map((column) => column.id)).toEqual(["backlog", "in_progress", "review", "done", "trash"]);
	});

	it("round-trips project task counts with a done key", () => {
		const parsed = runtimeProjectTaskCountsSchema.parse({
			backlog: 1,
			in_progress: 2,
			review: 3,
			done: 4,
			trash: 5,
		});

		expect(parsed).toEqual({
			backlog: 1,
			in_progress: 2,
			review: 3,
			done: 4,
			trash: 5,
		});
	});
});
