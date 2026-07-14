import { describe, expect, it } from "vitest";

import type { RuntimeBoardColumnId, RuntimeBoardData } from "../../../src/core/api-contract";
import { runtimeBoardCardSchema } from "../../../src/core/api-contract";
import { applyPersistedCardPrToBoard } from "../../../src/server/runtime-state-hub";
import type { CardPrRef } from "../../../src/workspace/card-pr-url";

const MERGED_PR: CardPrRef = {
	url: "https://github.com/cline/kanban/pull/42",
	state: "merged",
	number: 42,
};

const CLOSED_PR: CardPrRef = {
	...MERGED_PR,
	state: "closed",
};

const COLUMN_IDS: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "done", "trash"];

function boardWithCard(columnId: RuntimeBoardColumnId): RuntimeBoardData {
	return {
		columns: COLUMN_IDS.map((id) => ({
			id,
			title: id,
			cards:
				id === columnId
					? [
							runtimeBoardCardSchema.parse({
								id: "task-1",
								prompt: "Ship a feature",
								startInPlanMode: false,
								baseRef: "main",
								prUrl: MERGED_PR.url,
								prState: "open",
								prNumber: MERGED_PR.number,
								createdAt: 1,
								updatedAt: 1,
							}),
						]
					: [],
		})),
		dependencies: [],
	};
}

function cardColumnId(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	return board.columns.find((column) => column.cards.some((card) => card.id === taskId))?.id ?? null;
}

describe("applyPersistedCardPrToBoard", () => {
	it("given a review card whose PR transitioned to merged, when the monitor persists it, then the card is moved to done", () => {
		const result = applyPersistedCardPrToBoard(boardWithCard("review"), "task-1", MERGED_PR);

		expect(result.updated).toBe(true);
		expect(cardColumnId(result.board, "task-1")).toBe("done");
		expect(result.board.columns.find((column) => column.id === "done")?.cards[0]?.prState).toBe("merged");
	});

	it("given a review card whose PR transitioned to closed, when the monitor persists it, then the card is moved to trash", () => {
		const result = applyPersistedCardPrToBoard(boardWithCard("review"), "task-1", CLOSED_PR);

		expect(result.updated).toBe(true);
		expect(cardColumnId(result.board, "task-1")).toBe("trash");
		expect(result.board.columns.find((column) => column.id === "trash")?.cards[0]?.prState).toBe("closed");
	});

	it("given an in-progress card whose PR transitioned to merged, when the monitor persists it, then the card is moved to done", () => {
		const result = applyPersistedCardPrToBoard(boardWithCard("in_progress"), "task-1", MERGED_PR);

		expect(result.updated).toBe(true);
		expect(cardColumnId(result.board, "task-1")).toBe("done");
	});

	it("given a card already in done, when the monitor persists a terminal PR state, then the card stays in done", () => {
		const result = applyPersistedCardPrToBoard(boardWithCard("done"), "task-1", MERGED_PR);

		expect(result.updated).toBe(true);
		expect(cardColumnId(result.board, "task-1")).toBe("done");
	});

	it("given a backlog card, when the monitor persists a terminal PR state, then the card is not pulled forward", () => {
		const result = applyPersistedCardPrToBoard(boardWithCard("backlog"), "task-1", MERGED_PR);

		expect(result.updated).toBe(true);
		expect(cardColumnId(result.board, "task-1")).toBe("backlog");
	});
});
