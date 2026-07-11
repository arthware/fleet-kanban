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
