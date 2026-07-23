import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../../src/core/api-contract";
import { runtimeBoardCardSchema } from "../../../src/core/api-contract";
import { setCardPrUrl } from "../../../src/core/task-board-mutations";

const PR = {
	url: "https://github.com/cline/kanban/pull/42",
	state: "open" as const,
	number: 42,
};

describe("board card PR field schema", () => {
	it("carries a stored PR through a board card round-trip", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "task-1",
			prompt: "Ship a feature",
			startInPlanMode: false,
			baseRef: "main",
			prUrl: PR.url,
			prState: PR.state,
			prNumber: PR.number,
			createdAt: 1,
			updatedAt: 1,
		});

		expect(card.prUrl).toBe(PR.url);
		expect(card.prState).toBe("open");
		expect(card.prNumber).toBe(42);
	});

	it("carries a stored PR gate status through a board card round-trip", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "task-1",
			prompt: "Ship a feature",
			startInPlanMode: false,
			baseRef: "main",
			prUrl: PR.url,
			prState: PR.state,
			prNumber: PR.number,
			prGateStatus: "passing",
			createdAt: 1,
			updatedAt: 1,
		});

		expect(card.prGateStatus).toBe("passing");
	});

	it("parses a board card written before the PR fields existed", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "task-legacy",
			prompt: "Old task",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		});

		expect(card.prUrl).toBeUndefined();
		expect(card.prState).toBeUndefined();
		expect(card.prNumber).toBeUndefined();
	});
});

function boardWithCard(
	overrides?: Partial<{
		prUrl: string;
		prState: "open" | "merged" | "closed";
		prNumber: number;
		prGateStatus: "passing" | "failing" | "pending" | "none";
	}>,
): RuntimeBoardData {
	return {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: [
					runtimeBoardCardSchema.parse({
						id: "task-1",
						prompt: "Ship a feature",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
						...overrides,
					}),
				],
			},
		],
		dependencies: [],
	};
}

describe("setCardPrUrl", () => {
	it("stores the detected PR onto the matching card", () => {
		const result = setCardPrUrl(boardWithCard(), "task-1", PR);

		expect(result.updated).toBe(true);
		const card = result.board.columns[0]?.cards[0];
		expect(card?.prUrl).toBe(PR.url);
		expect(card?.prState).toBe("open");
		expect(card?.prNumber).toBe(42);
	});

	it("is idempotent when the card already stores the same PR", () => {
		const board = boardWithCard({ prUrl: PR.url, prState: PR.state, prNumber: PR.number });

		const result = setCardPrUrl(board, "task-1", PR);

		expect(result.updated).toBe(false);
		expect(result.board).toBe(board);
	});

	it("updates the stored PR when its state changes (e.g. open → merged)", () => {
		const board = boardWithCard({ prUrl: PR.url, prState: "open", prNumber: PR.number });

		const result = setCardPrUrl(board, "task-1", { ...PR, state: "merged" });

		expect(result.updated).toBe(true);
		expect(result.board.columns[0]?.cards[0]?.prState).toBe("merged");
	});

	it("updates the stored PR when its gate status changes", () => {
		const board = boardWithCard({ prUrl: PR.url, prState: "open", prNumber: PR.number, prGateStatus: "pending" });

		const result = setCardPrUrl(board, "task-1", { ...PR, gateStatus: "passing" });

		expect(result.updated).toBe(true);
		expect(result.board.columns[0]?.cards[0]?.prGateStatus).toBe("passing");
	});

	it("leaves the board untouched when no card matches the task id", () => {
		const board = boardWithCard();

		const result = setCardPrUrl(board, "task-missing", PR);

		expect(result.updated).toBe(false);
		expect(result.board).toBe(board);
	});
});
