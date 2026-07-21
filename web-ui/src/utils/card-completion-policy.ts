import type { BoardCard } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";

export type CardKind = "plan" | "build";

export type BuildCardCompletionPolicy = "manual" | "auto-pr";
export type PlanCardCompletionPolicy = "unknown";

export type CardCompletionPolicy =
	| {
			kind: "build";
			policy: BuildCardCompletionPolicy;
	  }
	| {
			kind: "plan";
			policy: PlanCardCompletionPolicy;
	  };

type CardKindFields = Pick<BoardCard, "startInPlanMode">;
type CardCompletionPolicyFields = Pick<BoardCard, "startInPlanMode" | "autoReviewEnabled" | "autoReviewMode">;

export function cardKind(card: CardKindFields): CardKind {
	return card.startInPlanMode === true ? "plan" : "build";
}

export function cardCompletionPolicy(card: CardCompletionPolicyFields): CardCompletionPolicy {
	const kind = cardKind(card);
	if (kind === "plan") {
		return { kind, policy: "unknown" };
	}
	if (card.autoReviewEnabled === true && resolveTaskAutoReviewMode(card.autoReviewMode) === "pr") {
		return { kind, policy: "auto-pr" };
	}
	return { kind, policy: "manual" };
}

export function getCardCompletionPolicyBadgeLabel(policy: CardCompletionPolicy): string | null {
	if (policy.kind === "plan") {
		return null;
	}
	if (policy.policy === "auto-pr") {
		return "Auto-PR";
	}
	return null;
}

export function getTaskCompletionPolicyBadgeLabel(card: CardCompletionPolicyFields): string | null {
	return getCardCompletionPolicyBadgeLabel(cardCompletionPolicy(card));
}
