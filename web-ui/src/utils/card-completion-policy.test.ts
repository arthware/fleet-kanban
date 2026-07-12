import { describe, expect, it } from "vitest";

import type { BoardCard } from "@/types";
import {
	cardCompletionPolicy,
	cardKind,
	getCardCompletionPolicyBadgeLabel,
	getTaskCompletionPolicyBadgeLabel,
} from "@/utils/card-completion-policy";

function createCard(overrides?: Partial<BoardCard>): BoardCard {
	return {
		id: "task-1",
		title: "Review API changes",
		prompt: "Review API changes",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("cardKind", () => {
	it("derives plan cards from the phase-1 startInPlanMode proxy", () => {
		expect(cardKind(createCard({ startInPlanMode: true }))).toBe("plan");
	});

	it("derives build cards when the phase-1 proxy is false", () => {
		expect(cardKind(createCard({ startInPlanMode: false }))).toBe("build");
	});
});

describe("cardCompletionPolicy", () => {
	it("maps manual build cards to manual", () => {
		expect(cardCompletionPolicy(createCard({ autoReviewEnabled: false }))).toEqual({
			kind: "build",
			policy: "manual",
		});
	});

	it("maps build auto-review commit cards to auto-commit", () => {
		expect(cardCompletionPolicy(createCard({ autoReviewEnabled: true, autoReviewMode: "commit" }))).toEqual({
			kind: "build",
			policy: "auto-commit",
		});
	});

	it("maps build auto-review PR cards to auto-pr", () => {
		expect(cardCompletionPolicy(createCard({ autoReviewEnabled: true, autoReviewMode: "pr" }))).toEqual({
			kind: "build",
			policy: "auto-pr",
		});
	});

	it("falls back to auto-commit when build auto-review mode is absent", () => {
		expect(cardCompletionPolicy(createCard({ autoReviewEnabled: true, autoReviewMode: undefined }))).toEqual({
			kind: "build",
			policy: "auto-commit",
		});
	});

	it("maps plan cards to the placeholder policy until dispositions are persisted", () => {
		expect(cardCompletionPolicy(createCard({ startInPlanMode: true, autoReviewEnabled: true }))).toEqual({
			kind: "plan",
			policy: "unknown",
		});
	});
});

describe("completion-policy badge labels", () => {
	it("labels auto-review build policies", () => {
		expect(getCardCompletionPolicyBadgeLabel({ kind: "build", policy: "auto-commit" })).toBe("Auto-commit");
		expect(getCardCompletionPolicyBadgeLabel({ kind: "build", policy: "auto-pr" })).toBe("Auto-PR");
	});

	it("renders nothing for manual and placeholder plan policies", () => {
		expect(getCardCompletionPolicyBadgeLabel({ kind: "build", policy: "manual" })).toBeNull();
		expect(getCardCompletionPolicyBadgeLabel({ kind: "plan", policy: "unknown" })).toBeNull();
	});

	it("derives badge labels directly from a card", () => {
		expect(getTaskCompletionPolicyBadgeLabel(createCard({ autoReviewEnabled: true, autoReviewMode: "pr" }))).toBe(
			"Auto-PR",
		);
		expect(getTaskCompletionPolicyBadgeLabel(createCard({ autoReviewEnabled: false }))).toBeNull();
	});
});
