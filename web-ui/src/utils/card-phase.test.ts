import { describe, expect, it } from "vitest";
import type { BoardCard } from "../types/board";
import { resolvePhaseLabelForLane } from "./card-phase";

function createCard(overrides?: Partial<BoardCard>): BoardCard {
	return {
		id: "task-1",
		title: "Sample Task",
		prompt: "Sample Task",
		startInPlanMode: false,
		autoReviewEnabled: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("resolvePhaseLabelForLane", () => {
	it("returns undefined for any card in backlog", () => {
		expect(resolvePhaseLabelForLane(createCard({ cardType: "build" }), "backlog")).toBeUndefined();
		expect(resolvePhaseLabelForLane(createCard({ cardType: "plan" }), "backlog")).toBeUndefined();
		expect(resolvePhaseLabelForLane(createCard({ cardType: undefined }), "backlog")).toBeUndefined();
	});

	it("returns undefined for any card in trash", () => {
		expect(resolvePhaseLabelForLane(createCard({ cardType: "build" }), "trash")).toBeUndefined();
		expect(resolvePhaseLabelForLane(createCard({ cardType: "plan" }), "trash")).toBeUndefined();
	});

	describe("when cardType is plan", () => {
		it("returns design in in_progress lane", () => {
			expect(resolvePhaseLabelForLane(createCard({ cardType: "plan" }), "in_progress")).toBe("design");
		});

		it("returns verify in review or done lane", () => {
			expect(resolvePhaseLabelForLane(createCard({ cardType: "plan" }), "review")).toBe("verify");
			expect(resolvePhaseLabelForLane(createCard({ cardType: "plan" }), "done")).toBe("verify");
		});
	});

	describe("when cardType is build (or default)", () => {
		it("returns build in in_progress lane when auto-review is disabled", () => {
			expect(resolvePhaseLabelForLane(createCard({ cardType: "build" }), "in_progress")).toBe("build");
			expect(resolvePhaseLabelForLane(createCard({ cardType: undefined }), "in_progress")).toBe("build");
		});

		it("returns build·ship in in_progress lane when auto-review is enabled with pr mode", () => {
			expect(
				resolvePhaseLabelForLane(
					createCard({
						cardType: "build",
						autoReviewEnabled: true,
						autoReviewMode: "pr",
					}),
					"in_progress",
				),
			).toBe("build·ship");

			expect(
				resolvePhaseLabelForLane(
					createCard({
						cardType: undefined,
						autoReviewEnabled: true,
						autoReviewMode: "pr",
					}),
					"in_progress",
				),
			).toBe("build·ship");
		});

		it("returns build in in_progress lane when auto-review is enabled but mode is not pr", () => {
			expect(
				resolvePhaseLabelForLane(
					createCard({
						cardType: "build",
						autoReviewEnabled: true,
						autoReviewMode: undefined,
					}),
					"in_progress",
				),
			).toBe("build");
		});

		it("returns verify in review or done lane", () => {
			expect(resolvePhaseLabelForLane(createCard({ cardType: "build" }), "review")).toBe("verify");
			expect(resolvePhaseLabelForLane(createCard({ cardType: "build" }), "done")).toBe("verify");
			expect(resolvePhaseLabelForLane(createCard({ cardType: undefined }), "review")).toBe("verify");
			expect(resolvePhaseLabelForLane(createCard({ cardType: undefined }), "done")).toBe("verify");
		});
	});
});
